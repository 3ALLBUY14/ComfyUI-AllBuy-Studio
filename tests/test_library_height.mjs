// Exercise production height measurement and resize guards with an overflowing list.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/videoprompt_library.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const cap = Number(css.match(/\.vpl-list\s*\{[^}]*max-height:\s*(\d+)px/)[1]);
const classes = new Set();
let contentHeight = 4000;
let visible = true;
const container = {
  isConnected: true, offsetTop: 0, style: { height: "", maxHeight: "" },
  classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name),
    remove: (name) => classes.delete(name) },
  getBoundingClientRect: () => ({ height: visible ? 600 : 0 }),
  get scrollHeight() {
    return 120 + (classes.has("vpl-fill") || list.style.maxHeight === "none"
      ? contentHeight : Math.min(cap, contentHeight));
  },
  get offsetHeight() { return this.scrollHeight; },
};
const list = { style: { maxHeight: "" } };
const node = {
  size: [380, 260],
  setSize(value) { this.size = value; this.onResize?.(); },
  setDirtyCanvas() {},
};
const frames = [];
const context = vm.createContext({
  container, els: { list }, node, NODE_WIDTH: 380, BOTTOM_GAP: 18,
  chromeH: () => 50, api: {},
  requestAnimationFrame: (callback) => frames.push(callback),
  setTimeout: () => 1, clearTimeout() {},
});
const guard = readFileSync(new URL("../web/panel_guard.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
vm.runInContext(guard, context);
vm.runInContext(source.slice(source.indexOf("  let _lastGoodH = 460;"),
  source.indexOf("  // 接管 node.computeSize")), context);
vm.runInContext(source.slice(source.indexOf("  let _recalcPending = false;"),
  source.indexOf("  function renderAll()")), context);
const floor = source.match(/floor: \(\) => ([^\n]+),/)[1];
vm.runInContext(`installFillResize(node, {
  el: () => container, chrome: chromeH, floor: () => ${floor}, minWidth: 380, margin: 8,
});`, context);
const recalc = () => {
  vm.runInContext("recalcHeight()", context);
  frames.splice(0).forEach((callback) => callback());
};
recalc();
assert.equal(node.size[1], cap + 120 + 50 + 18, "Many groups must not force a full-content height");
const boundedHeight = node.size[1];
contentHeight = 40000;
recalc();
node.onDrawBackground();
assert.equal(node.size[1], boundedHeight, "Adding more groups keeps the list scrollable");
node.setSize([380, 1200]);
recalc();
assert.equal(node.size[1], 1200, "User can still enlarge the node deliberately");
node.size[1] = 200; // Canvas drag writes the size directly.
node.onDrawBackground();
assert.equal(node.size[1], boundedHeight, "Shrinking stops at the capped layout, not all groups");
assert.equal(container.style.height, "");
visible = false;
recalc();
assert.equal(node.size[1], boundedHeight, "Off-screen measurements preserve the bounded height");
console.log("Prompt group list height and resize checks passed");
