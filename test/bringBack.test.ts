import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRING_BACK_ITEM_MAX_CHARS,
  BRING_BACK_MAX_CHARS,
  bringBackBlockedReason,
  hasFinishedReply,
  renderBringBack,
} from "../src/bringBack.ts";
import { assistant, customEntry, text, toolCall, toolResult, user } from "./helpers.ts";

const ready = {
  sideChatId: "s1",
  mainIsIdle: true,
  mainHasQueuedMessages: false,
  sideChatBusy: false,
  hasFinishedReply: true,
  pending: undefined,
};

test("Bring back is available when both threads are idle and the side chat has a finished reply", () => {
  assert.equal(bringBackBlockedReason(ready), null);
});

test("Bring back says why it is not available", () => {
  assert.equal(bringBackBlockedReason({ ...ready, mainIsIdle: false }), "Available when the main thread is idle.");
  assert.equal(bringBackBlockedReason({ ...ready, mainHasQueuedMessages: true }), "Available when the main thread is idle.");
  assert.equal(bringBackBlockedReason({ ...ready, sideChatBusy: true }), "Available when the side chat is idle.");
  assert.equal(bringBackBlockedReason({ ...ready, hasFinishedReply: false }), "Available after a finished reply.");
});

test("only one side chat waits to go back, and the same one may replace its note", () => {
  const pending = { sideChatId: "s2", title: "Other", text: "" };
  assert.match(bringBackBlockedReason({ ...ready, pending }) ?? "", /^Side chat "Other" already waits to go back\./);
  assert.equal(bringBackBlockedReason({ ...ready, pending: { ...pending, sideChatId: "s1" } }), null);
});

test("a finished reply is a newest assistant message that stopped normally", () => {
  assert.equal(hasFinishedReply([user("q"), assistant([text("a")])]), true);
  assert.equal(hasFinishedReply([user("q"), assistant([text("a")], { stopReason: "aborted" })]), false);
  assert.equal(hasFinishedReply([user("q")]), false);
  assert.equal(hasFinishedReply([assistant([text("a")]), user("q"), customEntry("x")]), true);
});

test("the note holds the questions and replies in full, and the calls as one line", () => {
  const note = renderBringBack("Parser", [
    user("Why does it fail?"),
    assistant([text("Line one\nLine two"), toolCall("1", "bash", { command: "npm test" }), toolCall("2", "edit", { path: "a.ts" })]),
    toolResult("1", "fail"),
  ]);
  assert.equal(
    note,
    [
      'Context brought back from side chat "Parser".',
      "The user asked these questions beside the main thread. Use what is relevant to the next message.",
      "",
      "Side chat delta:",
      "- User: Why does it fail?",
      "- Assistant: Line one",
      "  Line two",
      "- Command: npm test",
      "- File change: a.ts",
    ].join("\n"),
  );
});

test("the note cuts long messages and keeps the newest part under its cap", () => {
  const entries = Array.from({ length: 20 }, (_, index) => user(`${index} ${"x".repeat(BRING_BACK_ITEM_MAX_CHARS)}`));
  const note = renderBringBack("Long", entries);
  assert.ok(note.length <= BRING_BACK_MAX_CHARS, `${note.length}`);
  assert.match(note, /- Earlier items truncated\./);
  assert.match(note, /- User: 19 x/);
  assert.doesNotMatch(note, /- User: 0 x/);
});
