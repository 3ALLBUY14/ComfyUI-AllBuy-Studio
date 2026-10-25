// AllBuy 节点帮助徽章
//   每个 AllBuy 节点标题栏右侧绘制「?」徽章，点击弹出帮助卡片。卡片内容直接
//   取自节点注册的 schema（DESCRIPTION、输入 tooltip、OUTPUT_TOOLTIPS，由前端
//   经 /object_info 注入 node.constructor.nodeData），屏幕上的帮助与源码声明
//   永远一致，不需要另写文档。
//   渲染挂点（onDrawForeground / onMouseDown）与现有画布 custom widget 一致。
//   纯几何与卡片组装函数带 export，供 tests/test_help_badge.mjs 直测；
//   openHelpCard 在无 DOM 环境（node 测试）下安全返回 null。
import { app } from "../../scripts/app.js";

// 覆盖全部注册节点；tests/test_web_js.py 会与后端 NODE_CLASS_MAPPINGS 交叉校验
export const HELP_NODES = new Set([
  "AllBuyABCompare",
  "AllBuyGenerate",
  "AllBuyImageComposer",
  "AllBuyImageGrid",
  "AllBuyImageResize",
  "AllBuyImageTitle",
  "AllBuyLoRAStack",
  "AllBuyTextBox",
  "BatchImagePromptSelector",
  "MediaAssetLoader",
  "PromptLibrary",
  "PromptRandomDraw",
  "VideoPromptLibrary",
  "VideoPromptRandomDraw",
]);

const BADGE_RADIUS = 7;
const BADGE_MARGIN = 16;      // 徽章圆心距节点右缘的距离
const TITLE_CENTER_Y = -15;   // litegraph 标题栏高 30px，圆心在其中线上
const MIN_WIDTH_FOR_BADGE = 140;

export function isHelpNode(node) {
  return HELP_NODES.has(node?.constructor?.comfyClass || node?.comfyClass || node?.type);
}

export function badgeCenter(nodeWidth) {
  return [nodeWidth - BADGE_MARGIN, TITLE_CENTER_Y];
}

export function showBadge(nodeWidth, collapsed) {
  return !collapsed && (nodeWidth ?? 0) >= MIN_WIDTH_FOR_BADGE;
}

// 命中区大于可见圆，容差点击（与 v3.94 槽位命中的教训一致，宁可宽不可窄）
export function hitsBadge(pos, nodeWidth) {
  const [cx, cy] = badgeCenter(nodeWidth);
  return pos[0] >= cx - 10 && pos[0] <= cx + 10 && pos[1] >= cy - 11 && pos[1] <= cy + 11;
}

// 从 nodeData（object_info schema）组装卡片分节：说明 → 输入 → 输出。
// node 用于取前端设置的中文槽位标签（如 image_compare 的「图片 A」）。
// image_1~12 这类通用批输入、面板托管的存储字段不进卡片——帮助只讲节点特点。
export function helpSections(nodeData, node) {
  const sections = [];
  if (nodeData?.description) sections.push({ type: "text", text: nodeData.description });
  const inputs = [];
  for (const group of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(nodeData?.input?.[group] ?? {})) {
      if (PLUMBING.has(name) || /^image_\d+$/.test(name)) continue;
      const options = Array.isArray(spec) ? spec[1] : undefined;
      inputs.push({
        name,
        label: inputLabel(name, node),
        tooltip: options && typeof options === "object" ? options.tooltip : undefined,
      });
    }
  }
  if (inputs.length) sections.push({ type: "list", heading: "输入", items: inputs });
  const names = nodeData?.output_name ?? [];
  const tooltips = nodeData?.output_tooltips ?? [];
  const outputs = names.map((name, index) => ({ name, tooltip: tooltips[index] }));
  if (outputs.length) sections.push({ type: "list", heading: "输出", items: outputs });
  return sections;
}

// 前端 DOM 面板托管的存储字段：实现细节而非用户设定，卡片里不展示
const PLUMBING = new Set([
  "素材清单", "映射数据", "库数据", "选中卡片",
  "lora_picker", "stack_json", "edit_json", "original_image", "input_resize", "layout_json",
]);

