import assert from "node:assert/strict";
import { test } from "node:test";
import { DENIED_REASON } from "../src/approval.ts";
import { titleFromQuestion } from "../src/sideChat.ts";
import { lastAssistantText, transcriptFromEntries } from "../src/transcript.ts";
import { assistant, customEntry, text, toolCall, toolResult, user } from "./helpers.ts";

test("the transcript shows the questions, the replies, and each call with its outcome", () => {
  const entries = [
    user("Check the build"),
    customEntry("side-chat-context"),
    assistant([text("Looking."), toolCall("1", "bash", { command: "make" }), toolCall("2", "write", { path: "a.ts" })]),
    toolResult("1", "make: *** error", true),
    toolResult("2", DENIED_REASON, true),
    assistant([text("The build fails.")]),
  ];
  const items = transcriptFromEntries(entries, false);
  assert.deepEqual(
    items.map((item) => (item.kind === "tool" ? `${item.kind}:${item.toolName}:${item.status}` : item.kind)),
    ["user", "assistant", "tool:bash:error", "tool:write:denied", "assistant"],
  );
  const failed = items[2];
  assert.equal(failed?.kind === "tool" ? failed.error : undefined, "make: *** error");
  assert.equal(lastAssistantText(items), "The build fails.");
});

test("a call without a result runs while the side chat runs, and is stopped after", () => {
  const entries = [user("go"), assistant([toolCall("1", "bash", { command: "sleep 9" })])];
  const running = transcriptFromEntries(entries, true)[1];
  const stopped = transcriptFromEntries(entries, false)[1];
  assert.equal(running?.kind === "tool" ? running.status : undefined, "running");
  assert.equal(stopped?.kind === "tool" ? stopped.status : undefined, "interrupted");
});

test("a failed or stopped reply shows why", () => {
  const items = transcriptFromEntries(
    [assistant([], { stopReason: "error", errorMessage: "rate limited" }), assistant([text("part")], { stopReason: "aborted" })],
    false,
  );
  assert.deepEqual(
    items.map((item) => item.kind),
    ["error", "assistant", "stopped"],
  );
  assert.equal(items[0]?.kind === "error" ? items[0].text : undefined, "rate limited");
});

test("the title is the first line of the first question, cut short", () => {
  assert.equal(titleFromQuestion("  What is\nthis?"), "What is");
  assert.equal(titleFromQuestion(""), "Side chat");
  const long = titleFromQuestion("a".repeat(100));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});
