import { app, el, row, field, button, section, bind, hide, mount, previewPanel, dockTitlePreview, value, write, parseState, imageURL, acceptFiles } from "./image_tools_ui.js";
import { openComposer, DEFAULT_LAYOUT } from "./image_composer_editor.js";
import { composerPreview, dockComposerInfo } from "./image_composer_render.js";
import { openGenerateEditor, importGenerateImage, installGenerateMaskPreview } from "./generate_editor.js";
import { installGeneratePromptHook } from "./generate_prompt.js";

const NAMES = new Set(["AllBuyImageComposer", "AllBuyImageGrid", "AllBuyImageTitle", "AllBuyGenerate"]);
for (const [id, path] of [["allbuy-tools-theme", "./style.css"], ["allbuy-tools-style", "./image_tools.css"]]) {
  if (document.getElementById(id)) continue;
  const link = el("link"); link.id = id; link.rel = "stylesheet"; link.href = new URL(path + "?v=29", import.meta.url).href; document.head.append(link);
}
const typeOf = node => node.constructor?.comfyClass || node.comfyClass || node.type;

function dockGenerateRun(node, root, dom, run) {
  const controls = el("div", "ait-generate-controls");
  for (const child of [...root.children]) if (!child.classList.contains("vpl-exec-bar")) controls.append(child);
  const actions = el("div", "ait-generate-actions"); actions.append(run);
  root.append(actions, controls);
  const measure = document.createElement("canvas").getContext("2d");
  let lastLayout = "";
  const layout = () => {
    root.closest(".dom-widget")?.classList.add("ait-generate-widget");
    const sockets = (node.inputs || []).filter(input => !input.widget || input.link != null);
    const labels = sockets.map(input => input.label || input.name || "");
    const width = node.size?.[0] || 500, widgetY = dom.y || sockets.length * 20 + 10;
    const top = (node.outputs?.length || 3) * (globalThis.LiteGraph?.NODE_SLOT_HEIGHT || 20) + 8;
    const key = JSON.stringify([width, widgetY, top, labels, !!node.flags?.collapsed]);
    if (key === lastLayout) return;
    lastLayout = key;
    measure.font = `${globalThis.LiteGraph?.NODE_TEXT_SIZE || 14}px Arial`;
    const left = Math.ceil(Math.max(40, ...labels.map(label => measure.measureText(label).width)) + 28);
    const available = widgetY - top - 8;
    // Short socket bands keep the action above the panel instead of covering sockets.
    const docked = available >= 36 && width - left - 20 >= 140;
    actions.classList.toggle("ait-generate-actions-docked", docked);
    actions.hidden = !!node.flags?.collapsed;
    actions.style.left = `${left - 10}px`;
    actions.style.top = `${top + (available - 36) / 2 - widgetY - 10}px`;
    actions.style.width = docked ? `${width - left - 20}px` : "";
  };
  const draw = node.onDrawBackground;
  node.onDrawBackground = function() { draw?.apply(this, arguments); layout(); };
  const resize = node.onResize;
  node.onResize = function() { resize?.apply(this, arguments); layout(); };
  const refresh = node._aitRefresh;
  node._aitRefresh = (...args) => { refresh?.(...args); layout(); };
  layout(); requestAnimationFrame(layout);
}

