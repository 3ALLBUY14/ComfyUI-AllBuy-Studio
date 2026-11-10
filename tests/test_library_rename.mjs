import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/videoprompt_library.js", import.meta.url), "utf8");
const rename = source.slice(source.indexOf("  async function renameLibrary()"), source.indexOf("  async function createLibrary()"));
const locator = { source: "user", name: "stable-key" };
async function run(input, sourceName = "user", succeeds = true) {
  const state = { locator: { ...locator, source: sourceName }, libraryData: { name: "Old", groups: [{ id: "a" }] },
    selectedIds: ["a"], unselectedIds: ["b", "a"] };
  const requests = [], messages = [], refreshes = [];
  let syncs = 0;
  const context = vm.createContext({ state, prompt: () => input, alert: message => messages.push(message),
    libraryKey: value => JSON.stringify([value.source, value.name, value.path]),
    apiPost: async (path, body) => { requests.push({ path, body }); return { ok: succeeds, display_name: body.name, error: "duplicate" }; },
    syncWidgets: () => syncs++, _activeLibControllers: new Set([
      { refresh: () => refreshes.push("current") }, { refresh: () => refreshes.push("sibling") },
    ]) });
  vm.runInContext(rename, context);
  await vm.runInContext("renameLibrary()", context);
  assert.deepEqual(state.selectedIds, ["a"]);
  assert.deepEqual(state.unselectedIds, ["b", "a"]);
  assert.equal(state.locator.name, "stable-key");
  return { state, requests, messages, refreshes, syncs };
}
const renamed = await run("  New  ");
assert.equal(renamed.requests[0].path, "/library/rename");
assert.equal(renamed.requests[0].body.name, "New");
assert.equal(renamed.state.libraryData.name, "New");
assert.deepEqual(renamed.refreshes, ["current", "sibling"]);
assert.equal(renamed.syncs, 1);
for (const input of [null, "Old", "   "]) assert.equal((await run(input)).requests.length, 0);
assert.equal((await run("New", "builtin")).requests.length, 0);
const failed = await run("New", "user", false);
assert.equal(failed.state.libraryData.name, "Old");
assert.equal(failed.refreshes.length, 0);
assert.equal(failed.messages.length, 1);
console.log("Rename preserves references, selections and ordering; failures leave state intact");
