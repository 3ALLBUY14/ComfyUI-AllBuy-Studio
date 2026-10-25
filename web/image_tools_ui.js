// Shared AllBuy controls: native widget values remain the workflow source of truth.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installBypassSync, installExecutionLock, installFillResize, applyFillPanel } from "./panel_guard.js";

export { app, api };
export const API = "/allbuy_promptlibrary";
export function uid() { return globalThis.crypto?.randomUUID?.() || `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
export function el(tag, cls = "", text) {
  const item = document.createElement(tag);
  item.className = cls;
  if (text != null) item.textContent = text;
  return item;
}
export function button(text, action, primary = false) {
  const item = el("button", `vpl-btn vpl-btn-sm ${primary ? "vpl-btn-primary" : ""}`, text);
  item.type = "button";
  item.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); Promise.resolve().then(action).catch(error => report(item.closest(".ait-root"), error)); });
  return item;
}
export function report(root, error) {
  const status = root?.querySelector(".ait-status");
  if (status) { status.textContent = error.message || String(error); status.classList.add("ait-error"); }
  else console.error("[AllBuy image tools]", error);
}
export function widget(node, name) { return node.widgets?.find(w => w.name === name); }
export function value(node, name) { return widget(node, name)?.value; }
export function write(node, name, next) {
  const w = widget(node, name);
  if (!w) return;
  w.value = next;
  w.callback?.(next);
  node.graph?.change?.();
  node.setDirtyCanvas?.(true, true);
}
export function hide(w) {
  w.hidden = true; w.visible = false;
  w.options = { ...w.options, hidden: true };
  w.computeSize = () => [0, -4];
  w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, height: 0, minWidth: 0, maxWidth: 0, width: 0 });
  w.draw = () => {};
  // Multiline native widgets own DOM elements even when hidden on the canvas.
  if (w.inputEl) w.inputEl.style.display = "none";
}
function scrubNumber(input, label) {
  let drag = null, suppressClick = false;
  const start = event => {
    if (event.button !== 0 || event.pointerType === "touch" || input.disabled || input.readOnly ||
        input.closest(".vpl-locked, .vpl-bypassed")) return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    suppressClick = false;
    drag = { id: event.pointerId, x: event.clientX, value, moved: false, target: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  };
  const move = event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!(event.buttons & 1)) { end(event); return; }
    const dx = event.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    event.preventDefault(); event.stopPropagation();
    input.classList.add("ait-scrubbing");
    const step = Number(input.step) > 0 ? Number(input.step) : 1;
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    const speed = event.shiftKey ? 10 : event.altKey ? .1 : 1;
    const base = Number.isFinite(min) ? min : 0;
    const next = drag.value + Math.trunc(dx / 4 * speed) * step;
    const snapped = base + Math.round((next - base) / step) * step;
    const value = Number(Math.max(min, Math.min(max, snapped)).toFixed(10));
    if (Number(input.value) !== value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };
  const end = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { target, id, moved } = drag;
    drag = null; suppressClick = moved;
    input.classList.remove("ait-scrubbing");
    if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
    if (moved) input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  for (const target of [input, label]) {
    target.title = "按住左键左右拖动调节 · Shift 加速 · Alt 精调；数值框可直接输入";
    target.addEventListener("pointerdown", start);
    target.addEventListener("pointermove", move);
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) target.addEventListener(name, end);
    target.addEventListener("click", event => {
      if (suppressClick) { event.preventDefault(); event.stopPropagation(); suppressClick = false; }
    });
  }
  label.classList.add("ait-scrub-label");
}
export function field(label, initial, onChange, options = {}) {
  const row = el("label", "ait-field");
  const title = el("span", "ait-label", label);
  let input;
  if (options.values) {
    input = el("select", "ait-input");
    for (const entry of options.values) {
      const [v, text] = Array.isArray(entry) ? entry : [entry, entry];
      const option = el("option", "", text); option.value = v; input.append(option);
    }
  } else input = el(options.multiline ? "textarea" : "input", "ait-input");
  if (!options.values && !options.multiline) input.type = options.type || "number";
  for (const k of ["min", "max", "step"]) if (options[k] != null) input[k] = options[k];
  input.value = initial ?? "";
  input.setAttribute("aria-label", label);
  input.addEventListener(options.values ? "change" : "input", () => {
    const v = input.type === "number" ? Number(input.value) : input.value;
    if (input.type === "number" && (input.value === "" || !input.validity.valid || !Number.isFinite(v))) return;
    onChange(v);
  });
  if (input.type === "number") scrubNumber(input, title);
  row.append(title, input);
  row.input = input;
  return row;
}
export function bind(node, name, label, options = {}) {
  const w = widget(node, name);
  const spec = node._aitInputTypes?.[name];
  // Read real steps from the backend schema: canvas widgets may scale their
  // internal step for mouse handling, which is not an HTML input step.
  const numeric = spec?.[0] === "INT" || spec?.[0] === "FLOAT";
  const numberOptions = numeric ? { ...spec[1], step: spec[1]?.step ?? (spec[0] === "INT" ? 1 : .01) } : {};
  const values = options.values || (Array.isArray(w?.options?.values) ? w.options.values : null);
  const control = field(label, w?.value, v => write(node, name, v), {
    ...w?.options, ...numberOptions, type: typeof w?.value === "string" ? "text" : "number", ...options, values,
  });
  control.dataset.widget = name;
  return control;
}
export function section(title, ...children) {
  const box = el("section", "ait-section");
  box.append(el("div", "ait-section-title", title), ...children);
  return box;
}
export function row(...children) { const r = el("div", "ait-row"); r.append(...children); return r; }
export function parseState(node, name, fallback) {
  try { const state = JSON.parse(value(node, name)); return state && typeof state === "object" && !Array.isArray(state) ? state : structuredClone(fallback); }
  catch { return structuredClone(fallback); }
}
export function imageURL(ref) {
  return typeof ref === "string" ? api.apiURL(`${API}/cover/file?name=${encodeURIComponent(ref.replace(/^allbuy_media\//, ""))}`)
    : api.apiURL(`/view?${new URLSearchParams(ref)}`);
}
export async function loadImage(ref) {
  const image = new Image();
  image.src = imageURL(ref);
  await image.decode();
  return image;
}
export async function upload(file) {
  const body = new FormData(); body.append("file", file, file.name || "canvas.png");
  const response = await api.fetchApi(`${API}/media/upload`, { method: "POST", body });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || "素材上传失败");
  return data.name;
}
export async function uploadCanvas(canvas) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("无法保存画布");
  return upload(new File([blob], "canvas.png", { type: "image/png" }));
}
export function filePicker(onFiles, multiple = true) {
  const input = el("input"); input.type = "file"; input.accept = "image/*"; input.multiple = multiple;
  input.addEventListener("change", () => onFiles([...input.files]));
  input.click();
}
export function acceptFiles(root, onFiles, { node } = {}) {
  const receive = files => {
    const images = [...(files || [])].filter(f => f.type.startsWith("image/") || (!f.type && /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i.test(f.name)));
    if (!images.length) return false;
    Promise.resolve().then(() => onFiles(images)).catch(e => report(root, e));
    return true;
  };
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
  root.addEventListener("dragover", e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "copy"; root.classList.add("ait-dragover");
  }, true);
  root.addEventListener("dragleave", e => { if (!root.contains(e.relatedTarget)) root.classList.remove("ait-dragover"); });
  root.addEventListener("drop", e => {
    root.classList.remove("ait-dragover");
    if (receive(e.dataTransfer?.files)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  root.addEventListener("paste", e => {
    if (e.target.matches("input,textarea")) return;
    const files = e.clipboardData?.files;
    if (files?.length) { e.preventDefault(); e.stopPropagation(); receive(files); }
  });
  if (node) {
    const dragOver = node.onDragOver, dragDrop = node.onDragDrop;
    node.onDragOver = function(e) { return hasFiles(e) || dragOver?.apply(this, arguments) || false; };
    node.onDragDrop = function(e) { return receive(e.dataTransfer?.files) || dragDrop?.apply(this, arguments) || false; };
  }
}
export function dialog(title, onClose) {
  const overlay = el("div", "vpl-overlay ait-overlay ait-root vpl-node");
  const body = el("div", "ait-dialog");
  const status = el("div", "ait-status", "修改后点击保存，布局会随工作流保留");
  const close = (force = false) => { if (onClose?.(force) === false) return; document.removeEventListener("keydown", key, true); overlay.remove(); };
  const key = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", key, true);
  body.append(row(el("strong", "ait-dialog-title", title), button("关闭 ×", close)));
  overlay.append(body); document.body.append(overlay);
  overlay.addEventListener("pointerdown", e => e.stopPropagation());
  return { overlay, body, status, close };
}
export function editorAppearance(dlg) {
  const fontSizes = [16, 18, 20, 22, 24, 28, 32];
  const preferenceKey = "allbuy.composer.fontSize";
  dlg.overlay.classList.add("ait-editor-overlay");
  dlg.body.classList.add("ait-editor-dialog");
  dlg.body.firstElementChild.classList.add("ait-editor-header");
  let initialSize = 20;
  try {
    const saved = Number(localStorage.getItem(preferenceKey));
    if (fontSizes.includes(saved)) initialSize = saved;
  } catch { /* Storage may be unavailable in private browsing. */ }
  dlg.overlay.style.setProperty("--ait-font-size", `${initialSize}px`);
  const fontSize = field("界面字号", initialSize, v => {
    dlg.overlay.style.setProperty("--ait-font-size", `${v}px`);
    try { localStorage.setItem(preferenceKey, v); } catch { /* Keep the current selection usable. */ }
  }, { values: fontSizes.map(v => [v, `${v} px`]) });
  const windowSize = field("窗口大小 · 100%", 100, v => {
    dlg.body.style.setProperty("--ait-window-size", `${v}%`);
    windowSize.querySelector(".ait-label").textContent = `窗口大小 · ${v}%`;
  }, { type: "range", min: 50, max: 100, step: 1 });
  windowSize.classList.add("ait-window-size");
  // Freeze the slider's geometry throughout a drag, while the dialog resizes.
  let drag = null;
  const update = event => {
    if (event.pointerId !== drag?.id) return;
    windowSize.input.value = Math.max(50, Math.min(100, Math.round(50 + (event.clientX - drag.left) / drag.width * 50)));
    windowSize.input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  windowSize.input.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = windowSize.input.getBoundingClientRect();
    drag = { id: event.pointerId, left: rect.left + 8, width: Math.max(1, rect.width - 16) };
    windowSize.input.focus(); windowSize.input.setPointerCapture(event.pointerId); update(event);
  });
  windowSize.input.addEventListener("pointermove", update);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) windowSize.input.addEventListener(name, event => {
    if (event.pointerId !== drag?.id) return;
    drag = null;
    if (windowSize.input.hasPointerCapture(event.pointerId)) windowSize.input.releasePointerCapture(event.pointerId);
    windowSize.input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const appearance = el("div", "ait-editor-appearance"); appearance.append(windowSize, fontSize);
  return appearance;
}
export function mount(node, title, minHeight = 540, { compact = false } = {}) {
  const root = el("div", "vpl-node ait-root ait-node");
  if (title) root.append(el("div", "ait-heading", title));
  const status = el("div", "ait-status", "连接输入后运行工作流查看结果");
  root.addEventListener("pointerdown", e => e.stopPropagation());
  root.addEventListener("mousedown", e => e.stopPropagation());
  root.addEventListener("wheel", e => e.stopPropagation(), { passive: true });
  installBypassSync(node, root); installExecutionLock(node, root);
  const dom = node.addDOMWidget("allbuy_image_tools", "ALLBUY_TOOLS", root, { serialize: false, hideOnZoom: false });
  dom.computeSize = () => [460, minHeight];
  node.setSize([Math.max(node.size?.[0] || 0, 500), compact ? minHeight + 150 : Math.max(node.size?.[1] || 0, minHeight + 150)]);
  installFillResize(node, { el: () => root, chrome: () => dom.y || 100, floor: () => minHeight + (dom.y || 100) + 28, minWidth: 500, margin: 18, alwaysFill: true, trackChrome: true });
  requestAnimationFrame(() => applyFillPanel(node, root, dom.y || 100, 18));
  node._aitRefresh = () => {
    for (const control of root.querySelectorAll("[data-widget]")) control.input.value = value(node, control.dataset.widget) ?? "";
  };
  return { root, status, dom };
}
export function previewPanel(node, { titleFocus = false, live = false } = {}) {
  const box = el("div", "ait-preview");
  const image = el("img"); image.alt = "输出预览"; image.hidden = true;
  const empty = el("span", "ait-empty", "运行后显示图片");
  const pager = row(); let refs = [], index = 0;
  const crop = titleFocus ? el("canvas", "ait-title-crop") : null;
  let focus = null;
  if (crop) {
    crop.hidden = true;
    crop.setAttribute("role", "img");
    crop.setAttribute("aria-label", "标题区域预览");
  }
  const drawCrop = (notifyLayout = true) => {
    if (!crop || !refs.length || !image.complete || !image.naturalWidth) return;
    crop.hidden = false; empty.hidden = true;
    if (notifyLayout) box.dispatchEvent(new Event("allbuy-preview-layout"));
    const width = image.naturalWidth, height = image.naturalHeight;
    const fraction = Math.max(1, Math.min(100, focus?.height || 12)) / 100;
    const position = focus?.position || "图内底部";
    const outside = position.startsWith("图外");
    const band = Math.max(1, outside ? height - Math.round(height / (1 + fraction)) : Math.round(height * fraction));
    const y = position.includes("顶部") ? 0 : position === "中部" ? Math.floor((height - band) / 2) : height - band;
    // Expand the visible surroundings to fill the available frame at full width.
    // Anchor the crop to the title instead of adding empty letterboxing.
    const viewWidth = crop.clientWidth, viewHeight = crop.clientHeight;
    const wanted = viewWidth && viewHeight ? Math.round(width * viewHeight / viewWidth) : band * 2;
    const regionHeight = Math.min(height, Math.max(band, wanted));
    const top = Math.max(0, Math.min(height - regionHeight, Math.round(y + band / 2 - regionHeight / 2)));
    crop.width = width; crop.height = regionHeight;
    crop.getContext("2d").drawImage(image, 0, top, width, regionHeight, 0, 0, width, regionHeight);
  };
  if (crop) {
    box._aitDrawCrop = () => drawCrop(false);
    image.addEventListener("load", () => drawCrop());
    image.addEventListener("error", () => { crop.hidden = true; empty.hidden = false; empty.textContent = "预览加载失败"; });
  } else {
    image.addEventListener("load", () => box.dispatchEvent(new Event("allbuy-preview-layout")));
    image.addEventListener("error", () => { image.hidden = true; empty.hidden = false; empty.textContent = "预览加载失败"; });
  }
  const show = () => {
    image.hidden = !refs.length || !!crop; empty.hidden = !!refs.length;
    if (crop) crop.hidden = true;
    if (refs.length) {
      const url = imageURL(refs[index]);
      if (image.getAttribute("src") !== url) image.src = url;
      else drawCrop();
    }
    pager.replaceChildren(button("‹", () => { index = (index + refs.length - 1) % refs.length; show(); }), el("span", "", `${index + 1} / ${refs.length}`), button("›", () => { index = (index + 1) % refs.length; show(); }));
    pager.hidden = refs.length < 2;
    box.dispatchEvent(new Event("allbuy-preview-layout"));
  };
  let lastMessage = null;
  let liveURL = null;
  const releaseLive = () => { if (liveURL) URL.revokeObjectURL(liveURL); liveURL = null; };
  // Drafts and selected history images use the same pager without becoming outputs.
  box._aitShowImages = images => { releaseLive(); lastMessage = null; refs = images; index = 0; show(); };
  const receive = message => {
    const output = message?.output ?? message;
    const candidates = [output?.allbuy_images, output?.ui?.allbuy_images, output?.images, output?.ui?.images];
    const images = candidates.find(Array.isArray);
    // Cached execution events may have no UI payload. Preserve the last preview.
    if (!images || output === lastMessage) return;
    releaseLive();
    lastMessage = output;
    refs = images;
    // Keep the crop aligned with the displayed result until the next execution.
    if (crop) focus = { position: value(node, "position"), height: Number(value(node, "bar_height")) };
    index = 0; show(); node._aitOnImages?.(refs);
  };
  const original = node.onExecuted;
  node.onExecuted = function(message) {
    receive(message);
    return original?.apply(this, arguments);
  };
  const executed = event => {
    const detail = event?.detail;
    if (String(detail?.display_node ?? detail?.node) === String(node.id)) receive(detail?.output);
  };
  api.addEventListener("executed", executed);
  const liveHandlers = [];
  if (live) {
    let running = null, lastBlob = null, metadataBlob = null;
    const on = (name, handler) => { api.addEventListener(name, handler); liveHandlers.push([name, handler]); };
    const matches = id => id != null && String(id) === String(node.id);
    const displayLive = blob => {
      if (!(blob instanceof Blob) || blob === lastBlob) return;
      lastBlob = blob;
      const nextURL = URL.createObjectURL(blob);
      releaseLive(); liveURL = nextURL;
      image.src = liveURL; image.hidden = false; empty.hidden = true; pager.hidden = true;
      box.dispatchEvent(new Event("allbuy-preview-layout"));
      lastMessage = null;
    };
    on("executing", e => { running = matches(e.detail?.display_node ?? e.detail?.node ?? e.detail); });
    on("b_preview", e => { if (e.detail !== metadataBlob && (running ?? matches(app.runningNodeId))) displayLive(e.detail); });
    on("b_preview_with_metadata", e => {
      // New hosts emit both events for one frame. Honor the metadata even when
      // another node's frame arrives while this sampler is still running.
      metadataBlob = e.detail?.blob;
      if (matches(e.detail?.displayNodeId ?? e.detail?.nodeId)) displayLive(metadataBlob);
    });
    for (const name of ["execution_start", "execution_success", "execution_interrupted", "execution_error"]) on(name, () => { running = false; });
  }
  node._aitRestorePreview = () => receive(app.nodeOutputs?.[node.id]);
  requestAnimationFrame(() => node._aitRestorePreview?.());
  const removed = node.onRemoved;
  node.onRemoved = function() {
    api.removeEventListener("executed", executed);
    for (const [name, handler] of liveHandlers) api.removeEventListener(name, handler);
    releaseLive();
    node._aitRestorePreview = null;
    return removed?.apply(this, arguments);
  };
  box.append(image, ...(crop ? [crop] : []), empty, pager);
  return box;
}

// Reuse the space beside input sockets without adding another serialized widget.
// Keep the preview outside the parameter scroller so it stays visible while editing.
export function dockTitlePreview(node, root, dom, preview, { fullImage = false, captionText = "批次排版" } = {}) {
  const kind = fullImage ? "grid" : "title";
  const header = el("div", `vpl-node ait-${kind}-preview`);
  const caption = el("strong", `ait-${kind}-caption`, captionText);
  preview.remove();
  header.append(preview);
  const controls = el("div", `ait-${kind}-controls`);
  for (const child of [...root.children]) {
    if (!child.classList.contains("vpl-exec-bar")) controls.append(child);
  }
  root.classList.add(`ait-${kind}-node`);
  root.append(header, controls, caption);
  const measure = document.createElement("canvas").getContext("2d");
  const crop = preview.querySelector(".ait-title-crop");
  const pager = preview.querySelector(":scope > .ait-row");
  let lastLayout = "";
  const layout = () => {
    // DOM widgets start 10px below widget.y in the ComfyUI canvas host.
    const width = node.size?.[0] || 500;
    // Modern ComfyUI also lists unconnected widget inputs here; their labels
    // are not drawn beside the sockets and must not reserve preview space.
    const sockets = (node.inputs || []).filter(input => !input.widget || input.link != null);
    const widgetY = dom.y || Math.max(1, sockets.length || 12) * 20 + 10;
    const labels = sockets.map(input => input.label || input.name || "");
    const image = preview.querySelector("img");
    const ready = fullImage ? image && !image.hidden && image.complete && image.naturalWidth > 0
      : crop && !crop.hidden && crop.width > 0 && crop.height > 0;
    const key = JSON.stringify([width, widgetY, labels, !!node.flags?.collapsed,
      ready ? [image?.naturalWidth, image?.naturalHeight] : null, pager?.hidden, root.isConnected]);
    root.closest(".dom-widget")?.classList.add(`ait-${kind}-widget`);
    if (key === lastLayout) return;
    lastLayout = key;
    measure.font = `${globalThis.LiteGraph?.NODE_TEXT_SIZE || 14}px Arial`;
    const labelWidth = Math.max(20, ...labels.map(label => measure.measureText(label).width));
    const left = Math.ceil(labelWidth + 28);
    const top = 32; // Leave the first output socket and its label unobstructed.
    const available = widgetY - top;
    const previewWidth = Math.max(150, width - left - 20);
    // 12px for the two borders and outer padding, plus a compact 28px pager.
    const chrome = 12 + (pager?.hidden ? 0 : 28);
    const height = ready && image?.naturalWidth ? Math.min(available,
      Math.ceil((previewWidth - 12) * image.naturalHeight / image.naturalWidth) + chrome) : available;
    header.hidden = !!node.flags?.collapsed || available < 60 || width - left - 20 < 150;
    header.style.left = `${left - 10}px`;
    header.style.top = `${fullImage ? top - widgetY - 10 : -height - 10}px`;
    header.style.width = `${previewWidth}px`;
    header.style.height = `${Math.max(1, height)}px`;
    caption.hidden = header.hidden;
    caption.style.left = header.style.left;
    caption.style.top = `${6 - widgetY - 10}px`;
    preview._aitDrawCrop?.();
  };
  const draw = node.onDrawBackground;
  node.onDrawBackground = function() { draw?.apply(this, arguments); layout(); };
  const resize = node.onResize;
  node.onResize = function() { resize?.apply(this, arguments); layout(); };
  const refresh = node._aitRefresh;
  node._aitRefresh = () => { refresh?.(); layout(); };
  preview.addEventListener("allbuy-preview-layout", layout);
  layout();
  requestAnimationFrame(layout);
}
