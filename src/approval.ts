import { compactText } from "./context.ts";

/**
 * Which tool calls of a side chat wait for the user.
 *
 * A side chat works in the same directory as the main thread, so the calls that can change it ask
 * first. The run that carries the side chat context always asks, whatever the mode, because the
 * user has not seen what the side chat does yet. After that, `auto` lets the calls run.
 */

export type PermissionMode = "ask" | "auto";

export const APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

/** What the model reads when the user says no. */
export const DENIED_REASON = "The user denied this call.";

export function needsApproval(toolName: string, mode: PermissionMode, contextRun: boolean): boolean {
  return APPROVAL_TOOL_NAMES.has(toolName) && (contextRun || mode === "ask");
}

export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === "ask" ? "auto" : "ask";
}

/** `edit` and `write` name the file as `path`; Pi-Bolt's replacements of these tools also accept `file_path`. */
export function toolCallPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** The part of a call that the user decides on: the command, or the file. */
export function describeToolCall(toolName: string, input: unknown): string {
  if (toolName === "bash" && typeof input === "object" && input !== null) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string") return compactText(command, 300);
  }
  return toolCallPath(input) ?? "";
}
