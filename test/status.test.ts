import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { approvalNote, MAX_WIDGET_ROWS, stateLabel, statusKey, widgetLines } from "../src/status.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

test("each state has a label, and an unread idle side chat has a new reply", () => {
  assert.deepEqual(stateLabel("approval", false), { text: "waits for approval", tone: "warning" });
  assert.equal(stateLabel("running", true).text, "running");
  assert.equal(stateLabel("starting", false).text, "starting");
  assert.equal(stateLabel("idle", false).text, "idle");
  assert.equal(stateLabel("idle", true).text, "new reply");
});

test("the widget lists each side chat with its state, and folds the rest", () => {
  const rows = Array.from({ length: MAX_WIDGET_ROWS + 2 }, (_, index) => ({
    title: `Chat ${index + 1}`,
    label: stateLabel(index === 0 ? "approval" : "idle", false),
  }));
  const lines = widgetLines(rows, plainTheme, 80);
  assert.equal(lines[0], `Side chats (${rows.length}) · /side to open`);
  assert.equal(lines[1], "  ◆ Chat 1 · waits for approval");
  assert.equal(lines.at(-1), "  +2 more");
  assert.equal(lines.length, MAX_WIDGET_ROWS + 2);
});

test("the widget key changes only when a title or a state changes", () => {
  const rows = [{ title: "A", label: stateLabel("running", false) }];
  assert.equal(statusKey(rows), statusKey([{ title: "A", label: stateLabel("running", false) }]));
  assert.notEqual(statusKey(rows), statusKey([{ title: "A", label: stateLabel("idle", true) }]));
});

test("the approval note tells how to answer", () => {
  assert.equal(approvalNote("Deploy"), 'Side chat "Deploy" waits for approval. Run /side to answer.');
});
