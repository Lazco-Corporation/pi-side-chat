import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  deleteStoredSideChat,
  findMarker,
  loadStoredSideChats,
  ORPHAN_GRACE_MS,
  parentSessionOf,
  removeOrphans,
  SIDE_CHAT_ENTRY_TYPE,
  sideChatsDirFor,
  storeSession,
} from "../src/store.ts";
import { assistant, text, user } from "./helpers.ts";

function chainEntries() {
  const first = user("inherited question");
  const second = assistant([text("inherited answer")]);
  (second as { parentId: string | null }).parentId = first.id;
  return [first, second];
}

function seed(id: string, parentSession: string | undefined, title = "Parser") {
  const manager = SessionManager.inMemory("/work", { id, ...(parentSession ? { parentSession } : {}) }, chainEntries());
  manager.appendCustomEntry(SIDE_CHAT_ENTRY_TYPE, { id, title, forkLeafId: "leaf" });
  return manager;
}

test("a stored side chat holds its inherited part, its marker, and what pi appends later", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "side-chat-")), "main-id");
  const stored = storeSession(seed("chat-1", "/work/main.jsonl"), dir);
  stored.appendMessage({ role: "user", content: "side question", timestamp: 1 });
  const path = join(dir, "chat-1.jsonl");
  assert.equal(stored.getSessionFile(), path);
  assert.equal(parentSessionOf(path), "/work/main.jsonl");

  const [loaded] = loadStoredSideChats(dir);
  assert.ok(loaded);
  assert.deepEqual(loaded.marker, { id: "chat-1", title: "Parser", forkLeafId: "leaf" });
  const messages = loaded.sessionManager.getBranch().filter((entry) => entry.type === "message");
  assert.equal(messages.length, 3);
  assert.equal(findMarker(loaded.sessionManager.getEntries())?.title, "Parser");
});

test("side chats load oldest first, and files that are not side chats are skipped", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "side-chat-")), "main-id");
  storeSession(seed("first", "/work/main.jsonl", "First"), dir);
  storeSession(seed("second", "/work/main.jsonl", "Second"), dir);
  writeFileSync(join(dir, "notes.txt"), "x");
  writeFileSync(join(dir, "broken.jsonl"), "not json\n");
  assert.deepEqual(
    loadStoredSideChats(dir).map((stored) => stored.marker.title),
    ["First", "Second"],
  );
  assert.deepEqual(loadStoredSideChats(join(dir, "missing")), []);
});

test("deleting the last side chat of a main session removes its folder", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "side-chat-")), "main-id");
  storeSession(seed("only", "/work/main.jsonl"), dir);
  deleteStoredSideChat(join(dir, "only.jsonl"));
  assert.equal(existsSync(dir), false);
});

test("orphans go once their main session file is gone for longer than the grace time", () => {
  const root = mkdtempSync(join(tmpdir(), "side-chat-root-"));
  const mainFile = join(root, "main.jsonl");
  writeFileSync(mainFile, "");
  const liveDir = sideChatsDirFor(root, "live");
  const goneDir = sideChatsDirFor(root, "gone");
  storeSession(seed("kept", mainFile), liveDir);
  storeSession(seed("orphan", join(root, "deleted.jsonl")), goneDir);
  storeSession(seed("fresh-orphan", join(root, "not-written-yet.jsonl")), goneDir);
  const old = (Date.now() - ORPHAN_GRACE_MS - 1_000) / 1_000;
  utimesSync(join(goneDir, "orphan.jsonl"), old, old);
  mkdirSync(join(root, "side-chats", "empty"));

  const removed = removeOrphans(join(root, "side-chats"));
  assert.deepEqual(removed, [join(goneDir, "orphan.jsonl")]);
  assert.deepEqual(readdirSync(goneDir), ["fresh-orphan.jsonl"]);
  assert.deepEqual(readdirSync(liveDir), ["kept.jsonl"]);
  assert.equal(existsSync(join(root, "side-chats", "empty")), false);
});
