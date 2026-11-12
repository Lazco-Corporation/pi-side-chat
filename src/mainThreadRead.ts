import { Type } from "@earendil-works/pi-ai";
import type { SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { digestActivity, MAIN_THREAD_READ_TOOL_NAME, SIDE_CHAT_CONTEXT_MAX_CHARS } from "./context.ts";

/**
 * `main_thread_read`: the side chat's view of the main thread as it is now.
 *
 * The context of the first question is a snapshot. A side chat that lives longer, or a question
 * about what the main agent does right now, needs the live state, and this tool reads it.
 */

export interface MainThreadSnapshot {
  running: boolean;
  /** The main entries after the side chat's starting point. */
  activity: SessionEntry[];
}

const MIN_CHARS = 500;
const MAX_CHARS = 50_000;

export function renderMainThreadState(snapshot: MainThreadSnapshot, maxChars: number): string {
  const status = snapshot.running ? "The main thread is running now." : "The main thread is idle now.";
  const digest = digestActivity(snapshot.activity, Math.max(MIN_CHARS, maxChars - status.length - 100));
  if (digest.lines.length === 0) return `${status}\nThe main thread did nothing after this side chat's starting point.`;
  return [
    status,
    "Main thread activity since this side chat's starting point:",
    ...(digest.truncated ? ["- Earlier items truncated."] : []),
    ...digest.lines,
  ].join("\n");
}

export function createMainThreadReadTool(read: () => MainThreadSnapshot): ToolDefinition {
  const parameters = Type.Object({
    maxChars: Type.Optional(
      Type.Integer({
        minimum: MIN_CHARS,
        maximum: MAX_CHARS,
        description: `The most characters to return. Default ${SIDE_CHAT_CONTEXT_MAX_CHARS}. The newest activity is kept.`,
      }),
    ),
  });
  return {
    name: MAIN_THREAD_READ_TOOL_NAME,
    label: "Main thread",
    description:
      "Read what the main thread did after this side chat's starting point, and whether it is running now: the user's messages, the agent's replies, its commands, and the files it changed.",
    parameters,
    async execute(_toolCallId, params) {
      const maxChars = (params as { maxChars?: number }).maxChars ?? SIDE_CHAT_CONTEXT_MAX_CHARS;
      return { content: [{ type: "text", text: renderMainThreadState(read(), maxChars) }], details: undefined };
    },
  } as ToolDefinition;
}
