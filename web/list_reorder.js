// Native drag sorting with a real layout gap. State changes only on a valid drop.
export function reorderIds(ids, fromId, toId, after = false) {
  if (fromId === toId || !ids.includes(fromId) || !ids.includes(toId)) return [...ids];
  const result = ids.filter((id) => id !== fromId);
  result.splice(result.indexOf(toId) + (after ? 1 : 0), 0, fromId);
  return result;
}

export function installListReorder(list, { onDrop, canDrop = () => true }) {
  let drag = null;
  let frameId = 0;
  const items = () => [...list.querySelectorAll(".vpl-item[data-id]")]
    .filter((item) => item !== drag?.source && item.dataset.id !== drag?.source.dataset.id);
  const scale = () => list.offsetWidth ? list.getBoundingClientRect().width / list.offsetWidth : 1;
  const containsPoint = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

  function cancel() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    if (!drag) return;
    drag.animations.forEach((animation) => animation.cancel());
    drag.placeholder.remove();
    drag.source.classList.remove("vpl-sort-source", "vpl-dragging");
    drag.source.style.width = drag.width;
    list.classList.remove("vpl-sort-active");
    drag = null;
  }

  function revealGap() {
    if (!drag || drag.placeholder.isConnected) return;
    list.insertBefore(drag.placeholder, drag.source);
    drag.source.style.width = drag.source.offsetWidth + "px";
    drag.source.classList.add("vpl-sort-source");
    list.classList.add("vpl-sort-active");
  }

  function layoutRect(item) {
    const rect = item.getBoundingClientRect();
    // Hit test the final layout position while the visible item eases into it.
    if (!drag.animations.has(item)) return rect;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(item).transform);
    const zoom = scale();
    const dx = matrix.m41 * zoom, dy = matrix.m42 * zoom;
    return { left: rect.left - dx, right: rect.right - dx, top: rect.top - dy,
      bottom: rect.bottom - dy, width: rect.width, height: rect.height };
  }

  function moveGap(target, after) {
    const reference = after ? target.nextSibling : target;
    if (reference === drag.placeholder || drag.placeholder.nextSibling === reference) return;
    const siblings = items();
    const before = new Map(siblings.map((item) => [item, item.getBoundingClientRect()]));
    drag.animations.forEach((animation) => animation.cancel());
    drag.animations.clear();
    list.insertBefore(drag.placeholder, reference);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const zoom = scale() || 1;
    siblings.forEach((item) => {
      const old = before.get(item), now = item.getBoundingClientRect();
      const dx = (old.left - now.left) / zoom, dy = (old.top - now.top) / zoom;
      if (Math.abs(dx) + Math.abs(dy) < 1 || !item.animate) return;
      const animation = item.animate([
        { transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" },
      ], { duration: 150, easing: "cubic-bezier(.2,.8,.2,1)" });
      drag.animations.set(item, animation);
      const session = drag;
      animation.finished.then(() => {
        if (session.animations.get(item) === animation) session.animations.delete(item);
      }).catch(() => {});
    });
  }

  function updateGap(x, y) {
    if (!drag) return;
    revealGap();
    const bounds = list.getBoundingClientRect();
    drag.validDrop = false;
    if (!containsPoint(bounds, x, y)) return;
    // Holding over the open gap keeps the destination stable as neighbors move.
    if (containsPoint(drag.placeholder.getBoundingClientRect(), x, y)) { drag.validDrop = true; return; }
    const candidates = items();
    if (!candidates.length) return;
    const grid = list.classList.contains("vpl-list-cards");
    let target = null, distance = Infinity;
    candidates.forEach((item) => {
      const rect = layoutRect(item);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const dx = grid ? Math.max(rect.left - x, 0, x - rect.right) : 0;
      const score = dy * dy * 4 + dx * dx + Math.abs(y - (rect.top + rect.height / 2)) * 0.001;
      if (score < distance) { target = item; distance = score; }
    });
    if (!canDrop(drag.source, target)) return;
    drag.validDrop = true;
    const rect = layoutRect(target);
    const multipleColumns = grid && candidates.some((other) => {
      if (other === target) return false;
      const r = layoutRect(other);
      return Math.abs(r.left - rect.left) > 1;
    });
    const after = multipleColumns ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2;
    drag.destination = { fromId: drag.source.dataset.id, toId: target.dataset.id, after };
    moveGap(target, after);
  }

  function autoScroll() {
    frameId = 0;
    if (!drag) return;
    const rect = list.getBoundingClientRect();
    const { x, y } = drag.pointer;
    if (!containsPoint(rect, x, y)) return;
    const edge = Math.min(32, rect.height / 4);
    const speed = y < rect.top + edge ? -(rect.top + edge - y) / 3
      : y > rect.bottom - edge ? (y - rect.bottom + edge) / 3 : 0;
    if (!speed) return;
    const previous = list.scrollTop;
    list.scrollTop += speed / (scale() || 1);
    if (list.scrollTop !== previous) {
      updateGap(x, y);
      frameId = requestAnimationFrame(autoScroll);
    }
  }

  function start(event) {
    const source = event.target.closest?.(".vpl-item[data-id]");
    if (!source || source.parentElement !== list) return;
    cancel();
    const placeholder = document.createElement("div");
    placeholder.className = "vpl-drag-placeholder";
    placeholder.style.height = source.offsetHeight + "px";
    placeholder.textContent = "放到这里";
    placeholder.setAttribute("aria-hidden", "true");
    drag = { source, placeholder, width: source.style.width, destination: null,
      pointer: { x: event.clientX, y: event.clientY }, animations: new Map() };
    source.classList.add("vpl-dragging");
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", source.dataset.id);
    // Capture the native drag image before removing the source from layout.
    frameId = requestAnimationFrame(() => { frameId = 0; revealGap(); });
  }

  function over(event) {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    drag.pointer = { x: event.clientX, y: event.clientY };
    updateGap(event.clientX, event.clientY);
    event.dataTransfer.dropEffect = drag.validDrop ? "move" : "none";
    if (!frameId) frameId = requestAnimationFrame(autoScroll);
  }

  function drop(event) {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const destination = drag.validDrop ? drag.destination : null;
    cancel();
    if (destination) onDrop(destination);
  }

  function key(event) { if (event.key === "Escape") cancel(); }
  list.addEventListener("dragstart", start);
  list.addEventListener("dragover", over);
  list.addEventListener("drop", drop);
  document.addEventListener("dragend", cancel, true);
  document.addEventListener("keydown", key, true);
  return {
    cancel,
    destroy() {
      cancel();
      list.removeEventListener("dragstart", start);
      list.removeEventListener("dragover", over);
      list.removeEventListener("drop", drop);
      document.removeEventListener("dragend", cancel, true);
      document.removeEventListener("keydown", key, true);
    },
  };
}
