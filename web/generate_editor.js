import { el, row, field, button, section, dialog, editorAppearance, parseState, write, imageURL, loadImage, uploadCanvas, upload, filePicker, report } from "./image_tools_ui.js";

function tintedMask(mask, width, height) {
  const tint = el("canvas"); tint.width = Math.max(1, Math.round(width)); tint.height = Math.max(1, Math.round(height));
  const ctx = tint.getContext("2d"); ctx.drawImage(mask, 0, 0, tint.width, tint.height);
  // Saved masks are opaque grayscale; luminance determines the overlay alpha.
  const data = ctx.getImageData(0, 0, tint.width, tint.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const alpha = data.data[i] * .45;
    data.data[i] = 99; data.data[i + 1] = 102; data.data[i + 2] = 241; data.data[i + 3] = alpha;
  }
  ctx.putImageData(data, 0, 0);
  return tint;
}

export function installGenerateMaskPreview(node, box, status) {
  const image = box.querySelector("img"), overlay = el("canvas", "ait-generate-mask");
  overlay.hidden = true; overlay.setAttribute("role", "img"); overlay.setAttribute("aria-label", "已保存的重绘遮罩");
  box.append(overlay);
  let revision = 0, maskRef = null, maskPromise = null;
  const sync = async () => {
    const current = ++revision;
    overlay.hidden = true;
    const state = parseState(node, "edit_json", {});
    if (!state.enabled || !state.source || !state.mask || image.hidden || !image.complete || !image.naturalWidth ||
        image.getAttribute("src") !== imageURL(state.source)) return;
    try {
      if (maskRef !== state.mask) { maskRef = state.mask; maskPromise = loadImage(state.mask); }
      const mask = await maskPromise;
      // A new source, history selection or generated result wins over late mask loads.
      if (current !== revision || !box.isConnected) return;
      const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
      const tint = tintedMask(mask, image.naturalWidth * scale, image.naturalHeight * scale);
      overlay.width = tint.width; overlay.height = tint.height;
      overlay.getContext("2d").drawImage(tint, 0, 0);
      overlay.style.left = `${image.offsetLeft}px`; overlay.style.top = `${image.offsetTop}px`;
      overlay.style.width = `${image.clientWidth}px`; overlay.style.height = `${image.clientHeight}px`;
      overlay.hidden = false;
    } catch (error) {
      if (current !== revision) return;
      maskRef = null;
      status.textContent = `遮罩预览加载失败：${error.message || error}`; status.classList.add("ait-error");
    }
  };
  box.addEventListener("allbuy-preview-layout", sync);
  const observer = new ResizeObserver(sync); observer.observe(image);
  const removed = node.onRemoved;
  node.onRemoved = function() {
    revision++; observer.disconnect(); box.removeEventListener("allbuy-preview-layout", sync); overlay.remove();
    return removed?.apply(this, arguments);
  };
}

