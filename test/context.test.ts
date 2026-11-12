import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSideChatContext,
  compactText,
  DIGEST_ITEM_MAX_CHARS,
  digestActivity,
  digestLines,
  MAIN_THREAD_READ_TOOL_NAME,
  SIDE_CHAT_CONTEXT_MAX_CHARS,
} from "../src/context.ts";
import { assistant, messageEntry, text, toolCall, toolResult, user } from "./helpers.ts";

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

test("the digest keeps what was said, the commands, and the changed files", () => {
  const entries = [
    user("Fix   the\nparser"),
    assistant([
      { type: "thinking", thinking: "hidden" },
      text("Running the tests."),
      toolCall("1", "bash", { command: "npm test" }),
      toolCall("2", "edit", { path: "src/parser.ts" }),
      toolCall("3", "write", { file_path: "src/new.ts" }),
      toolCall("4", "read", { path: "src/other.ts" }),
    ]),
    toolResult("1", "42 passing"),
    messageEntry({ role: "bashExecution", command: "git status", output: "" }),
  ];
  assert.deepEqual(entries.flatMap(digestLines), [
    "- User: Fix the parser",
    "- Assistant: Running the tests.",
    "- Command: npm test",
    "- File change: src/parser.ts",
    "- File change: src/new.ts",
    "- Command: git status",
  ]);
});

test("a long digest item keeps its start", () => {
  const long = "x".repeat(DIGEST_ITEM_MAX_CHARS + 50);
  assert.equal(compactText(long).length, DIGEST_ITEM_MAX_CHARS);
  assert.ok(compactText(long).endsWith("…"));
});

test("the digest keeps the newest lines that fit", () => {
  const entries = Array.from({ length: 10 }, (_, index) => user(`message ${index}`));
  const digest = digestActivity(entries, 54);
  assert.equal(digest.truncated, true);
  assert.deepEqual(digest.lines, ["- User: message 7", "- User: message 8", "- User: message 9"]);
  assert.equal(digestActivity(entries.slice(0, 2), 1_000).truncated, false);
});

test("the context frames the side chat and lists its tools even without activity", () => {
  const context = buildSideChatContext({ activity: [], toolNames: TOOLS });
  assert.match(context, /^This is a side chat beside the main thread\./);
  assert.match(context, /only these tools: read, bash, edit, write, grep, find, ls\./);
  assert.doesNotMatch(context, /Main thread activity/);
  assert.doesNotMatch(context, new RegExp(MAIN_THREAD_READ_TOOL_NAME));
});

test("the context shows the main activity and points to main_thread_read when the side chat has it", () => {
  const context = buildSideChatContext({
    activity: [user("Deploy it"), assistant([toolCall("1", "bash", { command: "make deploy" })])],
    toolNames: [...TOOLS, MAIN_THREAD_READ_TOOL_NAME],
  });
  assert.match(context, /Main thread activity since this side chat's starting point:\n- User: Deploy it\n- Command: make deploy/);
  assert.match(context, /Use main_thread_read to see the main thread's live state\.$/);
});

test("the whole context stays under its cap, and says when older activity is cut", () => {
  const activity = Array.from({ length: 200 }, (_, index) => user(`${index} ${"word ".repeat(40)}`));
  const context = buildSideChatContext({ activity, toolNames: [...TOOLS, MAIN_THREAD_READ_TOOL_NAME] });
  assert.ok(context.length <= SIDE_CHAT_CONTEXT_MAX_CHARS, `${context.length}`);
  assert.match(context, /- Earlier items truncated\./);
  assert.match(context, /- User: 199 /);
});
