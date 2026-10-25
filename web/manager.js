import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { openEditor, uid } from "./editor_dialog.js";
import { modelKey, categoriesOf, locatorKey, shortName, filterManagerItems, validatePresetEntries, managerAppearance, managerVisualPreferences } from "./manager_data.js";
import { mediaThumbnail, openMediaLightbox, promptMedia, attachMediaDrop, previewFileKind } from "./manager_media.js";
import { createManagerSelect, showManagerContext, hasManagerPopup, closeManagerPopup } from "./manager_controls.js";
import { ManagerStackEditor } from "./manager_stack.js";
import { ManagerWorkflows } from "./manager_workflows.js";

const API = "/allbuy_promptlibrary";
const STORAGE = "allbuy-manager.v1";
const PAGE_SIZE = 80;
const TABS = { prompts: "提示词组", loras: "LoRA 模型", stacks: "LoRA 堆栈", presets: "LoRA 组合", workflows: "工作流管理" };
const icons = {
  library: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  prompts: '<path d="M7 4h10M12 4v16M8 20h8"/>',
  loras: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  presets: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  stacks: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="15" width="18" height="5" rx="1.5"/><path d="M7 9v6m10-6v6"/>',
  workflows: '<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/><path d="M9 7h8v7M6 10v7h9"/>',
  bookmark: '<path d="M6 4h12v17l-6-4-6 4V4Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>',
  glass: '<rect x="3" y="3" width="13" height="13" rx="2"/><path d="M8 16v3a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-3M6 10l4-4"/>',
  native: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
};
function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}
function icon(name) {
  const node = el("span", "abm-icon");
  node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.library}</svg>`;
  return node;
}
function button(text, action, className = "") {
  const node = el("button", "abm-button " + className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
function input(label, value = "", type = "text") {
  const node = el("input", "abm-input");
  node.type = type;
  node.value = value;
  node.setAttribute("aria-label", label);
  node.placeholder = label;
  return node;
}
function select(label, options, value, action) {
  return createManagerSelect(label, options, value, action);
}
function field(label, node) {
  const wrapper = el("label", "abm-field");
  wrapper.append(el("span", "abm-label", label), node);
  return wrapper;
}
function readPreferences() {
  try { return JSON.parse(localStorage.getItem(STORAGE)) || {}; } catch { return {}; }
}
function savePreferences(patch) {
  try { localStorage.setItem(STORAGE, JSON.stringify({ ...readPreferences(), ...patch })); } catch { /* Private browsing remains usable. */ }
}
async function request(path, body) {
  const response = await api.fetchApi(path.startsWith("/object_info") ? path : API + path, body === undefined
    ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) throw new Error(result.error || `请求失败 (${response.status})，请刷新或重启 ComfyUI`);
  return result;
}
function download(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = el("a");
  link.href = url;
  link.download = name.replace(/[\\/:*?"<>|]/g, "_") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return; } catch { /* HTTP LAN fallback. */ }
  const area = el("textarea");
  area.value = text;
  area.style.cssText = "position:fixed;opacity:0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("复制失败，请手动选择文字复制");
}

let manager = null;
let launcher = null;

class Manager {
  constructor() {
    const prefs = readPreferences();
    this.tab = TABS[prefs.tab] ? prefs.tab : "prompts";
    this.view = ["list", "masonry"].includes(prefs.view) ? prefs.view : "grid";
    this.locator = prefs.locator;
    this.libraries = [];
    this.library = null;
    this.models = [];
    this.groups = [];
    this.catalog = { tags: [], models: {} };
    this.previews = {};
    this.appearance = managerAppearance(prefs);
    this.visual = managerVisualPreferences(prefs);
    this.presets = [];
    this.ready = { stacks: true };
    this.errors = {};
    this.drafts = new Map();
    this.selection = new Set();
    this.focused = null;
    this.filter = "";
    this.sort = "manual";
    this.limit = PAGE_SIZE;
    this.epoch = 0;
    this.busy = false;
    this.loading = false;
    this.restoreFocus = document.activeElement;
    this.root = el("div", "abm-overlay");
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-modal", "true");
    this.root.setAttribute("aria-labelledby", "abm-title");
    this.root.tabIndex = -1;
    this.applyAppearance();
    this.build();
    this.stackEditor = new ManagerStackEditor(this, { app, el, button, input, field, select });
    this.workflows = new ManagerWorkflows(this, { app, api, el, button, input, field, select, readPreferences, savePreferences });
    this.onKey = event => {
      if (hasManagerPopup() || this.childModal || this.mediaClose || document.querySelector("body > .vpl-overlay")) return;
      if (event.key === "Escape" && event.target.matches?.(".abm-folder-search") && event.target.value) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
      if (event.key === "Tab") {
        const focusable = [...this.root.querySelectorAll("button,input,select,textarea,a[href],[tabindex='0']")]
          .filter(node => !node.disabled && node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !this.root.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !this.root.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", this.onKey, true);
    for (const name of ["pointerdown", "mousedown", "wheel", "keydown", "keyup"]) this.root.addEventListener(name, event => event.stopPropagation());
    this.onSaved = event => {
      if (event.detail?.origin === "manager" || this.busy) return;
      if (!event.detail?.locator || locatorKey(event.detail.locator) === locatorKey(this.locator)) this.refresh();
    };
    window.addEventListener("allbuy-promptlibrary-saved", this.onSaved);
    window.addEventListener("allbuy-lora-data-changed", this.onSaved);
    document.body.appendChild(this.root);
    this.inertSiblings = [...document.body.children].filter(node => node !== this.root && !node.inert);
    for (const node of this.inertSiblings) node.inert = true;
    this.search.focus();
    this.refresh();
  }

  build() {
    const header = el("header", "abm-header");
    const brand = el("div", "abm-brand");
    const brandText = el("div");
    const title = el("h1", "", "AllBuy Studio");
    title.title = "AllBuy 创作套件 · 资源管理";
    title.id = "abm-title";
    brandText.append(title);
    brand.append(icon("library"), brandText);
    const tabs = el("nav", "abm-tabs");
    tabs.setAttribute("aria-label", "资源类型");
    this.tabButtons = {};
    for (const [key, label] of Object.entries(TABS)) {
      const node = button(label, () => this.switchTab(key), "abm-tab");
      node.prepend(icon(key));
      this.tabButtons[key] = node;
      tabs.appendChild(node);
    }
    const close = button("", () => this.close(), "abm-icon-button");
    close.append(icon("close"));
    close.setAttribute("aria-label", "收起管理面板");
    close.title = "收起面板 · Esc";
    const settings = el("div", "abm-header-settings");
    this.themeButton = button("", () => this.setVisual({ theme: this.visual.theme === "light" ? "dark" : "light" }), "abm-setting-button");
    this.launcherStyleButton = button("", () => this.setVisual({ launcherStyle: this.visual.launcherStyle === "glass" ? "native" : "glass" }), "abm-setting-button");
    settings.append(this.themeButton, this.launcherStyleButton); this.applyAppearance();
    const appearance = el("div", "abm-appearance");
    for (const [key, label, min, max, step, suffix] of [["scale", "界面", 80, 140, 5, "%"], ["fontSize", "字体", 11, 20, 1, "px"]]) {
      const control = input(label + "大小", this.appearance[key], "range");
      control.min = min; control.max = max; control.step = step;
      control.value = this.appearance[key]; // Set after bounds; native range inputs otherwise clamp restored scales to 100.
      const output = el("output", "", this.appearance[key] + suffix);
      const wrapper = el("label", "abm-size-control");
      wrapper.append(el("span", "", label), control, output);
      control.addEventListener("input", () => {
        this.appearance[key] = Number(control.value);
        output.textContent = control.value + suffix;
        if (!this.appearanceFrame) this.appearanceFrame = requestAnimationFrame(() => { this.appearanceFrame = null; this.applyAppearance(); });
      });
      control.addEventListener("change", () => { this.applyAppearance(); savePreferences(this.appearance); });
      appearance.appendChild(wrapper);
    }
    appearance.appendChild(button("重置", () => {
      this.appearance = managerAppearance(); this.applyAppearance(); savePreferences(this.appearance);
      appearance.querySelectorAll("input").forEach((control, index) => {
        const value = index === 0 ? this.appearance.scale : this.appearance.fontSize;
        control.value = value; control.nextElementSibling.textContent = value + (index === 0 ? "%" : "px");
      });
    }));
    header.append(brand, tabs, settings, close);
    const workspace = el("div", "abm-workspace");
    this.sidebar = el("aside", "abm-sidebar");
    this.sidebar.setAttribute("aria-label", "资源分类");
    const center = el("main", "abm-main");
    const heading = el("div", "abm-heading");
    const titles = el("div");
    this.heading = el("h2");
    this.subtitle = el("div", "abm-muted");
    titles.append(this.heading, this.subtitle);
    this.actions = el("div", "abm-actions");
    heading.append(titles, this.actions);
    const toolbar = el("div", "abm-toolbar");
    const searchBox = el("div", "abm-search");
    this.search = input("搜索名称、标签和内容", "", "search");
    this.search.addEventListener("input", () => { this.limit = PAGE_SIZE; this.renderItems(); });
    searchBox.append(icon("search"), this.search);
    const sort = select("排序方式", [["manual", "原始顺序"], ["name", "名称 A → Z"], ["desc", "名称 Z → A"], ["favorite", "收藏优先"], ["updated", "最近更新"]], this.sort,
      value => { this.sort = value; this.renderItems(); });
    this.sortSelect = sort;
    const viewSwitch = el("div", "abm-view-switch");
    this.viewButtons = {};
    for (const [mode, label, glyph] of [["grid", "卡片视图", "▦"], ["list", "列表视图", "☷"], ["masonry", "瀑布流视图", "▥"]]) {
      const node = button(glyph, () => this.setView(mode), "abm-icon-button");
      node.setAttribute("aria-label", label);
      node.title = label;
      this.viewButtons[mode] = node;
      viewSwitch.appendChild(node);
    }
    toolbar.append(searchBox, sort, viewSwitch);
    this.list = el("div", "abm-results");
    this.list.setAttribute("aria-label", "资源列表");
    this.list.tabIndex = 0;
    this.list.addEventListener("contextmenu", event => {
      if (event.target.closest(".abm-card") || ["stacks", "workflows"].includes(this.tab)) return;
      event.preventDefault(); event.stopPropagation();
      if (this.busy || this.loading) return;
      const chooseView = value => this.setView(value);
      showManagerContext(this.list, [
        { label: "全选当前结果", action: () => { this.filtered().forEach(item => this.selection.add(item.id)); this.renderItems(); } },
        { label: "清除选择", action: () => { this.selection.clear(); this.renderItems(); } },
        { separator: true },
        ...[["grid", "卡片"], ["list", "列表"], ["masonry", "瀑布流"]].map(([value, label]) => ({ label: (this.view === value ? "✓ " : "") + label, action: () => chooseView(value) })),
        { separator: true }, { label: "刷新资源", action: () => this.refresh() },
      ], event.clientX, event.clientY);
    });
    this.detail = el("aside", "abm-detail");
    this.detail.setAttribute("aria-label", "资源详情");
    center.append(heading, toolbar, this.list);
    workspace.append(this.sidebar, center, this.detail);
    const footer = el("footer", "abm-footer");
    this.status = el("div", "abm-status");
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.batch = el("div", "abm-batch");
    footer.append(appearance, this.status, this.batch);
    this.shell = el("div", "abm-shell");
    // Unscaled footer controls keep their physical track geometry stable while dragging.
    this.shell.appendChild(workspace);
    this.root.append(header, this.shell, footer);
  }

  applyAppearance() {
    this.root.dataset.theme = this.visual.theme;
    this.root.style.setProperty("--abm-ui-scale", this.appearance.scale / 100);
    this.root.style.setProperty("--abm-font-size", this.appearance.fontSize + "px");
    if (this.themeButton) {
      this.themeButton.replaceChildren(icon(this.visual.theme === "light" ? "sun" : "moon"), el("span", "abm-setting-label", this.visual.theme === "light" ? "亮色" : "深色"));
      this.themeButton.title = this.visual.theme === "light" ? "切换为深色主题" : "切换为亮色主题";
      this.themeButton.setAttribute("aria-label", this.themeButton.title); this.themeButton.setAttribute("aria-pressed", String(this.visual.theme === "light"));
      const glass = this.visual.launcherStyle === "glass";
      this.launcherStyleButton.replaceChildren(icon(glass ? "glass" : "native"), el("span", "abm-setting-label", glass ? "玻璃浮窗" : "原色浮窗"));
      this.launcherStyleButton.title = glass ? "资源管理按钮：玻璃质感，点击切换为 ComfyUI 原色" : "资源管理按钮：ComfyUI 原色，点击切换为玻璃质感";
      this.launcherStyleButton.setAttribute("aria-label", this.launcherStyleButton.title); this.launcherStyleButton.setAttribute("aria-pressed", String(!glass));
    }
  }
  setVisual(patch) {
    closeManagerPopup(); this.visual = managerVisualPreferences({ ...this.visual, ...patch }); savePreferences(this.visual);
    this.applyAppearance(); applyLauncherAppearance(this.visual);
  }
  stopMedia(host) { host.querySelectorAll("video").forEach(video => video.pause()); }
  setView(mode) {
    if (this.busy || this.loading || mode === this.view) return;
    this.view = mode; savePreferences({ view: mode });
    const grid = this.list.querySelector(".abm-collection");
    if (!grid) return this.renderItems();
    grid.className = "abm-collection abm-" + mode;
    for (const [value, node] of Object.entries(this.viewButtons)) {
      node.classList.toggle("is-active", value === mode); node.setAttribute("aria-pressed", String(value === mode));
    }
    if (mode !== "masonry") grid.querySelectorAll(".abm-card").forEach(card => { card.style.gridRowEnd = ""; });
    this.observeMasonry(grid);
  }
  observeMasonry(grid) {
    this.masonryObserver?.disconnect(); cancelAnimationFrame(this.masonryFrame); this.masonryFrame = null;
    if (this.view !== "masonry") return;
    this.layoutMasonry();
    this.masonryObserver = new ResizeObserver(() => {
      if (!this.masonryFrame) this.masonryFrame = requestAnimationFrame(() => { this.masonryFrame = null; this.layoutMasonry(); });
    });
    grid.querySelectorAll(".abm-card").forEach(card => this.masonryObserver.observe(card));
  }
  mediaOptions(item, compact = true) {
    return { compact, onDrop: this.tab === "loras" && this.ready.previews ? file => this.dropPreview(item, file) : undefined };
  }
  async dropPreview(item, file) {
    if (this.busy || this.loading) return;
    const kind = previewFileKind(file);
    if (!kind) { this.report("请拖入支持的图片或视频文件", true); return; }
    let updated;
    await this.run(async () => { await this.uploadPreview(item, kind, file); updated = this.previews[modelKey(item.name)]; });
    return updated;
  }
  layoutMasonry() {
    const grid = this.list.querySelector(".abm-masonry");
    if (!grid) return;
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
    grid.querySelectorAll(".abm-card").forEach(card => {
      const span = Math.max(1, Math.ceil((card.offsetHeight + gap) / (1 + gap)));
      if (card.style.gridRowEnd !== `span ${span}`) card.style.gridRowEnd = `span ${span}`;
    });
  }
  previewOf(item) { return this.tab === "loras" ? this.previews[modelKey(item.name)] || {} : promptMedia(item); }
  openPreview(item, kind) {
    closeManagerPopup();
    const record = this.previewOf(item);
    if (!record.image && !record.video) {
      if (this.tab === "loras" && this.ready.previews) this.run(() => this.editPreviewPaths(item));
      return;
    }
    this.mediaClose?.();
    this.stopMedia(this.list); this.stopMedia(this.detail);
    this.mediaClose = openMediaLightbox(this.root, record, item.name, kind, () => { this.mediaClose = null; this.root.focus(); }, this.mediaOptions(item));
  }

  report(text, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle("abm-error", error);
  }
  items() { return this.tab === "workflows" ? this.workflows.items : this.tab === "stacks" ? [] : this.tab === "prompts" ? this.library?.groups || [] : this.tab === "loras" ? this.models.map(name => ({ id: name, name })) : this.presets; }
  filtered() { return filterManagerItems(this.items(), { tab: this.tab, query: this.search.value, filter: this.filter, sort: this.sort, catalog: this.catalog, groups: this.groups }); }
  selected() { return this.items().filter(item => this.selection.has(item.id)); }
  editable() { return this.tab === "prompts" && this.locator?.source === "user" && this.library && this.ready.prompts; }
  async run(action) {
    if (this.busy || this.loading) return;
    this.busy = true;
    this.root.setAttribute("aria-busy", "true");
    this.render();
    try { await action(); }
    catch (err) { this.report(err.message || String(err), true); }
    finally { this.busy = false; this.root.removeAttribute("aria-busy"); if (this.root.isConnected) this.render(); }
  }
  switchTab(tab) {
    if (this.busy || this.loading || tab === this.tab) return;
    if (this.tab === "workflows") this.workflows.rememberPosition();
    this.tab = tab;
    this.selection.clear(); this.focused = null; this.filter = ""; this.search.value = ""; this.limit = PAGE_SIZE;
    savePreferences({ tab });
    if (tab === "workflows") this.workflows.restorePosition();
    if (tab !== "workflows" && (!this.ready[tab] || tab === "stacks" && !this.modelInfo) && !this.errors[tab]) { this.refresh(); return; }
    this.render();
    this.report(this.errors[tab] || "勾选资源后，可添加到工作流", !!this.errors[tab]);
  }

  async refresh() {
    if (this.tab === "workflows") return this.workflows.refresh();
    if (this.busy || this.loading) return;
    this.loading = true;
    const epoch = ++this.epoch;
    this.report("正在读取资源…");
    this.render();
    const results = await Promise.allSettled([
      request("/libraries"), request("/object_info/AllBuyLoRAStack"), request("/lora_groups"), request("/lora_catalog"), request("/lora_presets"), request("/lora_previews"),
    ]);
    if (epoch !== this.epoch || !this.root.isConnected) return;
    this.errors = {};
    const failures = [];
    const assign = (index, tab, action) => {
      const result = results[index];
      if (result.status === "fulfilled") {
        try { action(result.value); this.ready[tab] = true; return; }
        catch (err) { result.reason = err; }
      }
      this.ready[tab] = false;
      this.errors[tab] = result.reason?.message || "数据格式错误";
      failures.push(this.errors[tab]);
    };
    assign(0, "prompts", data => { if (!Array.isArray(data.libraries)) throw new Error("提示词库格式错误"); this.libraries = data.libraries; });
    assign(1, "loras", data => {
      const options = data.AllBuyLoRAStack?.input?.optional?.lora_picker?.[0] || data.AllBuyLoRAStack?.input?.required?.lora_picker?.[0];
      if (!Array.isArray(options)) throw new Error("未找到 AllBuy LoRA 节点，请重启 ComfyUI");
      this.models = [...new Set(options.filter(name => name && name !== "None"))];
      this.modelInfo = data.AllBuyLoRAStack;
    });
    // Classification failures must disable mutations instead of overwriting disk with empty defaults.
    assign(2, "groups", data => { if (!Array.isArray(data.groups)) throw new Error("LoRA 分组格式错误"); this.groups = data.groups; });
    assign(3, "catalog", data => { if (!Array.isArray(data.tags) || !data.models) throw new Error("LoRA 标签格式错误"); this.catalog = data; });
    assign(4, "presets", data => { if (!Array.isArray(data.presets)) throw new Error("LoRA 组合格式错误"); this.presets = data.presets; });
    assign(5, "previews", data => { if (!data.models || Array.isArray(data.models)) throw new Error("LoRA 预览数据格式错误"); this.previews = data.models; });
    if (this.ready.prompts) {
      const match = this.libraries.find(item => locatorKey(item) === locatorKey(this.locator))
        || this.libraries.find(item => item.source === "user") || this.libraries[0];
      this.locator = match ? { source: match.source, name: match.name } : null;
      try { await this.loadLibrary(); } catch (err) { this.ready.prompts = false; this.errors.prompts = err.message; failures.push(err.message); }
    }
    this.loading = false;
    if (!this.root.isConnected) return;
    this.selection = new Set([...this.selection].filter(id => this.items().some(item => item.id === id)));
    this.render();
    this.report(failures.length ? failures.join("；") : "资源已更新 · 勾选后可添加到工作流", !!failures.length);
  }
  async loadLibrary() {
    const locator = this.locator;
    if (!locator) { this.library = null; return; }
    const data = await request("/library?locator=" + encodeURIComponent(JSON.stringify(locator)));
    if (!data.library || !Array.isArray(data.library.groups)) throw new Error("提示词库格式错误");
    if (locatorKey(locator) !== locatorKey(this.locator) || !this.root.isConnected) return;
    this.library = data.library;
    savePreferences({ locator });
  }
  async chooseLibrary(item) {
    await this.run(async () => {
      const previous = this.locator;
      this.locator = { source: item.source, name: item.name };
      try { await this.loadLibrary(); }
      catch (err) { this.locator = previous; throw err; }
      this.selection.clear(); this.focused = null; this.filter = ""; this.limit = PAGE_SIZE;
      this.report(item.readonly ? "内置库为只读，可另存为用户库后编辑" : "已切换提示词库");
    });
  }
  render() {
    closeManagerPopup();
    this.root.dataset.tab = this.tab;
    this.sortSelect.hidden = this.tab === "stacks";
    this.search.placeholder = this.tab === "stacks" ? "筛选堆栈模型 / 激活提示词…" : this.tab === "workflows" ? "搜索工作流、模型、节点、标签和备注…" : "搜索名称、标签和内容";
    for (const [tab, node] of Object.entries(this.tabButtons)) { node.classList.toggle("is-active", tab === this.tab); node.disabled = this.busy || this.loading; node.setAttribute("aria-pressed", String(tab === this.tab)); }
    this.heading.textContent = TABS[this.tab];
    if (this.tab === "workflows") { this.workflows.render(); return; }
    this.renderSidebar(); this.renderActions(); this.renderItems();
  }
  navItem(label, filter, count) {
    const node = button("", () => { this.filter = filter; this.limit = PAGE_SIZE; this.render(); }, "abm-nav-item");
    node.append(el("span", "abm-nav-label", label), el("span", "abm-count", String(count)));
    node.classList.toggle("is-active", this.filter === filter);
    node.setAttribute("aria-pressed", String(this.filter === filter));
    return node;
  }
  renderDetail() {
    this.stopMedia(this.detail);
    this.detail.replaceChildren();
    const item = this.items().find(item => item.id === this.focused);
    this.detail.appendChild(el("div", "abm-section-label", "资源详情"));
    if (!item) {
      this.detail.append(icon(this.tab), el("h3", "", "选一项，查看更多"), el("p", "abm-muted", "点击卡片查看内容；勾选左上角复选框可批量管理并应用到工作流。"));
      if (this.tab === "prompts" && this.library) {
        this.detail.append(el("div", "abm-divider"), el("h3", "", this.library.name), el("p", "abm-muted", this.locator.source === "user" ? "用户库 · 可编辑" : "内置库 · 只读"),
          this.action("重命名当前库", () => this.renameLibrary(), !!this.editable()), this.action("另存为用户库", () => this.createLibrary(structuredClone(this.library)), !!this.library));
      }
      return;
    }
    this.detail.append(el("h3", "abm-detail-title", this.tab === "loras" ? shortName(item.name) : item.name));
    if (this.tab === "prompts") {
      const buttons = el("div", "abm-detail-actions");
      buttons.append(this.action("编辑", () => this.editPrompt(item), !!this.editable(), true), this.action("复制一组", () => this.duplicatePrompt(item), !!this.editable()), this.action("删除", () => this.deletePrompts([item]), !!this.editable()));
      this.detail.append(buttons);
      for (const [label, value] of [["正向提示词", item.positive], ["负向提示词", item.negative], ["备注", item.note]]) {
        const section = el("section", "abm-text-section");
        const head = el("div", "abm-detail-actions");
        head.append(el("h4", "", label));
        if (value) head.append(this.action("复制", async () => { await copy(value); this.report("已复制" + label); }));
        const text = el("pre", "abm-prompt-text", value || "—");
        section.append(head, text); this.detail.appendChild(section);
      }
      this.detail.append(el("p", "abm-muted", `权重 ${item.weight ?? 1} · ${categoriesOf(item).join(" / ") || "未分类"}`));
    } else if (this.tab === "loras") {
      this.detail.append(el("p", "abm-model-path", item.name));
      const record = this.previewOf(item);
      if (record.image || record.video) this.detail.appendChild(mediaThumbnail(record, kind => this.openPreview(item, kind), this.mediaOptions(item, false)));
      else { const drop = el("div", "abm-preview-empty", "拖入图片或视频设置预览"); attachMediaDrop(drop, this.mediaOptions(item).onDrop); this.detail.appendChild(drop); }
      const previewControls = el("div", "abm-preview-controls");
      previewControls.append(this.action("选择图片…", () => this.uploadPreview(item, "image"), this.ready.previews),
        this.action("选择视频…", () => this.uploadPreview(item, "video"), this.ready.previews),
        this.action("自定义路径", () => this.editPreviewPaths(item), this.ready.previews),
        this.action("恢复同目录", () => this.savePreview(item, { image: null, video: null }), this.ready.previews && !!Object.keys(record.custom || {}).length));
      this.detail.append(previewControls);
      const sources = [!record.video && record.image && `图片：${record.image.source === "custom" ? "自定义" : "同目录"}`, record.video && `视频：${record.video.source === "custom" ? "自定义" : "同目录"}`].filter(Boolean);
      this.detail.appendChild(el("p", "abm-muted abm-preview-source", sources.length ? sources.join(" · ") + " · 双击放大" : "未找到同名预览，可选择图片/视频或填写本机路径。"));
      if (record.missing?.length) this.detail.appendChild(el("p", "abm-error", "自定义预览文件已丢失，当前尝试读取同目录文件。"));
      const draft = this.draft(item.name);
      const weight = input("应用权重", draft.weight, "number");
      weight.step = "0.05"; weight.min = draft.min; weight.max = draft.max;
      weight.addEventListener("input", () => { draft.weight = weight.value; });
      const trigger = el("textarea", "abm-input abm-textarea");
      trigger.value = draft.trigger; trigger.rows = 4;
      trigger.setAttribute("aria-label", "激活提示词");
      trigger.placeholder = "输入激活提示词…";
      trigger.addEventListener("input", () => { draft.trigger = trigger.value; });
      this.detail.append(field("应用权重", weight), field("激活提示词", trigger), el("p", "abm-muted", "参数用于本次应用。保存为组合后，可保留权重和激活提示词。"));
      const tags = el("div", "abm-chips");
      for (const tag of this.tagsOf(item)) tags.appendChild(el("span", "abm-chip", tag));
      this.detail.append(tags, this.action("编辑标签", () => this.editModelTags([item.name]), this.ready.catalog),
        this.action("加入分组", () => this.assignGroup([item.name]), this.ready.groups),
        this.action("保存为组合", () => this.editPreset(null, [structuredClone(draft)]), this.ready.presets));
    } else {
      const controls = el("div", "abm-detail-actions");
      controls.append(this.action("编辑组合", () => this.editPreset(item), this.ready.presets, true), this.action("重命名", () => this.renamePreset(item), this.ready.presets), this.action("删除", () => this.deletePreset(item), this.ready.presets));
      this.detail.appendChild(controls);
      for (const entry of item.entries) {
        const row = el("div", "abm-preset-summary");
        row.append(el("strong", "", shortName(entry.name)), el("span", "abm-muted", `权重 ${entry.weight} · ${entry.enabled !== false ? "启用" : "停用"}`));
        if (entry.trigger) row.appendChild(el("p", "", entry.trigger));
        if (!this.models.some(name => modelKey(name) === modelKey(entry.name))) row.appendChild(el("p", "abm-error", "本地未找到模型"));
        this.detail.appendChild(row);
      }
      this.detail.append(this.action("导出此组合", () => download({ version: 1, presets: [item] }, item.name)));
    }
  }

  renderBatch() {
    this.batch.replaceChildren();
    const selected = this.selected();
    const visible = this.filtered();
    const hidden = selected.filter(item => !visible.some(row => row.id === item.id)).length;
    this.batch.append(el("span", "abm-selection-count", `已选 ${selected.length} 项` + (hidden ? `（含筛选外 ${hidden} 项）` : "")));
    const selectAll = button("全选当前结果", () => { for (const item of visible) this.selection.add(item.id); this.renderItems(); });
    selectAll.disabled = this.busy || this.loading || !this.ready[this.tab];
    const clear = button("清除选择", () => { this.selection.clear(); this.renderItems(); });
    clear.disabled = this.busy || this.loading || !selected.length;
    this.batch.append(selectAll, clear);
    if (this.tab === "prompts") this.batch.append(this.action("分类 / 标签", () => this.editPromptTaxonomy(selected), !!this.editable() && !!selected.length), this.action("批量删除", () => this.deletePrompts(selected), !!this.editable() && !!selected.length));
    if (this.tab === "loras") this.batch.append(this.action("标签", () => this.editModelTags(selected.map(item => item.name)), this.ready.catalog && !!selected.length), this.action("分组", () => this.assignGroup(selected.map(item => item.name)), this.ready.groups && !!selected.length));
    const graph = app.canvas?.graph || app.graph;
    const type = this.tab === "prompts" ? "PromptLibrary" : "AllBuyLoRAStack";
    const targets = (graph?._nodes || []).filter(node => type === "PromptLibrary" ? [type, "VideoPromptLibrary"].includes(node.type) : node.type === type);
    const picked = this.targetValue || (targets.find(node => app.canvas?.selected_nodes?.[node.id])?.id ?? "new");
    this.targetSelect = select("应用到节点", [["new", "新建" + (type === "PromptLibrary" ? "提示词库节点" : "LoRA 堆栈节点")], ...targets.map(node => [String(node.id), `${node.title || node.type} #${node.id}`])], String(picked), value => { this.targetValue = value; });
    if (!this.targetSelect.value) this.targetSelect.value = "new";
    this.targetSelect.disabled = this.busy || this.loading;
    this.batch.append(this.targetSelect, this.action("添加到工作流 →", () => this.applyToGraph(selected), !!selected.length && this.ready[this.tab], true));
  }

  async stageStack(items) {
    const entries = this.tab === "loras" ? items.map(item => structuredClone(this.draft(item.name))) : items.flatMap(item => structuredClone(item.entries));
    this.tab = "stacks"; this.selection.clear(); this.focused = null; this.search.value = "";
    savePreferences({ tab: this.tab });
    if (!this.stackEditor.initialized) await this.stackEditor.loadTarget(this.stackEditor.target, true);
    if (!this.stackEditor.initialized) throw new Error("无法读取目标堆栈，请重新选择节点");
    this.stackEditor.append(entries);
  }
  contextFor(item, node, event) {
    const chosen = this.selection.has(item.id) ? this.selected() : [item];
    const entries = [];
    const action = (label, callback, enabled = true, danger = false) => ({ label, action: () => this.run(callback), disabled: !enabled, danger });
    if (this.tab !== "presets") {
      const preview = this.previewOf(item);
      entries.push({ label: "放大预览", disabled: !preview.image && !preview.video, action: () => this.openPreview(item) });
      entries.push(action(this.isFavorite(item) ? "取消收藏" : "收藏", () => this.toggleFavorite(item), this.tab === "prompts" ? !!this.editable() : this.ready.groups));
    }
    if (this.tab === "prompts") {
      entries.push(action("复制正向提示词", () => copy(item.positive || "")), action("复制负向提示词", () => copy(item.negative || "")), { separator: true },
        action("编辑提示词组", () => this.editPrompt(item), !!this.editable()), action("复制提示词组", () => this.duplicatePrompt(item), !!this.editable()),
        action(`整理分类 / 标签（${chosen.length} 项）`, () => this.editPromptTaxonomy(chosen), !!this.editable()));
    } else if (this.tab === "loras") {
      entries.push(action("复制模型路径", () => copy(item.name)), { separator: true },
        action(`编辑标签（${chosen.length} 项）`, () => this.editModelTags(chosen.map(row => row.name)), this.ready.catalog),
        action(`管理分组（${chosen.length} 项）`, () => this.assignGroup(chosen.map(row => row.name)), this.ready.groups),
        action("选择预览图片…", () => this.uploadPreview(item, "image"), this.ready.previews), action("选择预览视频…", () => this.uploadPreview(item, "video"), this.ready.previews),
        action("自定义预览路径", () => this.editPreviewPaths(item), this.ready.previews),
        action("保存为 LoRA 组合", () => this.editPreset(null, chosen.map(row => structuredClone(this.draft(row.name)))), this.ready.presets));
    } else {
      entries.push(action("编辑组合", () => this.editPreset(item), this.ready.presets), action("重命名组合", () => this.renamePreset(item), this.ready.presets),
        action("导出此组合", () => download({ version: 1, presets: [item] }, item.name)));
    }
    entries.push({ separator: true }, action(`添加到工作流（${chosen.length} 项）`, () => this.applyToGraph(chosen), this.ready[this.tab]));
    if (this.tab !== "prompts") entries.push(action("加入堆栈草稿…", () => this.stageStack(chosen)));
    if (this.tab === "prompts") entries.push({ separator: true }, action(`删除提示词组（${chosen.length} 项）`, () => this.deletePrompts(chosen), !!this.editable(), true));
    if (this.tab === "presets") entries.push({ separator: true }, action("删除此组合", () => this.deletePreset(item), this.ready.presets, true));
    showManagerContext(node, entries, event.clientX, event.clientY);
  }

  async savePromptChange(change) {
    if (!this.editable()) throw new Error("当前库不可编辑，请另存为用户库");
    const locator = { ...this.locator };
    // Re-read immediately before mutation so edits in other nodes are retained.
    const { library } = await request("/library?locator=" + encodeURIComponent(JSON.stringify(locator)));
    if (!library || !Array.isArray(library.groups)) throw new Error("提示词库格式错误");
    change(library);
    await request("/library/save", { locator, data: library });
    this.library = library;
    this.libraries = (await request("/libraries")).libraries;
    window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator, origin: "manager" } }));
    this.report("已保存到用户库");
  }
  async editPrompt(item) {
    const result = await openEditor(item || null, { isNew: !item, categories: [...new Set((this.library?.groups || []).flatMap(categoriesOf))], palette: this.library?.meta || {}, theme: this.visual.theme });
    this.root.focus();
    if (!result || !this.root.isConnected) return;
    await this.savePromptChange(library => {
      if (item) {
        const index = library.groups.findIndex(group => group.id === item.id);
        if (index < 0) throw new Error("此提示词组已被删除，请刷新");
        library.groups[index] = result.group;
      } else library.groups.push(result.group);
      library.meta = { ...library.meta, ...result.meta };
    });
    this.focused = result.group.id;
  }
  async duplicatePrompt(item) {
    const clone = { ...structuredClone(item), id: uid(), name: item.name + " 副本" };
    await this.savePromptChange(library => library.groups.push(clone));
    this.focused = clone.id;
  }
  async deletePrompts(items) {
    if (!items.length || !confirm(`删除 ${items.length} 个提示词组？此操作会同步到用户库。`)) return;
    const ids = new Set(items.map(item => item.id));
    await this.savePromptChange(library => { library.groups = library.groups.filter(group => !ids.has(group.id)); });
    for (const id of ids) this.selection.delete(id);
  }
  async editPromptTaxonomy(items) {
    const kind = select("修改字段", [["categories", "分类"], ["tags", "标签"]], "categories");
    const mode = select("修改方式", [["add", "添加，保留现有内容"], ["remove", "移除指定内容"]], "add");
    const values = input("多个名称用逗号分隔");
    const body = el("div", "abm-modal-fields");
    body.append(field("字段", kind), field("方式", mode), field("名称", values));
    await this.modal(`批量整理 ${items.length} 个提示词组`, body, async () => {
      const labels = [...new Set(values.value.split(/[,，;；]/).map(value => value.trim()).filter(Boolean))];
      if (!labels.length) throw new Error("请填写至少一个名称");
      const ids = new Set(items.map(item => item.id));
      await this.savePromptChange(library => {
        for (const item of library.groups.filter(item => ids.has(item.id))) {
          const existing = kind.value === "categories" ? categoriesOf(item) : item.tags || [];
          item[kind.value] = mode.value === "add" ? [...new Set([...existing, ...labels])] : existing.filter(label => !labels.includes(label));
          if (kind.value === "categories") delete item.category;
        }
      });
    });
  }
  async createLibrary(data) {
    const name = prompt("新用户库名称：", data?.name || "我的提示词库");
    if (!name?.trim()) return;
    const { locator } = await request("/library/create", { name: name.trim() });
    if (data) {
      await request("/library/save", { locator, data: { ...data, name: name.trim() } });
      window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator, origin: "manager" } }));
    }
    this.libraries = (await request("/libraries")).libraries;
    this.locator = locator;
    await this.loadLibrary();
    this.ready.prompts = true;
    this.selection.clear(); this.focused = null; this.filter = "";
    this.report("用户库已创建");
  }
  async renameLibrary() {
    const name = prompt("库的新名称：", this.library.name);
    if (!name?.trim() || name.trim() === this.library.name) return;
    await request("/library/rename", { locator: this.locator, name: name.trim() });
    this.library.name = name.trim();
    this.libraries = (await request("/libraries")).libraries;
    window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator: this.locator, origin: "manager" } }));
    this.report("库已重命名");
  }
  async deleteLibrary() {
    if (!this.editable() || !confirm(`删除用户库「${this.library.name}」及其中的 ${this.library.groups.length} 个提示词组？`)) return;
    const locator = { ...this.locator };
    await request("/library/delete", { name: locator.name });
    this.libraries = (await request("/libraries")).libraries;
    const next = this.libraries.find(item => item.source === "user") || this.libraries[0];
    this.locator = next ? { source: next.source, name: next.name } : null;
    await this.loadLibrary();
    this.selection.clear(); this.focused = null; this.filter = "";
    window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator, origin: "manager" } }));
    this.report("用户库已删除");
  }
  readFile() {
    return new Promise((resolve, reject) => {
      const file = input("导入 JSON", "", "file");
      file.accept = ".json,application/json";
      file.addEventListener("cancel", () => resolve(null), { once: true });
      file.addEventListener("change", async () => {
        try { resolve(file.files?.[0] ? JSON.parse(await file.files[0].text()) : null); } catch { reject(new Error("无法读取 JSON 文件")); }
      }, { once: true });
      file.click();
    });
  }
  async importLibrary() {
    const data = await this.readFile();
    if (!data) return;
    if (!Array.isArray(data.groups) || data.groups.some(group => !group || typeof group !== "object" || Array.isArray(group))) throw new Error("请选择含 groups 数组的提示词库 JSON");
    const ids = new Set();
    for (const group of data.groups) {
      if (typeof group.id !== "string" || !group.id || ids.has(group.id)) group.id = uid();
      ids.add(group.id);
    }
    await this.createLibrary(data);
  }
  async toggleFavorite(item) {
    if (this.tab === "prompts") await this.savePromptChange(library => {
      const group = library.groups.find(group => group.id === item.id);
      if (!group) throw new Error("提示词组已被删除，请刷新");
      group.star = !group.star;
    });
    else {
      const { groups } = await request("/lora_groups");
      const group = groups.find(group => group.name === "我的收藏");
      if (!group) throw new Error("收藏分组不存在，请刷新");
      const exists = group.loras.some(name => modelKey(name) === modelKey(item.name));
      group.loras = exists ? group.loras.filter(name => modelKey(name) !== modelKey(item.name)) : [...group.loras, item.name];
      await this.saveGroups(groups);
    }
  }
  changedLoras() { window.dispatchEvent(new CustomEvent("allbuy-lora-data-changed", { detail: { origin: "manager" } })); }
  async saveGroups(groups) {
    this.groups = (await request("/lora_groups/save", { data: { groups } })).groups;
    this.changedLoras(); this.report("LoRA 分组已保存");
  }
  async createLoraGroup() {
    return this.run(async () => {
      const name = prompt("分组名称：");
      if (!name?.trim()) return;
      const { groups } = await request("/lora_groups");
      if (groups.some(group => group.name === name.trim())) throw new Error("同名分组已存在");
      groups.push({ id: uid(), name: name.trim(), loras: [] });
      await this.saveGroups(groups);
    });
  }
  async editLoraGroup() {
    const id = this.filter.slice(6);
    const { groups } = await request("/lora_groups");
    const group = groups.find(group => group.id === id);
    if (!group) throw new Error("分组已被删除，请刷新");
    const name = input("分组名称", group.name);
    const remove = input("删除此分组", "", "checkbox");
    const body = el("div", "abm-modal-fields");
    body.append(field("名称", name), field("删除此分组（模型文件保留）", remove));
    const result = await this.modal("编辑 LoRA 分组", body, async () => {
      if (remove.checked) {
        await this.saveGroups(groups.filter(row => row.id !== id)); this.filter = "";
      } else {
        if (!name.value.trim()) throw new Error("名称不能为空");
        if (groups.some(row => row.id !== id && row.name === name.value.trim())) throw new Error("同名分组已存在");
        group.name = name.value.trim(); await this.saveGroups(groups);
      }
    });
    return result;
  }
  async assignGroup(names) {
    const { groups } = await request("/lora_groups");
    const picker = select("分组", groups.map(group => [group.id, group.name]), groups[0]?.id);
    const remove = input("从分组移除", "", "checkbox");
    const body = el("div", "abm-modal-fields");
    body.append(field("目标分组", picker), field("从此分组移除所选模型", remove));
    await this.modal(`管理 ${names.length} 个 LoRA 的分组`, body, async () => {
      const fresh = (await request("/lora_groups")).groups;
      const group = fresh.find(group => group.id === picker.value);
      if (!group) throw new Error("分组不存在，请刷新");
      const chosen = new Set(names.map(modelKey));
      group.loras = remove.checked ? group.loras.filter(name => !chosen.has(modelKey(name))) : [...new Map([...group.loras, ...names].map(name => [modelKey(name), name])).values()];
      await this.saveGroups(fresh);
    });
  }
  async catalogAction(action) {
    this.catalog = await request("/lora_catalog/update", action);
    this.changedLoras(); this.report("LoRA 标签已保存");
  }
  async savePreview(item, changes) {
    const result = await request("/lora_previews/update", { model: item.name, ...changes });
    if (!result.preview) throw new Error("预览数据格式错误");
    this.previews[modelKey(item.name)] = result.preview;
    this.report("LoRA 预览已保存");
  }
  async uploadPreview(item, kind, droppedFile = null) {
    const file = droppedFile || await new Promise(resolve => {
      const picker = input("选择预览文件", "", "file");
      picker.accept = kind === "image" ? ".png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff" : ".mp4,.webm,.mov,.mkv,.avi,.m4v,.mpg,.mpeg";
      picker.addEventListener("change", () => resolve(picker.files?.[0] || null), { once: true });
      picker.addEventListener("cancel", () => resolve(null), { once: true });
      picker.click();
    });
    if (!file) return;
    const form = new FormData();
    form.append("group_id", item.name); form.append("file", file);
    const response = await api.fetchApi(API + "/cover/upload", { method: "POST", body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok || !result.name) throw new Error(result.error || "预览上传失败");
    await this.savePreview(item, { [kind]: result.name });
  }
  async editPreviewPaths(item) {
    const record = this.previewOf(item);
    const body = el("div", "abm-modal-fields");
    const fields = {};
    for (const [kind, label] of [["image", "图片路径"], ["video", "视频路径"]]) {
      const reference = record.custom?.[kind] || "";
      const managed = /^[0-9a-f]{64}\.[a-z0-9]+$/.test(reference);
      const control = input(label, managed ? "" : reference);
      control.placeholder = "例如 D:\\预览\\model." + (kind === "image" ? "png" : "mp4");
      // Blank uploaded references remain bound unless the user explicitly resets them.
      fields[kind] = { control, reference, managed, changed: false };
      control.addEventListener("input", () => { fields[kind].changed = true; });
      body.appendChild(field(label, control));
      if (managed) body.appendChild(el("p", "abm-muted", "当前已绑定上传的" + (kind === "image" ? "图片" : "视频") + "，留空保留。"));
    }
    body.appendChild(el("p", "abm-muted", "填写运行 ComfyUI 的电脑上的完整路径；清空已有路径后恢复同目录匹配。"));
    await this.modal("自定义 LoRA 预览 · " + shortName(item.name), body, async () => {
      const changes = {};
      for (const [kind, value] of Object.entries(fields)) if (!value.managed || value.changed) changes[kind] = value.control.value.trim().replace(/^"|"$/g, "") || null;
      if (Object.keys(changes).length) await this.savePreview(item, changes);
    });
  }
  async manageTags() {
    const body = el("div", "abm-modal-fields");
    const name = input("新标签名称"), search = input("搜索标签", "", "search");
    const createRow = el("div", "abm-tag-create");
    const list = el("div", "abm-tag-manager-list");
    const message = el("div", "abm-muted"); message.setAttribute("role", "status");
    let busy = false;
    const perform = async action => {
      if (busy) return;
      busy = true; body.dataset.busy = "true";
      const form = body.closest("form"); form?.querySelectorAll("input,button").forEach(node => { node.disabled = true; });
      try { await this.catalogAction(action); message.textContent = "已保存"; message.classList.remove("abm-error"); name.value = ""; draw(); }
      catch (err) { message.textContent = err.message; message.classList.add("abm-error"); }
      finally { busy = false; body.dataset.busy = "false"; form?.querySelectorAll("input,button").forEach(node => { node.disabled = false; }); }
    };
    const create = button("＋ 新建标签", () => perform({ action: "create_tag", name: name.value.trim() }));
    createRow.append(name, create);
    const draw = () => {
      list.replaceChildren();
      for (const tag of this.catalog.tags.filter(tag => tag.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))) {
        const row = el("div", "abm-tag-manager-row");
        const count = Object.values(this.catalog.models).filter(tags => tags.includes(tag)).length;
        row.append(el("span", "abm-tag-name", tag), el("span", "abm-muted", `${count} 个模型`),
          button("重命名", () => { const newName = prompt("标签的新名称：", tag); if (newName?.trim() && newName.trim() !== tag) perform({ action: "rename_tag", name: tag, new_name: newName.trim() }); }),
          button("删除", () => { if (confirm(`删除标签「${tag}」并解除 ${count} 个模型的关联？`)) perform({ action: "delete_tag", name: tag }); }));
        list.appendChild(row);
      }
      if (!list.childElementCount) list.append(el("p", "abm-muted", "没有匹配的标签"));
    };
    search.addEventListener("input", draw);
    name.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); create.click(); } });
    body.append(createRow, search, message, list); draw();
    await this.modal("管理 LoRA 标签", body, async () => {}, "完成");
  }
  async editModelTags(names) {
    this.catalog = await request("/lora_catalog");
    const body = el("div", "abm-modal-fields");
    const checks = [];
    for (const tag of this.catalog.tags) {
      const check = input(tag, "", "checkbox");
      const counts = names.filter(name => this.catalog.models[modelKey(name)]?.includes(tag)).length;
      check.checked = counts === names.length; check.indeterminate = counts > 0 && counts < names.length;
      let changed = false;
      check.addEventListener("change", () => { changed = true; });
      checks.push({ tag, check, changed: () => changed });
      body.appendChild(field(tag + (check.indeterminate ? "（部分模型）" : ""), check));
    }
    if (!checks.length) body.append(el("p", "abm-muted", "暂无标签，请先用顶部「管理标签」创建。"));
    await this.modal(`编辑 ${names.length} 个 LoRA 的标签`, body, async () => {
      const changed = checks.filter(row => row.changed());
      if (!changed.length) return;
      await this.catalogAction({ action: "patch_tags", models: names, add: changed.filter(row => row.check.checked).map(row => row.tag), remove: changed.filter(row => !row.check.checked).map(row => row.tag) });
    });
  }
  renderSidebar() {
    if (this.tab === "stacks") { this.stackEditor.renderSidebar(); return; }
    this.sidebar.replaceChildren();
    const caption = text => this.sidebar.appendChild(el("div", "abm-section-label", text));
    caption("资源导航");
    this.sidebar.append(this.navItem("全部" + TABS[this.tab], "", this.items().length));
    if (this.tab !== "presets") this.sidebar.append(this.navItem("★ 我的收藏", "favorite", this.items().filter(item => this.isFavorite(item)).length));
    if (this.tab === "prompts") {
      caption("提示词库");
      for (const item of this.libraries) {
        const node = button("", () => this.chooseLibrary(item), "abm-nav-item");
        node.append(el("span", "abm-nav-label", (item.readonly ? "◈ " : "▱ ") + (item.display_name || item.name)), el("span", "abm-count", String(item.count)));
        node.title = item.readonly ? "内置只读库" : "用户库";
        node.classList.toggle("is-active", locatorKey(item) === locatorKey(this.locator));
        node.disabled = this.busy || this.loading;
        this.sidebar.appendChild(node);
      }
      const controls = el("div", "abm-library-actions");
      controls.append(this.action("重命名", () => this.renameLibrary(), !!this.editable()), this.action("删除库", () => this.deleteLibrary(), !!this.editable()));
      this.sidebar.appendChild(controls);
      caption("分类");
      for (const name of [...new Set(this.items().flatMap(categoriesOf))].sort()) this.sidebar.append(this.navItem(name, "category:" + name, this.items().filter(item => categoriesOf(item).includes(name)).length));
    }
    if (this.tab === "loras") {
      caption("自定义分组");
      for (const group of this.groups.filter(group => group.name !== "我的收藏")) this.sidebar.append(this.navItem(group.name, "group:" + group.id, group.loras.length));
      const add = button("＋ 新建分组", () => this.createLoraGroup(), "abm-sidebar-add");
      add.disabled = !this.ready.groups || this.busy || this.loading;
      this.sidebar.appendChild(add);
      caption("模型文件夹");
      for (const name of [...new Set(this.models.map(modelKey).filter(name => name.includes("/")).map(name => name.slice(0, name.lastIndexOf("/"))))].sort()) this.sidebar.append(this.navItem(name, "folder:" + name, this.models.filter(model => modelKey(model).startsWith(name + "/")).length));
    }
    if (this.tab !== "presets") {
      caption("标签");
      const tags = this.tab === "prompts" ? [...new Set(this.items().flatMap(item => item.tags || []))] : this.catalog.tags;
      for (const tag of tags.slice().sort()) this.sidebar.append(this.navItem("# " + tag, "tag:" + tag, this.items().filter(item => this.tagsOf(item).includes(tag)).length));
      this.sidebar.append(this.navItem("未分类", "untagged", this.items().filter(item => !this.tagsOf(item).length).length));
    }
  }
  action(text, callback, enabled = true, primary = false) {
    const node = button(text, () => this.run(callback), primary ? "abm-primary" : "");
    node.disabled = !enabled || this.busy || this.loading;
    return node;
  }
  renderActions() {
    if (this.tab === "stacks") { this.stackEditor.renderActions(); return; }
    this.actions.replaceChildren();
    const refresh = button("↻ 刷新", () => this.refresh());
    refresh.disabled = this.busy || this.loading;
    this.actions.appendChild(refresh);
    if (this.tab === "prompts") {
      this.actions.append(this.action("导入", () => this.importLibrary()), this.action("导出", () => download(this.library, this.library.name || "提示词库"), !!this.library),
        this.action("＋ 新建库", () => this.createLibrary()), this.action("＋ 提示词组", () => this.editPrompt(), !!this.editable(), true));
    } else if (this.tab === "loras") {
      this.actions.append(this.action("管理标签", () => this.manageTags(), this.ready.catalog), this.action("保存为组合", () => this.editPreset(null, this.selected().map(item => this.draft(item.name))), this.selection.size > 0 && this.ready.presets, true));
      if (this.filter.startsWith("group:")) this.actions.append(this.action("编辑分组", () => this.editLoraGroup(), this.ready.groups));
    } else {
      this.actions.append(this.action("导入组合", () => this.importPresets(), this.ready.presets), this.action("导出组合", () => download({ version: 1, presets: this.presets }, "LoRA组合"), this.ready.presets), this.action("＋ 新建组合", () => this.editPreset(), this.ready.presets, true));
    }
  }
  tagsOf(item) { return this.tab === "prompts" ? item.tags || [] : this.catalog.models?.[modelKey(item.name)] || []; }
  isFavorite(item) { return this.tab === "prompts" ? !!item.star : (this.groups.find(group => group.name === "我的收藏")?.loras || []).some(name => modelKey(name) === modelKey(item.name)); }
  draft(name) {
    if (!this.drafts.has(name)) this.drafts.set(name, { name, weight: 1, min: -3, max: 3, enabled: true, trigger: "" });
    return this.drafts.get(name);
  }
  renderItems() {
    if (this.tab === "workflows") { this.workflows.renderList(); return; }
    if (this.tab === "stacks") { this.stackEditor.render(); return; }
    this.masonryObserver?.disconnect();
    const filtered = this.filtered();
    this.subtitle.textContent = `${this.items().length} 项资源 · 当前显示 ${filtered.length} 项` + (this.tab === "prompts" && this.locator?.source === "builtin" ? " · 只读" : "");
    const scroll = this.list.scrollTop;
    this.stopMedia(this.list);
    this.list.replaceChildren();
    for (const [mode, node] of Object.entries(this.viewButtons)) { node.classList.toggle("is-active", mode === this.view); node.setAttribute("aria-pressed", String(mode === this.view)); }
    const grid = el("div", "abm-collection abm-" + this.view);
    if (this.loading) grid.appendChild(el("div", "abm-empty", "正在加载资源…"));
    else if (!this.ready[this.tab]) grid.appendChild(el("div", "abm-empty", this.errors[this.tab] || "暂无可用数据，点击刷新重试"));
    else if (!filtered.length) {
      const empty = el("div", "abm-empty");
      empty.append(icon(this.tab), el("h3", "", this.items().length ? "没有匹配的资源" : "从第一项资源开始"), el("p", "", this.items().length ? "尝试其他关键词，或切换左侧分类。" : this.tab === "loras" ? "将模型放入 ComfyUI 的 LoRA 目录，再点击刷新。" : "使用右上角的新建或导入，建立自己的资源库。"));
      grid.appendChild(empty);
    } else for (const item of filtered.slice(0, this.limit)) grid.appendChild(this.card(item));
    this.list.appendChild(grid);
    this.observeMasonry(grid);
    if (!this.loading && filtered.length > this.limit) this.list.appendChild(button(`加载更多 · 还有 ${filtered.length - this.limit} 项`, () => { this.limit += PAGE_SIZE; this.renderItems(); }, "abm-load-more"));
    this.list.scrollTop = scroll;
    this.renderDetail(); this.renderBatch();
    if (this.tab === "loras") this.renderActions();
  }
  card(item) {
    const node = el("article", "abm-card");
    node.classList.toggle("is-focused", this.focused === item.id);
    node.classList.toggle("is-selected", this.selection.has(item.id));
    node.tabIndex = 0;
    node.setAttribute("aria-label", item.name || "未命名");
    const focus = () => { this.focused = item.id; this.list.querySelectorAll(".abm-card").forEach(card => card.classList.remove("is-focused")); node.classList.add("is-focused"); this.renderDetail(); };
    node.addEventListener("click", focus);
    node.addEventListener("contextmenu", event => {
      event.preventDefault(); event.stopPropagation();
      if (this.busy || this.loading) return;
      focus(); this.contextFor(item, node, event);
    });
    if (this.tab !== "presets") node.addEventListener("dblclick", event => {
      if (event.target.closest("button,input")) return;
      this.openPreview(item);
    });
    node.addEventListener("keydown", event => { if (event.target === node && ["Enter", " "].includes(event.key)) { event.preventDefault(); focus(); } });
    const visual = el("div", "abm-card-visual");
    const record = this.tab === "presets" ? {} : this.previewOf(item);
    if (record.image || record.video) visual.appendChild(mediaThumbnail(record, kind => this.openPreview(item, kind), this.mediaOptions(item)));
    else {
      visual.classList.add("abm-no-preview");
      visual.append(icon(this.tab), el("span", "", this.tab === "presets" ? `${item.entries.length} 个 LoRA` : "暂无预览"));
      if (this.tab === "loras") visual.title = "双击设置图片或视频预览";
      attachMediaDrop(visual, this.mediaOptions(item).onDrop);
    }
    const check = input("选择 " + item.name, "", "checkbox");
    check.className = "abm-checkbox";
    check.checked = this.selection.has(item.id);
    check.disabled = this.busy || this.loading;
    check.addEventListener("click", event => event.stopPropagation());
    check.addEventListener("change", () => {
      check.checked ? this.selection.add(item.id) : this.selection.delete(item.id);
      node.classList.toggle("is-selected", check.checked);
      this.renderBatch(); if (this.tab === "loras") this.renderActions();
    });
    visual.appendChild(check);
    const content = el("div", "abm-card-content");
    const title = el("h3", "", this.tab === "loras" ? shortName(item.name) : item.name || "未命名");
    title.title = item.name;
    const titleRow = el("div", "abm-card-title-row"); titleRow.appendChild(title);
    if (this.tab !== "presets") {
      const favorite = button("", event => { event.stopPropagation(); this.run(() => this.toggleFavorite(item)); }, "abm-card-favorite");
      favorite.appendChild(icon("bookmark"));
      favorite.title = this.isFavorite(item) ? "取消收藏" : "收藏";
      favorite.setAttribute("aria-label", favorite.title + " " + item.name);
      favorite.setAttribute("aria-pressed", String(this.isFavorite(item)));
      favorite.disabled = this.busy || this.loading || (this.tab === "prompts" ? !this.editable() : !this.ready.groups);
      titleRow.appendChild(favorite);
    }
    content.append(titleRow, el("p", "abm-card-description", this.tab === "prompts" ? item.note || item.positive || "暂无描述" : this.tab === "loras" ? modelKey(item.name).split("/").slice(0, -1).join("/") || "LoRA 根目录" : `${item.entries.length} 个 LoRA · ${item.entries.filter(entry => entry.enabled !== false).length} 个启用`));
    const tags = el("div", "abm-chips");
    for (const tag of (this.tab === "prompts" ? [...categoriesOf(item), ...this.tagsOf(item)] : this.tagsOf(item)).slice(0, 3)) tags.appendChild(el("span", "abm-chip", tag));
    if (this.tab === "loras" && !tags.childElementCount) tags.appendChild(el("span", "abm-chip abm-subtle", "未分类"));
    content.appendChild(tags);
    node.append(visual, content);
    return node;
  }
  modal(title, content, onSave, confirmLabel = "保存") {
    return new Promise(resolve => {
      const overlay = el("div", "abm-modal-overlay");
      const dialog = el("form", "abm-modal");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", title);
      const message = el("div", "abm-error");
      message.setAttribute("role", "alert");
      const footer = el("div", "abm-modal-footer");
      let saving = false;
      const close = result => {
        if (saving || content.dataset.busy === "true") return;
        closeManagerPopup();
        document.removeEventListener("keydown", onKey, true);
        overlay.remove(); this.childModal = null;
        this.root.focus(); resolve(result);
      };
      const cancel = button("取消", () => close(false));
      const save = button(confirmLabel, () => dialog.requestSubmit(), "abm-primary");
      footer.append(cancel, save);
      dialog.append(el("h2", "", title), content, message, footer);
      overlay.appendChild(dialog);
      overlay.addEventListener("click", event => { if (event.target === overlay) close(false); });
      this.childModal = overlay;
      this.root.appendChild(overlay);
      const onKey = event => {
        if (hasManagerPopup()) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(false); }
        if (event.key === "Tab") {
          const controls = [...dialog.querySelectorAll("button,input,select,textarea")].filter(node => !node.disabled && node.getClientRects().length);
          if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }
      };
      document.addEventListener("keydown", onKey, true);
      dialog.addEventListener("submit", async event => {
        event.preventDefault();
        if (saving) return;
        saving = true; save.disabled = true; cancel.disabled = true; message.textContent = "";
        try { await onSave(); saving = false; close(true); }
        catch (err) { message.textContent = err.message; }
        finally { saving = false; save.disabled = false; cancel.disabled = false; }
      });
      dialog.querySelector("input,select,textarea")?.focus();
    });
  }
  async presetAction(action) {
    this.presets = (await request("/lora_presets/update", action)).presets;
    this.changedLoras(); this.report("LoRA 组合已保存");
  }
  async editPreset(preset, initial = []) {
    const entries = structuredClone(preset?.entries || initial);
    const body = el("div", "abm-preset-editor");
    const name = input("组合名称", preset?.name || "我的 LoRA 组合");
    const rows = el("div", "abm-preset-rows");
    const render = () => {
      rows.replaceChildren();
      entries.forEach((entry, index) => {
        const row = el("div", "abm-preset-row");
        const enabled = input("启用第 " + (index + 1) + " 条", "", "checkbox");
        enabled.checked = entry.enabled !== false;
        enabled.addEventListener("change", () => { entry.enabled = enabled.checked; });
        const heading = el("div", "abm-detail-actions");
        const up = button("↑", () => { [entries[index - 1], entries[index]] = [entries[index], entries[index - 1]]; render(); }); up.disabled = index === 0; up.setAttribute("aria-label", "上移");
        const down = button("↓", () => { [entries[index + 1], entries[index]] = [entries[index], entries[index + 1]]; render(); }); down.disabled = index === entries.length - 1; down.setAttribute("aria-label", "下移");
        heading.append(enabled, el("strong", "", `LoRA ${index + 1}`), up, down, button("删除", () => { entries.splice(index, 1); render(); }));
        const model = input("模型文件", entry.name);
        model.addEventListener("input", () => { entry.name = model.value; });
        const chooseModel = select("选择组合模型", [["", "搜索本地 LoRA…"], ...this.models.map(name => [name, name])], "", value => { if (value) { entry.name = value; model.value = value; } });
        const parameters = el("div", "abm-preset-parameters");
        for (const [key, label] of [["weight", "权重"], ["min", "最小值"], ["max", "最大值"]]) {
          const control = input(label, entry[key], "number"); control.step = "0.01";
          control.addEventListener("input", () => { entry[key] = control.value; });
          parameters.appendChild(field(label, control));
        }
        const trigger = input("激活提示词", entry.trigger || "");
        trigger.addEventListener("input", () => { entry.trigger = trigger.value; });
        row.append(heading, field("本地模型", chooseModel), field("模型文件（也可手填）", model), parameters, field("激活提示词", trigger));
        if (!this.models.includes(entry.name)) row.appendChild(el("p", "abm-muted", "可保存尚未安装的模型；应用前需安装对应文件。"));
        rows.appendChild(row);
      });
      if (!entries.length) rows.appendChild(el("p", "abm-muted", "点击「添加 LoRA」开始建立组合。"));
    };
    render();
    body.append(field("组合名称", name), rows, button("＋ 添加 LoRA", () => { entries.push({ name: this.models[0] || "", weight: 1, min: -3, max: 3, enabled: true, trigger: "" }); render(); }));
    await this.modal(preset ? "编辑 LoRA 组合" : "新建 LoRA 组合", body, async () => {
      const normalized = validatePresetEntries(entries);
      if (!name.value.trim()) throw new Error("请填写组合名称");
      if (preset) {
        // Validate both operations before writing; preserve the stored order mode.
        const fresh = (await request("/lora_presets")).presets;
        if (fresh.some(item => item.id !== preset.id && item.name.toLocaleLowerCase() === name.value.trim().toLocaleLowerCase())) throw new Error("同名组合已存在");
        if (name.value.trim() !== preset.name) await this.presetAction({ action: "rename", id: preset.id, name: name.value.trim() });
        await this.presetAction({ action: "overwrite", id: preset.id, entries: normalized, view: preset.view || { sort: "manual" } });
      } else {
        await this.presetAction({ action: "save", name: name.value.trim(), entries: normalized, view: { sort: "manual" } });
      }
    });
  }
  async renamePreset(preset) {
    const name = prompt("组合的新名称：", preset.name);
    if (name?.trim()) await this.presetAction({ action: "rename", id: preset.id, name: name.trim() });
  }
  async deletePreset(preset) {
    if (!confirm(`删除组合「${preset.name}」？模型文件保留。`)) return;
    await this.presetAction({ action: "delete", id: preset.id });
    this.selection.delete(preset.id);
  }
  async importPresets() {
    const data = await this.readFile();
    if (!data) return;
    const rows = Array.isArray(data.presets) ? data.presets : data.entries ? [{ ...data, name: data.name || "导入组合" }] : [];
    if (!rows.length) throw new Error("请选择含 presets 或 entries 的组合 JSON");
    const validated = rows.map(row => ({ name: String(row.name || "导入组合"), entries: validatePresetEntries(row.entries), view: { sort: row.view?.sort || "manual" } }));
    const names = new Set((await request("/lora_presets")).presets.map(row => row.name.toLocaleLowerCase()));
    let count = 0;
    for (const row of validated) {
      const base = row.name.slice(0, 80); let name = base, suffix = 1;
      while (names.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`;
      try { await this.presetAction({ action: "save", ...row, name }); }
      catch (err) { throw new Error(`已导入 ${count} 个组合，后续导入失败：${err.message}`); }
      count++; names.add(name.toLocaleLowerCase());
    }
    this.report(`已导入 ${count} 个组合`);
  }
  async applyToGraph(selected) {
    if (!selected.length) return;
    const graph = app.canvas?.graph || app.graph;
    if (!graph) throw new Error("当前没有可用工作流");
    const type = this.tab === "prompts" ? "PromptLibrary" : "AllBuyLoRAStack";
    let entries;
    if (this.tab !== "prompts") {
      entries = this.tab === "loras" ? selected.map(item => this.draft(item.name)) : selected.flatMap(item => item.entries);
      entries = validatePresetEntries(entries, this.models);
    }
    let node = this.targetSelect.value === "new" ? null : graph.getNodeById(this.targetSelect.value);
    if (this.targetSelect.value !== "new" && !node) throw new Error("目标节点已被删除，请重新选择");
    let created = false;
    if (!node) {
      node = globalThis.LiteGraph?.createNode(type);
      if (!node) throw new Error("节点尚未注册，请刷新 ComfyUI");
      const center = app.canvas?.convertEventToCanvasOffset?.({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 });
      node.pos = center || [100, 100];
      graph.add(node); created = true;
    }
    try {
      // DOM controllers attach asynchronously after native widgets are created.
      for (let i = 0; !node._allbuyManagerApply && i < 120; i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (node.graph !== graph) throw new Error("目标节点已被移除");
      if (!node._allbuyManagerApply) throw new Error("节点面板尚未就绪，请刷新 ComfyUI 后重试");
      const panel = node._stackContainer || node._allbuyManagerContainer;
      if (panel?.closest(".vpl-node")?.classList.contains("vpl-locked")) throw new Error("目标节点正在执行，请等待完成后再添加");
      await node._allbuyManagerApply(this.tab === "prompts" ? { locator: this.locator, ids: selected.map(item => item.id), append: !created } : { entries, append: !created });
      graph.change?.(); node.setDirtyCanvas?.(true, true);
      this.targetValue = String(node.id);
      this.report(`已添加到「${node.title || type}」#${node.id} · ${selected.length} 项资源`);
    } catch (err) {
      if (created && node.graph === graph) graph.remove(node);
      throw err;
    }
  }
  close() {
    if (this.busy || this.childModal) return;
    if (!this.stackEditor.allowDiscard()) return;
    closeManagerPopup();
    cancelAnimationFrame(this.appearanceFrame); savePreferences(this.appearance);
    this.stackEditor.destroy();
    this.workflows.destroy();
    this.masonryObserver?.disconnect(); cancelAnimationFrame(this.masonryFrame);
    this.mediaClose?.();
    this.stopMedia(this.root);
    ++this.epoch;
    this.root.remove();
    for (const node of this.inertSiblings) node.inert = false;
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("allbuy-promptlibrary-saved", this.onSaved);
    window.removeEventListener("allbuy-lora-data-changed", this.onSaved);
    manager = null;
    (this.restoreFocus?.isConnected ? this.restoreFocus : launcher)?.focus();
    launcher?.setAttribute("aria-expanded", "false");
  }
}

