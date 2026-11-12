import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * The text that tells the side chat model where it is, with a digest of what the main thread did
 * after the fork point.
 *
 * The wording follows T3 Code's side chat context, so a model reads the same framing in both.
 */

/** The whole context block stays under this size, so a long main run cannot crowd out the question. */
export const SIDE_CHAT_CONTEXT_MAX_CHARS = 8_000;
/** One digest line keeps this many characters of its text. */
export const DIGEST_ITEM_MAX_CHARS = 500;

export const MAIN_THREAD_READ_TOOL_NAME = "main_thread_read";

const FRAMING =
  "This is a side chat beside the main thread. The main thread may still be running in the same working directory. Answer the user's questions; do not continue or redo the main thread's task.";
const ACTIVITY_HEADER = "Main thread activity since this side chat's starting point:";
const TRUNCATED_LINE = "- Earlier items truncated.";
const LIVE_STATE_FOOTER = `Use ${MAIN_THREAD_READ_TOOL_NAME} to see the main thread's live state.`;

/** Whitespace runs become one space, and long text keeps its start. */
export function compactText(text: string, maxChars: number = DIGEST_ITEM_MAX_CHARS): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1)}…`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function stringArgument(argumentsValue: unknown, ...names: string[]): string | undefined {
  if (typeof argumentsValue !== "object" || argumentsValue === null) return undefined;
  for (const name of names) {
    const value = (argumentsValue as Record<string, unknown>)[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The digest lines of one entry. Only what the user said, what the agent said, the commands it ran,
 * and the files it changed go in; tool results and thinking stay out.
 */
export function digestLines(entry: SessionEntry): string[] {
  if (entry.type !== "message") return [];
  const message = entry.message as unknown as Record<string, unknown>;
  switch (message.role) {
    case "user": {
      const text = textOf(message.content);
      return text.trim().length === 0 ? [] : [`- User: ${compactText(text)}`];
    }
    case "assistant": {
      const lines: string[] = [];
      const text = textOf(message.content);
      if (text.trim().length > 0) lines.push(`- Assistant: ${compactText(text)}`);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (part?.type !== "toolCall") continue;
        if (part.name === "bash") {
          const command = stringArgument(part.arguments, "command");
          if (command) lines.push(`- Command: ${compactText(command)}`);
        } else if (part.name === "edit" || part.name === "write") {
          const path = stringArgument(part.arguments, "path", "file_path");
          if (path) lines.push(`- File change: ${compactText(path)}`);
        }
      }
      return lines;
    }
    case "bashExecution": {
      const command = typeof message.command === "string" ? message.command : "";
      return command.length === 0 ? [] : [`- Command: ${compactText(command)}`];
    }
    default:
      return [];
  }
}

export interface ActivityDigest {
  /** Oldest first. */
  lines: string[];
  /** True when older lines did not fit. */
  truncated: boolean;
}

/** Keeps the newest lines that fit in `maxChars`, counting one newline per line. */
export function digestActivity(entries: readonly SessionEntry[], maxChars: number): ActivityDigest {
  const all = entries.flatMap(digestLines);
  const kept: string[] = [];
  let remaining = maxChars;
  for (let index = all.length - 1; index >= 0; index--) {
    const line = all[index] as string;
    if (line.length + 1 > remaining) return { lines: kept, truncated: true };
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return { lines: kept, truncated: false };
}

/**
 * The context the side chat model gets with its first question.
 * The framing goes in even when the main thread did nothing after the fork point.
 */
export function buildSideChatContext(input: { activity: readonly SessionEntry[]; toolNames: readonly string[] }): string {
  const toolsLine = `In this side chat you can use only these tools: ${input.toolNames.join(", ")}. A tool that the system prompt or an earlier message names is not available unless it is in this list.`;
  const footer = input.toolNames.includes(MAIN_THREAD_READ_TOOL_NAME) ? ["", LIVE_STATE_FOOTER] : [];
  // The cap covers the whole block, so the fixed lines are reserved before any digest line.
  const fixed = [FRAMING, "", toolsLine, "", ACTIVITY_HEADER, TRUNCATED_LINE, ...footer].join("\n");
  const digest = digestActivity(input.activity, SIDE_CHAT_CONTEXT_MAX_CHARS - fixed.length);
  const activity =
    digest.lines.length === 0 ? [] : ["", ACTIVITY_HEADER, ...(digest.truncated ? [TRUNCATED_LINE] : []), ...digest.lines];
  return [FRAMING, "", toolsLine, ...activity, ...footer].join("\n");
}
