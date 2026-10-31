import { workflowFolderRows, workflowTags } from "./workflow_library.js";
import { showManagerContext } from "./manager_controls.js";
import { bindWorkflowMarquee } from "./manager_workflow_marquee.js";

const chevron = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 3 5 5-5 5"/></svg>';
const folderIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9H2Z"/></svg>';
const pinIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m6 2 6 6-3 1-2 3-3-3 3-2Z M5 11l-3 3"/></svg>';
const selectIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="m4 8 3 3 5-6"/></svg>';
const addIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 3v10M3 8h10"/></svg>';

export class WorkflowSidebar {
  constructor(workflows, { readPreferences, savePreferences }) {
    this.workflows = workflows; this.host = workflows.host; this.savePreferences = savePreferences;
    const state = readPreferences().workflowSidebar || {};
    this.expanded = new Set(Array.isArray(state.expanded) ? state.expanded.filter(path => typeof path === "string") : []);
    this.pinned = Array.isArray(state.pinned) ? state.pinned.filter(path => typeof path === "string") : [];
    this.foldersOpen = state.foldersOpen !== false; this.tagsOpen = state.tagsOpen === true;
    this.width = Math.max(180, Math.min(380, Number(state.width) || 210)); this.query = "";
    this.selected = new Set(); this.multiselect = false; this.rootMultiselect = false;
    this.unbindMarquee = bindWorkflowMarquee(this);
  }
  save() {
    this.savePreferences({ workflowSidebar: { expanded: [...this.expanded], pinned: this.pinned, foldersOpen: this.foldersOpen, tagsOpen: this.tagsOpen, width: this.width, position: this.workflows.position || {} } });
  }
  iconButton(label, svg, action) {
    const node = this.workflows.button("", action, "abm-icon-button abm-tree-control");
    node.innerHTML = svg; node.title = label; node.setAttribute("aria-label", label); return node;
  }
  render() {
    const w = this.workflows, h = this.host, { el } = w;
    this.endResize?.();
    const scroll = w.pendingPosition?.navScroll ?? this.scroll?.scrollTop ?? 0;
    const focused = h.sidebar.contains(document.activeElement) ? document.activeElement : null;
    const focusPath = focused?.closest("[data-folder]")?.dataset.folder;
    const focusInTree = !!focused?.closest(".abm-folder-tree");
    const focusLabel = focused?.getAttribute("aria-label");
    const selected = w.folder();
    if (selected && selected !== this.lastFolder) this.expandParents(selected);
    this.lastFolder = selected;
    h.root.style.setProperty("--abm-workflow-sidebar-width", this.width + "px"); h.sidebar.replaceChildren();
    const quick = el("div", "abm-workflow-quick");
    quick.append(el("div", "abm-section-label", "工作流导航"), h.navItem("全部工作流", "", w.items.length),
      h.navItem("我的收藏", "favorite", w.items.filter(item => w.meta(item).favorite).length),
      h.navItem("最近修改", "recent", Math.min(w.items.length, 20)),
      h.navItem("缺失节点", "missing", w.items.filter(item => item.summary?.missing.length).length), h.navItem("回收站", "trash", w.library.deleted.length));
    this.scroll = el("div", "abm-workflow-nav-scroll");
    this.scroll.addEventListener("scroll", w.onPosition);
    const pinned = this.pinned.filter(path => w.library.folders.includes(path));
    if (pinned.length) {
      this.scroll.appendChild(el("div", "abm-section-label", "常用文件夹"));
      for (const path of pinned) this.scroll.appendChild(this.folderRow({ path, depth: 0 }, true));
    }
    const heading = el("div", "abm-tree-heading");
    const toggle = w.button("工作流文件夹", () => { this.foldersOpen = !this.foldersOpen; this.save(); this.render(); }, "abm-tree-section-toggle");
    toggle.prepend(this.arrow(this.foldersOpen)); toggle.setAttribute("aria-expanded", String(this.foldersOpen));
    const collapse = this.iconButton("全部收起", '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M5 2h8v9M3 5h7v9H3ZM5 9.5h3"/></svg>', () => {
      this.expanded.clear(); this.save(); this.renderTree();
    });
    collapse.disabled = !this.foldersOpen || !!this.query.trim();
    const create = this.iconButton("新建文件夹", addIcon, () => h.run(() => w.createFolder()));
    const multi = this.iconButton("多选文件夹", selectIcon, () => { this.multiselect = !this.multiselect; if (!this.multiselect) this.selected.clear(); this.render(); });
    multi.setAttribute("aria-pressed", String(this.multiselect)); multi.classList.toggle("is-active", this.multiselect);
    create.disabled = !w.loaded || h.loading || h.busy; heading.append(toggle, multi, collapse, create); this.scroll.appendChild(heading);
    if (this.selected.size) {
      const batch = el("div", "abm-folder-batch");
      batch.append(el("span", "abm-muted", `已选 ${this.selected.size} 个`), w.button("清除", () => { this.selected.clear(); this.render(); }), h.action("移入回收站", () => w.removeFolders([...this.selected]), !h.busy && !h.loading)); this.scroll.appendChild(batch);
      const contained = w.items.filter(item => [...this.selected].some(path => item.path.startsWith(path + "/")));
      if (w.opened(contained).length) batch.appendChild(h.action("保存并关闭页签", () => w.saveClose(contained)));
    }
    this.folderBody = el("div", "abm-tree-body"); this.folderBody.hidden = !this.foldersOpen;
    const search = w.input("搜索文件夹", this.query, "search"); search.placeholder = "搜索目录 / 根目录文件"; search.classList.add("abm-folder-search");
    search.addEventListener("input", () => { this.query = search.value; collapse.disabled = !this.foldersOpen || !!this.query.trim(); this.renderTree(); });
    search.addEventListener("keydown", event => { if (event.key === "Escape" && search.value) { event.preventDefault(); event.stopPropagation(); search.value = this.query = ""; collapse.disabled = false; this.renderTree(); } });
    this.tree = el("div", "abm-folder-tree"); this.tree.setAttribute("role", "tree"); this.tree.setAttribute("aria-label", "工作流文件夹"); this.tree.setAttribute("aria-multiselectable", "true");
    this.folderBody.append(search, this.tree); this.scroll.appendChild(this.folderBody); this.renderTree();
    const tags = workflowTags(w.library.metadata);
    {
      const toggleTags = w.button("标签", () => { this.tagsOpen = !this.tagsOpen; this.save(); this.render(); }, "abm-tree-section-toggle");
      toggleTags.prepend(this.arrow(this.tagsOpen)); toggleTags.setAttribute("aria-expanded", String(this.tagsOpen));
      const tagHeading = el("div", "abm-tree-heading"), manage = this.iconButton("管理工作流标签", '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M6 10v4"/></svg>', () => w.manageTags());
      manage.disabled = !w.loaded || h.loading || h.busy; tagHeading.append(toggleTags, el("span", "abm-count", String(tags.length)), manage);
      const body = el("div", "abm-workflow-tags"); body.hidden = !this.tagsOpen;
      for (const tag of tags) body.appendChild(h.navItem("# " + tag, "tag:" + tag, w.items.filter(item => w.meta(item).tags?.includes(tag)).length));
      if (!tags.length) body.appendChild(el("p", "abm-tree-empty abm-muted", "暂无标签，点击右侧管理按钮创建"));
      this.scroll.append(tagHeading, body);
    }
    h.sidebar.append(quick, this.scroll, this.resizeHandle()); this.scroll.scrollTop = scroll;
    const workflowPath = focused?.closest("[data-workflow-path]")?.dataset.workflowPath;
    if (workflowPath) [...this.tree.querySelectorAll("[data-workflow-path]")].find(node => node.dataset.workflowPath === workflowPath)?.focus({ preventScroll: true });
    else if (focusPath) [...(focusInTree ? this.tree.children : h.sidebar.querySelectorAll("[data-folder]"))].find(node => node.dataset.folder === focusPath)?.focus({ preventScroll: true });
    else if (focusLabel) [...h.sidebar.querySelectorAll("[aria-label]")].find(node => node.getAttribute("aria-label") === focusLabel)?.focus({ preventScroll: true });
  }
  arrow(open) {
    const node = this.workflows.el("span", "abm-tree-chevron" + (open ? " is-open" : "")); node.innerHTML = chevron; node.setAttribute("aria-hidden", "true"); return node;
  }
  expandParents(path) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { this.expanded.add(parts.join("/")); parts.pop(); }
    this.save();
  }
  reveal(path) {
    if (!path.includes("/")) { this.highlightRoot(path); return; }
    this.expandParents(path); this.foldersOpen = true;
    // A workflow path includes its filename; its ancestors are the folders to reveal.
    this.save();
    if (this.host.tab === "workflows") {
      this.render();
      const folder = path.slice(0, path.lastIndexOf("/"));
      [...this.tree.children].find(node => node.dataset.folder === folder)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  renderTree(focusPath, focusWorkflow) {
    if (!this.tree) return;
    const { el } = this.workflows; this.tree.replaceChildren();
    const rows = workflowFolderRows(this.workflows.library.folders, this.expanded, this.query);
    for (const row of rows) this.tree.appendChild(this.folderRow(row));
    const roots = this.workflows.items.filter(item => !item.path.includes("/") && item.name.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }));
    if (roots.length || !this.query.trim()) {
      const group = el("div", "abm-root-workflows"); group.setAttribute("role", "group"); group.setAttribute("aria-label", "根目录工作流");
      const heading = el("div", "abm-root-heading"), nav = this.host.navItem("根目录工作流", "root", roots.length); nav.classList.add("abm-root-nav");
      const w = this.workflows, h = this.host;
      const multi = this.iconButton("多选根目录工作流", selectIcon, () => {
        this.rootMultiselect = !this.rootMultiselect;
        if (!this.rootMultiselect) for (const item of w.items) if (!item.path.includes("/")) h.selection.delete(item.path);
        this.render(); w.renderList();
      });
      multi.setAttribute("aria-pressed", String(this.rootMultiselect)); multi.classList.toggle("is-active", this.rootMultiselect);
      const create = this.iconButton("在根目录新建文件夹", addIcon, () => h.run(() => w.createFolder("")));
      multi.disabled = create.disabled = !w.loaded || h.loading || h.busy; heading.append(nav, multi, create); group.appendChild(heading);
      for (const item of roots) group.appendChild(this.rootRow(item)); this.tree.appendChild(group);
    }
    if (!rows.length && !roots.length) this.tree.appendChild(el("div", "abm-tree-empty abm-muted", this.query ? "没有匹配的目录或文件" : "暂无目录或根目录工作流"));
    if (focusPath) [...this.tree.children].find(node => node.dataset.folder === focusPath)?.focus({ preventScroll: true });
    if (focusWorkflow) [...this.tree.querySelectorAll("[data-workflow-path]")].find(node => node.dataset.workflowPath === focusWorkflow)?.focus({ preventScroll: true });
  }
  toggleFolder(path) {
    this.expanded.has(path) ? this.expanded.delete(path) : this.expanded.add(path); this.save(); this.renderTree(path);
  }
  pin(path) {
    this.pinned = this.pinned.includes(path) ? this.pinned.filter(item => item !== path) : [...this.pinned, path]; this.save(); this.render();
  }
  folderRow({ path, depth, branch = false, open = false }, pinned = false) {
    const w = this.workflows, h = this.host, { el } = w, row = el("div", "abm-tree-row");
    row.dataset.folder = path; row.title = path; row.tabIndex = 0;
    row.style.setProperty("--abm-tree-depth", depth); row.classList.toggle("is-active", w.folder() === path);
    row.classList.toggle("is-selected", this.selected.has(path));
    row.setAttribute("role", pinned ? "group" : "treeitem"); row.setAttribute("aria-label", path);
    if (!pinned) { row.setAttribute("aria-level", String(depth + 1)); row.setAttribute("aria-selected", String(this.selected.has(path))); }
    if (branch) row.setAttribute("aria-expanded", String(open));
    if (!pinned) {
      const arrow = this.iconButton((open ? "收起 " : "展开 ") + path, chevron, () => { if (!this.query.trim()) this.toggleFolder(path); });
      arrow.classList.add("abm-tree-arrow"); arrow.classList.toggle("is-open", open); arrow.tabIndex = -1; arrow.disabled = !branch || !!this.query.trim();
      if (!branch) arrow.style.visibility = "hidden"; row.appendChild(arrow);
    }
    const check = w.input("选择文件夹 " + path, "", "checkbox"); check.className = "abm-folder-checkbox"; check.checked = this.selected.has(path); check.tabIndex = -1; check.hidden = !this.multiselect && !check.checked; check.disabled = h.loading || h.busy;
    check.addEventListener("click", event => event.stopPropagation()); check.addEventListener("change", () => this.selectFolder(path, false, check.checked)); row.appendChild(check);
    const select = h.navItem(path.split("/").pop(), "folder:" + path, w.items.filter(item => item.path.startsWith(path + "/")).length);
    select.addEventListener("click", event => {
      if (this.multiselect || event.ctrlKey || event.metaKey || event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); this.selectFolder(path, event.shiftKey); }
    }, true);
    select.title = path; select.tabIndex = -1; select.classList.remove("is-active");
    const icon = el("span", "abm-tree-folder-icon"); icon.innerHTML = folderIcon; select.prepend(icon);
    select.addEventListener("click", () => this.folderBody?.hidden && this.reveal(path + "/")); row.appendChild(select);
    const pin = this.iconButton((this.pinned.includes(path) ? "取消固定 " : "固定文件夹 ") + path, pinIcon, () => this.pin(path));
    pin.classList.add("abm-tree-pin"); pin.classList.toggle("is-pinned", this.pinned.includes(path)); pin.tabIndex = -1; pin.setAttribute("aria-pressed", String(this.pinned.includes(path))); row.appendChild(pin);
    row.addEventListener("contextmenu", event => {
      event.preventDefault(); event.stopPropagation();
      const chosen = this.selected.has(path) ? [...this.selected] : [path];
      const contained = w.items.filter(item => chosen.some(folder => item.path.startsWith(folder + "/")));
      showManagerContext(select, [{ label: this.pinned.includes(path) ? "取消固定文件夹" : "固定到常用文件夹", action: () => this.pin(path) },
        { label: "在目录树中定位", action: () => { this.query = ""; this.reveal(path + "/"); const target = [...this.tree.children].find(node => node.dataset.folder === path); target?.focus(); target?.scrollIntoView({ block: "nearest" }); } },
        { label: this.selected.has(path) ? "取消选择文件夹" : "选择此文件夹", action: () => this.selectFolder(path) },
        ...(w.opened(contained).length ? [{ label: `保存并关闭目录内页签（${w.opened(contained).length}）`, disabled: h.busy || h.loading, action: () => h.run(() => w.saveClose(contained)) }] : []),
        { separator: true }, { label: "移入回收站", description: `（${chosen.length} 个文件夹）`, danger: true, disabled: h.busy || h.loading, action: () => h.run(() => w.removeFolders(chosen)) }], event.clientX, event.clientY);
    });
    row.addEventListener("keydown", event => {
      if (event.target !== row) return;
      const rows = pinned ? [...row.parentElement.children].filter(node => node.dataset.folder) : [...this.tree.querySelectorAll(".abm-tree-row")], index = rows.indexOf(row);
      if (event.key === " ") { event.preventDefault(); this.selectFolder(path, event.shiftKey); }
      else if (event.key === "Enter") { event.preventDefault(); select.click(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); for (const node of rows) if (node.dataset.folder) this.selected.add(node.dataset.folder); this.multiselect = true; this.render(); }
      else if (event.key === "Delete" && !h.busy && !h.loading) { event.preventDefault(); h.run(() => w.removeFolders(this.selected.has(path) ? [...this.selected] : [path])); }
      else if (event.key === "ArrowRight" && !pinned) { event.preventDefault(); if (branch && !open && !this.query.trim()) this.toggleFolder(path); else if (open) rows[index + 1]?.focus(); }
      else if (event.key === "ArrowLeft" && !pinned) {
        event.preventDefault(); if (open && !this.query.trim()) this.toggleFolder(path);
        else rows.find(node => node.dataset.folder === path.slice(0, path.lastIndexOf("/")))?.focus();
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault(); rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    });
    row.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes("application/x-allbuy-workflows")) { event.preventDefault(); row.classList.add("is-drop-target"); } });
    row.addEventListener("dragleave", event => { if (!row.contains(event.relatedTarget)) row.classList.remove("is-drop-target"); });
    row.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); row.classList.remove("is-drop-target");
      let paths; try { paths = JSON.parse(event.dataTransfer.getData("application/x-allbuy-workflows")); } catch { return; }
      if (!Array.isArray(paths) || h.loading || h.busy) return;
      const selected = w.items.filter(item => paths.includes(item.path)); if (selected.length) h.run(() => w.move(selected, path));
    });
    return row;
  }
  selectFolder(path, range = false, checked = !this.selected.has(path)) {
    if (this.host.busy || this.host.loading) return;
    const visible = [...this.tree.children].map(node => node.dataset.folder), a = visible.indexOf(this.anchor), b = visible.indexOf(path);
    if (range && a >= 0 && b >= 0) for (const item of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(item);
    else checked ? this.selected.add(path) : this.selected.delete(path);
    this.anchor = path; this.multiselect = true; this.render();
  }
  highlightRoot(path) {
    this.tree?.querySelectorAll("[data-workflow-path]").forEach(row => { const focused = row.dataset.workflowPath === path; row.classList.toggle("is-focused", focused); row.setAttribute("aria-current", String(focused)); });
  }
  rootRow(item) {
    const w = this.workflows, h = this.host, row = w.el("div", "abm-tree-row abm-tree-workflow"); row.dataset.workflowPath = item.path; row.tabIndex = 0;
    row.title = item.path; row.setAttribute("role", "treeitem"); row.setAttribute("aria-level", "1"); row.setAttribute("aria-label", item.name);
    row.classList.toggle("is-focused", h.focused === item.path); row.classList.toggle("is-selected", h.selection.has(item.path)); row.setAttribute("aria-selected", String(h.selection.has(item.path))); row.setAttribute("aria-current", String(h.focused === item.path));
    const toggle = () => {
      if (h.busy || h.loading) return;
      h.selection.has(item.path) ? h.selection.delete(item.path) : h.selection.add(item.path);
      this.renderTree(null, item.path); w.renderList();
    };
    const check = w.input("选择根目录工作流 " + item.name, "", "checkbox"); check.className = "abm-folder-checkbox"; check.checked = h.selection.has(item.path); check.hidden = !this.rootMultiselect && !check.checked; check.tabIndex = -1; check.disabled = h.busy || h.loading;
    check.addEventListener("click", event => event.stopPropagation()); check.addEventListener("change", toggle);
    const select = w.button("", event => {
      if (h.busy || h.loading) return;
      if (event.ctrlKey || event.metaKey || this.rootMultiselect) { toggle(); return; }
      w.focusRoot(item);
    }, "abm-nav-item"); select.tabIndex = -1;
    const icon = w.el("span", "abm-tree-folder-icon"); icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 2h7l5 5v11H4ZM11 2v5h5"/></svg>';
    select.append(icon, w.el("span", "abm-nav-label", item.name)); row.append(check, select);
    if (w.meta(item).favorite) { const favorite = w.el("span", "abm-root-bookmark"); favorite.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 4h12v17l-6-4-6 4V4Z"/></svg>'; favorite.title = "已收藏"; row.appendChild(favorite); }
    row.addEventListener("dblclick", event => { if (!event.target.closest("input")) w.open(item); });
    row.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); if (!h.busy && !h.loading) { w.focusRoot(item); w.context(item, row, event); } });
    row.addEventListener("keydown", event => {
      if (event.target !== row || h.busy || h.loading) return;
      if (event.key === "Enter") { event.preventDefault(); w.open(item); }
      else if (event.key === " ") { event.preventDefault(); toggle(); }
      else if (event.key === "F2") { event.preventDefault(); h.run(() => w.rename(item)); }
      else if (event.key === "Delete") { event.preventDefault(); h.run(() => w.remove(h.selection.has(item.path) ? w.items.filter(file => h.selection.has(file.path)) : [item])); }
      else if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); const rows = [...this.tree.querySelectorAll(".abm-tree-row")], index = rows.indexOf(row); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    });
    row.draggable = true; row.addEventListener("dragstart", event => { event.dataTransfer.setData("application/x-allbuy-workflows", JSON.stringify(h.selection.has(item.path) ? [...h.selection] : [item.path])); event.dataTransfer.effectAllowed = "move"; }); return row;
  }
  resizeHandle() {
    const h = this.host, grip = this.workflows.el("div", "abm-sidebar-resize"); grip.tabIndex = 0;
    grip.setAttribute("role", "separator"); grip.setAttribute("aria-orientation", "vertical"); grip.setAttribute("aria-label", "调整工作流侧栏宽度"); grip.title = "拖动调整宽度 · 双击重置";
    grip.setAttribute("aria-valuemin", "180"); grip.setAttribute("aria-valuemax", "380"); grip.setAttribute("aria-valuenow", String(this.width));
    const set = value => { this.width = Math.round(Math.max(180, Math.min(380, value))); h.root.style.setProperty("--abm-workflow-sidebar-width", this.width + "px"); grip.setAttribute("aria-valuenow", String(this.width)); };
    grip.addEventListener("dblclick", () => { set(210); this.save(); });
    grip.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); set(event.key === "Home" ? 180 : event.key === "End" ? 380 : this.width + (event.key === "ArrowRight" ? 10 : -10)); this.save();
    });
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); grip.setPointerCapture(event.pointerId);
      const start = event.clientX, width = this.width, scale = h.sidebar.getBoundingClientRect().width / h.sidebar.offsetWidth;
      const move = event => set(width + (event.clientX - start) / (scale || 1));
      const end = () => {
        grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", end); grip.removeEventListener("pointercancel", end); grip.removeEventListener("lostpointercapture", end);
        h.root.classList.remove("is-sidebar-resizing"); this.save(); this.endResize = null;
      };
      this.endResize = end; h.root.classList.add("is-sidebar-resizing");
      grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", end); grip.addEventListener("pointercancel", end); grip.addEventListener("lostpointercapture", end);
    }); return grip;
  }
  destroy() { this.unbindMarquee?.(); this.endResize?.(); }
}
