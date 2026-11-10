// Keep viewport state with the node: workflow tabs may recreate both nodes and DOM.
const PROPERTY = "allbuyLoraScroll";
const position = (value) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

export function installLoRAScroll(node, list, panel) {
  const targets = { list, panel };
  let saved = {};
  let pending = true;
  let frame = 0;
  let disposed = false;
  const visible = (el) => el.isConnected && el.clientHeight > 0 && el.getClientRects().length > 0;
  const persist = () => {
    node.properties ||= {};
    node.properties[PROPERTY] = { ...saved };
  };
  const capture = () => {
    if (disposed || pending) return;
    for (const [key, el] of Object.entries(targets)) if (visible(el)) saved[key] = position(el.scrollTop);
    persist();
  };
  const restore = () => {
    if (disposed) return;
    pending = true;
    if (frame) return;
    // Run after row rebuilding and height measurement; hidden tabs have no usable layout.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (disposed || !Object.values(targets).every(visible)) return;
      for (const [key, el] of Object.entries(targets)) {
        el.scrollTop = Math.min(saved[key], Math.max(0, el.scrollHeight - el.clientHeight));
        saved[key] = position(el.scrollTop);
      }
      pending = false;
      persist();
    });
  };
  const sync = () => {
    if (!Object.values(targets).every(visible)) pending = true;
    else if (pending) restore();
  };
  const handlers = Object.entries(targets).map(([key, el]) => {
    const onScroll = () => {
      // Browsers emit scroll events when hidden/emptied containers are reset to zero.
      if (disposed || pending || !visible(el)) return;
      saved[key] = position(el.scrollTop);
      persist();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return [el, onScroll];
  });
  const observer = new ResizeObserver(sync);
  for (const el of Object.values(targets)) observer.observe(el);
  const restoreView = () => {
    const raw = node.properties?.[PROPERTY];
    saved = { list: position(raw?.list), panel: position(raw?.panel) };
    restore();
  };
  restoreView();
  return {
    capture, restore, restoreView, sync,
    prepare() { capture(); pending = true; },
    serialize(data) {
      capture();
      // onSerialize may run after LiteGraph has copied node.properties.
      data.properties = { ...data.properties, [PROPERTY]: { ...saved } };
    },
    destroy() {
      capture();
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const [el, handler] of handlers) el.removeEventListener("scroll", handler);
    },
  };
}
