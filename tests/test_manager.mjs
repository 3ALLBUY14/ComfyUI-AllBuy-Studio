import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/manager_data.js", import.meta.url), "utf8");
const rules = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const tabSource = readFileSync(new URL("../web/manager_workflow_tabs.js", import.meta.url), "utf8");
const { saveAndCloseWorkflowTabs } = await import("data:text/javascript;base64," + Buffer.from(tabSource).toString("base64"));
{
  const events = [], one = { path: "workflows/a.json", isModified: true, changeTracker: { prepareForSave() { events.push("prepare:a"); } } }, two = { path: "workflows/b.json", isModified: true };
  const store = { openWorkflows: [one, two], activeWorkflow: one, async saveWorkflow(file) { events.push("save:" + file.path); file.isModified = false; }, async closeWorkflow(file) { events.push("close:" + file.path); this.openWorkflows = this.openWorkflows.filter(value => value !== file); } };
  const app = { extensionManager: { workflow: store }, async loadGraphData(data) { events.push("load"); assert.deepEqual(data.nodes, []); } };
  assert.equal(await saveAndCloseWorkflowTabs(app, [{ path: "a.json" }, { path: "b.json" }]), 2);
  assert.ok(events.indexOf("save:workflows/b.json") < events.indexOf("close:workflows/a.json"), "Save every draft before closing any tabs");
  assert.ok(events.indexOf("load") < events.indexOf("close:workflows/a.json"), "Switch active canvas before unloading its tracker");
  store.openWorkflows = [one, two]; store.saveWorkflow = async file => { if (file === two) throw new Error("disk full"); };
  await assert.rejects(saveAndCloseWorkflowTabs(app, [{ path: "a.json" }, { path: "b.json" }]), /disk full/);
  assert.equal(store.openWorkflows.length, 2, "Save failures keep every tab open");
  store.saveWorkflow = async () => false;
  await assert.rejects(saveAndCloseWorkflowTabs(app, [{ path: "a.json" }]), /未能保存/);
  store.saveWorkflow = async () => {}; app.loadGraphData = async () => false;
  await assert.rejects(saveAndCloseWorkflowTabs(app, [{ path: "a.json" }, { path: "b.json" }]), /切换画布失败/);
  assert.equal(store.openWorkflows.length, 2);
}
const mediaSource = readFileSync(new URL("../web/manager_media.js", import.meta.url), "utf8");
const media = await import("data:text/javascript;base64," + Buffer.from(mediaSource).toString("base64"));
assert.equal(media.previewFileKind({ name: "portrait.PNG" }), "image");
assert.equal(media.previewFileKind({ name: "motion.MP4" }), "video");
assert.equal(media.previewFileKind({ name: "model.safetensors" }), null);
const bothMedia = media.promptMedia({ cover: "image.png", coverVideo: "motion.mp4" });
assert.ok(bothMedia.video.poster.endsWith("motion.mp4"), "Video poster must come from its own frame, not the hidden bound image");
const { filterManagerItems: filter, validatePresetEntries: validate, promptApplication, appendUniqueEntries, modelKey } = rules;
{
  const items = ["a", "b", "c"].map(name => ({ name, id: name }));
  const catalog = { models: { a: ["画风", "人物"], b: ["画风"], c: ["工具"] }, model_info: { a: { base_model: "Flux", version: "v2" }, b: { base_model: "SDXL", version: "v1" } } };
  assert.deepEqual(filter(items, { tab: "loras", catalog, advanced: { bases: ["Flux"], version: "V2" } }).map(item => item.name), ["a"]);
  assert.equal(filter(items, { tab: "loras", catalog, query: "SDXL" })[0].name, "b");
  assert.deepEqual(filter(items, { tab: "loras", catalog, advanced: { includeTags: ["画风", "人物"], tagMode: "all" } }).map(item => item.name), ["a"]);
  assert.deepEqual(filter(items, { tab: "loras", catalog, advanced: { includeTags: ["画风"], excludeTags: ["人物"] } }).map(item => item.name), ["b"]);
  assert.deepEqual(filter(items, { tab: "loras", catalog, advanced: { bases: [""] } }).map(item => item.name), ["c"]);
  assert.equal(rules.normalizeLoraFilterPresets([{ id: "a", name: "One" }, { id: "a", name: "duplicate" }, { name: "invalid" }]).length, 1);
  assert.equal(rules.normalizeLoraFilters(null).tagMode, "any");
}
{
  const catalog = { content_ratings: { a: "nsfw", b: "sfw" }, recommendations: { b: { content: { rating: "nsfw" } } } };
  const items = ["a", "b", "c"].map(name => ({ id: name, name }));
  assert.deepEqual(rules.managerContentPreferences(null), { mode: "blur", includeUnknown: false });
  assert.equal(rules.modelContent("b", catalog).rating, "sfw", "Manual label overrides source metadata");
  assert.deepEqual(filter(items, { tab: "loras", catalog, content: { mode: "hide" } }).map(item => item.name), ["b", "c"]);
  assert.deepEqual(filter(items, { tab: "loras", catalog, content: { mode: "hide", includeUnknown: true } }).map(item => item.name), ["b"]);
  assert.equal(filter(items, { tab: "loras", catalog, filter: "content:nsfw" }).length, 1);
  assert.equal(filter(items, { tab: "loras", catalog, query: "a", content: { mode: "hide" } }).length, 0, "Search cannot bypass hidden content");
  assert.equal(filter(items, { tab: "loras", catalog, groups: [{ id: "g", loras: ["a"] }], filter: "group:g", content: { mode: "hide" } }).length, 0);
}
assert.deepEqual(rules.managerAppearance(), { scale: 100, fontSize: 13 });
assert.deepEqual(rules.managerAppearance({ scale: 120, fontSize: 16 }), { scale: 120, fontSize: 16 });
assert.deepEqual(rules.managerAppearance({ scale: 900, fontSize: -2 }), { scale: 140, fontSize: 11 });
assert.deepEqual(rules.managerAppearance({ scale: "broken", fontSize: null }), { scale: 100, fontSize: 13 });
assert.deepEqual(rules.managerVisualPreferences(), { theme: "dark", launcherStyle: "glass" });
assert.deepEqual(rules.managerVisualPreferences({ theme: "light", launcherStyle: "native" }), { theme: "light", launcherStyle: "native" });
assert.deepEqual(rules.managerVisualPreferences({ theme: "broken", launcherStyle: null }), { theme: "dark", launcherStyle: "glass" });
const library = { source: "user", name: "shared" };
const prompts = [{ id: "a", name: "镜头 10", categories: ["电影"], tags: ["光影"], positive: "slow dolly", star: true },
  { id: "b", name: "镜头 2", category: "人像", negative: "blurry", tags: [] }];
