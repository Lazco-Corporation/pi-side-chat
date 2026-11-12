import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DENIED_REASON, describeToolCall } from "./approval.ts";

/**
 * What the side chat overlay shows, built from the side chat's own session entries.
 * The entries it inherited from the main thread are not part of it.
 */

export type ToolStatus = "running" | "done" | "error" | "denied" | "interrupted";

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; toolName: string; summary: string; status: ToolStatus; error?: string }
  | { kind: "error"; key: string; text: string }
  | { kind: "stopped"; key: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * `running` says whether the side chat still runs, so a call without a result shows as running then,
 * and as interrupted after the run ended.
 */
export function transcriptFromEntries(entries: readonly SessionEntry[], running: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolItems = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "user") {
      items.push({ kind: "user", key: entry.id, text: textOf(message.content) });
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text.trim().length > 0) items.push({ kind: "assistant", key: entry.id, text });
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (part?.type !== "toolCall") continue;
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          key: `${entry.id}:${part.id}`,
          toolName: part.name,
          summary: describeToolCall(part.name, part.arguments),
          status: running ? "running" : "interrupted",
        };
        toolItems.set(part.id, item);
        items.push(item);
      }
      if (message.stopReason === "error") {
        const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "The model call failed.";
        items.push({ kind: "error", key: `${entry.id}:error`, text: errorMessage });
      } else if (message.stopReason === "aborted") {
        items.push({ kind: "stopped", key: `${entry.id}:stopped` });
      }
    } else if (message.role === "toolResult") {
      const item = toolItems.get(String(message.toolCallId));
      if (!item) continue;
      const resultText = textOf(message.content);
      if (message.isError !== true) item.status = "done";
      else if (resultText.trim() === DENIED_REASON) item.status = "denied";
      else {
        item.status = "error";
        item.error = resultText;
      }
    }
  }
  return items;
}

/** The text of an assistant message while it streams. */
export function streamingText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  return textOf((message as Record<string, unknown>).content);
}

/** The newest complete reply, for the copy key. */
export function lastAssistantText(items: readonly TranscriptItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind === "assistant") return item.text;
  }
  return undefined;
}
