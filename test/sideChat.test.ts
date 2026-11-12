import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { SideChat } from "../src/sideChat.ts";

function model(id: string, reasoning: boolean): Model<Api> {
  return { provider: "acme", id, reasoning } as unknown as Model<Api>;
}

function draftSideChat(authorized: (model: Model<Api>) => boolean): SideChat {
  return new SideChat({
    fork: { leafId: null, inherited: [] },
    main: {
      cwd: "/work",
      sessionFile: undefined,
      modelRegistry: { hasConfiguredAuth: authorized } as unknown as ModelRegistry,
      branch: () => [],
      isIdle: () => true,
      systemPrompt: () => "",
    },
    model: model("start", true),
    thinkingLevel: "high",
    hooks: { fileChanged: () => {}, runChangedFiles: () => {} },
  });
}

test("a draft side chat takes a new model and keeps its thinking level where it can", async () => {
  const sideChat = draftSideChat(() => true);
  await sideChat.setModel(model("plain", false));
  assert.equal(sideChat.model?.id, "plain");
  assert.equal(sideChat.thinkingLevel, "off");
  await sideChat.setModel(model("thinker", true));
  assert.equal(sideChat.thinkingLevel, "off");
  assert.equal(sideChat.cycleThinkingLevel(), "minimal");
  assert.equal(sideChat.thinkingLevel, "minimal");
});

test("a model without a key or login is refused, and the old model stays", async () => {
  const sideChat = draftSideChat((candidate) => candidate.id !== "locked");
  await assert.rejects(sideChat.setModel(model("locked", true)), /No API key or login for acme\/locked\./);
  assert.equal(sideChat.model?.id, "start");
  assert.equal(sideChat.thinkingLevel, "high");
});

test("a draft side chat has no messages, and asks in its mode until switched", () => {
  const sideChat = draftSideChat(() => true);
  assert.equal(sideChat.state, "draft");
  assert.equal(sideChat.hasMessages, false);
  assert.equal(sideChat.mode, "ask");
  sideChat.togglePermissionMode();
  assert.equal(sideChat.mode, "auto");
});
