import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { ChangeTracker, changeNotification, displayPath, resolveToolPath, staleFileReason } from "../src/changes.ts";
import { renderMainThreadState } from "../src/mainThreadRead.ts";
import { assistant, text, toolCall, user } from "./helpers.ts";

const source = { sideChatId: "s1", title: "Fix the parser" };

test("tool paths resolve like pi's tools: relative, absolute, ~, and @", () => {
  assert.equal(resolveToolPath("/work", { path: "src/a.ts" }), "/work/src/a.ts");
  assert.equal(resolveToolPath("/work", { file_path: "/etc/hosts" }), "/etc/hosts");
  assert.equal(resolveToolPath("/work", { path: "~/notes.md" }), `${homedir()}/notes.md`);
  assert.equal(resolveToolPath("/work", { path: "@src/b.ts" }), "/work/src/b.ts");
  assert.equal(resolveToolPath("/work", {}), undefined);
});

test("paths inside the working directory show relative to it", () => {
  assert.equal(displayPath("/work", "/work/src/a.ts"), "src/a.ts");
  assert.equal(displayPath("/work", "/other/a.ts"), "/other/a.ts");
});

test("a changed file stops the main agent's write once", () => {
  const tracker = new ChangeTracker();
  tracker.record("/work/a.ts", source);
  assert.deepEqual(tracker.take("/work/a.ts"), source);
  assert.equal(tracker.take("/work/a.ts"), undefined);
});

test("a read by the main agent clears the mark", () => {
  const tracker = new ChangeTracker();
  tracker.record("/work/a.ts", source);
  tracker.clear("/work/a.ts");
  assert.equal(tracker.take("/work/a.ts"), undefined);
});

test("deleting a side chat forgets only its marks", () => {
  const tracker = new ChangeTracker();
  tracker.record("/work/a.ts", source);
  tracker.record("/work/b.ts", { sideChatId: "s2", title: "Other" });
  tracker.forgetSideChat("s1");
  assert.equal(tracker.size, 1);
  assert.equal(tracker.take("/work/b.ts")?.sideChatId, "s2");
});

test("the reason and the notification name the side chat and the files", () => {
  assert.equal(
    staleFileReason("src/a.ts", source),
    'src/a.ts was changed by side chat "Fix the parser". Read it again before you change it.',
  );
  assert.equal(
    changeNotification("Fix the parser", ["src/a.ts", "src/b.ts"]),
    'Side chat "Fix the parser" changed files in the working directory: src/a.ts, src/b.ts.\nIts conversation is not included. Read these files again before you rely on them or commit them.',
  );
});

test("main_thread_read reports the state and the activity", () => {
  const busy = renderMainThreadState(
    { running: true, activity: [user("Deploy"), assistant([text("Deploying."), toolCall("1", "bash", { command: "make deploy" })])] },
    8_000,
  );
  assert.equal(
    busy,
    "The main thread is running now.\nMain thread activity since this side chat's starting point:\n- User: Deploy\n- Assistant: Deploying.\n- Command: make deploy",
  );
  assert.equal(
    renderMainThreadState({ running: false, activity: [] }, 8_000),
    "The main thread is idle now.\nThe main thread did nothing after this side chat's starting point.",
  );
});
