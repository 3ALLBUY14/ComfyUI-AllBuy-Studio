// Long press separates marquee selection from ordinary workflow file dragging.
export function bindWorkflowMarquee(nav) {
  const w = nav.workflows, h = nav.host, sidebar = h.sidebar;
  let gesture, timer, frame, suppressClick = false;
  const refreshSelection = () => {
    sidebar.querySelectorAll(".abm-tree-row").forEach(row => {
      const selected = row.dataset.workflowPath ? h.selection.has(row.dataset.workflowPath) : nav.selected.has(row.dataset.folder);
      row.classList.toggle("is-selected", selected); row.setAttribute("aria-selected", String(selected));
      const check = row.querySelector('input[type="checkbox"]'); if (check) { check.checked = selected; check.hidden = !selected && !(row.dataset.workflowPath ? nav.rootMultiselect : nav.multiselect); }
    });
    w.renderList();
  };
  const finish = (cancel = false) => {
    clearTimeout(timer); cancelAnimationFrame(frame);
    const g = gesture; gesture = null; if (!g) return;
    g.box?.remove(); sidebar.classList.remove("is-marquee-selecting");
    if (sidebar.hasPointerCapture(g.id)) sidebar.releasePointerCapture(g.id);
    if (!g.active) return;
    suppressClick = true;
    if (cancel) { nav.selected = g.folders; h.selection = g.files; }
    else { if (nav.selected.size) nav.multiselect = true; if (h.selection.size) nav.rootMultiselect = true; }
    nav.render(); w.renderList();
  };
  const update = () => {
    const g = gesture; if (!g?.active) return;
    const area = nav.scroll.getBoundingClientRect(), scroll = nav.scroll.scrollTop;
    const left = Math.min(g.x, g.currentX), right = Math.max(g.x, g.currentX), top = Math.min(g.y, g.currentY + scroll), bottom = Math.max(g.y, g.currentY + scroll);
    const folders = new Set(g.add ? g.folders : []), files = new Set(g.add ? g.files : []);
    sidebar.querySelectorAll(".abm-tree-row").forEach(row => {
      const rect = row.getBoundingClientRect();
      if (rect.right < left || rect.left > right || rect.bottom + scroll < top || rect.top + scroll > bottom || !row.getClientRects().length) return;
      if (row.dataset.workflowPath) files.add(row.dataset.workflowPath);
      else if (row.dataset.folder) folders.add(row.dataset.folder);
    });
    const root = h.root.getBoundingClientRect(), x = Math.max(area.left, left), y = Math.max(area.top, top - scroll);
    Object.assign(g.box.style, { left: x - root.left + "px", top: y - root.top + "px", width: Math.max(0, Math.min(area.right, right) - x) + "px", height: Math.max(0, Math.min(area.bottom, bottom - scroll) - y) + "px" });
    const key = JSON.stringify([[...folders].sort(), [...files].sort()]);
    if (key !== g.key) { nav.selected = folders; h.selection = files; g.key = key; refreshSelection(); }
    const dy = g.currentY < area.top + 28 ? -9 : g.currentY > area.bottom - 28 ? 9 : 0;
    if (dy) nav.scroll.scrollTop += dy;
    frame = requestAnimationFrame(update);
  };
  const down = event => {
    if (gesture) finish(true);
    suppressClick = false;
    if (event.button !== 0 || event.pointerType !== "mouse" || h.tab !== "workflows" || h.busy || h.loading || h.childModal || !nav.scroll?.contains(event.target)) return;
    if (event.target.closest("input,textarea,.abm-tree-heading,.abm-root-heading,.abm-workflow-tags,.abm-sidebar-resize") || event.target.closest("button:not(.abm-nav-item)")) return;
    const g = gesture = { id: event.pointerId, x: event.clientX, y: event.clientY + nav.scroll.scrollTop, currentX: event.clientX, currentY: event.clientY, startY: event.clientY, add: event.ctrlKey || event.metaKey || event.shiftKey, folders: new Set(nav.selected), files: new Set(h.selection) };
    timer = setTimeout(() => {
      if (gesture !== g || !sidebar.isConnected || h.busy || h.loading) return;
      g.active = true; suppressClick = true;
      g.box = w.el("div", "abm-workflow-marquee"); g.box.setAttribute("aria-hidden", "true"); h.root.appendChild(g.box);
      sidebar.classList.add("is-marquee-selecting"); sidebar.setPointerCapture(g.id); update();
    }, 280);
  };
  const move = event => {
    const g = gesture; if (!g || g.id !== event.pointerId) return;
    if (!g.active) { if (Math.hypot(event.clientX - g.x, event.clientY - g.startY) > 6) finish(); return; }
    event.preventDefault(); g.currentX = event.clientX; g.currentY = event.clientY;
  };
  const up = event => {
    if (gesture?.id !== event.pointerId) return;
    if (gesture.active) { gesture.currentX = event.clientX; gesture.currentY = event.clientY; cancelAnimationFrame(frame); update(); }
    finish();
  };
  const cancel = () => finish(true);
  const click = event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); } };
  const drag = event => { if (gesture?.active) { event.preventDefault(); event.stopImmediatePropagation(); } else finish(); };
  const key = event => { if (event.key === "Escape" && gesture?.active) { event.preventDefault(); event.stopImmediatePropagation(); finish(true); } };
  sidebar.addEventListener("pointerdown", down, true); sidebar.addEventListener("click", click, true); sidebar.addEventListener("dblclick", click, true); sidebar.addEventListener("dragstart", drag, true);
  document.addEventListener("pointermove", move, { capture: true, passive: false }); document.addEventListener("pointerup", up, true); document.addEventListener("pointercancel", cancel, true); document.addEventListener("keydown", key, true); window.addEventListener("blur", cancel);
  return () => {
    finish(true); sidebar.removeEventListener("pointerdown", down, true); sidebar.removeEventListener("click", click, true); sidebar.removeEventListener("dblclick", click, true); sidebar.removeEventListener("dragstart", drag, true);
    document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", cancel, true); document.removeEventListener("keydown", key, true); window.removeEventListener("blur", cancel);
  };
}
