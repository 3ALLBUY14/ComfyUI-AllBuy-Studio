// Browser upload contract: the frontend must use shared storage and retain IDs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const requests = [];
let response = {
  ok: true, asset_id: "a".repeat(64), name: "a".repeat(64) + ".png",
  file: "allbuy_media/" + "a".repeat(64) + ".png", type: "image", size: 123, reused: true,
};
class FormData {
  constructor() { this.fields = []; }
  append(...args) { this.fields.push(args); }
}
class XMLHttpRequest {
  constructor() {
    this.handlers = new Map();
    this.upload = { addEventListener: (type, callback) => { this.progress = callback; } };
    requests.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  addEventListener(type, callback) { this.handlers.set(type, callback); }
  send(body) {
    this.body = body;
    this.status = 200;
    this.responseText = JSON.stringify(response);
    this.progress({ lengthComputable: true, loaded: 123, total: 123 });
    this.handlers.get("load")();
  }
}

const context = vm.createContext({
  document: { getElementById: () => true },
  app: { registerExtension() {} },
  FormData, XMLHttpRequest, console: { log() {}, info() {} },
});
const source = readFileSync(new URL("../web/media_asset_loader.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "")
  .replaceAll("import.meta.url", '"https://example.test/extensions/test.js"');
vm.runInContext(source, context);
const upload = vm.runInContext("uploadOne", context);
const file = { name: "original.png" };
let progress;
const saved = await upload(file, (value) => { progress = value; });
assert.equal(requests[0].url, "/allbuy_promptlibrary/media/upload");
assert.equal(requests[0].method, "POST");
assert.deepEqual(requests[0].body.fields, [["file", file, "original.png"]]);
assert.equal(saved.asset_id, response.asset_id);
assert.equal(saved.rel, response.file);
assert.equal(saved.reused, true);
assert.equal(progress, 1);
response = { ok: false, error: "upload failed" };
await assert.rejects(upload(file, () => {}), /upload failed/);
response = { ok: true, name: "old-server.png" };
await assert.rejects(upload(file, () => {}));
console.log("Shared frontend upload contract checks passed");
