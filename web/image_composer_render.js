import { el, loadImage } from "./image_tools_ui.js";

// The workspace and saved-layout preview use the same image drawing rules.
export function drawComposition(ctx, project, images) {
  ctx.fillStyle = project.background || "#171923";
  ctx.fillRect(0, 0, project.width, project.height);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, project.width, project.height); ctx.clip();
  for (const layer of project.layers) {
    const image = images.get(layer.asset);
    if (!image || layer.visible === false) continue;
    const width = layer.width ?? image.width, height = layer.height ?? image.height;
    ctx.save(); ctx.translate(layer.x ?? project.width / 2, layer.y ?? project.height / 2);
    ctx.rotate((layer.rotation || 0) * Math.PI / 180);
    ctx.scale(layer.flip_x ? -1 : 1, layer.flip_y ? -1 : 1);
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.globalCompositeOperation = !layer.blend || layer.blend === "normal" ? "source-over" : layer.blend;
    if (layer.stroke) {
      // Alpha silhouettes also outline transparent cutouts.
      const silhouette = document.createElement("canvas"), ratio = Math.min(1, 1024 / Math.max(width, height));
      silhouette.width = Math.max(1, Math.round(width * ratio)); silhouette.height = Math.max(1, Math.round(height * ratio));
      const sc = silhouette.getContext("2d"); sc.drawImage(image, 0, 0, silhouette.width, silhouette.height);
      sc.globalCompositeOperation = "source-in"; sc.fillStyle = layer.stroke_color || "#ffffff";
      sc.fillRect(0, 0, silhouette.width, silhouette.height);
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16)
        ctx.drawImage(silhouette, -width / 2 + Math.cos(angle) * layer.stroke, -height / 2 + Math.sin(angle) * layer.stroke, width, height);
    }
    ctx.drawImage(image, -width / 2, -height / 2, width, height); ctx.restore();
  }
  ctx.restore();
}

export function composerPreview(node, box, status) {
  const canvas = el("canvas", "ait-composer-preview"); canvas.hidden = true;
  canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", "已保存的图层合成预览");
  box.prepend(canvas);
  const image = box.querySelector("img"), empty = box.querySelector(".ait-empty"), pager = box.querySelector(".ait-row");
  let revision = 0, lastLayout = null, hasSavedLayers = false;
  const restore = node._aitRestorePreview;
  node._aitRestorePreview = () => {
    // A saved layout may be newer than the last workflow execution.
    if (!hasSavedLayers) restore?.();
  };
  const onImages = node._aitOnImages;
  node._aitOnImages = refs => {
    onImages?.(refs);
    if (refs.length) { revision++; canvas.hidden = true; }
  };
  return async project => {
    hasSavedLayers = Array.isArray(project.layers) && project.layers.length > 0;
    const key = JSON.stringify(project);
    if (key === lastLayout) return;
    lastLayout = key;
    const current = ++revision;
    image.hidden = true; canvas.hidden = true; empty.hidden = false; pager.hidden = true;
    empty.textContent = "正在加载布局预览…";
    status.classList.remove("ait-error");
    try {
      if (!Array.isArray(project.layers)) throw new Error("合成布局格式无效");
      if (!project.layers.length) {
        empty.textContent = "在图层工作台中导入图片并保存布局";
        status.textContent = "保存布局后显示预览，运行工作流输出图片";
        return;
      }
      const { width, height } = project;
      if (![width, height].every(v => Number.isFinite(v) && v > 0 && v <= 16384)) throw new Error("画布尺寸无效");
      const images = new Map();
      const assets = [...new Set(project.layers.filter(layer => layer.visible !== false).map(layer => layer.asset))];
      await Promise.all(assets.map(async asset => images.set(asset, await loadImage(asset))));
      // A newer layout or an executed result takes priority over pending loads.
      if (current !== revision || !box.isConnected) return;
      const scale = Math.min(1, 1024 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d"); ctx.scale(canvas.width / width, canvas.height / height);
      drawComposition(ctx, project, images);
      image.hidden = true; empty.hidden = true; canvas.hidden = false; pager.hidden = true;
      status.textContent = "布局预览已更新 · 运行工作流输出图片";
    } catch (error) {
      if (current !== revision || !box.isConnected) return;
      lastLayout = null;
      empty.textContent = "布局预览加载失败，请打开工作台检查素材";
      status.textContent = `布局预览失败：${error.message || error}`;
      status.classList.add("ait-error");
    }
  };
}

// Place metadata in the unused socket band above the DOM panel.
export function dockComposerInfo(node, root, dom, info) {
  root.classList.add("ait-composer-docked");
  const measure = document.createElement("canvas").getContext("2d");
  let lastLayout = "";
  const layout = () => {
    root.closest(".dom-widget")?.classList.add("ait-composer-widget");
    const width = node.size?.[0] || 500, widgetY = dom.y || 100;
    const labels = (node.outputs || []).map(output => output.label || output.localized_name || output.name || "");
    const key = JSON.stringify([width, widgetY, labels, !!node.flags?.collapsed]);
    if (key === lastLayout) return;
    lastLayout = key;
    measure.font = `${globalThis.LiteGraph?.NODE_TEXT_SIZE || 14}px Arial`;
    const socketWidth = Math.max(80, ...labels.map(label => measure.measureText(label).width + 32));
    const top = 6, height = widgetY - top - 6;
    info.hidden = !!node.flags?.collapsed || height < 40;
    info.style.left = "2px";
    info.style.top = `${top - widgetY - 10}px`;
    info.style.width = `${Math.max(1, width - socketWidth - 24)}px`;
    info.style.height = `${Math.max(1, height)}px`;
  };
  const draw = node.onDrawBackground;
  node.onDrawBackground = function() { draw?.apply(this, arguments); layout(); };
  const resize = node.onResize;
  node.onResize = function() { resize?.apply(this, arguments); layout(); };
  const refresh = node._aitRefresh;
  node._aitRefresh = () => { refresh?.(); layout(); };
  layout(); requestAnimationFrame(layout);
}
