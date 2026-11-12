import type { SessionEntry } from "@earendil-works/pi-coding-agent";

let nextId = 0;

/** A message entry with a fresh id, chained to `parentId`. */
export function messageEntry(message: Record<string, unknown>, parentId: string | null = null): SessionEntry {
  nextId++;
  return { type: "message", id: `e${nextId}`, parentId, timestamp: "", message } as unknown as SessionEntry;
}

export function user(text: string): SessionEntry {
  return messageEntry({ role: "user", content: text });
}

export function assistant(content: unknown[], extra: Record<string, unknown> = {}): SessionEntry {
  return messageEntry({ role: "assistant", content, stopReason: "stop", ...extra });
}

export function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { type: "toolCall", id, name, arguments: args };
}

export function toolResult(toolCallId: string, resultText: string, isError = false): SessionEntry {
  return messageEntry({ role: "toolResult", toolCallId, toolName: "tool", content: [text(resultText)], isError });
}

export function customEntry(customType: string, data: unknown = {}): SessionEntry {
  nextId++;
  return { type: "custom", id: `e${nextId}`, parentId: null, timestamp: "", customType, data } as unknown as SessionEntry;
}