// 后端 widget 名是代码标识符，卡片统一显示中文名。
// 本表优先于节点槽位 label：翻译插件会把 position 之类机器翻译成「职位」，
// 内置映射保证卡片用词与节点面板一致。
const INPUT_LABELS = {
  model: "模型", positive: "正向条件", negative: "负向条件",
  vae: "VAE", latent: "Latent", source_image: "底图", mask: "遮罩",
  image: "图片", images: "图片",
  seed: "种子", steps: "步数", cfg: "CFG", sampler_name: "采样器",
  scheduler: "调度器", denoise: "重绘幅度", feather: "羽化",
  ckpt_name: "Checkpoint 模型", unet_name: "UNET 模型", gguf_name: "GGUF 模型",
  weight_dtype: "加载精度", gguf_dequant_dtype: "GGUF 反量化精度",
  gguf_patch_dtype: "GGUF LoRA 精度", gguf_patch_on_device: "LoRA 显存计算",
  clip_name: "CLIP 模型", clip_type: "CLIP 类型", vae_name: "VAE 模型",
  mode: "缩放模式", size: "目标边长",
  auto_output: "自动输出", image_a: "图片 A", image_b: "图片 B",
  layout: "排布", fit: "适应方式", columns: "列数", cell_size: "格子边长",
  gap: "间距", padding: "外边距", background: "底色",
  titles: "标题", position: "标题位置", bar_height: "标题栏高",
  opacity: "不透明度", text_color: "文字颜色", font_size: "字号",
  align: "对齐", output_size: "输出尺寸", font_name: "字体",
  stroke_width: "描边粗细", stroke_color: "描边颜色",
  shadow_opacity: "阴影浓度", shadow_color: "阴影颜色",
  shadow_offset_x: "阴影横移", shadow_offset_y: "阴影纵移",
  shadow_blur: "阴影模糊", corner_radius: "圆角", bar_width: "标题栏宽",
  suffix_mode: "编号后缀",
};

function inputLabel(name, node) {
  if (INPUT_LABELS[name]) return INPUT_LABELS[name];
  const slot = (node?.inputs || []).find((inp) => inp?.name === name && inp.label);
  return slot ? slot.label : name;
}

let openCard = null; // 当前打开的卡片元素（全局只保留一张）

export function openHelpCard(node, event) {
  if (typeof document === "undefined") return null; // node 测试 / 无 DOM 环境
  if (openCard) {
    const sameNode = openCard._allbuyNode === node;
    closeHelpCard();
    if (sameNode) return null; // 再点同节点徽章 = 关闭
  }
  const nodeData = node?.constructor?.nodeData;
  const sections = helpSections(nodeData, node);
  const card = document.createElement("div");
  card._allbuyNode = node;
  card.style.cssText = [
    "position:fixed", "z-index:99999", "width:min(500px,calc(100vw - 24px))",
    "max-height:76vh", "overflow:auto", "padding:14px 16px 14px",
    "border-radius:12px", "background:#211f33",
    "border:1px solid rgba(99,102,241,0.35)",
    "box-shadow:0 12px 32px rgba(0,0,0,0.45)", "color:#e6e4f0",
    "font:13px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif",
    "text-align:left", "cursor:default", "user-select:text",
  ].join(";");
  const title = document.createElement("div");
  title.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:4px";
  const name = document.createElement("strong");
  name.textContent = node?.title || nodeData?.display_name || "AllBuy 节点";
  name.style.cssText = "font-size:14px;color:#c7c3ff;flex:1";
  const close = document.createElement("span");
  close.textContent = "×";
  close.style.cssText = "cursor:pointer;color:#8f8aa8;font-size:17px;line-height:1;padding:0 2px";
  close.onclick = () => closeHelpCard();
  title.append(name, close);
  card.appendChild(title);
  let first = true;
  for (const section of sections) {
    if (section.type === "text") {
      const p = document.createElement("div");
      p.textContent = section.text;
      p.style.cssText = "white-space:pre-wrap;margin:8px 0 2px;padding:6px 10px;"
        + "background:rgba(99,102,241,0.10);border-left:3px solid rgba(99,102,241,0.55);"
        + "border-radius:0 6px 6px 0";
      card.appendChild(p);
    } else if (section.items.length) {
      const h = document.createElement("div");
      h.textContent = section.heading;
      h.style.cssText = "font-weight:600;font-size:12px;letter-spacing:1px;color:#8f8aa8;"
        + (first ? "margin:6px 0 6px" : "margin:12px 0 6px;padding-top:10px;"
           + "border-top:1px solid rgba(99,102,241,0.18)");
      first = false;
      card.appendChild(h);
      card.appendChild(buildItems(section.items));
    }
  }
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.textContent = "该节点暂无说明。";
    empty.style.cssText = "color:#8f8aa8";
    card.appendChild(empty);
  }
  // 定位：优先贴着点击点，向左/向上收拢并夹在视口内
  const x = Math.max(12, Math.min(event?.clientX ?? 80, window.innerWidth - 452));
  const y = Math.max(12, Math.min(event?.clientY ?? 80, window.innerHeight - 160));
  card.style.left = x + "px";
  card.style.top = y + "px";
  document.body.appendChild(card);
  openCard = card;
  // 点击卡片外 / Esc 关闭。监听器是具名的，随卡片关闭一并移除；
  // 点卡片本身不消耗监听，之后任意一次点击外部仍会关闭（不能用 once）
  const onDown = (ev) => { if (!card.contains(ev.target)) closeHelpCard(); };
  const onKey = (ev) => { if (ev.key === "Escape") closeHelpCard(); };
  openCardCleanup = { card, onDown, onKey };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  return card;
}

