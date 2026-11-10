// Execute both frontend modules with a minimal DOM and a controlled save response.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.classList = { add() {} };
    this.value = "";
    this.isConnected = true;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    if (this.tagName === "select" && this.children.length === 1) this.value = child.value;
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set innerHTML(value) { this.children = []; this.value = ""; }
  matches(selector) { return selector.split(",").some((tag) => tag.trim() === this.tagName); }
  querySelector(selector) { return descendants(this).slice(1).find((child) => child.matches(selector)); }
  after(child) { this.parentElement.appendChild(child); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute() {}
  focus() {}
  remove() { this.isConnected = false; }
}

class CustomEvent extends Event {
  constructor(type, options) { super(type); this.detail = options?.detail; }
}

function loadModule(filename, globals) {
  const source = readFileSync(new URL(`../web/${filename}`, import.meta.url), "utf8")
    .replace(/^import .*;\r?\n/gm, "")
    .replaceAll("import.meta.url", '"https://example.test/extensions/test.js"');
  const context = vm.createContext({ ...globals });
  vm.runInContext(source, context, { filename });
  return context;
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function checkSave(succeeds) {
  const window = new EventTarget();
  const document = {
    body: new Element("body"),
    getElementById: () => true, // Styles are already installed.
    createElement: (tag) => new Element(tag),
    addEventListener() {}, removeEventListener() {},
  };
  let disk = { name: "shared", groups: [{ id: "existing", name: "已有组" }] };
  let acknowledgeSave;
  let posted;
  const timers = [];
  const globals = {
    window, document, CustomEvent,
    app: { registerExtension() {} }, api: {},
    console: { log() {}, info() {}, warn() {}, error() {} },
    randomColor: () => "#ABCDEF",
    setTimeout: (callback) => timers.push(callback),
    fetch: async (url, options) => {
      if (options?.method === "POST") {
        posted = JSON.parse(options.body);
        return new Promise((resolve) => {
          acknowledgeSave = () => {
            if (succeeds) disk = posted.data;
            resolve({ json: async () => ({ ok: succeeds, error: "保存失败" }) });
          };
        });
      }
      const result = url.endsWith("/libraries")
        ? { ok: true, libraries: [{ source: "user", name: "shared", count: 1 }] }
        : { ok: true, library: structuredClone(disk) };
      return { json: async () => result };
    },
  };
  const library = loadModule("videoprompt_library.js", globals);
  const controllers = vm.runInContext("_activeLibControllers", library);
  const key = vm.runInContext("libraryKey", library);
  const refreshed = [];
  const makeController = (id, locator) => ({
    locKey: () => key(locator),
    refresh: () => refreshed.push({ id, groups: disk.groups.map((group) => group.name) }),
  });
  controllers.add(makeController("first", { source: "user", name: "shared" }));
  controllers.add(makeController("second", { name: "shared", source: "user" }));
  controllers.add(makeController("other", { source: "user", name: "other" }));
  controllers.add(makeController("builtin", { source: "builtin", name: "shared" }));
  const removed = makeController("removed", { source: "user", name: "shared" });
  controllers.add(removed);
  controllers.delete(removed);

  const textbox = loadModule("textbox_node.js", globals);
  vm.runInContext('saveToLibrary("new prompt")', textbox);
  await settle();
  const elements = descendants(document.body);
  const name = elements.find((element) => element.placeholder === "新提示词组名称");
  const save = elements.find((element) => element.textContent === "入库");
  assert.equal(save.disabled, false, "Library metadata must finish loading");
  name.value = "新增组";
  save.listeners.get("click")({ preventDefault() {}, stopPropagation() {} });
  await settle();
  assert.ok(posted, "Textbox must send the save request");
  assert.deepEqual(refreshed, [], "No refresh before the server acknowledges the save");
  acknowledgeSave();
  await settle();
  assert.deepEqual(refreshed, succeeds ? [
    { id: "first", groups: ["已有组", "新增组"] },
    { id: "second", groups: ["已有组", "新增组"] },
  ] : [], "Only active panels for the saved user library refresh, immediately after success");
  if (succeeds) {
    assert.equal(timers.length, 1, "Refresh happens before the delayed dialog close");
    window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved"));
    window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator: [] } }));
    assert.equal(refreshed.length, 2, "Malformed notifications are ignored");
  }
}

await checkSave(true);
await checkSave(false);
console.log("Textbox save refresh regression checks passed");
