import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { digestLines } from "./context.ts";

/**
 * Bring back: what the main thread gets from a side chat when the user asks for it.
 *
 * It does not start a main run. It waits for the user's next message in the main thread and goes
 * with it, like T3 Code's merge-back, so the user decides what the main agent does with it.
 * Only one side chat can wait at a time, so two notes never pile up unseen.
 */

export const BRING_BACK_MESSAGE_TYPE = "side-chat-bring-back";
/** One message of the side chat keeps this many characters. */
export const BRING_BACK_ITEM_MAX_CHARS = 4_000;
/** The whole note stays under this size, keeping the newest part. */
export const BRING_BACK_MAX_CHARS = 20_000;

export interface PendingBringBack {
  sideChatId: string;
  title: string;
  text: string;
}

export interface BringBackCheck {
  sideChatId: string;
  mainIsIdle: boolean;
  mainHasQueuedMessages: boolean;
  sideChatBusy: boolean;
  hasFinishedReply: boolean;
  pending: PendingBringBack | undefined;
}

/** Why Bring back is not available now, or null when it is. */
export function bringBackBlockedReason(check: BringBackCheck): string | null {
  if (!check.mainIsIdle || check.mainHasQueuedMessages) return "Available when the main thread is idle.";
  if (check.sideChatBusy) return "Available when the side chat is idle.";
  if (!check.hasFinishedReply) return "Available after a finished reply.";
  if (check.pending && check.pending.sideChatId !== check.sideChatId) {
    return `Side chat "${check.pending.title}" already waits to go back. Send a message in the main thread first.`;
  }
  return null;
}

/** True when the newest reply of the side chat ended normally. */
export function hasFinishedReply(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "assistant") return message.stopReason === "stop";
  }
  return false;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 1)}…`;
}

/** A labeled block whose later lines are indented under the label, so a reply keeps its lines. */
function block(label: string, text: string): string {
  return `- ${label}: ${clip(text, BRING_BACK_ITEM_MAX_CHARS).replace(/\n/g, "\n  ")}`;
}

/** The blocks of one side chat entry: the messages in full, the calls as one line each. */
function deltaBlocks(entry: SessionEntry): string[] {
  if (entry.type !== "message") return [];
  const message = entry.message as unknown as Record<string, unknown>;
  if (message.role === "user") {
    const text = textOf(message.content);
    return text.trim().length === 0 ? [] : [block("User", text)];
  }
  if (message.role === "assistant") {
    const text = textOf(message.content);
    const calls = digestLines(entry).filter((line) => !line.startsWith("- Assistant:"));
    return [...(text.trim().length === 0 ? [] : [block("Assistant", text)]), ...calls];
  }
  return [];
}

export function renderBringBack(title: string, entries: readonly SessionEntry[]): string {
  const header = [
    `Context brought back from side chat "${title}".`,
    "The user asked these questions beside the main thread. Use what is relevant to the next message.",
    "",
    "Side chat delta:",
  ];
  const truncatedLine = "- Earlier items truncated.";
  let remaining = BRING_BACK_MAX_CHARS - [...header, truncatedLine].join("\n").length;
  const all = entries.flatMap(deltaBlocks);
  const kept: string[] = [];
  let truncated = false;
  for (let index = all.length - 1; index >= 0; index--) {
    const item = all[index] as string;
    if (item.length + 1 > remaining) {
      truncated = true;
      break;
    }
    kept.unshift(item);
    remaining -= item.length + 1;
  }
  return [...header, ...(truncated ? [truncatedLine] : []), ...kept].join("\n");
}
