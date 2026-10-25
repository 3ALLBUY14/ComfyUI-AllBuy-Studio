import { WorkflowLibrary, filterWorkflows, workflowData, workflowPath, workflowFolderRoots, workflowTags } from "./workflow_library.js";
import { mediaThumbnail, openMediaLightbox } from "./manager_media.js";
import { showManagerContext, closeManagerPopup, hasManagerPopup } from "./manager_controls.js";
import { workflowDestinationSelect } from "./manager_workflow_destination.js";
import { WorkflowSidebar } from "./manager_workflow_sidebar.js";
import { manageWorkflowTags, editWorkflowTags } from "./manager_workflow_tags.js";

function graphCover(data) {
  const canvas = document.createElement("canvas"); canvas.width = 480; canvas.height = 300;
  const ctx = canvas.getContext("2d"); ctx.fillStyle = "#171a22"; ctx.fillRect(0, 0, 480, 300);
  const nodes = (data?.nodes || []).slice(0, 2500).map(node => ({ node, x: Number(node.pos?.[0]) || 0, y: Number(node.pos?.[1]) || 0, w: Math.max(60, Math.min(1000, Number(node.size?.[0]) || 180)), h: Math.max(35, Math.min(1000, Number(node.size?.[1]) || 90)) }));
  if (!nodes.length) { ctx.fillStyle = "#8791a5"; ctx.font = "16px sans-serif"; ctx.textAlign = "center"; ctx.fillText(data ? "空工作流" : "正在读取节点图…", 240, 155); return canvas.toDataURL(); }
  const left = Math.min(...nodes.map(n => n.x)), top = Math.min(...nodes.map(n => n.y));
  const width = Math.max(1, ...nodes.map(n => n.x + n.w - left)), height = Math.max(1, ...nodes.map(n => n.y + n.h - top));
  const scale = Math.min(440 / width, 260 / height), dx = (480 - width * scale) / 2, dy = (300 - height * scale) / 2;
  ctx.translate(dx - left * scale, dy - top * scale); ctx.scale(scale, scale);
  const ids = new Map(nodes.map(n => [String(n.node.id), n]));
  ctx.strokeStyle = "#687993"; ctx.lineWidth = Math.max(1.5, 1 / scale);
  for (const link of (data.links || []).slice(0, 5000)) {
    const a = ids.get(String(Array.isArray(link) ? link[1] : link.origin_id)), b = ids.get(String(Array.isArray(link) ? link[3] : link.target_id));
    if (!a || !b) continue;
    ctx.beginPath(); ctx.moveTo(a.x + a.w, a.y + a.h / 2); ctx.bezierCurveTo(a.x + a.w + 40, a.y + a.h / 2, b.x - 40, b.y + b.h / 2, b.x, b.y + b.h / 2); ctx.stroke();
  }
  for (const n of nodes) {
    ctx.fillStyle = "#353c4b"; ctx.fillRect(n.x, n.y, n.w, n.h);
    ctx.fillStyle = /^#[0-9a-f]{3,8}$/i.test(n.node.color || "") ? n.node.color : "#6b70a7"; ctx.fillRect(n.x, n.y, n.w, Math.min(n.h, 22));
    if (scale > .3) { ctx.fillStyle = "#ecedf3"; ctx.font = "12px sans-serif"; ctx.fillText(String(n.node.title || n.node.type).slice(0, 22), n.x + 7, n.y + 16, n.w - 14); }
  }
  return canvas.toDataURL();
}
function exportWorkflow(item, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = item.path.split("/").pop(); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class ManagerWorkflows {
  constructor(host, { app, api, el, button, input, field, select, readPreferences, savePreferences }) {
    Object.assign(this, { host, app, api, el, button, input, field, select });
    this.library = new WorkflowLibrary(api); this.loaded = false; this.loading = false; this.epoch = 0; this.drafts = new Map(); this.undo = [];
    this.navigation = new WorkflowSidebar(this, { readPreferences, savePreferences });
    this.position = readPreferences().workflowSidebar?.position || {};
    this.onPosition = () => { clearTimeout(this.positionTimer); this.positionTimer = setTimeout(() => this.rememberPosition(), 180); };
    host.list.addEventListener("scroll", this.onPosition); host.search.addEventListener("input", this.onPosition);
    if (host.tab === "workflows") this.restorePosition();
  }
  get items() { return this.library.items; }
  meta(item) { return this.library.metadata.entries[item.path] || {}; }
  folder() { return this.host.filter.startsWith("folder:") ? this.host.filter.slice(7) : ""; }
  manageTags() { return this.host.run(() => manageWorkflowTags(this)); }
  rememberPosition() {
    const h = this.host; if (h.tab !== "workflows" || !this.loaded || this.loading || this.pendingPosition) return;
    this.position = { filter: h.filter, focused: h.focused, query: h.search.value, sort: h.sort, limit: h.limit, listScroll: h.list.scrollTop, navScroll: this.navigation.scroll?.scrollTop || 0 };
    this.navigation.save();
  }
  restorePosition() {
    const h = this.host, p = this.position;
    h.filter = typeof p.filter === "string" && (/^(folder:|tag:)/.test(p.filter) || ["", "root", "favorite", "recent", "missing", "trash"].includes(p.filter)) ? p.filter : "";
    h.focused = typeof p.focused === "string" ? p.focused : null; h.search.value = typeof p.query === "string" ? p.query : "";
    h.sort = ["manual", "name", "desc", "favorite", "updated"].includes(p.sort) ? p.sort : "manual"; h.sortSelect.value = h.sort;
    h.limit = Math.max(80, Math.min(10000, Number(p.limit) || 80));
    this.pendingPosition = { listScroll: Math.max(0, Number(p.listScroll) || 0), navScroll: Math.max(0, Number(p.navScroll) || 0) };
    if (this.loaded) this.reconcile();
  }
  reconcile() {
    const h = this.host; let folder = this.folder();
    while (folder && !this.library.folders.includes(folder)) folder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    if (h.filter.startsWith("folder:")) h.filter = folder ? "folder:" + folder : "";
    if (h.filter.startsWith("tag:") && !workflowTags(this.library.metadata).includes(h.filter.slice(4))) h.filter = "";
    if (h.focused && !this.items.some(item => item.path === h.focused)) h.focused = null;
    this.navigation.selected = new Set([...this.navigation.selected].filter(path => this.library.folders.includes(path)));
  }
  filtered() {
    const h = this.host;
    const items = filterWorkflows(this.items, this.library.metadata, h.search.value, h.filter === "recent" ? "" : h.filter, h.filter === "recent" ? "updated" : h.sort);
    return h.filter === "recent" ? items.slice(0, 20) : items;
  }
  native(item) {
    const service = this.app.extensionManager?.workflow;
    return service?.getWorkflowByPath?.("workflows/" + item.path) || service?.getWorkflowByPath?.(item.path);
  }
  assertClosed(item) {
    const opened = this.app.extensionManager?.workflow?.openWorkflows || [];
    if (opened.some(file => String(file.path || "").replace(/^workflows\//, "") === item.path)) throw new Error("此工作流已在页签中打开，请先关闭该页签再改名、移动或移除");
  }
  async sync() { await this.app.extensionManager?.workflow?.syncWorkflows?.(); }
  async refresh() {
    const h = this.host;
    if (this.loading || h.busy) return;
    const epoch = ++this.epoch; this.indexing = false; this.loading = true; h.loading = true; h.render();
    try {
      await this.library.refresh(); this.loaded = true;
      this.reconcile();
      h.selection = new Set([...h.selection].filter(path => this.items.some(item => item.path === path)));
      h.report(`已读取 ${this.items.length} 个工作流 · 双击打开，拖到文件夹可移动`);
    } catch (error) { h.report(error.message, true); }
    finally {
      this.loading = false; h.loading = false;
      if (epoch === this.epoch && h.root.isConnected && h.tab === "workflows") { h.render(); this.indexVisible(); }
    }
  }
  render() {
    const h = this.host; closeManagerPopup();
    this.renderSidebar(); this.renderActions(); this.renderList();
    this.rememberPosition();
    if (!this.loaded && !this.loading && !h.busy && !h.loading) queueMicrotask(() => { if (!this.loaded && h.root.isConnected && h.tab === "workflows") this.refresh(); });
  }
  renderSidebar() {
    this.navigation.render();
  }
  renderActions() {
    const { host: h, button } = this; h.actions.replaceChildren();
    const refresh = button("↻ 刷新", () => this.refresh()); refresh.disabled = h.busy || h.loading;
    h.actions.append(refresh, h.action("导入 JSON", () => this.importFiles(), this.loaded), h.action("管理标签", () => manageWorkflowTags(this), this.loaded), h.action("保存当前工作流", () => this.saveCurrent(), this.loaded, true));
    if (this.undo.length) h.actions.appendChild(h.action("撤销移除", () => this.restore()));
  }
  renderList() {
    const { host: h, el, button } = this; h.masonryObserver?.disconnect(); h.stopMedia(h.list);
    if (h.filter === "trash") { this.renderTrash(); this.restoreScroll(); return; }
    const scroll = h.list.scrollTop, focusedPath = document.activeElement?.closest(".abm-workflow-card")?.dataset.path;
    const editingDetail = h.detail.contains(document.activeElement) && document.activeElement.matches("input,textarea");
    h.list.replaceChildren(); const filtered = this.filtered();
    h.subtitle.textContent = `${this.items.length} 个工作流 · 当前 ${filtered.length} 个` + (this.indexing ? " · 正在读取内容索引…" : "");
    const grid = el("div", "abm-collection abm-" + h.view);
    for (const [mode, node] of Object.entries(h.viewButtons)) { node.classList.toggle("is-active", mode === h.view); node.setAttribute("aria-pressed", String(mode === h.view)); }
    if (this.loading) grid.appendChild(el("div", "abm-empty", "正在读取 ComfyUI 工作流目录…"));
    else if (!filtered.length) grid.appendChild(el("div", "abm-empty", this.loaded ? "暂无匹配工作流，可保存当前画布或导入 JSON。" : "工作流读取失败，请点击刷新重试。"));
    else for (const item of filtered.slice(0, h.limit)) grid.appendChild(this.card(item));
    h.list.appendChild(grid); h.observeMasonry(grid);
    if (filtered.length > h.limit) h.list.appendChild(button("加载更多工作流", () => { h.limit += 80; this.renderList(); }, "abm-workflow-more"));
    h.list.scrollTop = scroll;
    if (focusedPath) [...grid.querySelectorAll(".abm-workflow-card")].find(node => node.dataset.path === focusedPath)?.focus({ preventScroll: true });
    if (!editingDetail) this.renderDetail(); this.renderBatch(); this.indexVisible(); this.restoreScroll();
  }
  restoreScroll() {
    if (!this.pendingPosition || !this.loaded || this.loading) return;
    const position = this.pendingPosition; cancelAnimationFrame(this.positionFrame);
    this.positionFrame = requestAnimationFrame(() => {
      if (this.host.tab !== "workflows" || !this.host.root.isConnected) return;
      this.host.list.scrollTop = position.listScroll; if (this.navigation.scroll) this.navigation.scroll.scrollTop = position.navScroll;
      if (this.pendingPosition === position) this.pendingPosition = null; this.rememberPosition();
    });
  }
  cover(item) {
    if (this.meta(item).cover) return { image: { url: "/allbuy_promptlibrary/cover/file?name=" + encodeURIComponent(this.meta(item).cover) } };
    if (!item.thumbnail || item.thumbnailPending && item.data) { item.thumbnail = graphCover(item.data); item.thumbnailPending = !item.data; }
    return { image: { url: item.thumbnail } };
  }
  focusRoot(item) {
    const h = this.host; h.filter = "root"; h.focused = item.path; h.search.value = "";
    h.limit = Math.max(80, Math.ceil((this.filtered().findIndex(file => file.path === item.path) + 1) / 80) * 80);
    h.heading.textContent = "工作流管理"; h.search.placeholder = "搜索工作流、模型、节点、标签和备注…";
    h.sidebar.querySelectorAll(".abm-nav-item").forEach(node => { node.classList.toggle("is-active", node.classList.contains("abm-root-nav")); node.setAttribute("aria-pressed", String(node.classList.contains("abm-root-nav"))); });
    h.sidebar.querySelectorAll("[data-folder]").forEach(node => node.classList.remove("is-active"));
    this.navigation.highlightRoot(item.path); this.renderList();
    [...h.list.querySelectorAll("[data-path]")].find(node => node.dataset.path === item.path)?.scrollIntoView({ block: "nearest", inline: "nearest" }); this.rememberPosition();
  }
  card(item) {
    const { host: h, el, input, button } = this, meta = this.meta(item);
    const node = el("article", "abm-card abm-workflow-card"); node.tabIndex = 0; node.dataset.path = item.path; node.setAttribute("aria-label", item.name);
    node.classList.toggle("is-focused", h.focused === item.path); node.classList.toggle("is-selected", h.selection.has(item.path));
    const focus = () => { h.focused = item.path; h.list.querySelectorAll(".abm-card").forEach(n => n.classList.toggle("is-focused", n === node)); this.navigation.reveal(item.path); this.renderDetail(); this.rememberPosition(); };
    node.addEventListener("click", event => { focus(); if (event.ctrlKey || event.metaKey) { h.selection.has(item.path) ? h.selection.delete(item.path) : h.selection.add(item.path); this.renderList(); } });
    node.addEventListener("dblclick", event => { if (!event.target.closest("button,input,.abm-media")) this.open(item); });
    node.addEventListener("keydown", event => {
      if (event.target !== node || h.busy || h.loading) return;
      if (event.key === "Enter") { event.preventDefault(); this.open(item); }
      if (event.key === "F2") { event.preventDefault(); h.run(() => this.rename(item)); }
      if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); const cards = [...h.list.querySelectorAll(".abm-card")], index = cards.indexOf(node);
        const columns = h.view === "list" ? 1 : Math.max(1, Math.floor(h.list.clientWidth / Math.max(1, node.offsetWidth)));
        const offset = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: -columns, ArrowDown: columns }[event.key];
        const next = cards[Math.max(0, Math.min(cards.length - 1, index + offset))]; next?.focus(); next?.click();
      }
    });
    node.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); if (!h.busy && !h.loading) { focus(); this.context(item, node, event); } });
    node.draggable = true; node.addEventListener("dragstart", event => { event.dataTransfer.setData("application/x-allbuy-workflows", JSON.stringify(h.selection.has(item.path) ? [...h.selection] : [item.path])); event.dataTransfer.effectAllowed = "move"; });
    const visual = el("div", "abm-card-visual"), thumbnail = mediaThumbnail(this.cover(item), () => this.open(item), { onDrop: file => h.run(() => this.setCover(item, file)) });
    thumbnail.title = "双击打开工作流 · 拖入图片设置封面"; thumbnail.setAttribute("aria-label", "打开工作流 " + item.name); visual.appendChild(thumbnail);
    const check = input("选择 " + item.name, "", "checkbox"); check.className = "abm-checkbox"; check.checked = h.selection.has(item.path); check.disabled = h.busy || h.loading;
    check.addEventListener("click", event => event.stopPropagation()); check.addEventListener("change", () => { check.checked ? h.selection.add(item.path) : h.selection.delete(item.path); node.classList.toggle("is-selected", check.checked); this.renderBatch(); }); visual.appendChild(check);
    const favorite = button("", event => { event.stopPropagation(); h.run(() => this.library.patch(item.path, { favorite: !meta.favorite })); }, "abm-card-favorite");
    favorite.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 4h12v17l-6-4-6 4V4Z"/></svg>';
    favorite.setAttribute("aria-label", (meta.favorite ? "取消收藏 " : "收藏 ") + item.name); favorite.setAttribute("aria-pressed", String(!!meta.favorite)); favorite.disabled = h.busy || h.loading;
    const title = el("div", "abm-card-title-row"); title.append(el("h3", "", item.name), favorite);
    const content = el("div", "abm-card-content");
    content.append(title, el("p", "abm-card-description", item.error || meta.note || (item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "工作流根目录")));
    const chips = el("div", "abm-chips");
    if ((this.app.extensionManager?.workflow?.openWorkflows || []).some(file => String(file.path || "").replace(/^workflows\//, "") === item.path)) chips.appendChild(el("span", "abm-chip", "已打开"));
    chips.appendChild(el("span", "abm-chip abm-workflow-count", item.summary ? item.summary.count + " 个节点" : "读取预览…"));
    if (item.summary?.missing.length) chips.appendChild(el("span", "abm-chip abm-error abm-workflow-missing", "缺失 " + item.summary.missing.length + " 类节点"));
    for (const tag of (meta.tags || []).slice(0, 2)) chips.appendChild(el("span", "abm-chip", tag));
    content.appendChild(chips); node.append(visual, content); return node;
  }
  indexVisible() {
    const h = this.host;
    if (!this.loaded || this.loading || h.busy || h.tab !== "workflows" || h.filter === "trash" || this.indexing) return;
    const all = h.search.value.trim() || h.filter === "missing";
    const pending = (all ? this.items : this.filtered().slice(0, h.limit)).filter(item => !item.data && !item.error);
    if (!pending.length) return;
    const epoch = this.epoch; this.indexing = true; let processed = 0;
    const worker = async () => {
      while (pending.length && epoch === this.epoch && h.root.isConnected && h.tab === "workflows" && h.filter !== "trash") {
        const item = pending.shift();
        try { await this.library.read(item, globalThis.LiteGraph?.registered_node_types || {}); }
        catch (error) { item.error = error.message; }
        processed++;
        if (processed % 8 === 0 && h.root.isConnected && h.tab === "workflows" && !h.busy) this.scheduleRender();
      }
    };
    Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker)).finally(() => {
      if (epoch !== this.epoch) return;
      this.indexing = false;
      if (epoch === this.epoch && h.root.isConnected && h.tab === "workflows" && !h.busy) this.scheduleRender();
    });
  }
  scheduleRender() {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      if (!this.host.root.isConnected || this.host.tab !== "workflows" || this.host.busy) return;
      if (hasManagerPopup()) { this.scheduleRender(); return; }
      this.updateIndexed();
    }, 120);
  }
  updateIndexed() {
    if (this.host.filter === "trash") return;
    const { host: h, el, button } = this, grid = h.list.querySelector(".abm-collection"); if (!grid) return;
    const filtered = this.filtered(), wanted = filtered.slice(0, h.limit), paths = new Set(wanted.map(item => item.path));
    const existing = new Map([...grid.querySelectorAll(".abm-workflow-card")].map(node => [node.dataset.path, node]));
    for (const [path, node] of existing) if (!paths.has(path)) node.remove();
    if (wanted.length) grid.querySelector(".abm-empty")?.remove();
    for (const item of wanted) {
      let node = existing.get(item.path); if (!node) node = this.card(item);
      grid.appendChild(node);
      if (item.data && !this.meta(item).cover && node.dataset.indexed !== "true") {
        const image = node.querySelector(".abm-media img"); image.src = this.cover(item).image.url; image.hidden = false; node.dataset.indexed = "true";
      }
      node.querySelector(".abm-workflow-count").textContent = item.summary ? item.summary.count + " 个节点" : item.error ? "无法读取" : "读取预览…";
      if (item.error) node.querySelector(".abm-card-description").textContent = item.error;
      if (item.summary?.missing.length && !node.querySelector(".abm-workflow-missing")) node.querySelector(".abm-chips").appendChild(el("span", "abm-chip abm-error abm-workflow-missing", "缺失 " + item.summary.missing.length + " 类节点"));
    }
    h.subtitle.textContent = `${this.items.length} 个工作流 · 当前 ${filtered.length} 个` + (this.indexing ? " · 正在读取内容索引…" : "");
    const missing = [...h.sidebar.querySelectorAll(".abm-nav-item")].find(node => node.querySelector(".abm-nav-label")?.textContent === "缺失节点");
    if (missing) missing.querySelector(".abm-count").textContent = this.items.filter(item => item.summary?.missing.length).length;
    if (filtered.length > h.limit && !h.list.querySelector(".abm-workflow-more")) h.list.appendChild(button("加载更多工作流", () => { h.limit += 80; this.renderList(); }, "abm-workflow-more"));
    if (!h.detail.contains(document.activeElement) && !h.detail.matches(":hover")) this.renderDetail();
    h.observeMasonry(grid); this.indexVisible();
  }
  renderDetail() {
    const { host: h, el, input, field } = this; h.stopMedia(h.detail); h.detail.replaceChildren();
    h.detail.appendChild(el("div", "abm-section-label", "工作流详情"));
    const item = this.items.find(item => item.path === h.focused);
    if (!item) { h.detail.append(el("h3", "", "选择一个工作流"), el("p", "abm-muted", "单击查看节点、模型与备注；双击打开。工作流来自 ComfyUI 当前用户目录。")); return; }
    const meta = this.meta(item);
    const preview = mediaThumbnail(this.cover(item), () => this.preview(item), { compact: false, onDrop: file => h.run(() => this.setCover(item, file)) });
    preview.title = "双击放大预览 · 拖入图片设置封面";
    h.detail.append(el("h3", "abm-detail-title", item.name), el("p", "abm-model-path", item.path), preview);
    const controls = el("div", "abm-detail-actions"), open = this.button("打开工作流", () => this.open(item), "abm-primary"); open.disabled = h.busy || h.loading;
    controls.append(open, h.action("导出 JSON", async () => exportWorkflow(item, await this.library.read(item, globalThis.LiteGraph?.registered_node_types || {}))));
    h.detail.append(controls, el("p", "abm-muted", new Date(Number(item.modified) * (Number(item.modified) < 1e12 ? 1000 : 1)).toLocaleString()));
    if (item.error) h.detail.appendChild(el("p", "abm-error", item.error));
    if (item.summary) {
      h.detail.appendChild(el("p", "abm-muted", `${item.summary.count} 个节点 · ${item.summary.models.length} 个模型文件`));
      if (item.summary.missing.length) h.detail.append(el("p", "abm-error", "缺失节点：" + item.summary.missing.join("、")));
      h.detail.appendChild(el("div", "abm-section-label", "模型与 LoRA"));
      for (const name of item.summary.models) h.detail.appendChild(el("p", "abm-workflow-model", name));
      if (!item.summary.models.length) h.detail.appendChild(el("p", "abm-muted", "未发现文件名形式的模型依赖"));
    }
    if (!this.drafts.has(item.path)) this.drafts.set(item.path, { note: meta.note || "", tags: (meta.tags || []).join(", ") });
    const draft = this.drafts.get(item.path), note = el("textarea", "abm-input abm-textarea"), tags = input("工作流标签", draft.tags);
    note.setAttribute("aria-label", "工作流备注"); note.value = draft.note; note.maxLength = 20000;
    note.addEventListener("input", () => { draft.note = note.value; }); tags.addEventListener("input", () => { draft.tags = tags.value; });
    h.detail.append(field("备注", note), field("标签（逗号分隔）", tags), h.action("保存备注与标签", async () => {
      const values = [...new Set(draft.tags.split(/[,，;；]/).map(value => value.trim()).filter(Boolean))];
      if (values.length > 50 || values.some(value => value.length > 50)) throw new Error("最多 50 个标签，每个不超过 50 字");
      await this.library.patch(item.path, { note: draft.note, tags: values }); h.report("备注与标签已保存");
    }), h.action("选择封面", () => this.chooseCover(item)), h.action("恢复节点图", () => this.library.patch(item.path, { cover: null }), !!meta.cover));
  }
  renderBatch() {
    const { host: h, el, button } = this; h.batch.replaceChildren(); const selected = this.items.filter(item => h.selection.has(item.path));
    h.batch.append(el("span", "abm-muted", `已选 ${selected.length} 项`), button("全选当前结果", () => { this.filtered().forEach(item => h.selection.add(item.path)); this.renderList(); }), button("清除选择", () => { h.selection.clear(); this.renderList(); }),
      h.action("编辑标签", () => editWorkflowTags(this, selected), !!selected.length), h.action("移动到文件夹", () => this.chooseMove(selected), !!selected.length), h.action("移除", () => this.remove(selected), !!selected.length));
  }
  context(item, anchor, event) {
    const h = this.host, chosen = h.selection.has(item.path) ? this.items.filter(row => h.selection.has(row.path)) : [item];
    const action = (label, callback) => ({ label, action: () => h.run(callback) });
    showManagerContext(anchor, [{ label: "打开工作流", action: () => this.open(item) }, { label: "放大预览", action: () => this.preview(item) },
      action(this.meta(item).favorite ? "取消收藏" : "收藏", () => this.library.patch(item.path, { favorite: !this.meta(item).favorite })), { separator: true },
      action("重命名", () => this.rename(item)), action("创建副本", () => this.duplicate(item)), action("移动到文件夹", () => this.chooseMove(chosen)),
      action("编辑标签", () => editWorkflowTags(this, chosen)),
      action("选择封面", () => this.chooseCover(item)), action("导出 JSON", async () => exportWorkflow(item, await this.library.read(item, globalThis.LiteGraph?.registered_node_types || {}))),
      { ...action("移入回收站", () => this.remove(chosen)), description: `（${chosen.length} 个工作流）`, danger: true }], event.clientX, event.clientY);
  }
  async afterChange(path = null) {
    ++this.epoch; this.indexing = false;
    await this.library.refresh(); if (path) this.host.focused = path; this.reconcile(); await this.sync(); this.host.report("工作流已更新");
  }
  async open(item) {
    const h = this.host; if (h.busy || h.loading || !h.stackEditor.allowDiscard()) return;
    let opened = false, suspended = false;
    await h.run(async () => {
      const data = await this.library.read(item, globalThis.LiteGraph?.registered_node_types || {});
      await this.sync(); const native = this.native(item); let state = data;
      if (native) {
        if (!native.isLoaded) await native.load();
        native.changeTracker?.prepareForSave(); state = native.activeState || data;
      } else if ((this.app.graph?._nodes || []).length && !confirm("将打开选中的工作流，请先保存当前画布。继续？")) return;
      h.root.style.display = "none"; suspended = true;
      for (const node of h.inertSiblings) node.inert = false;
      document.removeEventListener("keydown", h.onKey, true);
      // The workflow store only selects tabs; loadGraphData also loads the graph and tracks the previous draft.
      const loaded = await this.app.loadGraphData(JSON.parse(JSON.stringify(state)), true, true, native || item.name);
      if (loaded === false) throw new Error("工作流加载失败，请检查 ComfyUI 的缺失节点提示");
      opened = true;
    });
    if (opened) { h.stackEditor.dirty = false; h.close(); }
    else if (suspended && h.root.isConnected) {
      h.root.style.display = "";
      for (const node of h.inertSiblings) node.inert = true;
      document.addEventListener("keydown", h.onKey, true); h.root.focus();
    }
  }
  preview(item) {
    const h = this.host; h.mediaClose?.();
    h.mediaClose = openMediaLightbox(h.root, this.cover(item), item.name, "image", () => { h.mediaClose = null; h.root.focus(); }, { onDrop: async file => { await h.run(() => this.setCover(item, file)); return this.cover(item); } });
  }
  async chooseCover(item) {
    const picker = this.input("选择工作流封面", "", "file"); picker.accept = ".png,.jpg,.jpeg,.webp,.gif,.bmp";
    const file = await new Promise(resolve => { picker.addEventListener("change", () => resolve(picker.files?.[0]), { once: true }); picker.addEventListener("cancel", () => resolve(null), { once: true }); picker.click(); });
    if (file) await this.setCover(item, file);
  }
  async setCover(item, file) {
    if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) throw new Error("工作流封面请选择图片文件");
    if (file.size > 32 * 1024 * 1024) throw new Error("封面图片上限为 32 MB");
    const data = new FormData(); data.append("group_id", item.path); data.append("file", file);
    const response = await this.api.fetchApi("/allbuy_promptlibrary/cover/upload", { method: "POST", body: data });
    const result = await response.json(); if (!response.ok || !result.ok || !result.name) throw new Error(result.error || "封面上传失败");
    await this.library.patch(item.path, { cover: result.name }); this.host.report("工作流封面已保存");
  }
  async destination(title, initial, callback) {
    const { host: h, el, input, field } = this; const body = el("div"), path = input("名称或相对路径", initial);
    body.append(field("工作流目录内的名称或相对路径", path), el("p", "abm-muted", "例如：风景/自然光.json。已有文件不会被覆盖。"));
    return h.modal(title, body, async () => callback(workflowPath(path.value)));
  }
  async saveCurrent() {
    const folder = this.folder();
    if (!(this.app.graph?._nodes || []).length) throw new Error("当前画布没有可保存的节点");
    const exported = await this.app.graphToPrompt();
    await this.destination("保存当前工作流副本", (folder ? folder + "/" : "") + "我的工作流.json", async path => { const saved = await this.library.save(path, exported.workflow); await this.afterChange(saved); });
  }
  async rename(item) {
    this.assertClosed(item);
    await this.destination("重命名工作流", item.path, async path => { await this.library.move(item.path, path); this.drafts.delete(item.path); await this.afterChange(/\.json$/i.test(path) ? path : path + ".json"); });
  }
  async duplicate(item) {
    const data = await this.library.read(item, globalThis.LiteGraph?.registered_node_types || {});
    await this.destination("创建工作流副本", item.path.replace(/\.json$/i, " 副本.json"), async path => {
      const saved = await this.library.save(path, structuredClone(data));
      if (Object.keys(this.meta(item)).length) await this.library.patch(saved, { ...this.meta(item) });
      await this.afterChange(saved);
    });
  }
  async createFolder(parent = this.folder()) {
    const { host: h, el, input, field } = this, name = input("文件夹相对路径", parent ? parent + "/" : "");
    const body = el("div"); body.append(field("文件夹（可用 / 建立子目录）", name));
    await h.modal("新建工作流文件夹", body, async () => { const folder = workflowPath(name.value); await this.library.createFolder(folder); await this.afterChange(); h.filter = "folder:" + folder; });
  }
  async chooseMove(items) {
    const { host: h, el, field } = this, target = workflowDestinationSelect(this);
    const body = el("div"); body.append(field("目标文件夹", target));
    await h.modal(`移动 ${items.length} 个工作流`, body, () => this.move(items, target.value), "移动");
  }
  async move(items, folder) {
    items.forEach(item => this.assertClosed(item)); let count = 0;
    try {
      for (const item of items) { await this.library.move(item.path, (folder ? folder + "/" : "") + item.path.split("/").pop()); count++; }
    } catch (error) { throw new Error(`已处理 ${count} 项，后续停止：${error.message}`); }
    finally { this.host.selection.clear(); await this.afterChange(); }
  }
  async remove(items) {
    items.forEach(item => this.assertClosed(item));
    if (!items.length || !await this.confirmTrash(items.map(item => item.path), 0, items.length)) return;
    this.undo = [];
    try { for (const item of items) this.undo.push(await this.library.trash(item.path)); }
    finally { this.host.selection.clear(); await this.afterChange(); }
  }
  async removeFolders(paths) {
    const roots = workflowFolderRoots(paths).filter(path => this.library.folders.includes(path)); if (!roots.length) return;
    const inside = path => roots.some(root => path.startsWith(root + "/"));
    for (const file of this.app.extensionManager?.workflow?.openWorkflows || []) if (inside(String(file.path || "").replace(/^workflows\//, ""))) throw new Error("选中文件夹内有已打开的工作流，请先关闭相关页签");
    const count = this.items.filter(item => inside(item.path)).length;
    if (!await this.confirmTrash(roots, roots.length, count, roots.length < paths.length)) return;
    this.undo = []; let completed = 0;
    try { for (const path of roots) { this.undo.push(await this.library.trash(path, "folder")); completed++; } }
    catch (error) { throw new Error(`已移入回收站 ${completed} 个文件夹，后续停止：${error.message}`); }
    finally { this.navigation.selected.clear(); await this.afterChange(); }
  }
  confirmTrash(paths, folders, workflows, merged = false) {
    const { host: h, el } = this, body = el("div", "abm-trash-confirm");
    const summary = el("div", "abm-trash-confirm-summary");
    if (folders) summary.appendChild(el("span", "abm-chip", `${folders} 个文件夹`)); summary.appendChild(el("span", "abm-chip", `${workflows} 个工作流`));
    const description = el("p", "abm-muted", folders ? "所选文件夹及其子目录、预览素材将一并移入回收站。" : "所选工作流将移入回收站。"); description.id = "abm-trash-description";
    const list = el("ul", "abm-trash-confirm-paths"); for (const path of paths) list.appendChild(el("li", "", path));
    body.append(summary, description, list, el("p", "abm-muted", "可在左侧「回收站」恢复到原位置。"));
    if (merged) body.appendChild(el("p", "abm-muted", "父子目录已合并处理，子目录不会重复移动。"));
    const result = h.modal("移入回收站", body, async () => {}, "移入回收站");
    h.childModal.querySelector("form").setAttribute("aria-describedby", description.id); h.childModal.querySelector(".abm-modal-footer button").focus(); return result;
  }
  renderTrash() {
    const { host: h, el, button, input } = this, scroll = h.list.scrollTop; h.list.replaceChildren(); h.detail.replaceChildren(); h.batch.replaceChildren();
    h.heading.textContent = "工作流回收站"; h.search.placeholder = "搜索回收项目的原路径…"; const needle = h.search.value.trim().toLocaleLowerCase();
    const records = this.library.deleted.filter(record => record.path.toLocaleLowerCase().includes(needle)).sort((a, b) => ["name", "desc"].includes(h.sort) ? a.path.localeCompare(b.path, "zh-CN", { numeric: true }) * (h.sort === "desc" ? -1 : 1) : b.deletedAt - a.deletedAt);
    h.subtitle.textContent = `${this.library.deleted.length} 个回收项目 · 当前 ${records.length} 个`;
    const grid = el("div", "abm-collection abm-" + h.view);
    for (const record of records.slice(0, h.limit)) {
      const card = el("article", "abm-card abm-trash-card"), visual = el("div", "abm-card-visual abm-trash-visual", record.kind === "folder" ? "文件夹" : "工作流"); card.dataset.trashId = record.id;
      const check = input("选择回收项目 " + record.path, "", "checkbox"); check.className = "abm-checkbox"; check.checked = h.selection.has(record.id); check.disabled = h.busy || h.loading;
      check.addEventListener("change", () => { check.checked ? h.selection.add(record.id) : h.selection.delete(record.id); this.renderTrash(); }); visual.appendChild(check);
      const content = el("div", "abm-card-content");
      content.append(el("h3", "", record.path.split("/").pop()), el("p", "abm-model-path", record.path), el("p", "abm-muted", new Date(record.deletedAt).toLocaleString()), h.action("恢复", () => this.restoreRecords([record]), !h.busy));
      card.append(visual, content); grid.appendChild(card);
    }
    if (!records.length) grid.appendChild(el("div", "abm-empty", "回收站中没有匹配的项目"));
    h.list.appendChild(grid); h.observeMasonry(grid); h.list.scrollTop = scroll;
    if (records.length > h.limit) h.list.appendChild(button("加载更多回收项目", () => { h.limit += 80; this.renderTrash(); }));
    const chosen = records.filter(record => h.selection.has(record.id));
    h.batch.append(el("span", "abm-muted", `已选 ${chosen.length} 项`), button("全选当前结果", () => { records.forEach(record => h.selection.add(record.id)); this.renderTrash(); }), button("清除选择", () => { h.selection.clear(); this.renderTrash(); }), h.action("恢复所选", () => this.restoreRecords(chosen), !!chosen.length));
    h.detail.append(el("div", "abm-section-label", "回收站"), el("h3", "", "恢复到原位置"), el("p", "abm-muted", "文件夹连同其子目录和素材一并恢复。原位置已有同名文件或目录时会停止恢复，请先处理名称冲突。"));
  }
  async restoreRecords(records) {
    try { for (const record of records) { await this.library.restore(record); this.undo = this.undo.filter(item => item.id !== record.id); } }
    finally { this.host.selection.clear(); await this.afterChange(); }
  }
  async restore() {
    await this.restoreRecords([...this.undo].reverse());
  }
  async importFiles() {
    const picker = this.input("导入工作流 JSON", "", "file"); picker.accept = ".json,application/json"; picker.multiple = true;
    const files = await new Promise(resolve => { picker.addEventListener("change", () => resolve([...picker.files]), { once: true }); picker.addEventListener("cancel", () => resolve([]), { once: true }); picker.click(); });
    if (!files.length) return;
    const validated = [];
    for (const file of files) {
      if (file.size > 16 * 1024 * 1024) throw new Error("工作流导入上限为 16 MB");
      validated.push({ path: (this.folder() ? this.folder() + "/" : "") + workflowPath(file.name), data: workflowData(JSON.parse(await file.text())) });
    }
    let count = 0;
    try { for (const file of validated) { await this.library.save(file.path, file.data); count++; } }
    catch (error) { throw new Error(`已导入 ${count} 项，后续停止：${error.message}`); }
    finally { await this.afterChange(); }
  }
  destroy() {
    this.rememberPosition(); ++this.epoch; clearTimeout(this.renderTimer); clearTimeout(this.positionTimer); cancelAnimationFrame(this.positionFrame);
    this.host.list.removeEventListener("scroll", this.onPosition); this.host.search.removeEventListener("input", this.onPosition); this.navigation.destroy();
  }
}
