import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, truncateToWidth } from "@earendil-works/pi-tui";

const LOG = process.env.SPIKE_LOG ?? "/tmp/pi-side-chat-l0.log";
const log = (...parts: unknown[]) =>
  appendFileSync(LOG, `${new Date().toISOString()} ${parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ")}\n`);

async function spikeChild(prompt: string, ctx: ExtensionCommandContext, bind: boolean) {
  log("spike-child start", { bind, branch: ctx.sessionManager.getBranch().length, model: ctx.model?.id });
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  const systemPrompt = ctx.getSystemPrompt();
  const loader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    extensionFactories: [
      (childPi: ExtensionAPI) => {
        childPi.on("tool_call", async (event) => {
          log("child tool_call", event.toolName, event.input);
          if (event.toolName === "write") return { block: true, reason: "Blocked by the L0 spike." };
          return undefined;
        });
        childPi.on("tool_result", async (event) => {
          log("child tool_result", event.toolName, { isError: event.isError });
        });
        childPi.on("agent_settled", async () => log("child agent_settled"));
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    sessionManager: SessionManager.inMemory(ctx.cwd, undefined, ctx.sessionManager.getBranch()),
    resourceLoader: loader,
    model: ctx.model,
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined ? { modelRuntime: parentModelRuntime } : {}),
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  } as Parameters<typeof createAgentSession>[0]);
  if (bind) await session.bindExtensions({ onError: (error) => log("child extension error", String(error.error)) });
  log("child active tools", session.getActiveToolNames());
  log("child messages before prompt", session.messages.length);
  let deltas = 0;
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") deltas++;
    if (event.type === "tool_execution_start") log("child tool_execution_start", event.toolName);
  });
  try {
    await session.prompt(prompt);
    log("child done", { deltas, text: session.getLastAssistantText(), messages: session.messages.length });
    ctx.ui.notify(`spike-child done: ${deltas} deltas`, "info");
  } catch (error) {
    log("child error", String(error));
    ctx.ui.notify(`spike-child error: ${String(error)}`, "error");
  } finally {
    session.dispose();
  }
}

class SpikeOverlay implements Component, Focusable {
  private readonly input = new Input({ prompt: "› " });
  private hasFocus = false;
  private lines: string[] = ["Type into the input. enter logs it, tab toggles select test, esc closes."];
  constructor(
    private readonly onSubmit: (value: string) => void,
    private readonly onSelect: () => void,
    private readonly onClose: () => void,
  ) {
    this.input.onSubmit = (value) => {
      this.lines.push(`submitted: ${value}`);
      this.onSubmit(value);
      this.input.setValue("");
    };
  }
  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value;
  }
  note(line: string): void {
    this.lines.push(line);
  }
  handleInput(data: string): void {
    if (data === "\u001b") return this.onClose();
    if (data === "\t") return this.onSelect();
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    return [
      "┌ L0 overlay spike",
      ...this.lines.map((line) => truncateToWidth(`│ ${line}`, width)),
      `│ ${this.input.render(Math.max(1, width - 2))[0] ?? ""}`,
      "└",
    ];
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("spike-child", {
    description: "L0: run a child session without bindExtensions",
    handler: async (args, ctx) => spikeChild(args || "Use the write tool to create /tmp/pi-side-chat-l0.txt with the text hi, then use bash to run `echo spike`. Report both results in one sentence.", ctx, false),
  });
  pi.registerCommand("spike-child-bound", {
    description: "L0: run a child session with bindExtensions",
    handler: async (args, ctx) => spikeChild(args || "Use the write tool to create /tmp/pi-side-chat-l0.txt with the text hi, then use bash to run `echo spike`. Report both results in one sentence.", ctx, true),
  });
  pi.registerCommand("spike-overlay", {
    description: "L0: overlay with Input, and ctx.ui.select() over it",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<void>(
        (tui, _theme, _keybindings, done) => {
          const overlay: SpikeOverlay = new SpikeOverlay(
            (value) => {
              log("overlay submitted", value);
              tui.requestRender();
            },
            () => {
              void (async () => {
                log("select requested");
                const choice = await ctx.ui.select("L0 select over overlay", ["first 第一", "second 第二"]);
                log("select result", choice ?? "(cancelled)");
                overlay.note(`select result: ${choice ?? "(cancelled)"}`);
                tui.requestRender();
              })();
            },
            () => done(),
          );
          return overlay;
        },
        { overlay: true, overlayOptions: { width: "70%", anchor: "center" } },
      );
      log("overlay closed");
    },
  });
}
