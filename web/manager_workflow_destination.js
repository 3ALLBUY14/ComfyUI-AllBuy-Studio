import { workflowFolderRows, workflowDestinationFolders, workflowTags } from "./workflow_library.js";
import { mountPopup, closeManagerPopup } from "./manager_controls.js";

export function workflowDestinationSelect(w) {
  const { el, button, input, navigation: nav, library } = w;
  const wrapper = el("div", "abm-select abm-destination-select"), caption = el("span", "abm-select-caption");
  const trigger = button("", () => open(), "abm-input abm-select-trigger");
  trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-label", "目标文件夹");
  trigger.setAttribute("aria-haspopup", "tree"); trigger.setAttribute("aria-expanded", "false");
  trigger.append(caption, el("span", "abm-select-chevron", "⌄")); wrapper.appendChild(trigger);
  let selected = w.folder();
  Object.defineProperty(wrapper, "value", { get: () => selected });
  const update = () => { caption.textContent = selected || "工作流根目录"; trigger.title = caption.textContent; }; update();
  const open = () => {
    if (trigger.getAttribute("aria-expanded") === "true") { closeManagerPopup(); return; }
    const popup = el("div", "abm-popup abm-destination-popup"), search = input("搜索目标文件夹", "", "search");
    search.classList.add("abm-popup-search");
    const categories = el("div", "abm-destination-categories"), list = el("div", "abm-destination-list");
    categories.setAttribute("role", "group"); categories.setAttribute("aria-label", "标签分类");
    list.setAttribute("role", "tree"); list.setAttribute("aria-label", "目标文件夹目录树"); list.id = "abm-destination-tree";
    trigger.setAttribute("aria-controls", list.id);
    const expanded = new Set(nav.expanded); let category = "", close;
    const parts = selected.split("/"); parts.pop(); while (parts.length) { expanded.add(parts.join("/")); parts.pop(); }
    const choose = path => { selected = path; update(); close(true); };
    const row = ({ path, depth = 0, branch = false, open = false }, pinned = false, selectable = true) => {
      const node = el("div", "abm-tree-row abm-destination-row"); node.dataset.folder = path; node.tabIndex = 0; node.title = path || "工作流根目录";
      node.style.setProperty("--abm-tree-depth", depth); node.classList.toggle("is-active", selected === path);
      node.setAttribute("role", "treeitem"); node.setAttribute("aria-label", path || "工作流根目录");
      node.setAttribute("aria-level", String(depth + 1)); node.setAttribute("aria-selected", String(selected === path));
      if (branch) node.setAttribute("aria-expanded", String(open));
      const toggle = () => { expanded.has(path) ? expanded.delete(path) : expanded.add(path); draw(path, pinned); };
      const arrow = nav.iconButton((open ? "收起 " : "展开 ") + path, '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m6 3 5 5-5 5"/></svg>', toggle);
      arrow.classList.add("abm-tree-arrow"); arrow.classList.toggle("is-open", open); arrow.disabled = !branch || !!search.value.trim(); arrow.tabIndex = -1;
      if (!branch) arrow.style.visibility = "hidden";
      const label = button("", () => choose(path), "abm-destination-label"); label.tabIndex = -1;
      if (!selectable) { label.disabled = true; node.classList.add("is-ancestor"); }
      const icon = el("span", "abm-tree-folder-icon"); icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v9H2Z"/></svg>';
      label.append(icon, el("span", "abm-select-caption", path ? pinned ? path : path.split("/").pop() : "工作流根目录"));
      node.append(arrow, label);
      const pin = () => {
        nav.pinned = nav.pinned.includes(path) ? nav.pinned.filter(value => value !== path) : [...nav.pinned, path];
        if (!nav.pinned.includes(path)) {
          const parts = path.split("/"); parts.pop(); while (parts.length) { expanded.add(parts.join("/")); parts.pop(); }
        }
        nav.save(); draw(path, pinned && nav.pinned.includes(path));
      };
      if (path) {
        const saved = nav.pinned.includes(path), control = nav.iconButton((saved ? "取消收藏置顶 " : "收藏置顶 ") + path, '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="m6 2 6 6-3 1-2 3-3-3 3-2Z M5 11l-3 3"/></svg>', pin);
        control.classList.add("abm-tree-pin"); control.classList.toggle("is-pinned", saved); control.tabIndex = -1; control.setAttribute("aria-pressed", String(saved)); node.appendChild(control);
      }
      node.addEventListener("keydown", event => {
        if (event.target !== node) return;
        const rows = [...list.querySelectorAll(".abm-destination-row")], index = rows.indexOf(node);
        if (["Enter", " "].includes(event.key)) { event.preventDefault(); if (selectable) choose(path); else if (branch && !search.value.trim()) toggle(); }
        else if (event.key.toLowerCase() === "p" && path) { event.preventDefault(); pin(); }
        else if (event.key === "ArrowRight") { event.preventDefault(); if (branch && !open && !search.value.trim()) toggle(); else if (open) rows[index + 1]?.focus(); }
        else if (event.key === "ArrowLeft") { event.preventDefault(); if (open && !search.value.trim()) toggle(); else rows.find(row => row.dataset.folder === (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""))?.focus(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }
      });
      return node;
    };
    const draw = (focusPath, pinned = false) => {
      list.replaceChildren();
      const eligible = workflowDestinationFolders(library.folders, w.items, library.metadata, category);
      const visible = new Set(eligible), term = search.value.trim().toLocaleLowerCase();
      // Keep structural ancestors for filtered empty/untagged destinations without making them selectable.
      for (const path of eligible) { const parts = path.split("/"); parts.pop(); while (parts.length) { visible.add(parts.join("/")); parts.pop(); } }
      const roots = row({ path: "" }); list.appendChild(roots);
      const pinnedPaths = nav.pinned.filter(path => eligible.includes(path) && path.toLocaleLowerCase().includes(term));
      if (pinnedPaths.length) {
        list.appendChild(el("div", "abm-destination-heading", "收藏置顶"));
        const group = el("div"); group.setAttribute("role", "group"); group.dataset.pinned = "true";
        pinnedPaths.forEach(path => group.appendChild(row({ path }, true))); list.appendChild(group);
      }
      const heading = el("div", "abm-destination-heading", "目录树"), collapse = button("全部收起", () => { expanded.clear(); draw(); });
      collapse.disabled = !!term; heading.appendChild(collapse); list.appendChild(heading);
      const tree = el("div"); tree.setAttribute("role", "group");
      for (const item of workflowFolderRows(library.folders.filter(path => visible.has(path)), expanded, search.value)) {
        tree.appendChild(row(item, false, eligible.includes(item.path)));
      }
      if (!tree.childElementCount) tree.appendChild(el("div", "abm-popup-empty", "没有匹配目录，可切换分类或清空搜索"));
      list.appendChild(tree);
      if (focusPath !== undefined) {
        const focus = [...(pinned ? list.querySelector('[data-pinned="true"]')?.children || [] : tree.children)].find(node => node.dataset.folder === focusPath);
        focus?.focus({ preventScroll: true }); focus?.scrollIntoView({ block: "nearest" });
      }
    };
    for (const [key, text] of [["", "全部分类"], ["empty", "空文件夹"], ["untagged", "未标记"], ...workflowTags(library.metadata).map(tag => ["tag:" + tag, "# " + tag])]) {
      const chip = button(text, () => {
        category = key;
        if (key) for (const path of workflowDestinationFolders(library.folders, w.items, library.metadata, key)) {
          const parts = path.split("/"); parts.pop(); while (parts.length) { expanded.add(parts.join("/")); parts.pop(); }
        }
        for (const node of categories.children) node.setAttribute("aria-pressed", String(node === chip)); draw();
      }, "abm-destination-category"); chip.title = text; chip.setAttribute("aria-pressed", String(!key)); categories.appendChild(chip);
    }
    const hint = el("div", "abm-destination-hint", "按目录内工作流标签分类（含子目录） · 图钉收藏，P 键切换");
    popup.append(search, categories, list, hint); draw();
    close = mountPopup(trigger, popup); trigger.setAttribute("aria-expanded", "true");
    search.addEventListener("input", () => draw());
    search.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); const rows = list.querySelectorAll('.abm-destination-row'); (event.key === "ArrowDown" ? rows[0] : rows[rows.length - 1])?.focus(); }
      if (event.key === "Enter") event.preventDefault();
    });
    search.focus();
  };
  trigger.addEventListener("keydown", event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(); } });
  return wrapper;
}
