import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelKey, nextThinkingLevel } from "../src/modelPicker.ts";

function model(reasoning: boolean, thinkingLevelMap?: Record<string, string | null>): Model<Api> {
  return { provider: "acme", id: "fast-1", reasoning, thinkingLevelMap } as unknown as Model<Api>;
}

test("a model reads as provider/id", () => {
  assert.equal(modelKey(model(false)), "acme/fast-1");
});

test("t steps through the levels that the model supports and wraps around", () => {
  const thinking = model(true);
  assert.equal(nextThinkingLevel(thinking, "off"), "minimal");
  assert.equal(nextThinkingLevel(thinking, "medium"), "high");
  assert.equal(nextThinkingLevel(thinking, "high"), "off");
  assert.equal(nextThinkingLevel(thinking, undefined), "off");
});

test("a model without thinking stays off, and an unsupported level is skipped", () => {
  assert.equal(nextThinkingLevel(model(false), "off"), "off");
  assert.equal(nextThinkingLevel(model(true, { minimal: null }), "off"), "low");
});
