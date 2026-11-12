import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  BRING_BACK_MESSAGE_TYPE,
  bringBackBlockedReason,
  hasFinishedReply,
  type PendingBringBack,
  renderBringBack,
} from "./bringBack.ts";
import {
  CHANGE_TOOL_NAMES,
  CHANGES_MESSAGE_TYPE,
  ChangeTracker,
  changeNotification,
  displayPath,
  resolveToolPath,
  staleFileReason,
} from "./changes.ts";
import { chooseForkPoint } from "./fork.ts";
import { ModelPicker, modelKey } from "./modelPicker.ts";
import { type OverlayNotice, SideChatOverlay } from "./overlay.ts";
import type { ThinkingLevel } from "./child.ts";
import { BUSY_SETTING_MESSAGE, type MainThread, SideChat, type SideChatHooks } from "./sideChat.ts";
import { approvalNote, type StatusRow, stateLabel, statusKey, statusWidget } from "./status.ts";
import { deleteStoredSideChat, loadStoredSideChats, removeOrphans, type StoredSideChat, sideChatsDirFor, sideChatsRoot } from "./store.ts";

const WIDGET_KEY = "side-chat";
const APPROVAL_STATUS_KEY = "side-chat-approval";
const BRING_BACK_STATUS_KEY = "side-chat-bring-back";
const NEW_SIDE_CHAT_OPTION = "New side chat";

/**
 * The side chats of the main session, the commands that open them, and what the main session
 * learns from them.
 *
 * It follows the main session: the leaf of the last settled run is where a new side chat forks
 * while the main agent runs, and a session switch or reload ends every side chat.
 */
export class SideChatRegistry {
  private readonly sideChats: SideChat[] = [];
  private readonly changes = new ChangeTracker();
  private readonly stopWatching = new Map<string, () => void>();
  /** Side chats whose run ended while their overlay was closed. */
  private readonly unread = new Set<string>();
  private readonly wasBusy = new Map<string, boolean>();
  private stableLeafId: string | null = null;
  private mainContext: ExtensionContext | undefined;
  private pendingBringBack: PendingBringBack | undefined;
  private openSideChatId: string | undefined;
  private shownStatus: string | undefined;
  /** Where the side chats of the main session are saved. Undefined when the main session is not saved. */
  private storeDir: string | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  /**
   * The main session started, or the extension runtime was replaced. Its leaf is settled now.
   * Its saved side chats come back, and the files of deleted main sessions go.
   */
  onSessionStart(ctx: ExtensionContext): void {
    this.mainContext = ctx;
    this.stableLeafId = ctx.sessionManager.getLeafId();
    const agentDir = getAgentDir();
    this.storeDir = ctx.sessionManager.getSessionFile() ? sideChatsDirFor(agentDir, ctx.sessionManager.getSessionId()) : undefined;
    try {
      removeOrphans(sideChatsRoot(agentDir));
      if (this.storeDir) for (const stored of loadStoredSideChats(this.storeDir)) this.add(this.restoreSideChat(stored, ctx));
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Side chats: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    this.refreshStatus();
  }

  onMainSettled(ctx: ExtensionContext): void {
    this.mainContext = ctx;
    this.stableLeafId = ctx.sessionManager.getLeafId();
  }

  onSessionShutdown(ctx: ExtensionContext): void {
    // Saved side chats stay on disk; the next start of this main session brings them back.
    for (const sideChat of [...this.sideChats]) this.forget(sideChat);
    this.pendingBringBack = undefined;
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(APPROVAL_STATUS_KEY, undefined);
      ctx.ui.setStatus(BRING_BACK_STATUS_KEY, undefined);
    }
    this.shownStatus = undefined;
    this.mainContext = undefined;
  }