export async function openGenerateEditor(node, reference) {
  if (node._aitDialog) return;
  const state = parseState(node, "edit_json", {});
  const initial = reference || state.source;
  if (!initial) throw new Error("请先导入底图，或生成图片后点击「局部重绘 / 扩图」");
  const base = document.createElement("canvas"), mask = document.createElement("canvas");
  let busy = true, ready = false, touched = false, painting = false, erase = false, brush = 40, last = null;
  let undo = [], redo = [];
  const dlg = dialog("重绘与扩图", force => {
    if (!force && busy) { dlg.status.textContent = "正在处理图片，请稍候"; return false; }
    if (!force && touched && !window.confirm("放弃未保存的重绘修改？")) return false;
    ro.disconnect(); node._aitDialog = null; return true;
  });
  node._aitDialog = dlg;
  dlg.body.classList.add("ait-generate-dialog");
  const appearance = editorAppearance(dlg);
  dlg.status.setAttribute("role", "status"); dlg.status.setAttribute("aria-live", "polite");
  const stage = el("div", "ait-stage"); stage.tabIndex = 0;
  const view = el("canvas"); stage.append(view);
  const inspector = el("div", "ait-inspector");
  const workspace = el("div", "ait-workspace"); workspace.append(stage, inspector);
  function snapshot() {
    const b = document.createElement("canvas"), m = document.createElement("canvas");
    b.width = m.width = base.width; b.height = m.height = base.height;
    b.getContext("2d").drawImage(base, 0, 0); m.getContext("2d").drawImage(mask, 0, 0);
    return { base: b, mask: m };
  }
  function push() {
    undo.push(snapshot());
    while (undo.length > 1 && (undo.length > 12 || undo.reduce((n, f) => n + f.base.width * f.base.height, 0) > 24 * 1024 * 1024)) undo.shift();
    redo = []; touched = true;
  }
  function restore(from, to) {
    if (!from.length || busy) return;
    to.push(snapshot()); const frame = from.pop();
    base.width = mask.width = frame.base.width; base.height = mask.height = frame.base.height;
    base.getContext("2d").drawImage(frame.base, 0, 0); mask.getContext("2d").drawImage(frame.mask, 0, 0);
    touched = true; draw();
  }
  function draw() {
    if (!base.width || !base.height) return;
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    view.width = w; view.height = h;
    const scale = Math.min((w - 24) / base.width, (h - 24) / base.height), x = (w - base.width * scale) / 2, y = (h - base.height * scale) / 2;
    const ctx = view.getContext("2d"); ctx.fillStyle = "#11131c"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(base, x, y, base.width * scale, base.height * scale);
    ctx.drawImage(tintedMask(mask, base.width * scale, base.height * scale), x, y, base.width * scale, base.height * scale);
    ctx.strokeStyle = "#6366f1"; ctx.strokeRect(x, y, base.width * scale, base.height * scale);
    dlg.status.textContent = `${base.width} × ${base.height} · 紫色区域将重绘；未涂抹区域保留原图`;
  }
  function point(e) {
    const r = view.getBoundingClientRect(), scale = Math.min((view.width - 24) / base.width, (view.height - 24) / base.height);
    return [(e.clientX - r.left - (view.width - base.width * scale) / 2) / scale,
      (e.clientY - r.top - (view.height - base.height * scale) / 2) / scale];
  }
  function paint(e) {
    const p = point(e), ctx = mask.getContext("2d");
    ctx.strokeStyle = ctx.fillStyle = erase ? "#000000" : "#ffffff";
    ctx.lineWidth = brush; ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(...(last || p)); ctx.lineTo(...p); ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], brush / 2, 0, Math.PI * 2); ctx.fill(); last = p; draw();
  }
  view.addEventListener("pointerdown", e => { if (busy || e.button !== 0) return; e.preventDefault(); stage.focus(); view.setPointerCapture(e.pointerId); push(); painting = true; last = null; paint(e); });
  view.addEventListener("pointermove", e => { if (painting) paint(e); });
  const end = () => { painting = false; last = null; };
  view.addEventListener("pointerup", end); view.addEventListener("pointercancel", end);
  stage.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey || e.key.toLowerCase() === "y") restore(redo, undo); else restore(undo, redo);
    }
  });
  let left = 128, right = 128, top = 128, bottom = 128;
  const brushRange = el("input", "ait-brush-range");
  brushRange.type = "range"; brushRange.min = 1; brushRange.max = 1024; brushRange.step = 1; brushRange.value = brush;
  brushRange.setAttribute("aria-label", "画笔大小滑条");
  const brushField = field("画笔直径 px", brush, v => { brush = v; brushRange.value = v; }, { min: 1, max: 1024 });
  brushRange.addEventListener("input", () => { brush = Number(brushRange.value); brushField.input.value = brush; });
  const brushControls = el("div", "ait-brush-controls"); brushControls.append(brushField, brushRange);
  const setMode = next => {
    erase = next;
    for (const [control, active] of [[paintButton, !erase], [eraseButton, erase]]) {
      control.classList.toggle("vpl-btn-primary", active); control.setAttribute("aria-pressed", String(active));
    }
  };
  const paintButton = button("涂抹", () => setMode(false)), eraseButton = button("擦除遮罩", () => setMode(true));
  setMode(false);
  inspector.append(section("遮罩画笔", brushControls,
    row(paintButton, eraseButton),
    row(button("清空遮罩", () => { if (busy) return; push(); const ctx = mask.getContext("2d"); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, mask.width, mask.height); draw(); }),
      button("全部重绘", () => { if (busy) return; push(); const ctx = mask.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, mask.width, mask.height); draw(); })),
    row(button("撤销", () => restore(undo, redo)), button("重做", () => restore(redo, undo)))));
  inspector.append(section("扩展画布 · 像素", row(field("左", left, v => { left = v; }, { min: 0, max: 4096, step: 8 }), field("右", right, v => { right = v; }, { min: 0, max: 4096, step: 8 })),
    row(field("上", top, v => { top = v; }, { min: 0, max: 4096, step: 8 }), field("下", bottom, v => { bottom = v; }, { min: 0, max: 4096, step: 8 })),
    button("应用扩图", () => {
      if (busy) return;
      const w = Math.ceil((base.width + left + right) / 8) * 8, h = Math.ceil((base.height + top + bottom) / 8) * 8;
      if (w * h > 16 * 1024 * 1024 || Math.max(w, h) > 8192) throw new Error("编辑画布最多 1600 万像素、边长 8192");
      push(); const old = snapshot(); base.width = mask.width = w; base.height = mask.height = h;
      const bctx = base.getContext("2d"), mctx = mask.getContext("2d");
      bctx.fillStyle = "#808080"; bctx.fillRect(0, 0, w, h); bctx.drawImage(old.base, left, top);
      mctx.fillStyle = "#ffffff"; mctx.fillRect(0, 0, w, h); mctx.drawImage(old.mask, left, top); draw();
    })));
  inspector.append(section("操作提示", el("div", "ait-hint", "紫色区域会重新绘制，未涂抹区域保留原图。扩图会自动选中新增区域。"),
    el("div", "ait-hint", "Ctrl+Z 撤销 · Ctrl+Shift+Z / Ctrl+Y 重做。保存编辑后，回到节点点击「运行生成」。")));
  const saveButton = button("保存编辑", async () => {
    if (busy || !ready) throw new Error("请等待底图加载成功后保存");
    busy = true;
    try {
      const source = await uploadCanvas(base), maskFile = await uploadCanvas(mask);
      write(node, "edit_json", JSON.stringify({ enabled: true, source, mask: maskFile }));
      touched = false; busy = false; node._aitRefresh?.(true); dlg.close();
    } finally { busy = false; }
  }, true);
  const header = dlg.body.firstElementChild;
  header.insertBefore(saveButton, header.lastElementChild);
  const saveControls = row(dlg.status);
  saveControls.classList.add("ait-editor-save");
  const footer = el("div", "ait-editor-footer"); footer.append(saveControls, appearance);
  dlg.body.append(workspace, footer);
  const ro = new ResizeObserver(draw); ro.observe(stage);
  try {
    const image = await loadImage(initial);
    if (image.width * image.height > 16 * 1024 * 1024 || Math.max(image.width, image.height) > 8192) throw new Error("编辑底图最多 1600 万像素、边长 8192");
    base.width = mask.width = image.width; base.height = mask.height = image.height;
    base.getContext("2d").drawImage(image, 0, 0); const mctx = mask.getContext("2d"); mctx.fillStyle = "#000"; mctx.fillRect(0, 0, mask.width, mask.height);
    if (!reference && state.mask) mctx.drawImage(await loadImage(state.mask), 0, 0, mask.width, mask.height);
    ready = true; draw();
  } catch (error) { report(dlg.overlay, error); }
  finally { busy = false; }
  return dlg;
}

