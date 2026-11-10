import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const timers = new Map();
let next = 0;
globalThis.setTimeout = (fn) => { timers.set(++next, fn); return next; };
globalThis.clearTimeout = (id) => timers.delete(id);
globalThis.CustomEvent = class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } };
globalThis.window = new EventTarget();
const events = [];
window.addEventListener("allbuy-lora-trigger-saved", (event) => events.push(event.detail));
const calls = [];
let fail = false;
globalThis.fetch = async (url, options) => {
  calls.push(JSON.parse(options.body));
  return { ok: !fail, json: async () => fail ? { ok: false, error: "disk full" } : { ok: true } };
};
const source = readFileSync(new URL("../web/lora_triggers.js", import.meta.url), "utf8");
const { bindLoRATrigger, saveLoRATrigger } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
class Input extends EventTarget {
  value = ""; style = {}; attributes = {};
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  edit(value) { this.value = value; this.dispatchEvent(new Event("input")); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const input = new Input();
let name = "folder\\model.safetensors";
bindLoRATrigger(input, () => name);
input.edit("p"); input.edit("pxl8x");
assert.equal(calls.length, 0);
assert.equal(timers.size, 1, "typing debounces shared storage writes");
input.dispatchEvent(new Event("blur"));
await settle();
assert.deepEqual(calls[0], { action: "set_trigger", model: "folder/model.safetensors", trigger: "pxl8x" });
assert.match(input.title, /已保存/);
assert.deepEqual(events[0], { model: "folder/model.safetensors", trigger: "pxl8x" });
input.edit("old model text");
name = "other.safetensors";
input.dispatchEvent(new Event("change"));
await settle();
assert.equal(calls.at(-1).model, "folder/model.safetensors", "a pending edit remains attached to the original model");
input.edit(""); input.dispatchEvent(new Event("change"));
await settle();
assert.equal(calls.at(-1).trigger, "", "clearing the field also updates shared storage");
fail = true;
input.edit("keep draft"); input.dispatchEvent(new Event("change"));
await settle();
assert.equal(input.value, "keep draft");
assert.equal(input.attributes["aria-invalid"], "true");
assert.match(input.title, /disk full/);
fail = false;
input.edit("retry"); input.dispatchEvent(new Event("change"));
await settle();
assert.equal(input.attributes["aria-invalid"], undefined);
const before = calls.length;
await Promise.all([saveLoRATrigger("x", "first"), saveLoRATrigger("x", "latest")]);
assert.deepEqual(calls.slice(before).map(call => call.trigger), ["first", "latest"]);
await saveLoRATrigger("None", "skip");
assert.equal(calls.length, before + 2);
const manager = readFileSync(new URL("../web/manager.js", import.meta.url), "utf8");
assert.ok(manager.includes('bindLoRATrigger(trigger, () => item.name)'));
assert.ok(manager.includes('this.catalog.triggers?.[modelKey(name)]'));
const stack = readFileSync(new URL("../web/lora_stack.js", import.meta.url), "utf8");
assert.ok(stack.includes('bindLoRATrigger(trig, () => entry.name)'));
assert.ok(stack.includes('trig.dispatchEvent(new Event("input"))'));
console.log("PASS: trigger autosave, clearing, ordered updates, failure feedback, retry and model identity");
