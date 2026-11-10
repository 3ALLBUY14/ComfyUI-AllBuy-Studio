const METADATA = "allbuy/workflow-library.json";
const TRASH = "allbuy/workflow-trash/index.json";

function tagName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 50 || /[,，;；\x00-\x1f]/.test(value)) throw new Error("标签须为 1–50 字，不能包含逗号、分号或控制字符");
  return value.trim();
}
export function workflowTags(metadata) { return [...new Set([...(metadata.tags || []), ...Object.values(metadata.entries).flatMap(entry => entry.tags || [])])].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })); }
export function workflowFolderRoots(paths) {
  const sorted = [...new Set(paths.map(workflowPath))].sort();
  return sorted.filter(path => !sorted.some(parent => parent !== path && path.startsWith(parent + "/")));
}

export function workflowPath(value) {
  if (typeof value !== "string") throw new Error("请填写工作流路径");
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 240 || /[<>:"|?*\x00-\x1f]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) throw new Error("路径无效，请使用工作流目录内的相对路径");
  return path;
}
export function workflowData(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.nodes) || !Array.isArray(value.links) || value.nodes.some(node => !node || typeof node !== "object" || typeof node.type !== "string")) throw new Error("请选择 ComfyUI 界面保存的工作流 JSON（含 nodes / links），不支持 API 提示词格式");
  return value;
}
export function workflowSummary(data, available = {}) {
  workflowData(data);
  const strings = [], models = new Set(), missing = new Set();
  const subgraphs = Array.isArray(data.definitions?.subgraphs) ? data.definitions.subgraphs : [];
  const subgraphIds = new Set(subgraphs.map(graph => graph.id));
  let size = 0;
  const visit = (value, depth = 0) => {
    if (size > 160000 || depth > 12) return;
    if (typeof value === "string" && !value.startsWith("data:")) {
      const text = value.slice(0, 5000); strings.push(text); size += text.length;
      if (/\.(safetensors|ckpt|gguf|pth|pt|bin|onnx)$/i.test(value) && value.length < 500) models.add(value);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach(item => visit(item, depth + 1));
  };
  for (const node of [...data.nodes, ...subgraphs.flatMap(graph => Array.isArray(graph.nodes) ? graph.nodes : [])]) {
    if (!node || typeof node.type !== "string") continue;
    strings.push(node.type, String(node.title || "")); visit(node.widgets_values); visit(node.properties);
    if (!available[node.type] && !subgraphIds.has(node.type) && !node.type.startsWith("workflow/")) missing.add(node.type);
  }
  return { count: data.nodes.length, models: [...models], missing: [...missing], text: strings.join(" ").toLocaleLowerCase() };
}
export function filterWorkflows(items, metadata, query = "", filter = "", sort = "manual") {
  const needle = query.trim().toLocaleLowerCase();
  const result = items.filter(item => {
    const meta = metadata.entries?.[item.path] || {};
    if (filter === "favorite" && !meta.favorite) return false;
    if (filter === "root" && item.path.includes("/")) return false;
    if (filter.startsWith("folder:") && !item.path.startsWith(filter.slice(7) + "/")) return false;
    if (filter.startsWith("tag:") && !(meta.tags || []).includes(filter.slice(4))) return false;
    if (filter === "missing" && !item.summary?.missing.length) return false;
    return !needle || [item.path, meta.note || "", ...(meta.tags || []), item.summary?.text || ""].join(" ").toLocaleLowerCase().includes(needle);
  });
  return result.sort((a, b) => {
    if (sort === "favorite") {
      const delta = Number(!!metadata.entries?.[b.path]?.favorite) - Number(!!metadata.entries?.[a.path]?.favorite);
      if (delta) return delta;
    }
    if (["manual", "updated"].includes(sort)) return Number(b.modified || 0) - Number(a.modified || 0);
    return a.path.localeCompare(b.path, "zh-CN", { numeric: true }) * (sort === "desc" ? -1 : 1);
  });
}

// Include matching folders and their ancestors without changing the saved expansion state.
export function workflowFolderRows(folders, expanded = new Set(), query = "") {
  const children = new Map([["", []]]);
  for (const path of folders) {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(path);
  }
  const term = query.trim().toLocaleLowerCase(), visible = new Set();
  if (term) for (const path of folders) if (path.toLocaleLowerCase().includes(term)) {
    const parts = path.split("/");
    while (parts.length) { visible.add(parts.join("/")); parts.pop(); }
  }
  const rows = [];
  const visit = (parent, depth) => {
    for (const path of children.get(parent) || []) {
      if (term && !visible.has(path)) continue;
      const branch = !!children.get(path)?.length, open = branch && (term ? true : expanded.has(path));
      rows.push({ path, depth, branch, open });
      if (open) visit(path, depth + 1);
    }
  };
  visit("", 0); return rows;
}

// Folder categories follow the tags of contained workflows, including subfolders.
export function workflowDestinationFolders(folders, items, metadata, category = "") {
  if (!category) return folders;
  const tagged = new Set(), occupied = new Set();
  for (const item of items) {
    const tags = metadata.entries[item.path]?.tags || [], parts = item.path.split("/"); parts.pop();
    while (parts.length) {
      const path = parts.join("/"); occupied.add(path);
      if (category === "untagged" ? tags.length : tags.includes(category.slice(4))) tagged.add(path);
      parts.pop();
    }
  }
  return folders.filter(path => category === "empty" ? !occupied.has(path) : category === "untagged" ? !tagged.has(path) : tagged.has(path));
}

export class WorkflowLibrary {
  constructor(api) { this.api = api; this.items = []; this.folders = []; this.deleted = []; this.metadata = { version: 1, entries: {} }; this.cache = new Map(); }
  async checked(response) {
    if (!response.ok) throw new Error(response.status === 409 ? "目标名称已存在，请换一个名称" : `工作流操作失败 (${response.status})`);
    return response;
  }
  async readMetadata() {
    const response = await this.api.getUserData(METADATA, { cache: "no-store" });
    if (response.status === 404) return { version: 1, entries: {} };
    await this.checked(response);
    const data = await response.json();
    if (!data || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) throw new Error("工作流管理记录格式错误，已停止写入以保留原数据");
    if (data.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== "string"))) throw new Error("工作流标签记录格式错误，已停止写入");
    for (const entry of Object.values(data.entries)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some(tag => typeof tag !== "string")) || entry.note !== undefined && typeof entry.note !== "string" || entry.cover != null && typeof entry.cover !== "string") throw new Error("工作流管理记录格式错误，已停止写入以保留原数据");
    }
    return data;
  }
  async refresh() {
    const [files, metadata, deleted, directories] = await Promise.all([this.api.listUserDataFullInfo("workflows"), this.readMetadata(), this.readTrash(), this.readDirectories()]);
    if (!Array.isArray(files)) throw new Error("工作流列表格式错误");
    if (this.hasDirectoryListing) {
      const markers = [...files, ...(this.directoryMarkers || [])].filter(file => typeof file.path === "string" && /(?:^|\/)(?:_allbuy-folder|\.allbuy-folder)$/.test(file.path) && file.size === 0);
      for (const path of new Set(markers.map(file => workflowPath(file.path)))) {
        const response = await this.api.getUserData("workflows/" + path, { cache: "no-store" });
        if (response.status === 404) continue;
        await this.checked(response);
        if (await response.text() === "") await this.checked(await this.api.fetchApi("/userdata/" + encodeURIComponent("workflows/" + path), { method: "DELETE" }));
      }
    }
    const folders = new Set(directories);
    this.items = files.filter(file => typeof file.path === "string" && /\.json$/i.test(file.path)).map(file => {
      const path = workflowPath(file.path);
      const cached = this.cache.get(path);
      const item = { ...file, path, id: path, name: path.split("/").pop().replace(/\.json$/i, "") };
      if (cached && cached.modified === file.modified && cached.size === file.size) Object.assign(item, cached);
      return item;
    });
    for (const file of files) if (typeof file.path === "string") {
      const parts = file.path.replaceAll("\\", "/").split("/"); parts.pop();
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    this.folders = [...folders].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
    this.metadata = metadata; this.deleted = deleted;
    return this.items;
  }
  async readDirectories() {
    this.hasDirectoryListing = false; this.directoryMarkers = [];
    if (!this.api.fetchApi) return [];
    const response = await this.api.fetchApi("/v2/userdata?path=workflows", { cache: "no-store" });
    if (response.status === 404) return []; // Older ComfyUI versions only provide the file listing.
    await this.checked(response); const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("工作流目录列表格式错误");
    this.hasDirectoryListing = true;
    this.directoryMarkers = entries.filter(entry => entry.type === "file" && typeof entry.path === "string" && entry.path.startsWith("workflows/")).map(entry => ({ ...entry, path: entry.path.slice(10) }));
    return entries.filter(entry => entry.type === "directory").map(entry => {
      if (typeof entry.path !== "string" || !entry.path.startsWith("workflows/")) throw new Error("工作流目录路径无效");
      return workflowPath(entry.path.slice(10));
    });
  }
  async read(item, available) {
    if (item.data) return item.data;
    const response = await this.checked(await this.api.getUserData("workflows/" + workflowPath(item.path), { cache: "no-store" }));
    if (Number(response.headers?.get("Content-Length")) > 16 * 1024 * 1024) throw new Error("工作流过大，预览上限为 16 MB");
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error("工作流过大，预览上限为 16 MB");
    item.data = workflowData(JSON.parse(text)); item.summary = workflowSummary(item.data, available);
    this.cache.set(item.path, item);
    return item.data;
  }
  async patch(path, changes) {
    const metadata = await this.readMetadata();
    metadata.entries[path] = { ...metadata.entries[path], ...changes };
    await this.checked(await this.api.storeUserData(METADATA, metadata));
    this.metadata = metadata;
  }
  async tagAction(action, name, replacement) {
    name = tagName(name); const metadata = await this.readMetadata(), tags = workflowTags(metadata);
    if (action === "create") { if (tags.includes(name)) throw new Error("标签已存在"); metadata.tags = [...tags, name]; }
    else {
      if (!tags.includes(name)) throw new Error("标签已不存在，请刷新");
      if (!["rename", "delete"].includes(action)) throw new Error("标签操作无效");
      const target = action === "rename" ? tagName(replacement) : null;
      if (target && target !== name && tags.includes(target)) throw new Error("目标标签已存在");
      metadata.tags = tags.filter(tag => tag !== name); if (target) metadata.tags.push(target);
      for (const entry of Object.values(metadata.entries)) if (entry.tags?.includes(name)) entry.tags = [...new Set(entry.tags.flatMap(tag => tag === name ? target ? [target] : [] : [tag]))];
    }
    await this.checked(await this.api.storeUserData(METADATA, metadata)); this.metadata = metadata;
  }
  async patchTags(paths, add, remove) {
    add = [...new Set(add.map(tagName))]; remove = remove.map(tagName);
    const metadata = await this.readMetadata();
    for (const path of paths.map(workflowPath)) {
      const entry = metadata.entries[path] || {}, tags = [...new Set([...(entry.tags || []).filter(tag => !remove.includes(tag)), ...add])];
      if (tags.length > 50) throw new Error("每个工作流最多 50 个标签");
      metadata.entries[path] = { ...entry, tags };
    }
    await this.checked(await this.api.storeUserData(METADATA, metadata)); this.metadata = metadata;
  }
  async save(path, data) {
    path = workflowPath(path);
    if (!/\.json$/i.test(path)) path += ".json";
    await this.checked(await this.api.storeUserData("workflows/" + path, workflowData(data), { overwrite: false, stringify: true, throwOnError: false }));
    return path;
  }
  async move(source, destination) {
    source = workflowPath(source); destination = workflowPath(destination);
    if (!/\.json$/i.test(destination)) destination += ".json";
    if (source === destination) return;
    const metadata = await this.readMetadata();
    await this.checked(await this.api.moveUserData("workflows/" + source, "workflows/" + destination, { overwrite: false }));
    if (metadata.entries[source]) {
      metadata.entries[destination] = metadata.entries[source]; delete metadata.entries[source];
      try { await this.checked(await this.api.storeUserData(METADATA, metadata)); }
      catch (error) {
        await this.checked(await this.api.moveUserData("workflows/" + destination, "workflows/" + source, { overwrite: false }));
        throw error;
      }
    }
    this.metadata = metadata; this.cache.delete(source);
  }
  async createFolder(path) {
    path = workflowPath(path);
    if (this.folders.includes(path)) throw new Error("文件夹已存在");
    await this.checked(await this.api.storeUserData("workflows/" + path + "/_allbuy-folder", "", { overwrite: false, stringify: false, throwOnError: false }));
    if (this.hasDirectoryListing) await this.checked(await this.api.fetchApi("/userdata/" + encodeURIComponent("workflows/" + path + "/_allbuy-folder"), { method: "DELETE" }));
  }
  async readTrash() {
    const response = await this.api.getUserData(TRASH, { cache: "no-store" });
    if (response.status === 404) return [];
    await this.checked(response); const records = await response.json();
    if (!Array.isArray(records)) throw new Error("回收站记录损坏，已停止操作");
    const ids = new Set();
    for (const record of records) {
      if (!record || typeof record.id !== "string" || !/^[a-z0-9-]+$/.test(record.id) || ids.has(record.id) || !["workflow", "folder"].includes(record.kind) || !Number.isFinite(record.deletedAt) || record.destination !== "allbuy/workflow-trash/" + record.id + "/" + workflowPath(record.path)) throw new Error("回收站记录损坏，已停止操作");
      ids.add(record.id);
    }
    return records;
  }
  async trash(path, kind = "workflow") {
    path = workflowPath(path);
    if (!["workflow", "folder"].includes(kind)) throw new Error("回收项目类型无效");
    const records = await this.readTrash(), deletedAt = Date.now(), id = deletedAt + "-" + Math.random().toString(36).slice(2, 10);
    const destination = "allbuy/workflow-trash/" + id + "/" + path, record = { id, path, destination, kind, deletedAt };
    await this.checked(await this.api.moveUserData("workflows/" + path, destination, { overwrite: false }));
    try { await this.checked(await this.api.storeUserData(TRASH, [...records, record])); }
    catch (error) {
      try { await this.checked(await this.api.moveUserData(destination, "workflows/" + path, { overwrite: false })); }
      catch { throw new Error(`回收站记录写入失败，素材仍保存在 ${destination}，请手动恢复`); }
      throw error;
    }
    this.deleted = [...records, record]; return record;
  }
  async restore(record) {
    const records = await this.readTrash(), saved = records.find(item => item.id === record.id);
    if (!saved) throw new Error("回收项目已不存在，请刷新回收站");
    const target = "workflows/" + saved.path;
    await this.checked(await this.api.moveUserData(saved.destination, target, { overwrite: false }));
    const remaining = records.filter(item => item.id !== saved.id);
    try { await this.checked(await this.api.storeUserData(TRASH, remaining)); }
    catch (error) {
      try { await this.checked(await this.api.moveUserData(target, saved.destination, { overwrite: false })); }
      catch { throw new Error(`回收站记录更新失败，素材已恢复到 ${saved.path}，请刷新后检查`); }
      throw error;
    }
    this.deleted = remaining;
  }
}
