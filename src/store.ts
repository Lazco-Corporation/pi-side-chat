import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Side chats on disk.
 *
 * Each side chat is a pi session file under `<agent dir>/side-chats/<main session id>/`.
 * The file starts as a copy of what the side chat inherited, so it opens without the main session,
 * and its header names the main session file. The file is written when the first message goes
 * out, so a side chat that never got one leaves nothing behind.
 */

export const SIDE_CHATS_DIR_NAME = "side-chats";
/** The custom entry that ends the inherited part of a side chat session. */
export const SIDE_CHAT_ENTRY_TYPE = "side-chat";
/**
 * Pi writes a new session file only after the first reply, so a side chat may briefly name a
 * main session file that does not exist yet. An orphan must be older than this to go.
 */
export const ORPHAN_GRACE_MS = 60 * 60 * 1_000;

export interface SideChatMarker {
  id: string;
  title: string;
  /** The newest main entry that the side chat inherited. Null when it inherited nothing. */
  forkLeafId: string | null;
}

export interface StoredSideChat {
  path: string;
  marker: SideChatMarker;
  sessionManager: SessionManager;
}

export function sideChatsRoot(agentDir: string): string {
  return join(agentDir, SIDE_CHATS_DIR_NAME);
}

export function sideChatsDirFor(agentDir: string, mainSessionId: string): string {
  return join(sideChatsRoot(agentDir), mainSessionId);
}

export function findMarker(entries: readonly SessionEntry[]): SideChatMarker | undefined {
  const entry = entries.find((candidate) => candidate.type === "custom" && candidate.customType === SIDE_CHAT_ENTRY_TYPE);
  if (entry?.type !== "custom") return undefined;
  const data = entry.data as Partial<SideChatMarker> | undefined;
  if (typeof data?.id !== "string" || typeof data.title !== "string") return undefined;
  return { id: data.id, title: data.title, forkLeafId: typeof data.forkLeafId === "string" ? data.forkLeafId : null };
}

/** Writes a seeded in-memory session to its file and opens it there, so pi appends to the file from then on. */
export function storeSession(seed: SessionManager, dir: string): SessionManager {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${seed.getSessionId()}.jsonl`);
  const lines = [seed.getHeader(), ...seed.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(path, `${lines.join("\n")}\n`, { flag: "wx" });
  return SessionManager.open(path, dir);
}

/** The side chats of one main session, oldest first. A file that is not a side chat is skipped. */
export function loadStoredSideChats(dir: string): StoredSideChat[] {
  if (!existsSync(dir)) return [];
  const stored: Array<StoredSideChat & { mtime: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const sessionManager = SessionManager.open(path, dir);
      const marker = findMarker(sessionManager.getEntries());
      if (marker) stored.push({ path, marker, sessionManager, mtime: statSync(path).birthtimeMs });
    } catch {
      // A file that pi cannot read is not ours to fix.
    }
  }
  return stored.sort((left, right) => left.mtime - right.mtime).map(({ mtime: _mtime, ...rest }) => rest);
}

export function deleteStoredSideChat(path: string): void {
  rmSync(path, { force: true });
  removeIfEmpty(join(path, ".."));
}

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Gone already, or not empty after all.
  }
}

/** The main session file that a side chat file names in its header, or undefined. */
export function parentSessionOf(path: string): string | undefined {
  const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  try {
    const header = JSON.parse(firstLine) as { type?: string; parentSession?: unknown };
    return header.type === "session" && typeof header.parentSession === "string" ? header.parentSession : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deletes the side chat files whose main session file is gone, and the folders that end up empty.
 * Returns the deleted files.
 */
export function removeOrphans(root: string, now: number = Date.now()): string[] {
  if (!existsSync(root)) return [];
  const removed: string[] = [];
  for (const dirName of readdirSync(root)) {
    const dir = join(root, dirName);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const parent = parentSessionOf(path);
      if (parent === undefined || existsSync(parent)) continue;
      if (now - statSync(path).mtimeMs < ORPHAN_GRACE_MS) continue;
      rmSync(path, { force: true });
      removed.push(path);
    }
    removeIfEmpty(dir);
  }
  return removed;
}
