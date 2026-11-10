import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/prompt_hover.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source.replace(/^export /gm, ""), context);
const fields = value => JSON.parse(JSON.stringify(context.promptInfoFields(value)));
assert.deepEqual(fields({ name: "Only title", weight: 1 }), [], "Empty/default fields must not appear");
const group = { id: "private", name: "说明卡", color: "#123456", note: "自己写的说明\n第二行",
  categories: ["人物", "镜头"], tags: ["自用"], positive: "原样 {a|b} <script>hello</script>", negative: "noise",
  prefix: "before", suffix: "after", weight: 0, cover: "image.png" };
const before = structuredClone(group);
assert.deepEqual(fields(group), [["备注", group.note], ["分类", "人物 / 镜头"], ["标签", "自用"],
  ["正向提示词", group.positive], ["负向提示词", "noise"], ["前缀", "before"], ["后缀", "after"], ["权重", "0"]]);
assert.deepEqual(group, before, "Hovering must not change saved data or expand wildcards");
assert.deepEqual(fields({ category: "旧分类", categories: [], note: "  ", positive: "", weight: "bad" }), [["分类", "旧分类"]]);
assert.deepEqual(fields({ negative: "只写负向", weight: undefined }), [["负向提示词", "只写负向"]]);
assert.deepEqual(fields({ categories: ["", "  "], tags: [null, ""], weight: false }), []);
console.log("Prompt hover uses filled editor fields, preserves raw content and omits empty/default fields");
