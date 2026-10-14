// Shared classification records; per-node view preferences live in workflow properties.
const API = "/allbuy_promptlibrary/lora_catalog";
const SORTS = [
  ["manual", "手动顺序"], ["name_asc", "名称 A→Z"], ["name_desc", "名称 Z→A"],
  ["weight_desc", "权重 高→低"], ["weight_asc", "权重 低→高"],
  ["enabled", "启用优先"], ["favorite", "收藏优先"], ["tag", "按标签排序"],
];
const compare = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" }).compare;
let data = { tags: [], models: {} };
let loaded = false;
let pending = null;
const listeners = new Set();
const key = (name) => String(name || "").trim().replaceAll("\\", "/");
const tagsOf = (name) => {
  const labels = Object.hasOwn(data.models, key(name)) ? data.models[key(name)] : [];
  return Array.isArray(labels) ? labels : [];
};

function element(tag, cls = "", text = "") {
  const el = document.createElement(tag);
  el.className = cls;
  el.textContent = text;
  return el;
}
function control(el) {
  el.classList.add("alora-control");
  for (const event of ["pointerdown", "mousedown", "touchstart", "keydown"]) el.addEventListener(event, (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  return el;
}
function button(text, title, action, cls = "") {
  const el = control(element("button", "vpl-btn " + cls, text));
  el.type = "button";
  el.title = title;
  el.addEventListener("click", (e) => { e.stopPropagation(); action(); });
  return el;
}
function select(label, options) {
  const el = control(element("select", "vpl-input alora-catalog-select"));
  el.setAttribute("aria-label", label);
  el.title = label;
  for (const [value, text] of options) {
    const option = element("option", "", text);
    option.value = value;
    el.appendChild(option);
  }
  return el;
}
function chip(tag, action) {
  const el = button(tag, tag, action, "alora-tag-chip");
  let hash = 0;
  for (const char of tag) hash = ((hash * 31) + char.codePointAt(0)) | 0;
  el.style.setProperty("--alora-tag-color", `hsl(${(hash >>> 0) % 360} 65% 72%)`);
  return el;
}
async function request(action) {
  const response = await fetch(API + (action ? "/update" : ""), action ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
  } : { cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(response.status === 404
    ? "请重启 ComfyUI，加载标签接口" : result.error || `HTTP ${response.status}`);
  if (!Array.isArray(result.tags) || !result.models || typeof result.models !== "object" || Array.isArray(result.models)) {
    throw new Error("LoRA 标签数据格式错误");
  }
  data = result;
  loaded = true;
  for (const listener of listeners) listener(action);
  if (action) window.dispatchEvent(new CustomEvent("allbuy-lora-data-changed", { detail: { origin: "node" } }));
  return data;
}
function load() {
  pending = pending || request().finally(() => { pending = null; });
  return pending;
}
function normalView(raw = {}) {
  if (!raw || typeof raw !== "object") raw = {};
  return { sort: SORTS.some(([value]) => value === raw.sort) ? raw.sort : "manual",
    query: typeof raw.query === "string" ? raw.query : "",
    tag: typeof raw.tag === "string" && (raw.tag === "@" || raw.tag.startsWith("#")) ? raw.tag : "",
    state: ["all", "enabled", "disabled", "favorite"].includes(raw.state) ? raw.state : "all" };
}

export function installLoRACatalog(node, hooks, search) {
  let view = normalView(node.properties?.allbuyLoraView);
  let closeDialog = null;
  let redrawDialog = null;
  let disposed = false;
  const toolbar = element("div", "alora-catalog-toolbar");
  const status = element("div", "alora-catalog-status");
  status.setAttribute("role", "status");
  const sort = select("LoRA 排序", SORTS);
  const tagFilter = select("按标签筛选", []);
  const state = select("按启用状态筛选", [["all", "全部状态"], ["enabled", "仅启用"], ["disabled", "仅停用"], ["favorite", "仅收藏"]]);
  const favorites = () => new Set((hooks.getFavorites?.() || []).map(key));
  const persist = () => {
    node.properties = node.properties || {};
    const changed = JSON.stringify(node.properties.allbuyLoraView) !== JSON.stringify(view);
    node.properties.allbuyLoraView = { ...view };
    node._stackFilter = view.query.trim().toLowerCase();
    if (changed) node.graph?.change?.();
  };
  const updateControls = () => {
    if (loaded && view.tag.startsWith("#") && !data.tags.includes(view.tag.slice(1))) {
      view.tag = "";
      persist();
    }
    tagFilter.replaceChildren();
    const tags = [...data.tags].sort(compare);
    if (!loaded && view.tag.startsWith("#") && !tags.includes(view.tag.slice(1))) tags.push(view.tag.slice(1));
    for (const [value, text] of [["", "全部标签"], ["@", "未分类"], ...tags.map((name) => ["#" + name, name])]) {
      const option = element("option", "", text);
      option.value = value;
      tagFilter.appendChild(option);
    }
    tagFilter.value = view.tag;
    sort.value = view.sort;
    state.value = view.state;
    search.value = view.query;
  };
  const filterChanged = () => {
    persist();
    hooks.applyRowFilter();
    node._aloraMultiSelect?.sync();
    hooks.recalcStackHeight();
  };
  search.placeholder = "搜索名称 / 标签…";
  search.setAttribute("aria-label", "筛选 LoRA 名称或标签");
  search.addEventListener("input", () => { view.query = search.value; filterChanged(); });
  tagFilter.addEventListener("change", () => { view.tag = tagFilter.value; filterChanged(); });
  state.addEventListener("change", () => { view.state = state.value; filterChanged(); });
  sort.addEventListener("change", () => {
    view.sort = sort.value;
    persist();
    hooks.writeStack();
    hooks.renderStack();
  });
  const filterTag = (tag) => {
    view.tag = "#" + tag;
    view.query = "";
    view.state = "all";
    updateControls();
    filterChanged();
  };
  const matchesName = (name, query, tag) => {
    const labels = tagsOf(name);
    return (!query || (key(name) + " " + labels.join(" ")).toLowerCase().includes(query.toLowerCase()))
      && (!tag || (tag === "@" ? !labels.length : labels.includes(tag.slice(1))));
  };
  const matches = (entry) => matchesName(entry.name, node._stackFilter || "", view.tag)
    && (view.state === "all" || (view.state === "enabled" && entry.enabled)
      || (view.state === "disabled" && !entry.enabled) || (view.state === "favorite" && favorites().has(key(entry.name))));
  const sorted = (entries, mode) => {
    if (mode === "manual") return [...entries];
    const fav = favorites();
    return entries.map((entry, index) => ({ entry, index })).sort((a, b) => {
      const x = a.entry, y = b.entry;
      let order = 0;
      if (mode === "name_asc" || mode === "name_desc") order = compare(key(x.name).split("/").pop(), key(y.name).split("/").pop()) * (mode === "name_desc" ? -1 : 1);
      if (mode === "weight_asc" || mode === "weight_desc") order = (Number(x.weight) - Number(y.weight)) * (mode === "weight_desc" ? -1 : 1);
      if (mode === "enabled") order = Number(!!y.enabled) - Number(!!x.enabled);
      if (mode === "favorite") order = Number(fav.has(key(y.name))) - Number(fav.has(key(x.name)));
      if (mode === "tag") order = compare(tagsOf(x.name).slice().sort(compare).join(" / ") || "\uffff", tagsOf(y.name).slice().sort(compare).join(" / ") || "\uffff");
      return order || a.index - b.index;
    }).map(({ entry }) => entry);
  };
  const sortEntries = () => {
    const original = node._stackEntries || [];
    const result = sorted(original, view.sort);
    if (!result.some((entry, index) => entry !== original[index])) return false;
    node._stackEntries = result;
    return true;
  };
  const canAddTag = (tag) => {
    const existing = new Set((node._stackEntries || []).map((entry) => key(entry.name)));
    return (node._loraOptions || []).some((name) => name !== "None" && tagsOf(name).includes(tag) && !existing.has(key(name)));
  };
  const addTag = (tag) => {
    const existing = new Set((node._stackEntries || []).map((entry) => key(entry.name)));
    const names = sorted((node._loraOptions || []).filter((name) => name !== "None" && tagsOf(name).includes(tag))
      .map((name) => ({ name })), "name_asc").map((entry) => entry.name).filter((name) => !existing.has(key(name)));
    for (const name of names) node._stackEntries.push({ ...hooks.defaultEntry(), name });
    if (names.length) {
      controller.revealEntries();
      hooks.writeStack();
      hooks.renderStack();
    }
    return names.length;
  };
  const editTags = (rawNames = []) => {
    node._aloraPickerClose?.();
    closeDialog?.();
    const names = [...new Set(rawNames.map(key).filter((name) => name && name !== "None"))];
    const overlay = element("div", "vpl-overlay alora-tag-overlay");
    const dialog = element("div", "vpl-dialog alora-tag-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", names.length ? "编辑 LoRA 标签" : "LoRA 标签管理");
    dialog.setAttribute("aria-modal", "true");
    const close = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      if (closeDialog === close) { closeDialog = null; redrawDialog = null; }
    };
    closeDialog = close;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    const title = element("div", "vpl-dialog-title");
    const closeBtn = button("✕", "关闭", close);
    title.append(element("span", "", names.length ? `编辑标签 · ${names.length} 个 LoRA` : "LoRA 标签管理"), closeBtn);
    const body = element("div", "vpl-dialog-body alora-tag-body");
    const description = element("div", "alora-tag-description", names.length ? names.join(" · ") : "自定义标签可用于所有 LoRA 节点和保存列表");
    const createRow = element("div", "alora-presets-save");
    const input = control(element("input", "vpl-input"));
    input.placeholder = "新标签名称，回车添加";
    input.maxLength = 64;
    input.setAttribute("aria-label", "新标签名称");
    const message = element("div", "alora-presets-message");
    message.setAttribute("role", "status");
    const choices = element("div", names.length ? "alora-tag-choices" : "alora-tag-list");
    const changes = new Map();
    let busy = !loaded;
    const report = (text, error = false) => { message.textContent = text; message.classList.toggle("error", error); };
    const sync = () => {
      for (const item of dialog.querySelectorAll("input, button")) if (item !== closeBtn && item !== cancel) item.disabled = busy || item.dataset.unavailable === "true";
      create.disabled = save.disabled = busy || !loaded;
    };
    const perform = async (action, text, after) => {
      if (busy) return;
      busy = true;
      sync();
      try {
        await request(action);
        if (!overlay.isConnected) return;
        after?.();
        report(text);
        draw();
      } catch (err) { if (overlay.isConnected) report(err.message, true); }
      finally { busy = false; if (overlay.isConnected) sync(); }
    };
    const submitTag = async () => {
      if (busy || !loaded) return;
      const name = input.value.trim();
      if (!name) { report("请填写标签名称", true); input.focus(); return; }
      await perform({ action: "create_tag", name }, "标签已创建", () => {
        if (names.length) changes.set(name, true);
        input.value = "";
      });
      if (overlay.isConnected) input.focus();
    };
    const create = button("创建标签", "创建自定义标签，也可按 Enter 添加", submitTag);
    const paste = button("粘贴", "从剪贴板粘贴标签名称", async () => {
      if (busy) return;
      busy = true; sync();
      try {
        const text = await navigator.clipboard.readText();
        if (!overlay.isConnected) return;
        if (text.trim()) {
          input.value = text.trim().slice(0, input.maxLength);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          report("");
        } else report("剪贴板没有文本，请输入标签名称", true);
      } catch (_) {
        if (overlay.isConnected) report("无法读取剪贴板，请按 Ctrl+V 粘贴", true);
      } finally {
        busy = false;
        if (overlay.isConnected) { sync(); input.focus(); }
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      if (!e.repeat) submitTag();
    });
    createRow.append(input, paste, create);
    const draw = () => {
      choices.replaceChildren();
      for (const tag of [...data.tags].sort(compare)) {
        if (names.length) {
          const label = control(element("label", "alora-tag-option"));
          const check = element("input", "vpl-checkbox");
          check.type = "checkbox";
          check.setAttribute("aria-label", "标签：" + tag);
          const count = names.filter((name) => tagsOf(name).includes(tag)).length;
          check.checked = changes.has(tag) ? changes.get(tag) : count === names.length;
          check.indeterminate = !changes.has(tag) && count > 0 && count < names.length;
          check.addEventListener("change", () => changes.set(tag, check.checked));
          label.append(check, element("span", "", tag));
          choices.appendChild(label);
        } else {
          const row = element("div", "alora-tag-manage-row");
          row.append(chip(tag, () => { filterTag(tag); close(); }),
            element("span", "alora-group-count", `${Object.values(data.models).filter((labels) => labels.includes(tag)).length} 个模型`));
          const rename = button("重命名", "重命名标签及所有模型的关联记录", () => {
            const editor = control(element("input", "vpl-input"));
            editor.value = tag;
            editor.maxLength = 64;
            editor.setAttribute("aria-label", "标签新名称");
            rename.replaceWith(editor);
            editor.focus();
            editor.select();
            editor.addEventListener("keydown", (e) => {
              if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229 && !e.repeat) {
                e.preventDefault();
                perform({ action: "rename_tag", name: tag, new_name: editor.value }, "标签已重命名");
              }
            });
          });
          const add = button("同标签加入", "将可用且尚未添加的同标签 LoRA 加入列表", () => { addTag(tag); close(); });
          add.dataset.unavailable = String(!canAddTag(tag));
          row.append(add, rename, button("删除", "删除此标签及其关联记录", () => {
            if (window.confirm(`删除标签「${tag}」及其关联记录？`)) perform({ action: "delete_tag", name: tag }, "标签已删除");
          }, "alora-clear"));
          choices.appendChild(row);
        }
      }
      if (!data.tags.length) choices.appendChild(element("div", "vpl-empty", "还没有标签，请先创建"));
    };
    redrawDialog = draw;
    const save = button("保存标签", "保存所选 LoRA 的标签修改，保留未操作的标签", () => {
      const add = [], remove = [];
      for (const [tag, enabled] of changes) if (data.tags.includes(tag)) (enabled ? add : remove).push(tag);
      if (!add.length && !remove.length) { close(); return; }
      perform({ action: "patch_tags", models: names, add, remove }, "标签已保存", close);
    }, "vpl-btn-primary");
    save.hidden = !names.length;
    const cancel = button(names.length ? "取消" : "关闭", "关闭标签窗口", close);
    const refresh = button("刷新", "重新读取标签记录", async () => {
      if (busy) return;
      busy = true; sync();
      try { await load(); if (overlay.isConnected) { draw(); report(""); } }
      catch (err) { if (overlay.isConnected) report(err.message, true); }
      finally { busy = false; if (overlay.isConnected) sync(); }
    });
    const footer = element("div", "vpl-dialog-footer");
    footer.append(refresh, save, cancel);
    body.append(description, createRow, message, choices);
    dialog.append(title, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    draw(); sync(); input.focus();
    if (!loaded) load().then(() => { if (overlay.isConnected) { busy = false; draw(); sync(); } })
      .catch((err) => { if (overlay.isConnected) { busy = false; report(err.message, true); sync(); } });
  };
  toolbar.append(search, sort, tagFilter, state, button("标签管理", "创建、重命名、删除和使用标签", () => editTags()), status);
  const onData = (action) => {
    if (disposed) return;
    status.textContent = "";
    if (action?.action === "rename_tag" && view.tag === "#" + action.name) view.tag = "#" + action.new_name.trim();
    if (view.tag.startsWith("#") && !data.tags.includes(view.tag.slice(1))) view.tag = "";
    const picker = node.properties?.allbuyLoraPicker;
    if (picker) {
      const previous = picker.tag;
      if (action?.action === "rename_tag" && picker.tag === "#" + action.name) picker.tag = "#" + action.new_name.trim();
      if (picker.tag?.startsWith("#") && !data.tags.includes(picker.tag.slice(1))) picker.tag = "";
      if (previous !== picker.tag) node.graph?.change?.();
    }
    persist(); updateControls();
    node._aloraPickerClose?.();
    hooks.renderStack();
    node._aloraPresetTagsSync?.();
    redrawDialog?.();
  };
  listeners.add(onData);
  const controller = {
    toolbar, matches, sortEntries, editTags, tagsOf, addTag,
    sortedEntries(entries, mode) { return sorted(entries, mode); },
    sortControl(mode, onChange) {
      const el = select("保存列表排序", SORTS);
      el.value = normalView({ sort: mode }).sort;
      el.addEventListener("change", () => onChange(el.value));
      return el;
    },
    sortedNames(names, mode) { return sorted(names.map((name) => ({ name })), mode).map((entry) => entry.name); },
    matchesName,
    snapshotSort() { return { sort: view.sort }; },
    setManualOrder() { view.sort = "manual"; persist(); updateControls(); },
    restoreSort(raw) { view.sort = normalView(raw).sort; persist(); updateControls(); },
    restoreView() { view = normalView(node.properties?.allbuyLoraView); persist(); updateControls(); },
    revealEntries() { view.query = ""; view.tag = ""; view.state = "all"; persist(); updateControls(); },
    rowTags(name) {
      const box = element("div", "alora-row-tags");
      for (const tag of tagsOf(name).slice(0, 3)) box.appendChild(chip(tag, () => filterTag(tag)));
      const more = tagsOf(name).length - 3;
      const edit = button(more > 0 ? `+${more} 标签` : "＋标签", "编辑此 LoRA 的分类标签", () => editTags([name]), "alora-tag-edit");
      edit.disabled = !name || name === "None";
      box.appendChild(edit);
      return box;
    },
    decoratePickerRow(row, name, onTag) {
      const box = element("div", "alora-picker-tags");
      for (const tag of tagsOf(name)) box.appendChild(chip(tag, () => onTag(tag)));
      if (!tagsOf(name).length) box.appendChild(element("span", "alora-tag-empty", "未分类"));
      row.appendChild(box);
    },
    pickerControls(onChange) {
      const raw = node.properties?.allbuyLoraPicker || {};
      const tags = select("选择器标签筛选", [["", "全部标签"], ["@", "未分类"], ...data.tags.slice().sort(compare).map((name) => ["#" + name, name])]);
      const sorting = select("选择器排序", SORTS.filter(([value]) => ["name_asc", "name_desc", "favorite", "tag"].includes(value)));
      tags.value = raw.tag || "";
      sorting.value = ["name_asc", "name_desc", "favorite", "tag"].includes(raw.sort) ? raw.sort : "name_asc";
      const bar = element("div", "alora-picker-controls");
      const add = button("同标签加入", "加入此标签的全部可用 LoRA，跳过重复项", () => {
        addTag(tags.value.slice(1));
        node._aloraPickerClose?.();
      });
      const sync = () => {
        add.disabled = !tags.value.startsWith("#") || !canAddTag(tags.value.slice(1));
        node.properties = node.properties || {};
        node.properties.allbuyLoraPicker = { tag: tags.value, sort: sorting.value };
        node.graph?.change?.();
        onChange();
      };
      tags.addEventListener("change", sync);
      sorting.addEventListener("change", sync);
      add.disabled = !tags.value.startsWith("#") || !canAddTag(tags.value.slice(1));
      bar.append(tags, sorting, add);
      return { bar, tags, sorting, setTag(tag) { tags.value = "#" + tag; sync(); } };
    },
    refresh: load,
    closeDialog() { closeDialog?.(); },
    destroy() { disposed = true; listeners.delete(onData); closeDialog?.(); },
  };
  node._aloraCatalog = controller;
  persist(); updateControls();
  load().catch((err) => { if (!disposed) status.textContent = "标签加载失败：" + err.message; });
  return controller;
}
