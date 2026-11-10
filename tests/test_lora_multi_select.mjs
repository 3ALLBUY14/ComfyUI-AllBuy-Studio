import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.attributes = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    };
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  fire(type, options = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ stopPropagation() {}, preventDefault() {}, ...options });
  }
  click(options = {}) {
    if (this.disabled) return;
    if (this.type === "checkbox") this.checked = !this.checked;
    this.fire("click", options);
    if (this.type === "checkbox") this.fire("change", options);
  }
  querySelectorAll() { return this.children.flatMap((child) => child.classes.has("alora-row-select") ? [child] : child.querySelectorAll()); }
  closest() { return this.parent; }
}
globalThis.document = { createElement: (tag) => new Element(tag), createTextNode: (text) => new Element("text") };
const source = readFileSync(new URL("../web/lora_multi_select.js", import.meta.url), "utf8");
const { createLoRAMultiSelect } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const base = [
  { id: "a", name: "same.safetensors", weight: 1, min: -3, max: 3, enabled: true },
  { id: "b", name: "same.safetensors", weight: .5, min: 0, max: 1, enabled: false },
  { id: "c", name: "other.safetensors", weight: .75, min: -2, max: 2, enabled: true },
];
let entries = structuredClone(base);
let displayed = null;
let changes = 0;
let failFavorites = false;
const favoriteCalls = [];
const host = new Element("host");
const controller = createLoRAMultiSelect({
  getEntries: () => entries, getVisibleEntries: () => displayed || entries, getHost: () => host,
  onChange: (fresh) => { changes++; entries = fresh; },
  onFavorites: async (names, remove) => {
    if (failFavorites) throw new Error("write failed");
    favoriteCalls.push({ names, remove });
  },
});
const boxes = base.map((entry) => controller.checkbox(entry));
host.append(...boxes);
const action = (text) => controller.bar.children.find((element) => element.textContent === text);
const weight = controller.bar.children.find((element) => element.attributes["aria-label"] === "批量权重");
const status = controller.bar.children.at(-1);
const master = controller.bar.children[0].children[0];
const setWeight = (value) => { weight.value = value; action("修改权重").click(); };
controller.toggleBtn.click();
boxes[0].click();
boxes[1].click();
setWeight("0.65");
assert.deepEqual(entries.map((entry) => entry.weight), [.65, .65, .75]);
assert.equal(entries[1].enabled, false);
assert.ok(boxes[0].checked && boxes[1].checked);
for (const value of ["", "2", "Infinity", "1e308"]) setWeight(value);
assert.equal(changes, 1, "invalid batch weights must not partially write selected entries");
entries[0].min = 2;
setWeight("0.5");
assert.match(status.textContent, /不重叠/);
entries[0].min = "";
setWeight("0.5");
assert.match(status.textContent, /修正/);
assert.equal(changes, 1);
entries[0].min = -3;

action("收藏").click();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(favoriteCalls, [{ names: ["same.safetensors"], remove: false }]);
assert.equal(action("收藏").disabled, false);
failFavorites = true;
action("收藏").click();
await new Promise((resolve) => setImmediate(resolve));
assert.match(status.textContent, /write failed/);
assert.ok(boxes[0].checked && boxes[1].checked);
assert.equal(action("收藏").disabled, false, "failed favorite requests must remain retryable");

action("清除选择").click();
boxes[0].click();
boxes[2].click({ shiftKey: true });
assert.ok(boxes.every((box) => box.checked), "Shift selects contiguous rows");
action("清除选择").click();
boxes[0].click();
displayed = [entries[2]];
controller.sync();
master.click();
assert.ok(boxes[0].checked && !boxes[1].checked && boxes[2].checked);
assert.match(controller.bar.children[1].textContent, /含 1 条筛选外/);
action("删除选中").click();
assert.deepEqual(entries.map((entry) => entry.id), ["b"], "delete follows stable selected IDs across filters");
assert.equal(action("修改权重").disabled, true);
controller.reset();
assert.equal(controller.bar.hidden, true);
assert.ok(boxes.every((box) => !box.checked));
assert.deepEqual(Object.keys(entries[0]).sort(), ["enabled", "id", "max", "min", "name", "weight"], "selection is never stored in stack entries");
console.log("LoRA multiselect: batch bounds, disabled rows, stable IDs, filtered selection, favorite errors and deduplication passed");