const snapshot = structuredClone(prompts);
assert.deepEqual(filter(prompts, { tab: "prompts", query: " DOLLY " }).map(item => item.id), ["a"]);
assert.deepEqual(filter(prompts, { tab: "prompts", filter: "category:人像" }).map(item => item.id), ["b"]);
assert.deepEqual(filter(prompts, { tab: "prompts", filter: "favorite" }).map(item => item.id), ["a"]);
assert.deepEqual(filter(prompts, { tab: "prompts", sort: "name" }).map(item => item.id), ["b", "a"]);
assert.deepEqual(prompts, snapshot, "Filtering and sorting must not alter stored library order");
const models = [{ id: "x", name: "portraits\\model.safetensors" }, { id: "y", name: "style.safetensors" }];
const classification = { tab: "loras", catalog: { models: { "portraits/model.safetensors": ["人物"] } }, groups: [{ id: "g", name: "我的收藏", loras: ["portraits/model.safetensors"] }] };
for (const value of ["favorite", "tag:人物", "group:g", "folder:portraits"]) assert.deepEqual(filter(models, { ...classification, filter: value }).map(item => item.id), ["x"]);
assert.equal(modelKey(models[0].name), "portraits/model.safetensors");
const current = [{ id: "old", name: "portraits\\model.safetensors", weight: .4, trigger: "keep" }];
const additions = [{ name: "portraits/model.safetensors", weight: .9 }, { name: "style.safetensors", weight: .8 }, { name: "style.safetensors", weight: .7 }];
const merged = appendUniqueEntries(current, additions);
assert.equal(merged.length, 2); assert.equal(merged[0], current[0]); assert.equal(merged[1].weight, .8);
assert.equal(current.length, 1, "Appending does not mutate existing entries");
assert.equal(validate([{ name: models[0].name, weight: 0, min: -3, max: 3 }], ["portraits/model.safetensors"])[0].weight, 0);
for (const entries of [[], [{ name: "None" }], [{ name: "x", weight: "" }], [{ name: "x", weight: Infinity }], [{ name: "x", min: 2, max: 1 }], [{ name: "x", weight: 4 }]]) assert.throws(() => validate(entries));
assert.throws(() => validate([{ name: "missing.safetensors" }], [models[0].name]), /不存在/);
const state = { locator: library, selectedIds: ["a"], unselectedIds: ["b", "a", "deleted"] };
assert.deepEqual(promptApplication(state, library, prompts, ["b"], true), { selectedIds: ["b", "a"], unselectedIds: ["b", "a"] });
assert.deepEqual(promptApplication(state, { source: "builtin", name: "shared" }, prompts, ["b"], true), { selectedIds: ["b"], unselectedIds: ["a", "b"] });
assert.deepEqual(promptApplication(state, library, prompts, ["b", "missing"], false).selectedIds, ["b"]);