  /** A side chat that the user brought back goes with the next message that the user sends. */
  onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): BeforeAgentStartEventResult | undefined {
    const pending = this.pendingBringBack;
    if (event.messageType !== "user" || pending === undefined) return undefined;
    this.pendingBringBack = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(BRING_BACK_STATUS_KEY, undefined);
    return {
      message: {
        customType: BRING_BACK_MESSAGE_TYPE,
        content: pending.text,
        display: true,
        details: { sideChatId: pending.sideChatId, title: pending.title },
      },
    };
  }

  /** Stops the main agent's first `edit` or `write` of a file that a side chat changed since the agent read it. */
  onMainToolCall(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
    if (!CHANGE_TOOL_NAMES.has(event.toolName) || this.changes.size === 0) return undefined;
    const path = resolveToolPath(ctx.cwd, event.input);
    const source = path === undefined ? undefined : this.changes.take(path);
    if (path === undefined || source === undefined) return undefined;
    return { block: true, reason: staleFileReason(displayPath(ctx.cwd, path), source) };
  }

  onMainToolResult(event: ToolResultEvent, ctx: ExtensionContext): void {
    if (event.toolName !== "read" || event.isError || this.changes.size === 0) return;
    const path = resolveToolPath(ctx.cwd, event.input);
    if (path !== undefined) this.changes.clear(path);
  }

  /** `/side <question>` starts a new side chat. `/side` alone lists the side chats, or starts an empty one. */
  async runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.mainContext = ctx;
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("Side chats need the interactive terminal.", "warning");
      return;
    }
    const question = args.trim();
    if (question.length > 0) {
      const sideChat = this.add(this.createSideChat(ctx));
      await sideChat.send(question);
      await this.openOverlay(sideChat, ctx, false);
      return;
    }
    const chosen = await this.chooseSideChat(ctx);
    if (chosen === "cancelled") return;
    const sideChat = chosen ?? this.add(this.createSideChat(ctx));
    await this.openOverlay(sideChat, ctx, !sideChat.hasMessages);
  }

  /** The side chat that the user picks, undefined for a new one. */
  private async chooseSideChat(ctx: ExtensionCommandContext): Promise<SideChat | undefined | "cancelled"> {
    const listed = this.sideChats.filter((sideChat) => sideChat.hasMessages);
    if (listed.length === 0) return undefined;
    const options = listed.map((sideChat, index) => `${index + 1}. ${sideChat.title} · ${this.labelOf(sideChat).text}`);
    const choice = await ctx.ui.select("Side chats", [NEW_SIDE_CHAT_OPTION, ...options]);
    if (choice === undefined) return "cancelled";
    if (choice === NEW_SIDE_CHAT_OPTION) return undefined;
    return listed[options.indexOf(choice)] ?? "cancelled";
  }

  private readonly hooks: SideChatHooks = {
    fileChanged: (sideChat, absolutePath) => {
      this.changes.record(absolutePath, { sideChatId: sideChat.id, title: sideChat.title });
    },
    runChangedFiles: (sideChat, absolutePaths) => {
      const ctx = this.mainContext;
      if (!ctx) return;
      const paths = absolutePaths.map((path) => displayPath(ctx.cwd, path));
      // A running main agent reads it before its next model call; an idle one gets it with the next message.
      void this.pi.sendMessage(
        {
          customType: CHANGES_MESSAGE_TYPE,
          content: changeNotification(sideChat.title, paths),
          display: true,
          details: { sideChatId: sideChat.id, paths },
        },
        { deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
      );
    },
  };

  private mainThread(ctx: ExtensionContext): MainThread {
    return {
      cwd: ctx.cwd,
      sessionFile: ctx.sessionManager.getSessionFile(),
      modelRegistry: ctx.modelRegistry,
      branch: () => ctx.sessionManager.getBranch(),
      isIdle: () => ctx.isIdle(),
      systemPrompt: () => ctx.getSystemPrompt(),
    };
  }

  private createSideChat(ctx: ExtensionCommandContext): SideChat {
    return new SideChat({
      fork: chooseForkPoint(ctx.sessionManager.getBranch(), this.stableLeafId, ctx.isIdle()),
      ...(this.storeDir ? { storeDir: this.storeDir } : {}),
      main: this.mainThread(ctx),
      model: ctx.model,
      thinkingLevel: this.pi.getThinkingLevel(),
      hooks: this.hooks,
    });
  }

  /** A saved side chat, with the model and thinking level of its last run. */
  private restoreSideChat(stored: StoredSideChat, ctx: ExtensionContext): SideChat {
    const context = stored.sessionManager.buildSessionContext();
    const model = context.model ? ctx.modelRegistry.find(context.model.provider, context.model.modelId) : undefined;
    return new SideChat({
      fork: { leafId: stored.marker.forkLeafId, inherited: [] },
      stored,
      main: this.mainThread(ctx),
      model: model ?? ctx.model,
      thinkingLevel: context.thinkingLevel as ThinkingLevel,
      hooks: this.hooks,
    });
  }

  private add(sideChat: SideChat): SideChat {
    this.sideChats.push(sideChat);
    this.stopWatching.set(
      sideChat.id,
      sideChat.onChange(() => this.onSideChatChange(sideChat)),
    );
    return sideChat;
  }

  /** Deletes a side chat, with its file. */
  private remove(sideChat: SideChat): void {
    const path = sideChat.path;
    this.forget(sideChat);
    if (path) deleteStoredSideChat(path);
  }

  /** Lets go of a side chat in this process. Its file stays. */
  private forget(sideChat: SideChat): void {
    const index = this.sideChats.indexOf(sideChat);
    if (index >= 0) this.sideChats.splice(index, 1);
    this.stopWatching.get(sideChat.id)?.();
    this.stopWatching.delete(sideChat.id);
    this.unread.delete(sideChat.id);
    this.wasBusy.delete(sideChat.id);
    this.changes.forgetSideChat(sideChat.id);
    sideChat.dispose();
    this.refreshStatus();
  }

  private onSideChatChange(sideChat: SideChat): void {
    const busy = sideChat.busy;
    if (this.wasBusy.get(sideChat.id) === true && !busy && this.openSideChatId !== sideChat.id) this.unread.add(sideChat.id);
    this.wasBusy.set(sideChat.id, busy);
    this.refreshStatus();
  }

  private labelOf(sideChat: SideChat) {
    return stateLabel(sideChat.state, this.unread.has(sideChat.id));
  }

  /** Redraws the widget and the approval note, when what they show changed. */
  private refreshStatus(): void {
    const ctx = this.mainContext;
    if (!ctx?.hasUI) return;
    const rows: StatusRow[] = this.sideChats
      .filter((sideChat) => sideChat.hasMessages)
      .map((sideChat) => ({ title: sideChat.title, label: this.labelOf(sideChat) }));
    const waiting = this.sideChats.find((sideChat) => sideChat.approvals.length > 0 && sideChat.id !== this.openSideChatId);
    const key = `${statusKey(rows)}\u0002${waiting?.id ?? ""}`;
    if (key === this.shownStatus) return;
    this.shownStatus = key;
    ctx.ui.setWidget(WIDGET_KEY, rows.length === 0 ? undefined : statusWidget(rows));
    ctx.ui.setStatus(APPROVAL_STATUS_KEY, waiting ? ctx.ui.theme.fg("warning", approvalNote(waiting.title)) : undefined);
  }

  private async openOverlay(sideChat: SideChat, ctx: ExtensionCommandContext, startInInput: boolean): Promise<void> {
    this.openSideChatId = sideChat.id;
    this.unread.delete(sideChat.id);
    this.refreshStatus();
    try {
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new SideChatOverlay({
            tui,
            theme,
            keybindings,
            sideChat,
            startInInput,
            actions: {
              close: () => done(),
              delete: () => void this.confirmDelete(sideChat, ctx, done),
              bringBack: () => this.bringBack(sideChat, ctx),
              pickModel: () => this.pickModel(sideChat, ctx),
            },
          }),
        { overlay: true, overlayOptions: { width: "80%", minWidth: 40, anchor: "center" } },
      );
    } finally {
      this.openSideChatId = undefined;
    }
    // A side chat that never got a message is not worth keeping.
    if (!sideChat.hasMessages) this.remove(sideChat);
    else this.refreshStatus();
  }

  private async confirmDelete(sideChat: SideChat, ctx: ExtensionCommandContext, close: () => void): Promise<void> {
    if (sideChat.hasMessages) {
      const confirmed = await ctx.ui.confirm(
        "Delete this side chat?",
        `"${sideChat.title}" and its conversation will be gone. Its changes to files stay.`,
      );
      if (!confirmed) return;
    }
    this.remove(sideChat);
    close();
  }

  private async pickModel(sideChat: SideChat, ctx: ExtensionCommandContext): Promise<OverlayNotice | undefined> {
    if (sideChat.busy) return { text: BUSY_SETTING_MESSAGE, tone: "warning" };
    const model = await ctx.ui.custom<Model<Api> | undefined>(
      (_tui, theme, keybindings, done) =>
        new ModelPicker({ theme, keybindings, models: ctx.modelRegistry.getAvailable(), current: sideChat.model, done }),
      { overlay: true, overlayOptions: { width: "60%", minWidth: 40, anchor: "center" } },
    );
    if (!model) return undefined;
    try {
      await sideChat.setModel(model);
      return { text: `Model: ${modelKey(model)}, thinking ${sideChat.thinkingLevel ?? "off"}, from the next run on.`, tone: "success" };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), tone: "error" };
    }
  }

  private bringBack(sideChat: SideChat, ctx: ExtensionCommandContext): OverlayNotice {
    const ownEntries = sideChat.ownEntries();
    const blocked = bringBackBlockedReason({
      sideChatId: sideChat.id,
      mainIsIdle: ctx.isIdle(),
      mainHasQueuedMessages: ctx.hasPendingMessages(),
      sideChatBusy: sideChat.busy,
      hasFinishedReply: hasFinishedReply(ownEntries),
      pending: this.pendingBringBack,
    });
    if (blocked !== null) return { text: blocked, tone: "warning" };
    this.pendingBringBack = { sideChatId: sideChat.id, title: sideChat.title, text: renderBringBack(sideChat.title, ownEntries) };
    ctx.ui.setStatus(BRING_BACK_STATUS_KEY, ctx.ui.theme.fg("accent", `Bring back waits: ${sideChat.title}`));
    return { text: "Brought back. The main thread gets this side chat with your next message there.", tone: "success" };
  }
}