function attach(node) {
  const type = typeOf(node);
  if (!NAMES.has(type)) return;
  if (type === "AllBuyGenerate") {
    // Old workflows stored only the generated image and latent outputs.
    // Insert the new output while keeping their existing wires on those outputs.
    if (node.outputs?.length === 2 && !node.outputs.some(output => output.name === "原图")) {
      node.addOutput("原图", "IMAGE");
      node.outputs.unshift(node.outputs.pop());
      const links = (node.graph || app.graph)?.links;
      node.outputs.forEach((output, index) => {
        for (const id of output.links || []) {
          const link = links?.get?.(id) ?? links?.[id];
          if (link) link.origin_slot = index;
        }
      });
      node.setDirtyCanvas?.(true, true);
    }
    const inputs = node.inputs || [];
    const vaeIndex = inputs.findIndex(input => input.name === "vae");
    const negativeIndex = inputs.findIndex(input => input.name === "negative");
    if (vaeIndex >= 0 && negativeIndex >= 0 && vaeIndex < negativeIndex) {
      const [vae] = inputs.splice(vaeIndex, 1);
      inputs.splice(inputs.findIndex(input => input.name === "negative") + 1, 0, vae);
      // Existing workflow links store the input index as well as the input's link ID.
      const links = (node.graph || app.graph)?.links;
      inputs.forEach((input, index) => {
        const link = links?.get?.(input.link) ?? links?.[input.link];
        if (link) link.target_slot = index;
      });
      node.setDirtyCanvas?.(true, true);
    }
  }
  const labels = { model: "模型", positive: "正向条件", negative: "负向条件", vae: "VAE", latent: "Latent", source_image: "底图", mask: "遮罩", images: "图片" };
  for (const input of node.inputs || []) input.label = labels[input.name] || (/^image_\d+$/.test(input.name) ? `图片 ${input.name.slice(6)}` : input.label || input.name);
  if (node._aitRoot) return;
  const nativeWidgets = [...(node.widgets || [])];
  for (const w of nativeWidgets) hide(w);
  const titles = { AllBuyImageComposer: "图层合成 · 自由画布", AllBuyImageGrid: "", AllBuyImageTitle: "", AllBuyGenerate: "生成 · 采样与画布编辑" };
  const { root, status, dom } = mount(node, titles[type], type === "AllBuyGenerate" ? 540 : type === "AllBuyImageTitle" ? 650 : 500, { compact: type === "AllBuyGenerate" });
  node._aitRoot = root;
  const preview = previewPanel(node, { titleFocus: type === "AllBuyImageTitle", live: type === "AllBuyGenerate" });
  root.append(preview);
  if (type === "AllBuyImageComposer") {
    root.classList.add("ait-composer-node");
    const summary = el("div", "ait-status");
    const refreshPreview = composerPreview(node, preview, status);
    const refresh = node._aitRefresh;
    node._aitRefresh = () => {
      refresh(); const p = parseState(node, "layout_json", DEFAULT_LAYOUT);
      summary.textContent = `${p.width} × ${p.height} · ${p.layers?.length || 0} 个图层 · 素材随布局保存`;
      refreshPreview(p);
    };
    const info = el("div", "ait-composer-info");
    info.setAttribute("role", "group"); info.setAttribute("aria-label", "图层合成信息");
    summary.classList.add("ait-composer-summary");
    info.append(summary, el("div", "ait-status", "在工作台中导入、排列、旋转、混合图层，保存后运行输出图片。"), status);
    root.append(info, button("打开图层工作台", () => openComposer(node), true));
    dockComposerInfo(node, root, dom, info);
  } else if (type === "AllBuyImageGrid") {
    root.classList.add("ait-grid-node");
    root.append(section("排列", row(bind(node, "layout", "拼接方向"), bind(node, "fit", "图片适配")),
      row(bind(node, "columns", "网格列数 · 0 自动"), bind(node, "cell_size", "单格最长边 · 0 跟随首图"))),
      section("画布留白", row(bind(node, "gap", "图片间距 px"), bind(node, "padding", "外边距 px")), bind(node, "background", "背景颜色", { type: "color" })),
      el("div", "ait-status", "支持 12 路图片，每路可连接批次；按输入口顺序排列，输出一张拼图。"));
  } else if (type === "AllBuyImageTitle") {
    const barWidth = bind(node, "bar_width", "标题栏宽度 %");
    const roundedRow = row(bind(node, "corner_radius", "标题栏圆角 px"), barWidth,
      bind(node, "background", "标题底色", { type: "color" }));
    roundedRow.classList.add("ait-title-bar-row");
    const refresh = node._aitRefresh;
    const updateWidth = () => { barWidth.hidden = !(Number(value(node, "corner_radius")) > 0); };
    roundedRow.addEventListener("input", updateWidth);
    node._aitRefresh = () => { refresh(); updateWidth(); };
    updateWidth();
    const textSection = section("标题文本", bind(node, "titles", "每行对应一张图片 · 单行应用到全部", { multiline: true }));
    const textHeading = row(); textHeading.classList.add("ait-title-text-heading");
    const heading = textSection.firstElementChild;
    textSection.prepend(textHeading);
    textHeading.append(heading, bind(node, "suffix_mode", "序号"));
    root.append(textSection,
      section("位置与标题栏", row(bind(node, "position", "标题位置"), bind(node, "output_size", "图片最长边")),
        row(bind(node, "bar_height", "标题栏高度 %"), bind(node, "opacity", "底色不透明度 %")),
        roundedRow),
      section("文字样式", bind(node, "font_name", "字体 · 系统字体 / 插件 fonts 目录"),
        row(bind(node, "font_size", "字号 px"), bind(node, "padding", "左右留白 px")),
        row(bind(node, "align", "对齐"), bind(node, "text_color", "文字颜色", { type: "color" })),
        row(bind(node, "stroke_width", "文字描边 px · 0 关闭"), bind(node, "stroke_color", "描边颜色", { type: "color" }))),
      section("字体阴影", row(bind(node, "shadow_opacity", "阴影不透明度 % · 0 关闭"), bind(node, "shadow_color", "阴影颜色", { type: "color" })),
        row(bind(node, "shadow_offset_x", "阴影水平偏移 px"), bind(node, "shadow_offset_y", "阴影垂直偏移 px"), bind(node, "shadow_blur", "阴影模糊 px"))),
      el("div", "ait-status", "支持 12 路图片 / IMAGE 批次，按输入口和批次顺序输出，标题按总序号对应。不同尺寸等比适应首图画布。所有数值可左键横向拖动，Shift 加速，Alt 精调，也可直接输入。"));
  } else {
    root.classList.add("ait-generate-node");
    installGenerateMaskPreview(node, preview, status);
    preview.querySelector(".ait-empty").textContent = "拖入图片作为底图，或点击「运行生成」";
    preview.title = "支持拖入图片或粘贴图片；生成时显示采样预览，完成后显示结果";
    let selectedRef = null, historyPicked = false;
    const history = el("div", "ait-history");
    node.properties ||= {};
    const historyKey = ref => JSON.stringify([ref.filename, ref.subfolder || "", ref.type || "temp"]);
    let refs = [], removed = new Set();
    const clear = button("清空", () => { node._aitClearHistory(); status.textContent = "已清空历史记录"; });
    clear.title = "清空历史记录，保留导入底图与遮罩";
    const showHistory = () => {
      history.replaceChildren();
      clear.disabled = !refs.length;
      for (const ref of refs) {
        const image = el("img"); image.src = imageURL(ref); image.alt = "历史生成图片";
        const item = el("div", "ait-history-item");
        const b = button("", () => { selectedRef = ref; historyPicked = true; preview._aitShowImages([ref]); status.textContent = "已选择历史图片，可将它用作下一次重绘底图"; });
        b.classList.add("ait-history-pick");
        b.title = "选择此图作为编辑来源"; b.setAttribute("aria-label", "选择历史图片"); b.append(image);
        const remove = button("×", () => {
          const key = historyKey(ref);
          refs = refs.filter(entry => historyKey(entry) !== key);
          removed.add(key);
          if (selectedRef && historyKey(selectedRef) === key) {
            selectedRef = null; historyPicked = false;
            const state = parseState(node, "edit_json", {});
            preview._aitShowImages(state.enabled && state.source ? [state.source] : refs);
          }
          showHistory(); node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
          status.textContent = "已移除历史图片";
        });
        remove.classList.add("ait-history-delete"); remove.title = "移除这张历史图片"; remove.setAttribute("aria-label", "移除历史图片");
        item.append(b, remove); history.append(item);
      }
    };
    node._aitClearHistory = () => {
      const cached = app.nodeOutputs?.[node.id];
      const saved = node.properties.allbuy_generate_history;
      const old = Array.isArray(saved) ? saved : [];
      const cachedImages = cached?.allbuy_images || cached?.ui?.allbuy_images || cached?.images;
      const images = Array.isArray(cachedImages) ? cachedImages : [];
      removed = new Set([...removed, ...[...refs, ...old, ...images].filter(ref => ref?.filename).map(historyKey)].slice(-64));
      delete node.properties.allbuy_generate_history;
      delete node.properties.allbuy_generate_removed_history;
      refs = []; selectedRef = null; historyPicked = false;
      showHistory();
      node._aitRestorePreview();
      status.textContent = "连接输入后运行工作流查看结果";
      status.classList.remove("ait-error");
    };
    node._aitOnImages = images => {
      const incoming = images.filter(ref => !removed.has(historyKey(ref)));
      if (!incoming.length) { node._aitRestorePreview?.(); return; }
      selectedRef = incoming[0]; historyPicked = false;
      const seen = new Set(removed);
      refs = [...incoming, ...refs].filter(ref => { const key = historyKey(ref); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 4);
      showHistory();
      status.textContent = "生成完成 · 点击历史图片可选择重绘来源";
    };
    const editStatus = status;
    const updateEditStatus = state => {
      if (!state.enabled) editStatus.textContent = "普通生成 · 使用连接的 Latent / 图片";
      else if (state.mask) editStatus.textContent = "局部重绘 / 扩图 · 使用已保存底图与遮罩";
      else if (Number(value(node, "denoise")) >= 1) editStatus.textContent = "图生图 · 降噪为 1 会完全重画；调低可保留底图内容";
      else editStatus.textContent = "图生图 · 使用已导入底图，可点击「局部重绘 / 扩图」涂抹编辑";
    };
    const refresh = node._aitRefresh;
    const saveImportResize = () => {
      node.properties.allbuy_generate_import_resize = { mode: importMode.input.value, size: Number(importSize.input.value) };
      write(node, "input_resize", JSON.stringify(node.properties.allbuy_generate_import_resize));
      importSize.input.disabled = importMode.input.value === "original";
      node.graph?.change?.(); node.setDirtyCanvas?.(true, true);
    };
    const importMode = field("导入缩放", "original", saveImportResize, { values: [["original", "原始尺寸"], ["longest", "最长边"], ["shortest", "最短边"]] });
    const importSize = field("目标尺寸 px", 1024, saveImportResize, { min: 1, max: 8192, step: 1 });
    const importControls = row(importMode, importSize);
    importControls.classList.add("ait-import-resize");
    importControls.title = "导入图片及普通生成连接的底图共用此缩放设置";
    const refreshImportResize = () => {
      const options = node.properties.allbuy_generate_import_resize || parseState(node, "input_resize", {});
      importMode.input.value = options?.mode || "original";
      importSize.input.value = options?.size ?? 1024;
      importSize.input.disabled = importMode.input.value === "original";
      node.properties.allbuy_generate_import_resize = { mode: importMode.input.value, size: Number(importSize.input.value) };
      write(node, "input_resize", JSON.stringify(node.properties.allbuy_generate_import_resize));
    };
    let lastEdit = null;
    node._aitRestorePreview = () => {
      const state = parseState(node, "edit_json", {});
      if (state.enabled && state.source) preview._aitShowImages([state.source]);
      else {
        preview._aitShowImages(refs);
        if (!refs.length) {
          preview.querySelector("img").removeAttribute("src");
          preview.querySelector(".ait-empty").textContent = "拖入图片作为底图，或点击「运行生成」";
        }
      }
    };
    node._aitRefresh = (forceSource = false) => {
      refresh(); const state = parseState(node, "edit_json", {});
      refreshImportResize();
      updateEditStatus(state);
      const edit = JSON.stringify(state);
      if (edit !== lastEdit || forceSource === true) {
        lastEdit = edit; selectedRef = null; historyPicked = false;
        if (state.enabled && state.source) preview._aitShowImages([state.source]);
        else node._aitRestorePreview();
      }
      showHistory();
    };
    const runGenerate = () => {
      if (node._aitImportBusy) throw new Error("图片正在导入，请等待预览更新后再运行");
      const targets = new Set(), pending = [node];
      while (pending.length) {
        const current = pending.pop(), id = String(current.id);
        if (targets.has(id)) continue;
        targets.add(id);
        for (const output of current.outputs || []) for (const linkId of output.links || []) {
          const graph = current.graph, link = graph?.links?.get?.(linkId) ?? graph?.links?.[linkId];
          const downstream = link && graph?.getNodeById(link.target_id);
          if (downstream) pending.push(downstream);
        }
      }
      return app.queuePrompt(0, 1, [...targets]);
    };
    root.append(history, importControls, row(button("导入底图", () => importGenerateImage(node)), button("局部重绘 / 扩图", () => {
      const state = parseState(node, "edit_json", {});
      const editor = openGenerateEditor(node, historyPicked ? selectedRef : state.enabled ? undefined : selectedRef || refs[0]);
      historyPicked = false; return editor;
    }), button("普通生成", () => {
      // Invalidate pending uploads so they cannot re-enable the old source.
      node._aitSourceVersion = (node._aitSourceVersion || 0) + 1; node._aitImportBusy = false;
      write(node, "edit_json", "{}"); write(node, "denoise", 1); node._aitRefresh(true);
    }), clear), editStatus,
    section("采样", row(bind(node, "sampler_name", "采样器"), bind(node, "scheduler", "调度器")),
      row(bind(node, "steps", "步数"), bind(node, "cfg", "CFG")),
      row(bind(node, "seed", "种子"), ...nativeWidgets.filter(w => w.name === "control_after_generate").map(() => bind(node, "control_after_generate", "生成后种子")))),
    section("重绘", row(bind(node, "denoise", "降噪强度"), bind(node, "feather", "遮罩羽化 px"))));
    const run = button("运行生成", runGenerate, true);
    run.title = "运行当前生成节点及相连的下游预览、保存节点";
    dockGenerateRun(node, root, dom, run);
    node._aitClearHistory();
    acceptFiles(root, files => importGenerateImage(node, files[0]), { node });
    root.addEventListener("input", e => { if (e.target.closest('[data-widget="denoise"]')) updateEditStatus(parseState(node, "edit_json", {})); });
    showHistory();
  }
  if (type !== "AllBuyImageComposer" && type !== "AllBuyGenerate") root.append(status);
  if (type === "AllBuyImageTitle") dockTitlePreview(node, root, dom, preview);
  if (type === "AllBuyImageGrid") dockTitlePreview(node, root, dom, preview, { fullImage: true, captionText: "多图拼接 · 布局与留白" });
  node._aitRefresh?.();
  const executed = node.onExecuted;
  node.onExecuted = function(message) {
    executed?.apply(this, arguments);
    if (type !== "AllBuyGenerate") status.textContent = "输出已更新";
    status.classList.remove("ait-error");
  };
  const removed = node.onRemoved;
  node.onRemoved = function() {
    // Removal must release the modal even when its draft is dirty.
    this._aitDialog?.close(true);
    this._aitSourceVersion = (this._aitSourceVersion || 0) + 1;
    removed?.apply(this, arguments);
  };
}

app.registerExtension({
  name: "AllBuy.ImageTools",
  setup() { installGeneratePromptHook(); },
  nodeCreated(node) { installGeneratePromptHook(); attach(node); },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NAMES.has(nodeData.name)) return;
    nodeType.prototype._aitInputTypes = { ...nodeData.input?.required, ...nodeData.input?.optional };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function() { configure?.apply(this, arguments); requestAnimationFrame(() => { attach(this); this._aitClearHistory?.(); this._aitRefresh?.(); this._aitRestorePreview?.(); }); };
  },
});