let openCardCleanup = null;

function closeHelpCard() {
  if (!openCardCleanup) return;
  const { card, onDown, onKey } = openCardCleanup;
  document.removeEventListener("pointerdown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
  openCardCleanup = null;
  openCard = null;
  card.remove();
}

// 名词条：code 元素 + font:inherit，避免 CJK 名词落入等宽字体显得松散
function termChip(name) {
  const term = document.createElement("code");
  term.textContent = name;
  term.style.cssText = "background:rgba(99,102,241,0.16);"
    + "border:1px solid rgba(99,102,241,0.25);border-radius:5px;"
    + "padding:1px 7px;color:#c7c3ff;font:inherit;white-space:nowrap";
  return term;
}

// 一个分节的条目排版：
// - 整节都有说明 → 两列网格，名词列对齐、说明列占余宽；
// - 整节都无说明 → 名词排成可换行的胶囊流，不再逐行占位。
function buildItems(items) {
  const box = document.createElement("div");
  if (!items.some((item) => item.tooltip)) {
    box.style.cssText = "display:flex;flex-wrap:wrap;gap:4px";
    for (const item of items) box.appendChild(termChip(item.label || item.name));
    return box;
  }
  box.style.cssText = "display:grid;grid-template-columns:max-content 1fr;"
    + "column-gap:12px;row-gap:4px;align-items:baseline";
  for (const item of items) {
    box.appendChild(termChip(item.label || item.name));
    const detail = document.createElement("span");
    detail.textContent = item.tooltip || "";
    detail.style.cssText = "color:#b6b3c9;min-width:0";
    box.appendChild(detail);
  }
  return box;
}

function chainAfter(obj, name, fn) {
  const original = obj[name];
  obj[name] = function (...args) {
    const result = original?.apply(this, args);
    fn.apply(this, args);
    return result;
  };
}

// 徽章命中要抢在原有 onMouseDown（开始拖拽 / custom widget 交互）之前；
// 未命中则原样委托，行为与未装徽章完全一致
function chainMouseBefore(node) {
  const original = node.onMouseDown;
  node.onMouseDown = function (event, pos) {
    if (showBadge(this.size?.[0], this.flags?.collapsed) && pos && hitsBadge(pos, this.size[0])) {
      openHelpCard(this, event);
      return true; // 消费点击，避免触发展开 / 拖拽
    }
    return original?.apply(this, arguments) ?? false;
  };
}

app.registerExtension({
  name: "AllBuy.HelpBadge",
  nodeCreated(node) {
    if (!isHelpNode(node)) return;
    chainAfter(node, "onDrawForeground", function (ctx) {
      if (!showBadge(this.size?.[0], this.flags?.collapsed)) return;
      const [x, y] = badgeCenter(this.size[0]);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, BADGE_RADIUS, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(99,102,241,0.55)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = "rgba(99,102,241,0.8)";
      ctx.font = "bold 9px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("?", x, y + 0.5);
      ctx.restore();
    });
    chainMouseBefore(node);
  },
});
