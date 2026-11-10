import { app, api, API, el, row, field, button, section, dialog, editorAppearance, write, value, loadImage, upload, acceptFiles } from "./image_tools_ui.js";
import { LABELS, blankLayout, clamp, newItem, moveBox, resizeBox, resizeLayout, editEdge, template, History, PIXEL_PRESETS, ASPECT_PRESETS, presetSize, sizePreset, mpLabel, resolutionInputs } from "./moss_layout_data.js";

const colors = { object: "#7299ed", character: "#5eb5a4", text: "#cf995f" };
const editable = target => !!target.closest("input,textarea,select,[contenteditable=true]");
export async function compile(draft, width = 1024, height = 1024, signal) {
  const response = await api.fetchApi(`${API}/moss_layout/compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: draft, width, height }), signal });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404) throw new Error("布局接口尚未加载，请重启 ComfyUI 后重试");
  if (!response.ok || !result.ok) throw new Error(result.error || "布局编译失败；请确认 ComfyUI 已重启");
  return result;
}
export function readLayout(node) {
  try {
    const draft = JSON.parse(value(node, "layout_json"));
    if (draft && draft.summary && [draft.width, draft.height].every(n => Number.isFinite(n) && n >= 16 && n <= 4096) &&
        Array.isArray(draft.items) && draft.items.length <= 200 && draft.items.every(item => item && Object.hasOwn(LABELS, item.label) &&
          Array.isArray(item.bbox) && item.bbox.length === 4 && item.bbox.every(Number.isFinite))) {
      const input = resolutionInputs(node, app.graph);
      return input.width || input.height ? resizeLayout(draft, input.width || draft.width, input.height || draft.height, true) : draft;
    }
  }
  catch { /* A malformed workflow remains visible as an error until explicitly imported. */ }
  return null;
}
export function drawPreview(canvas, draft) {
  const ctx = canvas.getContext("2d"), scale = Math.min(canvas.width / draft.width, canvas.height / draft.height);
  const theme = getComputedStyle(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save();
  ctx.translate((canvas.width - draft.width * scale) / 2, (canvas.height - draft.height * scale) / 2); ctx.scale(scale, scale);
  ctx.fillStyle = theme.getPropertyValue("--aml-sheet").trim() || "#202c38"; ctx.fillRect(0, 0, draft.width, draft.height);
  for (const [index, item] of draft.items.entries()) {
    const [x1, y1, x2, y2] = item.bbox;
    ctx.fillStyle = colors[item.label] + "28"; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeStyle = colors[item.label]; ctx.lineWidth = 1.5 / scale; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.save(); ctx.beginPath(); ctx.rect(x1 + 4 / scale, y1, Math.max(0, x2 - x1 - 8 / scale), y2 - y1); ctx.clip();
    ctx.fillStyle = theme.getPropertyValue("--aml-ink").trim() || "#e0e9f2"; ctx.font = `${11 / scale}px sans-serif`; ctx.fillText(`${index + 1}  ${item.text || item.caption || LABELS[item.label]}`, x1 + 5 / scale, y1 + 16 / scale); ctx.restore();
  }
  ctx.restore();
}

export function openLayoutEditor(node) {
  if (node._amlEditor) { node._amlEditor.overlay.querySelector("button")?.focus(); return; }
  const original = value(node, "layout_json");
  const opener = document.activeElement;
  const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
  let draft = structuredClone(readLayout(node) || blankLayout());
  let reference = structuredClone(node.properties?.allbuyMossReference || { asset: "", opacity: .35, visible: true });
  let selected = draft.items.length ? 0 : -1, zoom = 1, pan = [0, 0], gesture = null, tool = "select", space = false;
  let dirty = false, busy = false, disposed = false, referenceImage = null, referenceToken = 0;
  let timer, controller, previewVersion = 0, result = null, copyTimer;
  const history = new History({ draft, reference });
  const dlg = dialog("布局工作台", force => {
    if (!force && busy) { status.textContent = "正在处理，请稍候"; return false; }
    if (!force && dirty && !window.confirm("布局尚未应用。关闭后可从节点恢复草稿，仍要关闭？")) return false;
    disposed = true; clearTimeout(timer); clearTimeout(copyTimer); controller?.abort(); ro.disconnect();
    delete node._amlResolutionChanged;
    document.body.style.overflow = previousOverflow;
    document.removeEventListener("keydown", keydown, true); document.removeEventListener("keyup", keyup, true);
    if (opener?.isConnected) opener.focus();
    node._amlEditor = null; node._amlRefresh?.(); return true;
  });
  node._amlEditor = dlg;
  dlg.body.setAttribute("role", "dialog"); dlg.body.setAttribute("aria-modal", "true"); dlg.body.setAttribute("aria-label", "布局工作台");
  dlg.overlay.classList.add("aml-overlay"); dlg.body.classList.add("aml-dialog");
  const appearance = editorAppearance(dlg);
  const status = dlg.status; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  const badge = el("span", "aml-badge", "MOSS · 布局提示词"); dlg.body.firstElementChild.insertBefore(badge, dlg.body.firstElementChild.lastChild);
  const workspace = el("div", "aml-workspace"), left = el("aside", "aml-sidebar"), center = el("div", "aml-center"), right = el("aside", "aml-inspector");
  const stage = el("div", "aml-stage"); stage.tabIndex = 0; stage.setAttribute("aria-label", "布局画布，方向键微调，Delete 删除选中元素");
  const sheet = el("div", "aml-sheet"); stage.append(sheet);
  const bottom = el("div", "aml-canvas-hint", "框线只表示位置 · 空格拖动平移 · 滚轮缩放 · 双击文字框改字");
  const metric = el("span", "aml-metric");
  const zoomLabel = el("span", "aml-zoom-label", "100%");
  const undo = button("撤销", () => restore(-1)), redo = button("重做", () => restore(1));
  const selectTool = button("选择", () => setTool("select")), drawTool = button("画框", () => setTool("draw"));
  const canvasTools = row(selectTool, drawTool, metric, button("－", () => setZoom(zoom / 1.2)), zoomLabel, button("＋", () => setZoom(zoom * 1.2)), button("适应", () => { pan = [0, 0]; setZoom(1); }));
  canvasTools.classList.add("aml-canvas-tools");
  canvasTools.querySelectorAll("button").forEach(b => { if (b.textContent === "－") b.setAttribute("aria-label", "缩小画布"); if (b.textContent === "＋") b.setAttribute("aria-label", "放大画布"); });
  center.append(canvasTools, stage, bottom); workspace.append(left, center, right);
  const toolbar = row(undo, redo, button("导入布局", () => showImport()), button("导出草稿", () => download())); toolbar.classList.add("aml-toolbar");
  const templates = field("示例布局", "", kind => {
    if (!kind) return;
    if (draft.items.length && !window.confirm("示例将替换当前布局，继续？可撤销。")) { templates.input.value = ""; return; }
    draft = template(kind); selected = 1; pan = [0, 0]; zoom = 1; commit(); renderAll(); templates.input.value = "";
  }, { values: [["", "选择示例…"], ["poster", "旅行海报"], ["book", "书籍封面"]] }); toolbar.append(templates);
  const importPanel = el("section", "aml-import"); importPanel.hidden = true;
  const source = el("textarea", "ait-input"); source.setAttribute("aria-label", "导入布局 JSON"); source.placeholder = "粘贴草稿 JSON、MOSS 编译提示词或旧版 scene/elements；编译提示词需先设好画布尺寸。";
  const importMessage = el("p", "ait-status"); importMessage.setAttribute("role", "status");
  const applyImport = button("应用导入", async () => {
    if (busy) return; setBusy(true); applyImport.disabled = true; importMessage.textContent = "正在检查布局…";
    const before = JSON.stringify(draft);
    try {
      const imported = await compile(source.value, draft.width, draft.height);
      if (disposed) return;
      if (JSON.stringify(draft) !== before) throw new Error("导入期间布局已修改，请重新应用导入");
      draft = imported.draft; selected = draft.items.length ? 0 : -1; pan = [0, 0]; zoom = 1;
      commit(); renderAll(); importPanel.hidden = true; status.textContent = "布局已导入，原操作可撤销；点击保存并应用写入节点";
    } catch (error) { if (!disposed) importMessage.textContent = error.message; }
    finally { setBusy(false); applyImport.disabled = false; }
  }, true);
  const importFile = el("input"); importFile.type = "file"; importFile.accept = ".json,application/json,text/plain"; importFile.hidden = true;
  importFile.addEventListener("change", async () => {
    const file = importFile.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { importMessage.textContent = "布局文件不能超过 2 MB"; return; }
    source.value = await file.text(); importFile.value = "";
  });
  importPanel.append(el("strong", "", "导入布局"), source, importMessage, row(button("选择 JSON 文件", () => importFile.click()), applyImport, button("取消", () => { importPanel.hidden = true; })), importFile);
  const output = el("details", "aml-output"); output.append(el("summary", "", "编译结果 · 与节点输出一致"));
  const outputText = el("textarea", "ait-input aml-code"); outputText.readOnly = true; outputText.setAttribute("aria-label", "编译结果");
  const copy = button("复制提示词", async () => {
    if (!result) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(result.prompt);
    } catch {
      output.open = true; outputText.focus(); outputText.select(); status.textContent = "浏览器未允许剪贴板访问，已选中文本，可按 Ctrl/Cmd+C 复制"; return;
    }
    copy.textContent = "已复制";
    clearTimeout(copyTimer); copyTimer = setTimeout(() => { copy.textContent = "复制提示词"; }, 1500);
  }); output.append(outputText, copy);
  const save = button("保存并应用", async () => {
    if (busy) return; setBusy(true); status.textContent = "正在校验并保存…";
    applyExternalSize();
    const before = JSON.stringify({ draft, reference });
    try {
      const compiled = await compile(draft);
      if (disposed) return;
      if (JSON.stringify({ draft, reference }) !== before) throw new Error("保存期间布局已修改，请重新保存");
      write(node, "layout_json", JSON.stringify(compiled.draft));
      node.properties ||= {}; node.properties.allbuyMossReference = structuredClone(reference); delete node.properties.allbuyMossRecovery;
      node.graph?.change?.(); dirty = false; node._amlRefresh?.(); dlg.close(true);
    } catch (error) { if (!disposed) { status.textContent = error.message; status.classList.add("ait-error"); } }
    finally { setBusy(false); }
  }, true);
  const footer = el("div", "aml-footer"); footer.append(status, appearance, save);
  dlg.body.append(toolbar, importPanel, workspace, output, footer);
  const summary = textField("整体场景", draft.summary.caption, next => { draft.summary.caption = next; commit(); });
  const palette = textField("配色 · 用逗号分隔", (draft.summary.palette || []).join(", "), next => { draft.summary.palette = splitTags(next); commit(); }, false);
  const meta = textField("标签 · 用逗号分隔", (draft.summary.meta || []).join(", "), next => { draft.summary.meta = splitTags(next); commit(); }, false);
  const kind = field("画布类型", draft.summary.canvas || "single", next => { draft.summary.canvas = next; commit(); }, { values: [["single", "单幅"], ["multi_panel", "多分格"], ["collage", "拼贴"]] });
  const list = el("div", "aml-elements"); list.setAttribute("aria-label", "元素列表");
  const addButtons = row(...Object.entries(LABELS).map(([label, title]) => button("＋" + title, () => add(label)))); addButtons.classList.add("aml-add-buttons");
  left.append(section("场景设定", summary, kind, palette, meta), section("元素 · 从后到前", addButtons, list));
  const recovery = node.properties?.allbuyMossRecovery;
  if (recovery && recovery.base === original) {
    const notice = el("div", "aml-recovery");
    notice.append(el("span", "", "有一份尚未应用的布局草稿"), button("恢复草稿", () => {
      draft = structuredClone(recovery.draft); reference = structuredClone(recovery.reference); selected = -1; history.push({ draft, reference }); dirty = true;
      notice.remove(); loadReference(); renderAll(); queuePreview();
    }), button("忽略", () => { notice.remove(); })); left.prepend(notice);
  }
  const inspector = el("div", "aml-item-fields"), sizePanel = section("MOSS 分辨率", el("p", "aml-note", "推荐 1M / 1.5M / 2M · 自动对齐 16 像素")), referencePanel = section("参考底图", el("p", "aml-note", "仅供布局对照，不作为模型输入"));
  const sizeSource = el("div", "aml-size-source"), sizeMetric = el("div", "aml-size-metric");
  sizeMetric.title = "MP 为实际百万像素：宽 × 高 ÷ 1,000,000；M 档位沿用 MOSS 官方像素预算";
  const width = field("宽度", draft.width, () => { budget.input.value = "custom"; updateSizeMetric(); }, { min: 16, max: 4096, step: 16 });
  const height = field("高度", draft.height, () => { budget.input.value = "custom"; updateSizeMetric(); }, { min: 16, max: 4096, step: 16 });
  const scale = el("input"); scale.type = "checkbox"; scale.checked = true;
  const scaleLabel = el("label", "aml-check"); scaleLabel.append(scale, el("span", "", "按比例缩放元素"));
  const budget = field("像素档位", "custom", () => chooseSize(), { values: [["custom", "自定义尺寸"], ...PIXEL_PRESETS] });
  const ratio = field("画布比例", "custom", () => chooseSize(), { values: [["custom", "当前比例"], ...ASPECT_PRESETS.map(v => [v, v])] });
  function updateSizeMetric() { sizeMetric.textContent = `${width.input.value} × ${height.input.value} · ${mpLabel(Number(width.input.value), Number(height.input.value))}`; }
  function applySize(w, h) {
    if (![w, h].every(n => Number.isInteger(n) && n >= 16 && n <= 4096 && n % 16 === 0)) { status.textContent = "尺寸须为 16–4096 之间的 16 的整数倍"; return; }
    draft = resizeLayout(draft, w, h, scale.checked); pan = [0, 0]; zoom = 1; commit(); renderAll();
  }
  function chooseSize() {
    if (Object.keys(resolutionInputs(node, app.graph).connected).length) return;
    const pixels = budget.input.value === "custom" ? draft.width * draft.height : Number(budget.input.value);
    const aspect = ratio.input.value === "custom" ? `${draft.width}:${draft.height}` : ratio.input.value;
    const [w, h] = presetSize(pixels, aspect); applySize(w, h);
  }
  const applySizeButton = button("应用尺寸", () => {
    const w = Number(width.input.value), h = Number(height.input.value);
    applySize(w, h);
  });
  sizePanel.append(sizeSource, budget, ratio, row(width, height), sizeMetric, scaleLabel, applySizeButton);
  function applyExternalSize() {
    const input = resolutionInputs(node, app.graph), locked = Object.keys(input.connected).length > 0;
    const w = input.width || draft.width, h = input.height || draft.height;
    if (w !== draft.width || h !== draft.height) draft = resizeLayout(draft, w, h, true);
    for (const control of [width.input, height.input, budget.input, ratio.input, scale, applySizeButton]) control.disabled = locked;
    sizeSource.classList.toggle("is-linked", locked);
    sizeSource.textContent = !locked ? "使用工作台尺寸" : input.pending.length ? "外部分辨率优先 · 等待上游执行后同步" : input.cached.length ? "外部分辨率优先 · 显示上次执行值" : "外部分辨率优先 · 已覆盖工作台设置";
    const preset = sizePreset(w, h); budget.input.value = preset.pixels; ratio.input.value = preset.aspect;
    width.input.value = w; height.input.value = h; updateSizeMetric();
  }
  node._amlResolutionChanged = () => { if (!disposed) { renderAll(); queuePreview(); } };
  const refInput = el("input"); refInput.type = "file"; refInput.accept = "image/*"; refInput.hidden = true;
  refInput.addEventListener("change", () => { const file = refInput.files[0]; if (file) importReference(file); refInput.value = ""; });
  const visible = el("input"); visible.type = "checkbox"; visible.checked = reference.visible !== false;
  const visibleLabel = el("label", "aml-check"); visibleLabel.append(visible, el("span", "", "显示底图"));
  visible.addEventListener("change", () => { reference.visible = visible.checked; commit(); renderCanvas(); });
  const opacity = field("底图不透明度", Math.round(reference.opacity * 100), next => { reference.opacity = next / 100; commit(); renderCanvas(); }, { type: "range", min: 0, max: 100, step: 1 });
  const refStatus = el("p", "aml-note");
  referencePanel.append(row(button("载入图片", () => refInput.click()), button("移除", () => { reference.asset = ""; referenceImage = null; commit(); renderCanvas(); })), visibleLabel, opacity, refStatus, refInput);
  right.append(sizePanel, inspector, referencePanel);
  const snap = el("input"); snap.type = "checkbox"; snap.setAttribute("aria-label", "吸附到 16 像素网格");
  const snapLabel = el("label", "aml-check"); snapLabel.append(snap, el("span", "", "吸附 16")); canvasTools.insertBefore(snapLabel, metric);
  acceptFiles(stage, files => files[0] && importReference(files[0]));
  function textField(label, initial, action, multiline = true) {
    const wrap = el("label", "ait-field"), input = el(multiline ? "textarea" : "input", "ait-input");
    wrap.append(el("span", "ait-label", label), input); input.value = initial; input.setAttribute("aria-label", label);
    input.addEventListener("input", () => action(input.value)); return wrap;
  }
  function splitTags(text) { return [...new Set(text.split(/[,，]/).map(x => x.trim()).filter(Boolean))]; }
  function setBusy(next) {
    busy = next;
    if (disposed) return;
    toolbar.inert = next; workspace.inert = next; importPanel.inert = next;
    dlg.body.setAttribute("aria-busy", String(next)); status.classList.toggle("ait-processing", next); save.disabled = next || !result;
  }
  function setTool(next) { tool = next; selectTool.setAttribute("aria-pressed", next === "select"); drawTool.setAttribute("aria-pressed", next === "draw"); stage.classList.toggle("aml-drawing", next === "draw"); }
  function setZoom(next) { zoom = clamp(next, .2, 6); zoomLabel.textContent = Math.round(zoom * 100) + "%"; renderCanvas(); }
  function checkpoint() {
    dirty = true; node.properties ||= {};
    node.properties.allbuyMossRecovery = { base: original, draft: structuredClone(draft), reference: structuredClone(reference) };
    node.graph?.change?.();
  }
  function commit() { history.push({ draft, reference }); checkpoint(); syncHistory(); queuePreview(); renderList(); }
  function syncHistory() { undo.disabled = history.cursor === 0; redo.disabled = history.cursor === history.entries.length - 1; }
  function restore(offset) {
    const restored = history.step(offset); if (!restored) return;
    draft = restored.draft; reference = restored.reference; selected = -1; checkpoint(); syncHistory(); loadReference(); renderAll(); queuePreview();
  }
  function queuePreview() {
    applyExternalSize();
    result = null; save.disabled = true; copy.disabled = true; status.classList.remove("ait-error"); status.textContent = "正在检查布局…";
    const version = ++previewVersion; clearTimeout(timer); controller?.abort();
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const compiled = await compile(draft, draft.width, draft.height, controller.signal);
        if (disposed || version !== previewVersion) return;
        result = compiled; outputText.value = compiled.prompt; save.disabled = busy; copy.disabled = false;
        status.textContent = dirty ? "草稿可恢复 · 尚未应用到节点" : "布局随工作流保存 · 参考底图仅供对照";
      } catch (error) {
        if (disposed || version !== previewVersion || error.name === "AbortError") return;
        outputText.value = ""; status.textContent = error.message; status.classList.add("ait-error");
      }
    }, 180);
  }
  function add(label) {
    if (draft.items.length >= 200) { status.textContent = "最多支持 200 个元素"; return; }
    draft.items.push(newItem(draft, label)); selected = draft.items.length - 1; commit(); renderCanvas(); renderInspector();
  }
  function choose(index) { selected = index; renderList(); renderCanvas(); renderInspector(); }
  function removeSelected() { if (selected < 0) return; draft.items.splice(selected, 1); selected = Math.min(selected, draft.items.length - 1); commit(); renderCanvas(); renderInspector(); }
  function renderList() {
    list.replaceChildren();
    if (!draft.items.length) list.append(el("p", "aml-note", "添加一个元素，或在画布上画框开始构图。"));
    draft.items.forEach((item, index) => {
      const b = button("", () => choose(index)); b.classList.add("aml-element"); b.setAttribute("aria-pressed", index === selected);
      b.style.setProperty("--aml-element-color", colors[item.label]);
      b.append(el("span", "aml-element-number", String(index + 1)), el("span", "aml-element-caption", item.text || item.caption || "未填写描述"), el("span", "aml-element-type", LABELS[item.label]));
      b.setAttribute("aria-label", `选择元素 ${index + 1} ${LABELS[item.label]}`); list.append(b);
    });
  }
  function renderInspector() {
    inspector.replaceChildren(); const item = draft.items[selected];
    if (!item) { inspector.append(section("元素属性", el("p", "aml-note", "选择画布或列表中的元素以编辑属性"))); return; }
    const type = field("元素类型", item.label, next => { item.label = next; if (next === "text" && !item.text) item.text = "文字"; if (next !== "text") delete item.text; commit(); renderCanvas(); renderInspector(); }, { values: Object.entries(LABELS) });
    const description = textField("外观描述", item.caption, next => { item.caption = next; commit(); renderCanvas(); });
    const controls = [type, description];
    if (item.label === "text") controls.push(textField("画面中的文字", item.text || "", next => { item.text = next; commit(); renderCanvas(); }));
    const units = field("坐标单位", "px", () => drawCoords(), { values: [["px", "像素"], ["%", "百分比"]] });
    const coords = el("div", "aml-coordinates");
    function drawCoords() {
      coords.replaceChildren();
      ["左 X", "上 Y", "右 X", "下 Y"].forEach((label, edge) => {
        const limit = edge % 2 ? draft.height : draft.width, percent = units.input.value === "%";
        const control = field(label, Number((item.bbox[edge] / (percent ? limit / 100 : 1)).toFixed(2)), next => {
          item.bbox = editEdge(item.bbox, edge, next * (percent ? limit / 100 : 1), draft.width, draft.height); commit(); renderCanvas();
        }, { min: 0, max: percent ? 100 : limit, step: percent ? .1 : 1 });
        control.input.addEventListener("change", drawCoords); coords.append(control);
      });
    }
    drawCoords();
    const move = offset => { const next = selected + offset; if (next < 0 || next >= draft.items.length) return; [draft.items[selected], draft.items[next]] = [draft.items[next], draft.items[selected]]; selected = next; commit(); renderCanvas(); renderInspector(); };
    const back = button("后移一层", () => move(-1)), front = button("前移一层", () => move(1)); back.disabled = selected === 0; front.disabled = selected === draft.items.length - 1;
    inspector.append(section(`元素 ${selected + 1}`, ...controls, units, coords, row(back, front), row(button("复制元素", () => {
      if (draft.items.length >= 200) return; const clone = structuredClone(item); clone.bbox = moveBox(clone.bbox, 16, 16, draft.width, draft.height); draft.items.push(clone); selected = draft.items.length - 1; commit(); renderCanvas(); renderInspector();
    }), button("删除元素", removeSelected))));
  }
  function geometry() {
    const factor = Math.min(Math.max(100, stage.clientWidth - 72) / draft.width, Math.max(100, stage.clientHeight - 72) / draft.height) * zoom;
    return { factor, x: (stage.clientWidth - draft.width * factor) / 2 + pan[0], y: (stage.clientHeight - draft.height * factor) / 2 + pan[1] };
  }
  function point(event) { const rect = stage.getBoundingClientRect(), g = geometry(); return [(event.clientX - rect.left - g.x) / g.factor, (event.clientY - rect.top - g.y) / g.factor]; }
  function renderCanvas() {
    const g = geometry(); sheet.style.width = draft.width + "px"; sheet.style.height = draft.height + "px";
    sheet.style.transform = `translate(${g.x}px, ${g.y}px) scale(${g.factor})`; sheet.style.setProperty("--aml-scale", g.factor);
    sheet.replaceChildren();
    if (referenceImage && reference.asset && reference.visible !== false) {
      const img = el("img", "aml-reference"); img.src = referenceImage.src; img.alt = "参考底图，仅供对照"; img.style.opacity = reference.opacity; sheet.append(img);
    }
    draft.items.forEach((item, index) => {
      const box = el("div", "aml-box"), [x1, y1, x2, y2] = item.bbox;
      box.dataset.index = index; box.style.cssText = `left:${x1}px;top:${y1}px;width:${x2 - x1}px;height:${y2 - y1}px;--aml-color:${colors[item.label]};`;
      box.classList.toggle("selected", selected === index); box.setAttribute("aria-label", `元素 ${index + 1} ${LABELS[item.label]}`);
      const tab = el("div", "aml-box-tab", `${index + 1} · ${LABELS[item.label]}`); tab.dataset.tab = index;
      const caption = el("div", "aml-box-content", item.text || item.caption || "填写描述"); caption.classList.toggle("is-text", item.label === "text");
      box.append(tab, caption);
      if (index === selected) for (const handle of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) { const h = el("span", "aml-handle " + handle); h.dataset.handle = handle; box.append(h); }
      sheet.append(box);
    });
    metric.textContent = `${draft.width} × ${draft.height} · ${mpLabel(draft.width, draft.height)} · ${draft.items.length} 个元素`;
    zoomLabel.textContent = Math.round(zoom * 100) + "%";
    refStatus.textContent = reference.asset ? (referenceImage ? "底图随节点保存引用" : "底图暂不可用，可重新载入") : "支持拖入图片到画布";
  }
  function renderAll() {
    applyExternalSize();
    summary.querySelector("textarea").value = draft.summary.caption; palette.querySelector("input").value = (draft.summary.palette || []).join(", "); meta.querySelector("input").value = (draft.summary.meta || []).join(", ");
    kind.input.value = draft.summary.canvas || "single"; width.input.value = draft.width; height.input.value = draft.height;
    visible.checked = reference.visible !== false; opacity.input.value = Math.round(reference.opacity * 100);
    renderList(); renderCanvas(); renderInspector(); syncHistory();
  }
  async function loadReference() {
    const token = ++referenceToken; referenceImage = null;
    if (reference.asset) try { const image = await loadImage(reference.asset); if (token === referenceToken && !disposed) referenceImage = image; } catch { /* The stored layout works without its local reference image. */ }
    if (!disposed) renderCanvas();
  }
  async function importReference(file) {
    if (busy) return; setBusy(true); status.textContent = "正在保存参考底图…";
    try { const asset = await upload(file); if (disposed) return; reference.asset = asset; reference.visible = true; visible.checked = true; await loadReference(); commit(); }
    catch (error) { if (!disposed) status.textContent = error.message; }
    finally { setBusy(false); }
  }
  function showImport() { importPanel.hidden = false; importMessage.textContent = "编译提示词不携带尺寸，将使用当前画布；格式错误时保留原布局。"; source.focus(); }
  function download() {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = "allbuy-moss-layout.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  let cycle = { x: 0, y: 0, hits: [], cursor: 0 };
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 && event.button !== 1 || busy) return;
    event.preventDefault(); stage.focus(); const p = point(event); const boxNode = event.target.closest(".aml-box");
    if (space || event.button === 1) gesture = { kind: "pan", x: event.clientX, y: event.clientY, start: [...pan] };
    else if (tool === "draw" && !event.target.dataset.handle) {
      if (draft.items.length >= 200) return;
      if (p[0] < 0 || p[1] < 0 || p[0] > draft.width || p[1] > draft.height) return;
      const grid = snap.checked ? 16 : 1;
      const start = [clamp(Math.round(p[0] / grid) * grid, 0, draft.width - grid), clamp(Math.round(p[1] / grid) * grid, 0, draft.height - grid)];
      draft.items.push({ label: "object", caption: "", bbox: [...start, start[0] + grid, start[1] + grid] }); selected = draft.items.length - 1;
      gesture = { kind: "draw", start, index: selected };
    } else {
      let index = boxNode ? Number(boxNode.dataset.index) : -1;
      const hits = draft.items.map((item, i) => ({ item, i })).filter(({ item: { bbox: b } }) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]).map(x => x.i).reverse();
      const handle = event.target.dataset.handle;
      const tab = event.target.closest(".aml-box-tab");
      if (!tab && !handle && hits.length) {
        const same = Math.abs(cycle.x - p[0]) < 3 && Math.abs(cycle.y - p[1]) < 3 && JSON.stringify(hits) === JSON.stringify(cycle.hits);
        const cursor = same ? (cycle.cursor + 1) % hits.length : Math.max(0, hits.indexOf(selected));
        index = hits[cursor]; cycle = { x: p[0], y: p[1], hits, cursor };
      }
      if (index >= 0) gesture = { kind: handle ? "resize" : "move", handle, start: p, box: [...draft.items[index].bbox], index };
      selected = index;
    }
    gesture && (gesture.moved = false); stage.setPointerCapture(event.pointerId); renderList(); renderCanvas(); renderInspector();
  });
  stage.addEventListener("pointermove", event => {
    if (!gesture) return;
    const p = point(event), grid = snap.checked ? 16 : 1;
    if (gesture.kind === "pan") pan = [gesture.start[0] + event.clientX - gesture.x, gesture.start[1] + event.clientY - gesture.y];
    else if (gesture.kind === "draw") {
      const end = [clamp(Math.round(p[0] / grid) * grid, 0, draft.width), clamp(Math.round(p[1] / grid) * grid, 0, draft.height)];
      draft.items[gesture.index].bbox = [Math.min(gesture.start[0], end[0]), Math.min(gesture.start[1], end[1]), Math.max(gesture.start[0] + grid, end[0]), Math.max(gesture.start[1] + grid, end[1])];
    } else {
      const dx = p[0] - gesture.start[0], dy = p[1] - gesture.start[1];
      if (Math.abs(dx) + Math.abs(dy) < .5) return;
      draft.items[gesture.index].bbox = gesture.kind === "move" ? moveBox(gesture.box, dx, dy, draft.width, draft.height, grid) : resizeBox(gesture.box, gesture.handle, dx, dy, draft.width, draft.height, grid);
    }
    gesture.moved = true; renderCanvas();
  });
  const endGesture = event => {
    if (!gesture) return; const changed = gesture.moved || gesture.kind === "draw", kind = gesture.kind; gesture = null;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (changed && kind !== "pan") { commit(); renderList(); renderInspector(); cycle.hits = []; }
    if (kind === "draw") setTool("select");
  };
  stage.addEventListener("pointerup", endGesture); stage.addEventListener("pointercancel", endGesture); stage.addEventListener("lostpointercapture", endGesture);
  stage.addEventListener("dblclick", event => {
    const box = event.target.closest(".aml-box"); if (!box) return; choose(Number(box.dataset.index));
    right.querySelector(`[aria-label="${draft.items[selected].label === "text" ? "画面中的文字" : "外观描述"}"]`)?.focus();
  });
  stage.addEventListener("wheel", event => { event.preventDefault(); setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)); }, { passive: false });
  function keydown(event) {
    if (event.key === "Tab") {
      const targets = [...dlg.overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea,select,summary,[tabindex="0"]')].filter(item => item.getClientRects().length);
      if (event.shiftKey && document.activeElement === targets[0]) { event.preventDefault(); targets.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === targets.at(-1)) { event.preventDefault(); targets[0]?.focus(); }
      return;
    }
    if (!dlg.overlay.contains(document.activeElement) || editable(event.target)) return;
    if (event.key === " ") { space = true; event.preventDefault(); }
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopImmediatePropagation(); removeSelected(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopImmediatePropagation(); restore(event.shiftKey ? 1 : -1); }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (delta && selected >= 0) { event.preventDefault(); event.stopImmediatePropagation(); const step = event.shiftKey ? 16 : 1; draft.items[selected].bbox = moveBox(draft.items[selected].bbox, delta[0] * step, delta[1] * step, draft.width, draft.height); commit(); renderCanvas(); renderInspector(); }
  }
  function keyup(event) { if (event.key === " ") space = false; }
  document.addEventListener("keydown", keydown, true); document.addEventListener("keyup", keyup, true);
  dlg.overlay.addEventListener("keydown", event => { if (event.key !== "Escape") event.stopPropagation(); });
  const ro = new ResizeObserver(() => renderCanvas()); ro.observe(stage);
  setTool("select"); renderAll(); loadReference(); queuePreview(); stage.focus();
}
