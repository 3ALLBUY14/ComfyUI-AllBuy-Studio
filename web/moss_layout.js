import { app, el, button, mount, hide, value } from "./image_tools_ui.js";
import { compile, readLayout, drawPreview, openLayoutEditor } from "./moss_layout_editor.js";
import { mpLabel, resolutionInputs } from "./moss_layout_data.js";

for (const [id, file] of [["allbuy-tools-theme", "style.css"], ["allbuy-tools-style", "image_tools.css"], ["allbuy-moss-layout-style", "moss_layout.css"]]) {
  if (document.getElementById(id)) continue;
  const link = el("link"); link.id = id; link.rel = "stylesheet"; link.href = new URL(`./${file}?v=3.169`, import.meta.url).href; document.head.append(link);
}
function attach(node) {
  for (const [name, label] of [["width", "宽度"], ["height", "高度"]]) {
    if (!node.inputs?.some(input => input.name === name)) node.addInput?.(name, "INT");
    const input = node.inputs?.find(input => input.name === name); if (input) input.label = label;
  }
  if (node._amlRefresh) return;
  const storage = node.widgets?.find(w => w.name === "layout_json");
  if (!storage || !node.addDOMWidget) return;
  hide(storage);
  const { root, status, dom } = mount(node, "布局提示词 · MOSS", 390, { autoHeight: true }); root.classList.add("aml-node");
  const thumbnail = el("canvas", "aml-thumbnail"); thumbnail.width = 480; thumbnail.height = 260; thumbnail.setAttribute("aria-label", "布局缩略图，方框仅表示位置");
  const summary = el("div", "aml-node-summary"), hint = el("p", "ait-hint", "提示词接 MOSS 文本编码，宽高接 Latent；外部宽高输入优先覆盖工作台尺寸，参考底图仅供对照。");
  root.append(thumbnail, summary, hint, button("打开布局工作台", () => openLayoutEditor(node), true), status);
  status.setAttribute("role", "status");
  let resolutionKey = "";
  const syncResolution = () => {
    const input = resolutionInputs(node, app.graph), key = JSON.stringify([input.key, input.width, input.height, input.pending, input.cached]);
    if (key === resolutionKey) return;
    resolutionKey = key; node._amlRefresh?.(); node._amlResolutionChanged?.();
  };
  let panelHeight = 390, frame = 0, disposed = false, lastWidth = 0, lastChrome = 0;
  dom.computeSize = () => [460, panelHeight];
  dom.computeLayoutSize = () => ({ minHeight: panelHeight, maxHeight: panelHeight, minWidth: 460 });
  dom.options.getMinHeight = dom.options.getMaxHeight = () => panelHeight;
  const fit = () => {
    frame = 0;
    if (disposed || !root.isConnected || !root.getBoundingClientRect().height) return;
    panelHeight = Math.ceil(root.offsetHeight);
    lastWidth = node.size?.[0] || 500; lastChrome = dom.y || 100;
    const height = Math.ceil(lastChrome + 10 + panelHeight + 18);
    if (Math.abs((node.size?.[1] || 0) - height) > 1 || lastWidth < 500) {
      node.setSize([Math.max(500, lastWidth), height]); node.setDirtyCanvas?.(true, true);
    }
  };
  const queueFit = () => { if (!frame && !disposed) frame = requestAnimationFrame(fit); };
  const paint = () => { const layout = readLayout(node); if (layout) drawPreview(thumbnail, layout); };
  const observer = new ResizeObserver(() => { paint(); queueFit(); }); observer.observe(root);
  const resize = node.onResize, draw = node.onDrawBackground;
  node.onResize = function() { resize?.apply(this, arguments); queueFit(); };
  node.onDrawBackground = function() {
    draw?.apply(this, arguments);
    syncResolution();
    if (lastWidth !== this.size?.[0] || lastChrome !== (dom.y || 100) || Math.abs((this.size?.[1] || 0) - (lastChrome + panelHeight + 28)) > 1) queueFit();
  };
  let version = 0, controller;
  node._amlRefresh = async () => {
    const current = ++version; controller?.abort(); controller = new AbortController();
    const layout = readLayout(node);
    if (!layout) { status.textContent = "布局 JSON 无效，请打开工作台导入有效草稿"; status.classList.add("ait-error"); return; }
    const previewScale = Math.min(480 / layout.width, 1024 / layout.height);
    thumbnail.width = Math.max(1, Math.round(layout.width * previewScale));
    thumbnail.height = Math.max(1, Math.round(layout.height * previewScale));
    drawPreview(thumbnail, layout);
    const input = resolutionInputs(node, app.graph);
    summary.textContent = `${layout.width} × ${layout.height} · ${mpLabel(layout.width, layout.height)} · ${layout.items.length} 个元素`;
    status.textContent = node.properties?.allbuyMossRecovery ? "有未应用草稿，打开工作台可恢复" : "布局已保存到节点 · 随工作流保留";
    if (Object.keys(input.connected).length) status.textContent += input.pending.length ? " · 外部尺寸待上游执行" : " · 外部分辨率优先";
    queueFit();
    try {
      await compile(layout, layout.width, layout.height, controller.signal);
      if (current === version) status.classList.remove("ait-error");
    } catch (error) { if (current === version && error.name !== "AbortError") { status.textContent = error.message; status.classList.add("ait-error"); } }
  };
  const oldCallback = storage.callback;
  storage.callback = function() { oldCallback?.apply(this, arguments); node._amlRefresh?.(); };
  const removed = node.onRemoved;
  const themeObserver = new MutationObserver(paint);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  node._amlResume = () => {
    disposed = false; observer.observe(root);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    node._amlRefresh?.(); queueFit();
  };
  node.onRemoved = function() { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); themeObserver.disconnect(); version++; controller?.abort(); this._amlEditor?.close(true); removed?.apply(this, arguments); };
  const connected = node.onConnectionsChange;
  node.onConnectionsChange = function() { connected?.apply(this, arguments); syncResolution(); };
  const executed = node.onExecuted;
  node.onExecuted = function(message) {
    executed?.apply(this, arguments);
    const dimensions = (message?.ui || message?.output || message)?.allbuy_moss_dimensions;
    if (dimensions?.length === 2) {
      this.properties ||= {}; this.properties.allbuyMossResolution = { key: resolutionInputs(this, app.graph).key, width: dimensions[0], height: dimensions[1] };
      syncResolution();
    }
  };
  node._amlRefresh();
}
app.registerExtension({
  name: "AllBuy.MossLayoutPrompt",
  beforeRegisterNodeDef(nodeType, data) {
    if (data.name !== "AllBuyMossLayoutPrompt") return;
    const created = nodeType.prototype.onNodeCreated, configured = nodeType.prototype.onConfigure, added = nodeType.prototype.onAdded;
    nodeType.prototype.onNodeCreated = function() { created?.apply(this, arguments); attach(this); };
    nodeType.prototype.onConfigure = function() { configured?.apply(this, arguments); this._amlEditor?.close(true); requestAnimationFrame(() => { attach(this); this._amlRefresh?.(); }); };
    nodeType.prototype.onAdded = function() { added?.apply(this, arguments); this._amlResume?.(); };
  },
  nodeCreated(node) { if ((node.constructor?.comfyClass || node.comfyClass || node.type) === "AllBuyMossLayoutPrompt") attach(node); },
});
