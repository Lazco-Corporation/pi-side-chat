import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SideChatRegistry } from "./registry.ts";

/**
 * `/side` and `/btw`: a side chat beside the main thread.
 *
 * A side chat is an agent session of its own that starts from what the main thread knows.
 * It answers questions while the main agent keeps working, and nothing it says enters the main
 * session unless the user brings it back.
 */
export default function (pi: ExtensionAPI): void {
  const registry = new SideChatRegistry(pi);

  pi.on("session_start", (_event, ctx) => registry.onSessionStart(ctx));
  pi.on("agent_settled", (_event, ctx) => registry.onMainSettled(ctx));
  pi.on("session_shutdown", (_event, ctx) => registry.onSessionShutdown(ctx));
  pi.on("before_agent_start", (event, ctx) => registry.onBeforeAgentStart(event, ctx));
  pi.on("tool_call", (event, ctx) => registry.onMainToolCall(event, ctx));
  pi.on("tool_result", (event, ctx) => {
    registry.onMainToolResult(event, ctx);
  });

  for (const name of ["side", "btw"]) {
    pi.registerCommand(name, {
      description: "Ask a question in a side chat, without adding to this thread",
      handler: async (args, ctx) => {
        await registry.runCommand(args, ctx);
      },
    });
  }
}
