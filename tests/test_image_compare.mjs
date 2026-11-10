import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
globalThis.__abTestApp = {
  registerExtension(ext) { extension = ext; },
  graph: { setDirtyCanvas() {} },
};
const source = readFileSync(new URL("../web/image_compare.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', 'const app = globalThis.__abTestApp;')
  .replace('import { api } from "../../scripts/api.js";', 'const api = {};');
await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
class CompareNode {
  constructor() {
    this.type = "AllBuyABCompare";
    this.properties = {};
    this.widgets = [];
  }
  addWidget(type, name, value, callback) {
    const widget = { type, name, value, callback };
    this.widgets.push(widget);
    return widget;
  }
  addCustomWidget(widget) { this.widgets.push(widget); return widget; }
}
await extension.beforeRegisterNodeDef(CompareNode, { name: "AllBuyABCompare" });

for (const path of ["widget", "node"]) {
  for (const buttons of [0, 2, 4]) {
    const node = new CompareNode();
    node.onNodeCreated();
    node._abImages = { a: { img: { naturalWidth: 100 } } };
    const widget = node._abWidget;
    widget.rect = widget.imageRect = [0, 0, 100, 100];
    const down = (pos) => node.onMouseDown({ type: "pointerdown", button: 0, buttons: 1 }, pos);
    const move = (buttons, pos) => path === "widget"
      ? widget.mouse({ type: "pointermove", buttons }, pos)
      : node.onMouseMove({ type: "pointermove", buttons }, pos);

    move(0, [20, 50]);
    assert.equal(node._abSplit, 50, `${path}: disabled hover keeps the split fixed`);
    down([30, 50]);
    move(1, [60, 50]);
    assert.equal(node._abSplit, 60, `${path}: left-button dragging still works`);
    // Release outside the node: no pointerup reaches either handler.
    move(buttons, [80, 50]);
    assert.equal(node._abSplit, 60, `${path}: missing pointerup must not cause hover-follow (buttons=${buttons})`);
    assert.equal(node._abDragging, false);
    assert.equal(widget.dragging, false);

    widget.tglHoverRect = [0, 0, 20, 20];
    down([10, 10]);
    assert.equal(node.properties.ab_hover, true);
    assert.equal(node._abHoverWidget.value, true);
    move(0, [75, 50]);
    assert.equal(node._abSplit, 75, `${path}: enabled hover follows without a held button`);
    down([10, 10]);
    assert.equal(node._abHoverWidget.value, false);
    move(0, [25, 50]);
    assert.equal(node._abSplit, 75, `${path}: turning hover off immediately stops following`);

    down([40, 50]);
    node.onMouseUp({ type: "pointerup", button: 0, buttons: 0 }, [40, 50]);
    move(0, [90, 50]);
    assert.equal(node._abSplit, 40, `${path}: normal pointerup ends dragging`);
  }
}
console.log("A/B compare hover and drag regression checks passed");
