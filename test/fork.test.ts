import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySince, chooseForkPoint } from "../src/fork.ts";
import { assistant, text, user } from "./helpers.ts";

const branch = [user("one"), assistant([text("reply one")]), user("two"), assistant([text("reply two")])];
const ids = branch.map((entry) => entry.id);

test("an idle main thread forks at its leaf and inherits the whole branch", () => {
  const fork = chooseForkPoint(branch, ids[1] as string, true);
  assert.equal(fork.leafId, ids[3]);
  assert.deepEqual(fork.inherited.map((entry) => entry.id), ids);
});

test("a running main thread forks at the leaf of its last settled run", () => {
  const fork = chooseForkPoint(branch, ids[1] as string, false);
  assert.equal(fork.leafId, ids[1]);
  assert.deepEqual(fork.inherited.map((entry) => entry.id), ids.slice(0, 2));
  assert.deepEqual(activitySince(branch, fork.leafId).map((entry) => entry.id), ids.slice(2));
});

test("a running main thread without a settled leaf on the branch inherits nothing", () => {
  for (const stable of [null, "not-on-branch"]) {
    const fork = chooseForkPoint(branch, stable, false);
    assert.equal(fork.leafId, null);
    assert.deepEqual(fork.inherited, []);
    assert.deepEqual(activitySince(branch, fork.leafId).map((entry) => entry.id), ids);
  }
});

test("an empty main thread forks at nothing", () => {
  assert.deepEqual(chooseForkPoint([], null, true), { leafId: null, inherited: [] });
});

test("there is no activity when the fork leaf is not on the current branch", () => {
  assert.deepEqual(activitySince(branch, "elsewhere"), []);
});
