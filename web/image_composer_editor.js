// A dedicated canvas workspace; drafts are committed atomically to layout_json.
import { API, api, el, row, field, button, section, dialog, editorAppearance, parseState, write, loadImage, upload, uploadCanvas, filePicker, acceptFiles, imageURL, report, uid } from "./image_tools_ui.js";
import { drawComposition } from "./image_composer_render.js";

export const DEFAULT_LAYOUT = { width: 1024, height: 1024, background: "#171923", layers: [] };
const blendModes = [["normal", "正常"], ["multiply", "正片叠底"], ["screen", "滤色"], ["overlay", "叠加"]];
const canvasRatios = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "4:5", "5:4", "21:9"];
const canvasSizes = [1024, 2048, 3072, 4096];
function presetSize(ratio, edge) {
  const [w, h] = ratio.split(":").map(Number);
  return [w, h].map(side => Math.max(8, Math.round(edge * side / Math.max(w, h) / 8) * 8));
}
export async function openComposer(node) {
  if (node._aitDialog) return;
  let project = parseState(node, "layout_json", DEFAULT_LAYOUT);
  let selected = new Set(), zoom = 1, pan = [0, 0], gesture = null, tool = "move", busy = false;
  let history = [JSON.stringify(project)], cursor = 0;
  let baseline = history[0];
  const images = new Map();
  const dlg = dialog("图层工作台", force => {
    if (!force && busy) { dlg.status.textContent = "正在保存素材，请稍候"; return false; }
    if (!force && JSON.stringify(project) !== baseline && !window.confirm("放弃未保存的图层修改？")) return false;
    node._aitDialog = null; ro.disconnect(); return true;
  });
  node._aitDialog = dlg;
  dlg.body.classList.add("ait-composer-dialog");
  dlg.body.firstElementChild.classList.add("ait-composer-header");
  dlg.overlay.classList.add("ait-composer-overlay");
  const appearance = editorAppearance(dlg);
  appearance.classList.add("ait-composer-appearance");
  const cutoutTip = el("div", "ait-tooltip", "RMBG 自动抠图需在 ComfyUI 的 Python 环境安装抠图依赖；首次使用可能下载模型，请保持联网并耐心等待。");
  cutoutTip.id = uid(); cutoutTip.hidden = true; cutoutTip.setAttribute("role", "tooltip");
  dlg.overlay.append(cutoutTip);
  const stage = el("div", "ait-stage"); stage.tabIndex = 0;
  const canvas = el("canvas"); stage.append(canvas);
  const inspector = el("div", "ait-inspector");
  const workspace = el("div", "ait-workspace"); workspace.append(stage, inspector);
  const status = dlg.status;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const zoomControl = field("画布缩放 · 100%", 100, v => { zoom = Number(v) / 100; syncZoom(); draw(); }, { type: "range", min: 15, max: 600, step: 1 });
  zoomControl.classList.add("ait-zoom-control");
  function syncZoom() {
    zoomControl.input.value = Math.round(zoom * 100);
    zoomControl.querySelector(".ait-label").textContent = `画布缩放 · ${Math.round(zoom * 100)}%`;
  }
  const push = () => {
    const state = JSON.stringify(project);
    if (history[cursor] === state) return;
    history.splice(cursor + 1); history.push(state);
    if (history.length > 30) history.shift();
    cursor = history.length - 1;
  };
  const restore = async offset => {
    const index = cursor + offset;
    if (index < 0 || index >= history.length || busy) return;
    cursor = index; project = JSON.parse(history[index]); selected.clear();
    await ensureImages(); renderInspector(); draw();
  };
  async function ensureImages() {
    await Promise.all(project.layers.map(async layer => {
      if (!images.has(layer.asset)) images.set(layer.asset, await loadImage(layer.asset));
    }));
  }
  async function importFiles(files) {
    if (!files.length || busy) return;
    busy = true; status.textContent = "正在导入素材…";
    try {
      for (const file of files) {
        const asset = await upload(file), image = await loadImage(asset);
        images.set(asset, image);
        const scale = Math.min(1, project.width / image.width, project.height / image.height);
        const layer = { id: uid(), name: file.name, asset, x: project.width / 2, y: project.height / 2,
          width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)),
          rotation: 0, opacity: 1, visible: true, locked: false, blend: "normal", stroke: 0, stroke_color: "#ffffff" };
        project.layers.push(layer); selected = new Set([layer.id]); push();
      }
      renderInspector(); draw(); status.textContent = "已导入 · 拖动画布中的图层调整位置";
    } finally { busy = false; }
  }
  const toolbar = row(button("＋ 导入图片", () => filePicker(files => importFiles(files).catch(e => report(dlg.overlay, e)))),
    button("撤销", () => restore(-1)), button("重做", () => restore(1)),
    button("适应画布", () => { zoom = 1; pan = [0, 0]; syncZoom(); draw(); }),
    button("移动", () => { tool = "move"; status.textContent = "拖动图层 · Shift 多选 · 滚轮缩放 · 空格拖动平移"; }),
    button("橡皮擦", () => { tool = "erase"; status.textContent = "拖动擦除当前图层 · 可撤销 · 锁定的图层不会修改"; }), zoomControl);
  toolbar.classList.add("ait-composer-toolbar", "ait-editor-toolbar");
  const saveControls = row(status, button("保存布局", async () => {
    if (busy) throw new Error("请等待素材保存完成");
    write(node, "layout_json", JSON.stringify(project)); baseline = JSON.stringify(project);
    node._aitRefresh?.(); dlg.close();
  }, true));
  const footer = el("div", "ait-composer-footer ait-editor-footer"); footer.append(saveControls, appearance);
  dlg.body.append(toolbar, workspace, footer);
  acceptFiles(dlg.overlay, importFiles);
  function geometry() {
    const width = stage.clientWidth || 700, height = stage.clientHeight || 500;
    const scale = Math.min((width - 40) / project.width, (height - 40) / project.height) * zoom;
    return { width, height, scale, ox: (width - project.width * scale) / 2 + pan[0], oy: (height - project.height * scale) / 2 + pan[1] };
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect(), g = geometry();
    return [(event.clientX - rect.left - g.ox) / g.scale, (event.clientY - rect.top - g.oy) / g.scale];
  }
  function local(layer, p) {
    const angle = -layer.rotation * Math.PI / 180, x = p[0] - layer.x, y = p[1] - layer.y;
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
  }
  function hit(layer, p) { const q = local(layer, p); return Math.abs(q[0]) <= layer.width / 2 && Math.abs(q[1]) <= layer.height / 2; }
  function draw() {
    const g = geometry(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(g.width * dpr)); canvas.height = Math.max(1, Math.round(g.height * dpr));
    const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); ctx.fillStyle = "#11131c"; ctx.fillRect(0, 0, g.width, g.height);
    ctx.translate(g.ox, g.oy); ctx.scale(g.scale, g.scale);
    drawComposition(ctx, project, images);
    ctx.strokeStyle = "#6366f1"; ctx.lineWidth = 1 / g.scale; ctx.strokeRect(0, 0, project.width, project.height);
    for (const layer of project.layers.filter(l => selected.has(l.id) && l.visible)) {
      ctx.save(); ctx.translate(layer.x, layer.y); ctx.rotate(layer.rotation * Math.PI / 180);
      ctx.strokeStyle = layer.locked ? "#94a0b6" : "#a5a7ff"; ctx.lineWidth = 1.5 / g.scale;
      ctx.setLineDash(layer.locked ? [5 / g.scale, 3 / g.scale] : []);
      ctx.strokeRect(-layer.width / 2, -layer.height / 2, layer.width, layer.height);
      if (!layer.locked) {
        const s = 7 / g.scale; ctx.fillStyle = "#a5a7ff";
        ctx.fillRect(layer.width / 2 - s / 2, layer.height / 2 - s / 2, s, s);
      }
      ctx.restore();
    }
    if (gesture?.kind === "marquee") {
      const [x, y] = gesture.start, [ex, ey] = gesture.end;
      ctx.fillStyle = "rgba(99,102,241,.16)"; ctx.fillRect(x, y, ex - x, ey - y);
      ctx.strokeRect(x, y, ex - x, ey - y);
    }
  }
  function change(layer, key, next) {
    if (busy || (layer.locked && key !== "locked")) return;
    layer[key] = next;
    if (key === "name") {
      const item = [...inspector.querySelectorAll(".ait-layer")].find(item => item.dataset.layerId === layer.id);
      if (item) item.querySelector(".ait-layer-name").textContent = next;
    }
    push(); draw();
  }
  function renderInspector() {
    cutoutTip.hidden = true;
    inspector.onscroll = null;
    inspector.replaceChildren();
    const edge = Math.max(project.width, project.height);
    const ratio = canvasRatios.find(r => presetSize(r, edge).every((v, i) => v === [project.width, project.height][i]));
    const resizeCanvas = (nextRatio, nextEdge) => {
      [project.width, project.height] = presetSize(nextRatio, nextEdge);
      zoom = 1; pan = [0, 0]; syncZoom(); push(); renderInspector(); draw();
    };
    const ratioField = field("画布比例", ratio || "custom", v => {
        if (v !== "custom") resizeCanvas(v, Math.max(project.width, project.height));
      }, { values: [["custom", "自定义"], ...canvasRatios] });
    const sizeField = field("分辨率（长边）", canvasSizes.includes(edge) ? edge : "custom", v => {
        const currentRatio = ratioField.input.value;
        if (v !== "custom") resizeCanvas(currentRatio !== "custom" ? currentRatio : `${project.width}:${project.height}`, Number(v));
      }, { values: [["custom", "自定义"], ...canvasSizes.map((v, i) => [v, `${i + 1}K · ${v} px`])] });
    const syncPresets = () => {
      const currentEdge = Math.max(project.width, project.height);
      ratioField.input.value = canvasRatios.find(r => presetSize(r, currentEdge).every((v, i) => v === [project.width, project.height][i])) || "custom";
      sizeField.input.value = canvasSizes.includes(currentEdge) ? currentEdge : "custom";
    };
    inspector.append(section("画布", row(ratioField, sizeField),
      row(field("宽", project.width, v => { project.width = v; syncPresets(); push(); draw(); }, { min: 8, max: 8192, step: 8 }),
      field("高", project.height, v => { project.height = v; syncPresets(); push(); draw(); }, { min: 8, max: 8192, step: 8 })),
      el("div", "ait-hint", "预设按长边计算，尺寸对齐 8 px；修改画布不会缩放图层。"),
      field("背景", project.background, v => { project.background = v; push(); draw(); }, { type: "color" })));
    const list = el("div", "ait-layer-list");
    for (const layer of [...project.layers].reverse()) {
      const item = el("div", `ait-layer ${selected.has(layer.id) ? "selected" : ""}`);
      item.dataset.layerId = layer.id;
      item.draggable = !layer.locked;
      item.title = layer.locked ? "图层已锁定，解锁后可拖动排序" : "上下拖动调整顺序 · 上方图层显示在前";
      const thumb = el("img"); thumb.src = imageURL(layer.asset); thumb.alt = "";
      thumb.draggable = false;
      item.append(el("span", "ait-layer-handle", "⠿"), thumb, el("span", "ait-layer-name", layer.name),
        button(layer.visible ? "◉" : "○", () => { change(layer, "visible", !layer.visible); renderInspector(); }),
        button(layer.locked ? "🔒" : "◇", () => { change(layer, "locked", !layer.locked); renderInspector(); }));
      item.addEventListener("click", e => { if (e.target.closest("button")) return; if (!e.shiftKey) selected.clear(); selected.add(layer.id); renderInspector(); draw(); });
      item.addEventListener("dragstart", e => {
        if (busy || layer.locked || e.target.closest("button")) { e.preventDefault(); return; }
        e.stopPropagation();
        e.dataTransfer.setData("application/x-allbuy-layer", layer.id);
        e.dataTransfer.effectAllowed = "move";
        item.classList.add("ait-layer-dragging");
      });
      item.addEventListener("dragover", e => {
        if (!e.dataTransfer.types.includes("application/x-allbuy-layer") || busy) return;
        e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move";
        list.querySelectorAll(".ait-drop-before,.ait-drop-after").forEach(n => n.classList.remove("ait-drop-before", "ait-drop-after"));
        const rect = item.getBoundingClientRect();
        item.classList.add(e.clientY < rect.top + rect.height / 2 ? "ait-drop-before" : "ait-drop-after");
      });
      item.addEventListener("dragleave", () => item.classList.remove("ait-drop-before", "ait-drop-after"));
      item.addEventListener("dragend", () => list.querySelectorAll(".ait-layer").forEach(n => n.classList.remove("ait-layer-dragging", "ait-drop-before", "ait-drop-after")));
      item.addEventListener("drop", e => {
        const id = e.dataTransfer.getData("application/x-allbuy-layer");
        if (!id) return;
        e.preventDefault(); e.stopPropagation();
        const source = project.layers.find(l => l.id === id);
        if (busy || !source || source.locked || source === layer) return;
        const rect = item.getBoundingClientRect(), before = e.clientY < rect.top + rect.height / 2;
        project.layers.splice(project.layers.indexOf(source), 1);
        project.layers.splice(project.layers.indexOf(layer) + (before ? 1 : 0), 0, source);
        selected = new Set([id]); push(); renderInspector(); draw();
      });
      list.append(item);
    }
    inspector.append(section(`图层 · ${project.layers.length}（上方在前 · 可拖动排序）`, list));
    const layer = project.layers.find(l => selected.has(l.id));
    if (!layer) { inspector.append(el("div", "ait-status", "导入图片，或点击画布选择图层")); return; }
    const properties = section("所选图层", field("名称", layer.name, v => change(layer, "name", v), { type: "text" }),
      row(field("X", layer.x, v => change(layer, "x", v)), field("Y", layer.y, v => change(layer, "y", v))),
      row(field("宽", layer.width, v => change(layer, "width", v), { min: 1, max: 8192 }), field("高", layer.height, v => change(layer, "height", v), { min: 1, max: 8192 })),
      row(field("旋转 °", layer.rotation, v => change(layer, "rotation", v)), field("不透明度 %", Math.round(layer.opacity * 100), v => change(layer, "opacity", v / 100), { min: 0, max: 100 })),
      field("混合模式", layer.blend, v => change(layer, "blend", v), { values: blendModes }),
      row(field("描边 px", layer.stroke || 0, v => change(layer, "stroke", v), { min: 0, max: 40 }), field("描边颜色", layer.stroke_color || "#ffffff", v => change(layer, "stroke_color", v), { type: "color" })),
      row(button("水平翻转", () => { change(layer, "flip_x", !layer.flip_x); }), button("垂直翻转", () => { change(layer, "flip_y", !layer.flip_y); })),
      row(button("上移", () => reorder(1)), button("下移", () => reorder(-1)), button("复制", () => {
        const copy = { ...layer, id: uid(), name: layer.name + " 副本", x: layer.x + 20, y: layer.y + 20, locked: false };
        project.layers.push(copy); selected = new Set([copy.id]); push(); renderInspector(); draw();
      }), button("删除", removeSelected)),
      button("自动抠图（RMBG）", async () => {
        if (busy || layer.locked) return;
        busy = true; inspector.inert = true; inspector.setAttribute("aria-busy", "true");
        status.classList.remove("ait-error"); status.classList.add("ait-processing");
        status.textContent = "正在自动抠图…首次使用可能需要下载模型，请稍候。";
        try {
          const response = await api.fetchApi(`${API}/image-tools/remove-background`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: layer.asset }) });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "抠图失败");
          layer.asset = result.name; await ensureImages(); push(); renderInspector(); draw(); status.textContent = "抠图完成，可调整描边";
        } catch (error) { report(dlg.overlay, error); }
        finally { busy = false; inspector.inert = false; inspector.removeAttribute("aria-busy"); status.classList.remove("ait-processing"); }
      }));
    const cutoutButton = properties.lastElementChild;
    cutoutButton.setAttribute("aria-describedby", cutoutTip.id);
    const showCutoutTip = () => {
      const rect = cutoutButton.getBoundingClientRect();
      cutoutTip.hidden = false;
      cutoutTip.style.left = `${Math.max(8, Math.min(rect.right - cutoutTip.offsetWidth, window.innerWidth - cutoutTip.offsetWidth - 8))}px`;
      cutoutTip.style.top = `${Math.max(8, rect.top - cutoutTip.offsetHeight - 8)}px`;
    };
    cutoutButton.addEventListener("mouseenter", showCutoutTip);
    cutoutButton.addEventListener("focus", showCutoutTip);
    inspector.onscroll = () => {
      if (cutoutButton.matches(":hover, :focus")) showCutoutTip();
      else cutoutTip.hidden = true;
    };
    for (const event of ["mouseleave", "blur", "pointerdown"]) cutoutButton.addEventListener(event, () => { cutoutTip.hidden = true; });
    if (layer.locked) for (const input of properties.querySelectorAll("input,select,button")) input.disabled = true;
    inspector.append(properties);
  }
  function reorder(offset) {
    const index = project.layers.findIndex(l => selected.has(l.id));
    if (busy || index < 0 || project.layers[index].locked) return;
    const next = Math.max(0, Math.min(project.layers.length - 1, index + offset));
    [project.layers[index], project.layers[next]] = [project.layers[next], project.layers[index]];
    push(); renderInspector(); draw();
  }
  function removeSelected() { if (busy) return; project.layers = project.layers.filter(l => !selected.has(l.id) || l.locked); selected.clear(); push(); renderInspector(); draw(); }
  let space = false;
  stage.addEventListener("keydown", e => {
    if (busy) return;
    if (e.code === "Space") { e.preventDefault(); space = true; }
    if ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault(); e.stopPropagation(); restore(e.shiftKey || e.key.toLowerCase() === "y" ? 1 : -1); return;
    }
    if (e.key === "Delete") { e.preventDefault(); removeSelected(); }
    if (e.key.toLowerCase() === "v") { for (const layer of project.layers.filter(l => selected.has(l.id) && !l.locked)) layer.visible = !layer.visible; push(); renderInspector(); draw(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault(); for (const layer of project.layers.filter(l => selected.has(l.id))) layer.locked = !layer.locked; push(); renderInspector(); draw();
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault(); const step = e.shiftKey ? 10 : 1;
      for (const layer of project.layers.filter(l => selected.has(l.id) && !l.locked)) { layer.x += e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0; layer.y += e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0; }
      push(); renderInspector(); draw();
    }
  });
  stage.addEventListener("keyup", e => { if (e.code === "Space") space = false; });
  stage.addEventListener("blur", () => { space = false; });
  canvas.addEventListener("wheel", e => { e.preventDefault(); zoom = Math.max(.15, Math.min(6, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); syncZoom(); draw(); }, { passive: false });
  function eraseAt(p) {
    const g = gesture, layer = g.layer, q = local(layer, p);
    const x = (q[0] / layer.width + .5) * g.edit.width, y = (q[1] / layer.height + .5) * g.edit.height;
    const px = layer.flip_x ? g.edit.width - x : x, py = layer.flip_y ? g.edit.height - y : y;
    const ctx = g.edit.getContext("2d"); ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = 40 * g.edit.width / layer.width; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(...(g.last || [px, py])); ctx.lineTo(px, py); ctx.stroke();
    ctx.beginPath(); ctx.arc(px, py, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); g.last = [px, py]; draw();
  }
  canvas.addEventListener("pointerdown", e => {
    if (busy || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault(); stage.focus(); canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    if (space || e.button === 1) { gesture = { kind: "pan", start: [e.clientX, e.clientY], pan: [...pan] }; return; }
    const chosen = [...project.layers].reverse().find(l => l.visible && hit(l, p));
    if (!chosen) { if (!e.shiftKey) selected.clear(); gesture = { kind: "marquee", start: p, end: p }; renderInspector(); draw(); return; }
    if (!selected.has(chosen.id)) { if (!e.shiftKey) selected.clear(); selected.add(chosen.id); }
    if (chosen.locked) { renderInspector(); draw(); return; }
    if (tool === "erase") {
      const original = images.get(chosen.asset), edit = document.createElement("canvas"); edit.width = original.width; edit.height = original.height;
      edit.getContext("2d").drawImage(original, 0, 0);
      const oldAsset = chosen.asset; chosen.asset = `draft-${chosen.id}`; images.set(chosen.asset, edit);
      gesture = { kind: "erase", layer: chosen, edit, original, oldAsset }; eraseAt(p); return;
    }
    const q = local(chosen, p), tolerance = 14 / geometry().scale;
    const resize = Math.abs(q[0] - chosen.width / 2) < tolerance && Math.abs(q[1] - chosen.height / 2) < tolerance;
    gesture = { kind: resize ? "resize" : "move", start: p, layer: chosen,
      before: project.layers.filter(l => selected.has(l.id) && !l.locked).map(l => ({ layer: l, x: l.x, y: l.y, width: l.width, height: l.height })) };
    renderInspector(); draw();
  });
  canvas.addEventListener("pointermove", e => {
    if (!gesture) return;
    const p = point(e), g = gesture;
    if (g.kind === "pan") { pan = [g.pan[0] + e.clientX - g.start[0], g.pan[1] + e.clientY - g.start[1]]; }
    else if (g.kind === "marquee") g.end = p;
    else if (g.kind === "erase") { eraseAt(p); return; }
    else if (g.kind === "move") for (const item of g.before) { item.layer.x = item.x + p[0] - g.start[0]; item.layer.y = item.y + p[1] - g.start[1]; }
    else if (g.kind === "resize") {
      const initial = g.before.find(b => b.layer === g.layer), q = local(g.layer, p);
      const scale = Math.min(8192 / Math.max(initial.width, initial.height), Math.max(.02, Math.max(q[0] * 2 / initial.width, q[1] * 2 / initial.height)));
      g.layer.width = Math.max(1, Math.round(initial.width * scale)); g.layer.height = Math.max(1, Math.round(initial.height * scale));
    }
    draw();
  });
  async function endGesture() {
    const g = gesture; if (!g) return;
    gesture = null;
    if (g.kind === "erase") {
      busy = true;
      try { const asset = await uploadCanvas(g.edit); images.delete(g.layer.asset); g.layer.asset = asset; images.set(asset, g.edit); push(); }
      catch (error) { images.delete(g.layer.asset); g.layer.asset = g.oldAsset; report(dlg.overlay, error); }
      finally { busy = false; }
    } else if (g.kind === "marquee") {
      const minX = Math.min(g.start[0], g.end[0]), maxX = Math.max(g.start[0], g.end[0]);
      const minY = Math.min(g.start[1], g.end[1]), maxY = Math.max(g.start[1], g.end[1]);
      for (const l of project.layers) if (l.visible && l.x >= minX && l.x <= maxX && l.y >= minY && l.y <= maxY) selected.add(l.id);
    } else push();
    renderInspector(); draw();
  }
  canvas.addEventListener("pointerup", endGesture); canvas.addEventListener("pointercancel", endGesture);
  const ro = new ResizeObserver(draw); ro.observe(stage);
  renderInspector(); draw();
  try { await ensureImages(); draw(); }
  catch (error) { report(dlg.overlay, error); }
  return dlg;
}
