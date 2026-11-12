import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { toolCallPath } from "./approval.ts";

/**
 * What the main agent learns about the files that a side chat changed.
 *
 * Only `edit` and `write` are tracked, because their arguments name the file. A file that a side
 * chat changed is stale for the main agent until it reads the file again, so the main agent's first
 * `edit` or `write` of it is stopped with a reason; a `write` from an old copy would undo the change.
 */

export const CHANGE_TOOL_NAMES: ReadonlySet<string> = new Set(["edit", "write"]);
export const CHANGES_MESSAGE_TYPE = "side-chat-changes";

export interface ChangeSource {
  sideChatId: string;
  title: string;
}

/** The absolute path of a tool's file argument, resolved the way pi's tools resolve it. */
export function resolveToolPath(cwd: string, input: unknown): string | undefined {
  const raw = toolCallPath(input);
  if (raw === undefined) return undefined;
  const withoutAt = raw.startsWith("@") ? raw.slice(1) : raw;
  const expanded = withoutAt === "~" ? homedir() : withoutAt.startsWith("~/") ? resolve(homedir(), withoutAt.slice(2)) : withoutAt;
  return resolve(cwd, expanded);
}

/** A path inside the working directory reads relative to it; others stay absolute. */
export function displayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !isAbsolute(relativePath) ? relativePath : absolutePath;
}

export class ChangeTracker {
  /** Files that the main agent has not read since a side chat changed them. */
  private readonly stale = new Map<string, ChangeSource>();

  record(absolutePath: string, source: ChangeSource): void {
    this.stale.set(absolutePath, source);
  }

  /** The side chat that changed the file, when the main agent has not read it since. The mark goes. */
  take(absolutePath: string): ChangeSource | undefined {
    const source = this.stale.get(absolutePath);
    this.stale.delete(absolutePath);
    return source;
  }

  /** The main agent read the file, so it holds the side chat's change now. */
  clear(absolutePath: string): void {
    this.stale.delete(absolutePath);
  }

  forgetSideChat(sideChatId: string): void {
    for (const [path, source] of this.stale) if (source.sideChatId === sideChatId) this.stale.delete(path);
  }

  get size(): number {
    return this.stale.size;
  }
}

export function staleFileReason(path: string, source: ChangeSource): string {
  return `${path} was changed by side chat "${source.title}". Read it again before you change it.`;
}

export function changeNotification(title: string, paths: readonly string[]): string {
  return [
    `Side chat "${title}" changed files in the working directory: ${paths.join(", ")}.`,
    "Its conversation is not included. Read these files again before you rely on them or commit them.",
  ].join("\n");
}
