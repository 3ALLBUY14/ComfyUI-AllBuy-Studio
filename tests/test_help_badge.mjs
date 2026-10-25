// help_badge.js 纯逻辑测试：几何、卡片组装、命中、鼠标拦截与委托。
// 运行：node tests/test_help_badge.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let extension;
globalThis.__abTestApp = {
  registerExtension(ext) { extension = ext; },
};
const source = readFileSync(new URL("../web/help_badge.js", import.meta.url), "utf8")
  .replace('import { app } from "../../scripts/app.js";', 'const app = globalThis.__abTestApp;');
const mod = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
const { HELP_NODES, badgeCenter, showBadge, hitsBadge, helpSections, isHelpNode, openHelpCard } = mod;

// --- 几何与显隐 ---
assert.deepEqual(badgeCenter(300), [284, -15]);
assert.equal(showBadge(300, false), true);
assert.equal(showBadge(139, false), false, "过窄节点不显示徽章");
assert.equal(showBadge(300, true), false, "折叠节点不显示徽章");
assert.equal(hitsBadge([284, -15], 300), true, "圆心命中");
assert.equal(hitsBadge([292, -15], 300), true, "右缘容差命中");
assert.equal(hitsBadge([268, -15], 300), false, "左侧过远不命中");

// --- 帮助卡片内容组装 ---
const nodeData = {
  description: "示例说明",
  input: {
    required: { seed: ["INT", { default: 0, tooltip: "随机种子" }], model: ["MODEL"] },
    optional: { negative: ["CONDITIONING", { tooltip: "负向提示词" }] },
  },
  output_name: ["原图", "图片"],
  output_tooltips: ["输入原图", "最终结果"],
};
const sections = helpSections(nodeData);
assert.equal(sections[0].type, "text");
assert.equal(sections[0].text, "示例说明");
const inputs = sections.find((s) => s.heading === "输入").items;
assert.equal(inputs.length, 3);
assert.equal(inputs[0].tooltip, "随机种子", "从 [type, options] 提取 tooltip");
assert.equal(inputs[0].label, "种子", "英文 widget 名映射为中文");
assert.equal(inputs[1].tooltip, undefined, "纯连接型输入无 tooltip");
assert.equal(inputs[1].label, "模型");
assert.equal(inputs[2].tooltip, "负向提示词", "optional 组也被收集");
assert.equal(inputs[2].label, "负向条件");
const outputs = sections.find((s) => s.heading === "输出").items;
assert.deepEqual(outputs, [
  { name: "原图", tooltip: "输入原图" },
  { name: "图片", tooltip: "最终结果" },
]);
assert.deepEqual(helpSections(undefined), [], "空 nodeData 返回空分节");
assert.deepEqual(helpSections({}), []);

// --- 过滤与标签优先级 ---
const filtered = helpSections({
  input: {
    required: {
      image_1: ["IMAGE"], image_12: ["IMAGE"],
      素材清单: ["STRING", {}], stack_json: ["STRING", {}],
      真设定: ["STRING", { tooltip: "有意义的设定" }],
    },
    optional: {},
  },
});
const kept = filtered.find((s) => s.heading === "输入").items;
assert.deepEqual(kept.map((it) => it.name), ["真设定"],
  "image_N 与面板托管字段被过滤，只留有意义的设定");
const labeled = helpSections(
  {
    input: { optional: { image_a: ["IMAGE"], 模型类型: ["COMBO", {}] } },
  },
  { inputs: [{ name: "模型类型", label: "面板中文标签" }, { name: "image_a", label: "节点标签" }] },
);
const items = labeled.find((s) => s.heading === "输入").items;
assert.equal(items[0].label, "图片 A", "image_a 映射为中文（image_N 精确匹配，不带序号不隐藏）");
assert.equal(items[1].label, "面板中文标签",
  "中文名不在映射表里，回落到节点槽位 label（下方 clip_name 用例验证映射优先）");
const unlabeled = helpSections(
  { input: { optional: { clip_name: ["COMBO", {}] } } },
  { inputs: [{ name: "clip_name", label: "职位" }] },
);
assert.equal(unlabeled.find((s) => s.heading === "输入").items[0].label, "CLIP 模型",
  "没有内置映射的名字才回落到节点槽位 label");
const raw = helpSections({ input: { optional: { 真设定: ["STRING", {}] } } }, {});
assert.equal(raw.find((s) => s.heading === "输入").items[0].label, "真设定",
  "两者都没有时用原名");

// --- 节点识别与扩展挂点 ---
assert.equal(isHelpNode({ type: "AllBuyGenerate" }), true);
assert.equal(isHelpNode({ constructor: { comfyClass: "MediaAssetLoader" } }), true);
assert.equal(isHelpNode({ type: "KSampler" }), false);
const fakeNode = {
  type: "AllBuyGenerate",
  size: [300, 200],
  flags: {},
  onDrawForeground() { this._drew = true; },
  onMouseDown() { this._original = true; return "original"; },
};
extension.nodeCreated(fakeNode);
assert.notEqual(fakeNode.onMouseDown, undefined, "挂点后鼠标处理器被链式包装");

// 命中徽章：消费点击并打开卡片（无 DOM 环境下 openHelpCard 返回 null）
assert.equal(fakeNode.onMouseDown({}, [284, -15]), true);
assert.equal(openHelpCard(fakeNode, null), null, "无 document 时安全返回");

// 未命中：原样委托给原处理器（含返回值与参数）
const node2 = {
  type: "AllBuyGenerate", size: [300, 200], flags: {},
  onMouseDown(event, pos) { this._got = [event, pos]; return "orig"; },
};
extension.nodeCreated(node2);
assert.equal(node2.onMouseDown("ev", [10, 10]), "orig");
assert.deepEqual(node2._got, ["ev", [10, 10]], "未命中时收到原始参数");
assert.equal(node2.onMouseDown("ev", [284, -15]), true, "命中时消费点击");

// 非 AllBuy 节点不被触碰
const outsider = { type: "KSampler", size: [300, 200], flags: {} };
extension.nodeCreated(outsider);
assert.equal(outsider.onMouseDown, undefined);

// 绘制挂点：原处理器先执行，徽章随后绘制且不吞返回值
const node3 = { type: "AllBuyGenerate", size: [300, 200], flags: {}, onDrawForeground() { this._drew = true; } };
extension.nodeCreated(node3);
node3.onDrawForeground({ save() {}, beginPath() {}, arc() {}, stroke() {}, fill() {}, fillText() {}, restore() {} });
assert.equal(node3._drew, true, "原绘制处理器仍被执行");

console.log("test_help_badge: 全部断言通过");
