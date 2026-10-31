import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../web/workflow_library.js", import.meta.url), "utf8");
const { WorkflowLibrary, workflowPath, workflowData, workflowSummary, filterWorkflows, workflowFolderRows, workflowFolderRoots, workflowTags, workflowDestinationFolders } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
assert.deepEqual(workflowFolderRoots(["项目/风景", "项目", "项目", "项目2", "项目2/人物"]), ["项目", "项目2"], "Selected descendants must not be moved twice");
const folders = ["人物", "人物/人像", "人物/人像/柔光", "人物/人像/逆光", "人物/商品", "风景", "风景/户外"];
assert.deepEqual(workflowFolderRows(folders).map(row => row.path), ["人物", "风景"], "Only root folders are visible by default");
const expanded = new Set(["人物", "人物/人像"]);
assert.deepEqual(workflowFolderRows(folders, expanded).map(row => row.path), folders.filter(path => path !== "风景/户外"));
assert.deepEqual(workflowFolderRows(folders, new Set(), " 柔光 ").map(row => [row.path, row.depth, row.open]), [["人物", 0, true], ["人物/人像", 1, true], ["人物/人像/柔光", 2, false]], "Search reveals matching ancestors");
assert.equal(workflowFolderRows(folders, expanded, "none").length, 0);
assert.deepEqual([...expanded], ["人物", "人物/人像"], "Searching never changes saved expansion");
const destinations = ["项目", "项目/分类", "项目/空目录", "项目2", "项目2/子目录", "空目录"], entries = { "项目/分类/示例.json": { tags: ["人物"] } }, workflows = [{ path: "项目/分类/示例.json" }, { path: "项目2/子目录/示例.json" }];
assert.deepEqual(workflowDestinationFolders(destinations, workflows, { entries }, "tag:人物"), ["项目", "项目/分类"], "Tag categories include ancestors without matching sibling prefixes");
assert.deepEqual(workflowDestinationFolders(destinations, workflows, { entries }, "empty"), ["项目/空目录", "空目录"]);
assert.deepEqual(workflowDestinationFolders(destinations, workflows, { entries }, "untagged"), ["项目/空目录", "项目2", "项目2/子目录", "空目录"]);
assert.deepEqual(workflowDestinationFolders(destinations, workflows, { entries }, "tag:missing"), []);
assert.deepEqual(workflowDestinationFolders(destinations, workflows, { entries }), destinations);
assert.deepEqual(workflowFolderRows(["land", "land/city", "landscape", "landscape/beach"], new Set(["land"])).map(row => row.path), ["land", "land/city", "landscape"], "Sibling prefixes are independent branches");
const graph = { version: .4, nodes: [{ id: 1, type: "CheckpointLoaderSimple", widgets_values: ["demo.safetensors"], pos: [0, 0], size: [200, 100] }, { id: 2, type: "MissingNode", widgets_values: ["morning light"] }], links: [] };
assert.deepEqual(filterWorkflows([{ path: "root.json" }, { path: "folder/nested.json" }], { entries: {} }, "", "root").map(item => item.path), ["root.json"], "Root navigation excludes nested workflows");
assert.equal(workflowPath("风景\\清晨.json"), "风景/清晨.json");
for (const path of ["../outside.json", "/outside.json", "C:\\secret.json", "folder/../x.json", "folder//x.json", "folder./x.json", "x?.json", null]) assert.throws(() => workflowPath(path));
assert.throws(() => workflowData({ "1": { class_type: "KSampler" } }), /API/);
assert.throws(() => workflowData({ nodes: [null], links: [] }));
const summary = workflowSummary(graph, { CheckpointLoaderSimple: true });
assert.deepEqual(summary.models, ["demo.safetensors"]); assert.deepEqual(summary.missing, ["MissingNode"]); assert.ok(summary.text.includes("morning light"));
const subgraphSummary = workflowSummary({ nodes: [{ type: "demo-subgraph" }], links: [], definitions: { subgraphs: [{ id: "demo-subgraph", nodes: [graph.nodes[0]] }] } }, { CheckpointLoaderSimple: true });
assert.deepEqual(subgraphSummary.missing, [], "Embedded subgraphs must not be reported as missing custom nodes");
assert.deepEqual(subgraphSummary.models, ["demo.safetensors"], "Model search must include embedded subgraphs");
const metadataPath = "allbuy/workflow-library.json";
const files = new Map([["workflows/风景/清晨.json", structuredClone(graph)]]);
let failMetadataWrite = false, failMetadataRead = false, failTrashWrite = false;
const writes = [];
const api = {
  async listUserDataFullInfo() { return [...files.keys()].filter(path => path.startsWith("workflows/") && !path.split("/").some(part => part.startsWith("."))).map(path => ({ path: path.slice(10), modified: 1, size: 100 })); },
  async getUserData(path) {
    if (path === metadataPath && failMetadataRead) return new Response("unavailable", { status: 500 });
    return files.has(path) ? Response.json(files.get(path)) : new Response("missing", { status: 404 });
  },
  async storeUserData(path, data, options = {}) {
    writes.push(path);
    if (path === metadataPath && failMetadataWrite) return new Response("failed", { status: 500 });
    if (path === "allbuy/workflow-trash/index.json" && failTrashWrite) return new Response("failed", { status: 500 });
    if (options.overwrite === false && files.has(path)) return new Response("exists", { status: 409 });
    files.set(path, structuredClone(data)); return new Response("ok");
  },
  async moveUserData(from, to) {
    const sources = [...files.keys()].filter(path => path === from || path.startsWith(from + "/"));
    if (!sources.length) return new Response("missing", { status: 404 });
    if ([...files.keys()].some(path => path === to || path.startsWith(to + "/"))) return new Response("exists", { status: 409 });
    for (const path of sources) { files.set(to + path.slice(from.length), files.get(path)); files.delete(path); } return new Response("ok");
  },
};
const library = new WorkflowLibrary(api);
await library.refresh(); assert.equal(library.items.length, 1); assert.deepEqual(library.folders, ["风景"]);
await library.read(library.items[0], { CheckpointLoaderSimple: true });
await library.patch("风景/清晨.json", { favorite: true, note: "示例备注", tags: ["自然光"] });
assert.equal(filterWorkflows(library.items, library.metadata, "morning").length, 1);
assert.equal(filterWorkflows(library.items, library.metadata, "自然光", "favorite").length, 1);
assert.equal(filterWorkflows(library.items, library.metadata, "", "folder:other").length, 0);
assert.equal(filterWorkflows(library.items, library.metadata, "", "missing").length, 1);
await assert.rejects(library.save("风景/清晨.json", graph), /已存在/);
assert.deepEqual(files.get("workflows/风景/清晨.json"), graph, "Existing workflow must never be overwritten");
failMetadataRead = true; const beforeWrites = writes.length;
await assert.rejects(library.patch("风景/清晨.json", { note: "must not replace" }));
assert.equal(writes.length, beforeWrites, "Failed metadata reads must prevent writes"); failMetadataRead = false;
failMetadataWrite = true;
await assert.rejects(library.move("风景/清晨.json", "测试/changed.json"));
assert.ok(files.has("workflows/风景/清晨.json"), "Failed metadata migration rolls the file back"); assert.ok(!files.has("workflows/测试/changed.json")); failMetadataWrite = false;
await library.move("风景/清晨.json", "测试/changed.json");
assert.equal(library.metadata.entries["测试/changed.json"].note, "示例备注");
assert.ok(!library.metadata.entries["风景/清晨.json"]);
const removed = await library.trash("测试/changed.json");
assert.ok(files.has(removed.destination)); assert.ok(!files.has("workflows/测试/changed.json"));
await library.restore(removed); assert.deepEqual(files.get("workflows/测试/changed.json"), graph);
await library.createFolder("示例/子目录"); await library.refresh(); assert.ok(library.folders.includes("示例/子目录"));
assert.ok(files.has("workflows/示例/子目录/_allbuy-folder"), "Compatibility marker must survive hidden-file omission in older ComfyUI");
files.set("workflows/旧空目录/.allbuy-folder", "");
const directoryApi = { ...api, async fetchApi(url) {
  assert.equal(url, "/v2/userdata?path=workflows");
  return Response.json([{ path: "workflows/旧空目录", type: "directory" }, { path: "workflows/真实空目录", type: "directory" }, { path: "workflows/not-a-folder.json", type: "file" }]);
} };
const withEmpty = new WorkflowLibrary(directoryApi); await withEmpty.refresh();
assert.ok(withEmpty.folders.includes("旧空目录"), "Previously created hidden-marker folders must reappear");
assert.ok(withEmpty.folders.includes("真实空目录"), "Real empty directories are listed without marker files");
assert.ok(!withEmpty.folders.includes("not-a-folder.json"));
await assert.rejects(withEmpty.createFolder("旧空目录"), /已存在/);
directoryApi.fetchApi = async () => new Response("unavailable", { status: 500 });
await assert.rejects(withEmpty.refresh(), /500/, "Directory read errors must not silently hide folders");
directoryApi.fetchApi = async () => Response.json([{ path: "outside/dir", type: "directory" }]);
await assert.rejects(withEmpty.refresh(), /路径无效/);
directoryApi.fetchApi = async () => new Response("missing route", { status: 404 }); await withEmpty.refresh();
assert.ok(withEmpty.folders.includes("示例/子目录"), "File-based fallback supports older ComfyUI");
{
  const markers = new Map([["workflows/空目录/_allbuy-folder", ""], ["workflows/有内容/_allbuy-folder", "keep"]]);
  const dirs = new Set(["空目录", "有内容"]);
  const modern = new WorkflowLibrary({ ...api,
    async listUserDataFullInfo() { return [...markers].map(([path, body]) => ({ path: path.slice(10), size: body.length })); },
    async getUserData(path) { return markers.has(path) ? new Response(markers.get(path)) : new Response("", { status: 404 }); },
    async storeUserData(path, body) { markers.set(path, body); const parts = path.slice(10).split("/"); parts.pop(); dirs.add(parts.join("/")); return new Response(); },
    async fetchApi(url, options) {
      if (options?.method === "DELETE") { markers.delete(decodeURIComponent(url.slice("/userdata/".length))); return new Response(null, { status: 204 }); }
      return Response.json([...dirs].map(path => ({ path: "workflows/" + path, type: "directory" })));
    },
  });
  await modern.refresh(); assert.ok(!markers.has("workflows/空目录/_allbuy-folder"), "Remove only empty internal markers from native workflow listings");
  assert.equal(markers.get("workflows/有内容/_allbuy-folder"), "keep", "Never remove a nonempty same-named user file");
  assert.ok(modern.folders.includes("空目录")); await modern.createFolder("新空目录"); await modern.refresh();
  assert.ok(modern.folders.includes("新空目录")); assert.ok(!markers.has("workflows/新空目录/_allbuy-folder"), "New folders must not leave visible placeholder files");
}
await assert.rejects(library.createFolder("示例/子目录"), /已存在/);
await library.tagAction("create", "未使用标签"); assert.ok(workflowTags(library.metadata).includes("未使用标签"));
await assert.rejects(library.tagAction("create", "未使用标签"), /已存在/);
await library.patchTags(["测试/changed.json"], ["人物"], []);
await library.tagAction("rename", "自然光", "日光");
assert.deepEqual(library.metadata.entries["测试/changed.json"].tags, ["日光", "人物"]);
assert.equal(library.metadata.entries["测试/changed.json"].note, "示例备注");
await assert.rejects(library.tagAction("rename", "人物", "日光"), /已存在/);
await assert.rejects(library.tagAction("create", "bad,name"));
await library.patchTags(["测试/changed.json"], ["自然"], ["人物"]);
assert.deepEqual(library.metadata.entries["测试/changed.json"].tags, ["日光", "自然"]);
await library.tagAction("delete", "日光"); assert.deepEqual(library.metadata.entries["测试/changed.json"].tags, ["自然"]);
assert.ok(files.has("workflows/测试/changed.json"), "Tag deletion must keep workflow files");
files.set("workflows/示例/子目录/工作流.json", graph); files.set("workflows/示例/素材.png", "image"); files.set("workflows/示例2/保留.json", graph);
failTrashWrite = true; await assert.rejects(library.trash("示例", "folder")); failTrashWrite = false;
assert.ok(files.has("workflows/示例/素材.png"), "Failed trash index write rolls whole directory back");
const folderTrash = await library.trash("示例", "folder");
assert.ok(files.has(folderTrash.destination + "/子目录/工作流.json")); assert.ok(files.has(folderTrash.destination + "/素材.png"));
assert.ok(files.has("workflows/示例2/保留.json")); assert.ok(![...files.keys()].some(path => path.startsWith("workflows/示例/")));
const reopened = new WorkflowLibrary(api); await reopened.refresh(); assert.ok(reopened.deleted.some(item => item.id === folderTrash.id), "Trash survives reopening");
files.set("workflows/示例/新文件.json", graph); await assert.rejects(reopened.restore(folderTrash), /已存在/); files.delete("workflows/示例/新文件.json");
assert.ok(files.has(folderTrash.destination + "/素材.png"), "Restore conflict must leave backup intact");
failTrashWrite = true; await assert.rejects(reopened.restore(folderTrash)); failTrashWrite = false;
assert.ok(files.has(folderTrash.destination + "/素材.png"), "Failed restore index write moves folder back into trash");
await reopened.restore(folderTrash); assert.ok(files.has("workflows/示例/素材.png")); assert.equal(reopened.deleted.length, 0);
files.set("allbuy/workflow-trash/index.json", [{ id: "evil", kind: "folder", deletedAt: 1, path: "safe", destination: "outside" }]);
await assert.rejects(library.trash("示例", "folder"), /损坏/); assert.ok(files.has("workflows/示例/素材.png")); files.delete("allbuy/workflow-trash/index.json");
files.set(metadataPath, { entries: { broken: { tags: "invalid" } } });
await assert.rejects(library.patch("new.json", { favorite: true }), /格式错误/);
console.log("Workflow library paths, content search, no-overwrite saves, metadata safety, move rollback and trash restore passed");
