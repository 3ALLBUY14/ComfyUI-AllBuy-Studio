import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frames = new Map();
let nextFrame = 0;
globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
globalThis.cancelAnimationFrame = (id) => frames.delete(id);
const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((fn) => fn()); };
const observers = [];
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
};
class Scroller {
  isConnected = true;
  clientHeight = 400;
  scrollHeight = 1800;
  scrollTop = 0;
  handlers = new Set();
  getClientRects() { return this.clientHeight > 0 ? [{}] : []; }
  addEventListener(event, handler) { assert.equal(event, "scroll"); this.handlers.add(handler); }
  removeEventListener(event, handler) { this.handlers.delete(handler); }
  scroll(top) { this.scrollTop = top; this.handlers.forEach((fn) => fn()); }
}
const source = readFileSync(new URL("../web/lora_scroll.js", import.meta.url), "utf8");
const { installLoRAScroll } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const node = { properties: { other: "preserve" } };
const list = new Scroller(), panel = new Scroller();
const controller = installLoRAScroll(node, list, panel);
flush();
list.scroll(650);
panel.scroll(120);
assert.deepEqual(node.properties.allbuyLoraScroll, { list: 650, panel: 120 });
controller.prepare();
list.scroll(0);
panel.scroll(0);
controller.restore();
flush();
assert.equal(list.scrollTop, 650, "row rebuilding must restore the list viewport");
assert.equal(panel.scrollTop, 120, "the outer panel viewport is independent");
list.clientHeight = panel.clientHeight = 0;
list.scroll(0);
controller.sync();
controller.prepare();
controller.restore();
flush();
const snapshot = { properties: { other: "preserve" } };
controller.serialize(snapshot);
assert.equal(snapshot.properties.allbuyLoraScroll.list, 650, "serializing a hidden canvas must retain the last visible position");
assert.equal(snapshot.properties.other, "preserve");
list.clientHeight = panel.clientHeight = 400;
controller.sync();
flush();
assert.equal(list.scrollTop, 650, "showing a canvas restores after its layout becomes available");
const nodeB = { properties: structuredClone(snapshot.properties) };
const listB = new Scroller(), panelB = new Scroller();
listB.isConnected = panelB.isConnected = false;
const controllerB = installLoRAScroll(nodeB, listB, panelB);
flush();
assert.equal(nodeB.properties.allbuyLoraScroll.list, 650);
listB.isConnected = panelB.isConnected = true;
controllerB.sync();
flush();
assert.equal(listB.scrollTop, 650, "a recreated node restores serialized viewport state");
listB.scroll(240);
assert.equal(node.properties.allbuyLoraScroll.list, 650, "two nodes do not share viewport state");
nodeB.properties.allbuyLoraScroll = { list: 900, panel: 80 };
controllerB.restoreView();
flush();
assert.equal(listB.scrollTop, 900, "configure replaces stale runtime viewport state");
controllerB.prepare();
listB.scrollHeight = 500;
controllerB.restore();
flush();
assert.equal(listB.scrollTop, 100, "a shortened list clamps to the remaining scroll range");
nodeB.properties.allbuyLoraScroll = { list: Infinity, panel: -10 };
controllerB.restoreView();
flush();
assert.equal(listB.scrollTop, 0, "invalid saved positions cannot affect layout");
assert.equal(panelB.scrollTop, 0);
controllerB.restore();
controllerB.destroy();
assert.equal(listB.handlers.size, 0);
assert.equal(panelB.handlers.size, 0);
assert.ok(observers[1].disconnected);
assert.equal(frames.size, 0, "removing a node cancels pending restoration");
controller.destroy();
console.log("PASS: LoRA viewport survives rebuild, hidden tabs, serialization and node recreation");