async function resizeImport(file, options) {
  if (!options || options.mode === "original") return file;
  if (!["longest", "shortest"].includes(options.mode)) throw new Error("请选择有效的导入缩放方式");
  const target = Number(options.size);
  if (!Number.isInteger(target) || target < 1 || target > 8192) throw new Error("导入目标尺寸须为 1–8192 的整数");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const edge = options.mode === "longest" ? Math.max(image.naturalWidth, image.naturalHeight) : Math.min(image.naturalWidth, image.naturalHeight);
    const scale = target / edge;
    const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (width * height > 16 * 1024 * 1024 || Math.max(width, height) > 8192) throw new Error(`缩放后尺寸为 ${width} × ${height}，超过画布上限；请减小目标尺寸或改用最长边`);
    const canvas = el("canvas"); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("无法生成缩放后的图片");
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}-resized.png`, { type: "image/png" });
  } finally { URL.revokeObjectURL(url); }
}

export async function importGenerateImage(node, file) {
  if (!file) {
    filePicker(files => {
      if (files.length) importGenerateImage(node, files[0]).catch(error => report(node._aitRoot, error));
    }, false);
    return;
  }
  const version = node._aitSourceVersion = (node._aitSourceVersion || 0) + 1;
  const resizeOptions = { mode: "original", ...node.properties?.allbuy_generate_import_resize };
  node._aitImportBusy = true;
  try {
    const prepared = await resizeImport(file, resizeOptions);
    if (node._aitSourceVersion !== version) return;
    const asset = await upload(prepared);
    if (node._aitSourceVersion !== version) return;
    const image = await loadImage(asset);
    if (node._aitSourceVersion !== version) return;
    if (image.width * image.height > 16 * 1024 * 1024 || Math.max(image.width, image.height) > 8192) throw new Error("编辑底图最多 1600 万像素、边长 8192");
    write(node, "denoise", 1);
    write(node, "original_image", asset);
    write(node, "edit_json", JSON.stringify({ enabled: true, source: asset }));
    node._aitRefresh?.(true);
  } catch (error) {
    if (node._aitSourceVersion === version) throw error;
  } finally { if (node._aitSourceVersion === version) node._aitImportBusy = false; }
}