// Execute the actual node adapters, including getter-only state and hidden-widget persistence.
const promptSource = readFileSync(new URL("../web/videoprompt_library.js", import.meta.url), "utf8");
const start = promptSource.indexOf("  node._allbuyManagerApply = async");
const adapter = promptSource.slice(start, promptSource.indexOf("\n  };", start) + 5);
const node = { graph: { change() {} } };
let writes = 0, renders = 0;
const controller = { ...structuredClone(state), get readonly() { return this.locator.source === "builtin"; }, get inline() { return this.locator.source === "inline"; } };
const context = { node, state: controller, promptApplication, els: {}, apiGet: async () => ({ ok: true, library: { groups: prompts } }),
  syncWidgets: () => { writes++; }, loadLibraries: async () => {}, renderAll: () => { renders++; } };
vm.runInNewContext(adapter, context);
await node._allbuyManagerApply({ locator: library, ids: ["b"], append: true });
assert.equal(writes, 1); assert.equal(renders, 1); assert.deepEqual(controller.selectedIds, ["b", "a"]);
context.apiGet = async () => ({ ok: false, error: "offline" });
await assert.rejects(node._allbuyManagerApply({ locator: { source: "builtin", name: "other" }, ids: ["a"] }), /offline/);
assert.equal(controller.locator.name, "shared"); assert.equal(writes, 1, "Failed loads must leave workflow widgets untouched");

const stackSource = readFileSync(new URL("../web/lora_stack.js", import.meta.url), "utf8");
const stackStart = stackSource.indexOf("    node._allbuyManagerApply = (");
const stackAdapter = stackSource.slice(stackStart, stackSource.indexOf("\n    };", stackStart) + 7);
const stackNode = { _stackEntries: current, _loraOptions: [models[0].name, models[1].name], graph: { change() {} } };
let serialized;
vm.runInNewContext(stackAdapter, { node: stackNode, validatePresetEntries: validate, appendUniqueEntries, uid: () => "new", writeStack: n => { serialized = JSON.stringify(n._stackEntries); }, renderStack() {} });
stackNode._allbuyManagerApply({ entries: additions.slice(0, 2) });
assert.equal(stackNode._stackEntries.length, 2); assert.equal(JSON.parse(serialized)[0].trigger, "keep");
assert.throws(() => stackNode._allbuyManagerApply({ entries: [{ name: "missing" }] }), /不存在/);
assert.equal(stackNode._stackEntries.length, 2);
// Live stack edits validate all fields atomically, support empty stacks, and preserve row IDs.
const editStart = stackSource.indexOf("    node._allbuyManagerStack = {");
const editAdapter = stackSource.slice(editStart, stackSource.indexOf("\n    };", editStart) + 7);
const widgets = new Map([["模型类型", { value: "UNET", options: { values: ["UNET", "Checkpoint", "GGUF"] } }], ["unet_name", { value: "old.safetensors", options: { values: ["old.safetensors", "new.safetensors", "None"] } }]]);
stackNode.title = "Current stack";
vm.runInNewContext(editAdapter, { node: stackNode, structuredClone, validatePresetEntries: validate, uid: () => "generated",
  flushStackWrite() {}, findWidget: (node, name) => widgets.get(name), optionList: () => null, cachedObjectInfo: null,
  setWidget: (widget, value) => { if (widget) widget.value = value; },
  seg: { querySelectorAll: () => [] }, modelDD: { refresh() {} }, advWrap: { style: {} }, currentModelName: () => widgets.get("unet_name").value,
  writeStack: node => { serialized = JSON.stringify(node._stackEntries); }, renderStack() {} });
const before = JSON.stringify(stackNode._allbuyManagerStack.snapshot());
assert.throws(() => stackNode._allbuyManagerStack.replace({ entries: [{ name: "missing" }], settings: { unet_name: "new.safetensors" }, title: "Lost" }), /不存在/);
assert.equal(JSON.stringify(stackNode._allbuyManagerStack.snapshot()), before);
assert.throws(() => stackNode._allbuyManagerStack.replace({ entries: [], settings: { unet_name: "unknown.safetensors" } }), /选项/);
assert.equal(JSON.stringify(stackNode._allbuyManagerStack.snapshot()), before);
stackNode._allbuyManagerStack.replace({ entries: [{ id: "stable", name: models[1].name, weight: .6, min: -2, max: 2, trigger: "lighting" }], settings: { unet_name: "new.safetensors" }, title: "Lighting stack" });
assert.equal(stackNode._stackEntries[0].id, "stable"); assert.equal(stackNode._stackEntries[0].trigger, "lighting");
assert.equal(widgets.get("unet_name").value, "new.safetensors"); assert.equal(stackNode.title, "Lighting stack");
stackNode._allbuyManagerStack.replace({ entries: [] });
assert.equal(serialized, "[]", "Clearing a stack must flush its serialized widget");
console.log("Manager filtering, classification, validation, and workflow adapters passed");
