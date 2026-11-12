import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
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
import { BUSY_SETTING_MESSAGE, type MainThread, SideChat, type SideChatHooks } from "./sideChat.ts";

const BRING_BACK_STATUS_KEY = "side-chat-bring-back";

/**
 * The side chats of the main session, the commands that open them, and what the main agent
 * learns from them.
 *
 * It follows the main session: the leaf of the last settled run is where a new side chat forks
 * while the main agent runs, and a session switch or reload ends every side chat.
 */
export class SideChatRegistry {
  private readonly sideChats: SideChat[] = [];
  private readonly changes = new ChangeTracker();
  private stableLeafId: string | null = null;
  private mainContext: ExtensionContext | undefined;
  private pendingBringBack: PendingBringBack | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  /** The main session started, or the extension runtime was replaced. Its leaf is settled now. */
  onSessionStart(ctx: ExtensionContext): void {
    this.mainContext = ctx;
    this.stableLeafId = ctx.sessionManager.getLeafId();
  }

  onMainSettled(ctx: ExtensionContext): void {
    this.mainContext = ctx;
    this.stableLeafId = ctx.sessionManager.getLeafId();
  }

  onSessionShutdown(): void {
    for (const sideChat of this.sideChats.splice(0)) sideChat.dispose();
    this.mainContext = undefined;
    this.pendingBringBack = undefined;
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

  async runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.mainContext = ctx;
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify("Side chats need the interactive terminal.", "warning");
      return;
    }
    const question = args.trim();
    const existing = this.sideChats[0];
    if (existing && existing.hasMessages && question.length > 0) {
      ctx.ui.notify("A side chat is already open. Run /side to open it, and press d there to delete it first.", "warning");
      return;
    }
    const sideChat = existing ?? this.createSideChat(ctx);
    if (!existing) this.sideChats.push(sideChat);
    if (question.length > 0) await sideChat.send(question);
    await this.openOverlay(sideChat, ctx, question.length === 0 && !sideChat.hasMessages);
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

  private createSideChat(ctx: ExtensionCommandContext): SideChat {
    const main: MainThread = {
      cwd: ctx.cwd,
      modelRegistry: ctx.modelRegistry,
      branch: () => ctx.sessionManager.getBranch(),
      isIdle: () => ctx.isIdle(),
      systemPrompt: () => ctx.getSystemPrompt(),
    };
    return new SideChat({
      fork: chooseForkPoint(ctx.sessionManager.getBranch(), this.stableLeafId, ctx.isIdle()),
      main,
      model: ctx.model,
      thinkingLevel: this.pi.getThinkingLevel(),
      hooks: this.hooks,
    });
  }

  private async openOverlay(sideChat: SideChat, ctx: ExtensionCommandContext, startInInput: boolean): Promise<void> {
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
            bringBack: () => this.bringBack(sideChat, ctx),
            pickModel: () => this.pickModel(sideChat, ctx),
            delete: () => {
              void (async () => {
                if (sideChat.hasMessages) {
                  const confirmed = await ctx.ui.confirm(
                    "Delete this side chat?",
                    `"${sideChat.title}" and its conversation will be gone. Its changes to files stay.`,
                  );
                  if (!confirmed) return;
                }
                this.remove(sideChat);
                done();
              })();
            },
          },
        }),
      { overlay: true, overlayOptions: { width: "80%", minWidth: 40, anchor: "center" } },
    );
    // A side chat that never got a message is not worth keeping.
    if (!sideChat.hasMessages) this.remove(sideChat);
  }

  private remove(sideChat: SideChat): void {
    const index = this.sideChats.indexOf(sideChat);
    if (index >= 0) this.sideChats.splice(index, 1);
    this.changes.forgetSideChat(sideChat.id);
    sideChat.dispose();
  }
}
