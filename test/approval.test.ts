import assert from "node:assert/strict";
import { test } from "node:test";
import { describeToolCall, needsApproval, nextPermissionMode, toolCallPath } from "../src/approval.ts";

test("the context run asks before every change, whatever the mode", () => {
  for (const tool of ["bash", "edit", "write"]) {
    assert.equal(needsApproval(tool, "auto", true), true);
    assert.equal(needsApproval(tool, "ask", true), true);
  }
});

test("after the context run, ask mode asks and auto mode does not", () => {
  assert.equal(needsApproval("edit", "ask", false), true);
  assert.equal(needsApproval("edit", "auto", false), false);
});

test("reading tools never ask", () => {
  for (const tool of ["read", "grep", "find", "ls", "main_thread_read"]) {
    assert.equal(needsApproval(tool, "ask", true), false);
  }
});

test("the mode toggles between ask and auto", () => {
  assert.equal(nextPermissionMode("ask"), "auto");
  assert.equal(nextPermissionMode("auto"), "ask");
});

test("a call names its file as path or file_path", () => {
  assert.equal(toolCallPath({ path: "a.ts" }), "a.ts");
  assert.equal(toolCallPath({ file_path: "b.ts" }), "b.ts");
  assert.equal(toolCallPath({ path: "" }), undefined);
  assert.equal(toolCallPath(undefined), undefined);
});

test("the approval shows the command or the file", () => {
  assert.equal(describeToolCall("bash", { command: "rm -rf build\n&& make" }), "rm -rf build && make");
  assert.equal(describeToolCall("write", { path: "src/a.ts", content: "x" }), "src/a.ts");
});