function openManager() {
  if (manager) { manager.search.focus(); return; }
  manager = new Manager();
  launcher?.setAttribute("aria-expanded", "true");
}
function applyLauncherAppearance(visual = managerVisualPreferences(readPreferences())) {
  if (!launcher) return;
  launcher.dataset.theme = visual.theme; launcher.dataset.material = visual.launcherStyle;
}
function setLauncherStyle(style) {
  const visual = managerVisualPreferences({ ...readPreferences(), launcherStyle: style }); savePreferences(visual); applyLauncherAppearance(visual);
  if (manager) { manager.visual = visual; manager.applyAppearance(); }
}
function installLauncher() {
  if (document.getElementById("allbuy-manager-launcher")) return;
  const style = el("link");
  style.rel = "stylesheet";
  style.href = new URL("./manager.css?v=3.156", import.meta.url).href;
  document.head.appendChild(style);
  launcher = button("", openManager, "abm-launcher");
  applyLauncherAppearance();
  launcher.id = "allbuy-manager-launcher";
  launcher.append(icon("library"), el("span", "", "资源管理"));
  launcher.setAttribute("aria-label", "打开 AllBuy Studio 创作套件资源管理面板");
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-expanded", "false");
  launcher.title = "AllBuy Studio｜AllBuy 创作套件 · 点击打开 · 拖动调整位置 · 右键切换质感";
  document.body.appendChild(launcher);
  let position = readPreferences().position;
  const place = () => {
    if (!position) return;
    const x = Math.max(8, Math.min(window.innerWidth - launcher.offsetWidth - 8, Number(position.x) || 8));
    const y = Math.max(8, Math.min(window.innerHeight - launcher.offsetHeight - 8, Number(position.y) || 8));
    launcher.style.left = x + "px"; launcher.style.top = y + "px";
    launcher.style.right = "auto"; launcher.style.bottom = "auto";
  };
  place(); window.addEventListener("resize", place);
  let drag = null, suppressClick = false;
  launcher.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const rect = launcher.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    suppressClick = false;
    launcher.setPointerCapture(event.pointerId);
  });
  launcher.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) < 5 && !drag.moved) return;
    drag.moved = true;
    position = { x: drag.left + dx, y: drag.top + dy };
    place();
  });
  const finish = event => {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved;
    if (drag.moved) savePreferences({ position: { x: parseFloat(launcher.style.left), y: parseFloat(launcher.style.top) } });
    drag = null;
  };
  launcher.addEventListener("pointerup", finish);
  launcher.addEventListener("pointercancel", finish);
  launcher.addEventListener("contextmenu", event => {
    event.preventDefault(); event.stopPropagation();
    showManagerContext(launcher, [
      { label: "打开资源管理", action: openManager },
      { separator: true },
      { label: (launcher.dataset.material === "glass" ? "✓ " : "") + "玻璃质感", action: () => setLauncherStyle("glass") },
      { label: (launcher.dataset.material === "native" ? "✓ " : "") + "ComfyUI 原色（不透明）", action: () => setLauncherStyle("native") },
      { separator: true },
      { label: "恢复浮窗位置", action: () => { position = null; launcher.style.left = launcher.style.top = ""; launcher.style.right = launcher.style.bottom = ""; savePreferences({ position: null }); } },
    ], event.clientX, event.clientY);
  });
  launcher.addEventListener("click", event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);
}

app.registerExtension({ name: "AllBuy.FullscreenManager", setup: installLauncher });
