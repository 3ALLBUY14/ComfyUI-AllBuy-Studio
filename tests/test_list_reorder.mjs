import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reorderIds } from "../web/list_reorder.js";

const ids = ["a", "hidden", "b", "c", "d"];
assert.deepEqual(reorderIds(ids, "a", "c"), ["hidden", "b", "a", "c", "d"]);
assert.deepEqual(reorderIds(ids, "a", "c", true), ["hidden", "b", "c", "a", "d"]);
assert.deepEqual(reorderIds(ids, "d", "b"), ["a", "hidden", "d", "b", "c"]);
assert.deepEqual(reorderIds(ids, "d", "b", true), ["a", "hidden", "b", "d", "c"]);
assert.deepEqual(reorderIds(ids, "a", "d", true), ["hidden", "b", "c", "d", "a"]);
assert.deepEqual(reorderIds(ids, "d", "a"), ["d", "a", "hidden", "b", "c"]);
assert.deepEqual(reorderIds(ids, "missing", "b"), ids);
assert.deepEqual(reorderIds(ids, "a", "a"), ids);
assert.deepEqual(ids, ["a", "hidden", "b", "c", "d"]);

// Check the real controller operations, including selected output order and categories.
const source = readFileSync(new URL("../web/videoprompt_library.js", import.meta.url), "utf8");
const calls = [];
const state = {
  unselectedIds: ["a", "b", "c", "d"], selectedIds: ["a", "c"],
  libraryData: { groups: [
    { id: "a", categories: ["old"] }, { id: "c", categories: ["target"] },
  ] },
};
const context = vm.createContext({
  state, reorderIds, groupCats: (group) => group.categories || [], readonlyBlock: () => false,
  syncWidgets: () => calls.push("sync"), renderList: () => calls.push("render"),
  saveLibrary: async () => {
    assert.deepEqual(calls, ["sync", "render"], "Cross-category placement is visible before saving");
    calls.push("save");
  },
});
const moveStart = source.indexOf("  function moveItem(");
vm.runInContext(source.slice(moveStart, source.indexOf("  function groupCats(", moveStart)), context);
vm.runInContext('moveItem("a", "c", true)', context);
assert.deepEqual(state.unselectedIds, ["b", "c", "a", "d"]);
assert.deepEqual(state.selectedIds, ["c", "a"]);
calls.length = 0;
state.unselectedIds = ["a", "b", "c", "d"];
const crossStart = source.indexOf("  async function moveCrossGroup(");
vm.runInContext(source.slice(crossStart, source.indexOf("  // v3.28：批量操作条渲染", crossStart)), context);
await vm.runInContext('moveCrossGroup("a", "c", true)', context);
assert.deepEqual(state.unselectedIds, ["b", "c", "a", "d"]);
assert.deepEqual(state.selectedIds, ["c", "a"]);
assert.deepEqual(Array.from(state.libraryData.groups[0].categories), ["target"]);
assert.deepEqual(calls, ["sync", "render", "save"]);
console.log("Exact before/after placement, filtered IDs and controller persistence checks passed");
