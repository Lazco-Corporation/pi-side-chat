import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseForkPoint } from "./fork.ts";
import { SideChatOverlay } from "./overlay.ts";
import { type MainThread, SideChat } from "./sideChat.ts";

/**
 * The side chats of the main session, and the commands that open them.
 *
 * It follows the main session: the leaf of the last settled run is where a new side chat forks
 * while the main agent runs, and a session switch or reload ends every side chat.
 */
export class SideChatRegistry {
  private readonly sideChats: SideChat[] = [];
  private stableLeafId: string | null = null;

  constructor(private readonly pi: ExtensionAPI) {}

  /** The main session started, or the extension runtime was replaced. Its leaf is settled now. */
  onSessionStart(ctx: ExtensionContext): void {
    this.stableLeafId = ctx.sessionManager.getLeafId();
  }

  onMainSettled(ctx: ExtensionContext): void {
    this.stableLeafId = ctx.sessionManager.getLeafId();
  }

  onSessionShutdown(): void {
    for (const sideChat of this.sideChats.splice(0)) sideChat.dispose();
  }

  async runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
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
    sideChat.dispose();
  }
}
