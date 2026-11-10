import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assetA = "a".repeat(64) + ".png", assetB = "b".repeat(64) + ".png";
const template = {
  "1": { class_type: "LoadImage", inputs: { image: "old.png" } },
  "10": { class_type: "TextEncodeQwenImage21", inputs: {
    clip: ["2", 1], vae: ["2", 2], prompt: "edit", negative_prompt: "negative", resolution: 1024,
    "images.image_1": ["1", 0], "images.image_2": ["3", 0],
  } },
  "20": { class_type: "AllBuyGenerate", inputs: { positive: ["10", 0], negative: ["10", 1],
    edit_json: JSON.stringify({ enabled: true, source: assetA }) } },
  "21": { class_type: "AllBuyGenerate", inputs: { positive: ["10", 0], edit_json: "{}" } },
  "22": { class_type: "AllBuyGenerate", inputs: { positive: ["10", 0], negative: ["10", 1],
    edit_json: JSON.stringify({ enabled: true, source: assetB, mask: assetA }) } },
};
globalThis.__allbuyTestApp = { graph: { _nodes: [] }, graphToPrompt: async () => ({ output: structuredClone(template), workflow: { nodes: [] } }) };
const source = readFileSync(new URL("../web/generate_prompt.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/, "const app = globalThis.__allbuyTestApp;\n");
const { applyGenerateReferences, installGeneratePromptHook } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const output = applyGenerateReferences(structuredClone(template));
assert.deepEqual(output["10"], template["10"], "Shared original encoder must keep its old reference");
assert.deepEqual(output["21"], template["21"], "Normal generation keeps its original conditioning");
for (const [id, asset] of [["20", assetA], ["22", assetB]]) {
  const node = output[id], encoderId = node.inputs.positive[0];
  assert.notEqual(encoderId, "10");
  assert.deepEqual(node.inputs.negative, [encoderId, 1]);
  const encoder = output[encoderId], input = output[encoder.inputs["images.image_1"][0]];
  assert.equal(input.class_type, "LoadImage");
  assert.equal(input.inputs.image, `allbuy_media/${asset}`);
  assert.equal(encoder.inputs.resolution, 0);
  assert.deepEqual(encoder.inputs["images.image_2"], ["3", 0]);
  assert.deepEqual(encoder.inputs.clip, template["10"].inputs.clip);
  assert.equal(encoder.inputs.prompt, "edit");
  assert.equal(JSON.parse(node.inputs.edit_json).reference_encoding, "qwen_image21");
}
assert.notEqual(output["20"].inputs.positive[0], output["22"].inputs.positive[0], "Each generation gets its own encoder");
const generic = structuredClone(template);
generic["10"].class_type = "CLIPTextEncode";
assert.deepEqual(applyGenerateReferences(structuredClone(generic)), generic, "Generic models are unaffected");
const feedback = structuredClone(template);
feedback["20"].inputs.original_image = assetB;
feedback["10"].inputs["images.image_1"] = ["20", 0];
feedback["30"] = { class_type: "PreviewImage", inputs: { images: ["20", 0] } };
feedback["31"] = { class_type: "PreviewImage", inputs: { images: ["20", 1] } };
const independent = applyGenerateReferences(feedback);
const originalId = independent["30"].inputs.images[0];
assert.notEqual(originalId, "20", "Original-image consumers bypass the sampler");
assert.equal(independent[originalId].inputs.image, `allbuy_media/${assetB}`);
assert.deepEqual(independent["10"].inputs["images.image_1"], [originalId, 0], "Feedback into an upstream encoder must not form a cycle");
assert.deepEqual(independent["31"].inputs.images, ["20", 1], "Generated-image consumers keep the generated output");
const normalOriginal = { "1": {class_type:"AllBuyGenerate",inputs:{edit_json:"{}",original_image:assetA}}, "2": {class_type:"PreviewImage",inputs:{images:["1",0]}} };
const normalRouted = applyGenerateReferences(normalOriginal);
assert.equal(normalRouted[normalRouted["2"].inputs.images[0]].inputs.image, `allbuy_media/${assetA}`);
assert.throws(() => applyGenerateReferences({"1":{class_type:"AllBuyGenerate",inputs:{edit_json:"{}"}},"2":{class_type:"PreviewImage",inputs:{images:["1",0]}}}), /请先导入底图/);
for (const mode of ["longest", "shortest"]) {
  const normal = structuredClone(template);
  normal["21"].inputs.input_resize = JSON.stringify({mode, size:1536});
  normal["21"].inputs.negative = ["10", 1];
  normal["21"].inputs.latent = ["old-latent-switch", 0];
  const scaled = applyGenerateReferences(normal);
  const node = scaled["21"], encoderId = node.inputs.positive[0], encoder = scaled[encoderId];
  assert.notEqual(encoderId, "10");
  assert.deepEqual(node.inputs.negative, [encoderId, 1]);
  assert.deepEqual(node.inputs.latent, ["old-latent-switch", 0], "Custom canvas must survive reference resizing");
  const resizeNode = scaled[encoder.inputs["images.image_1"][0]];
  assert.deepEqual(resizeNode, {class_type:"AllBuyImageResize",inputs:{image:["1",0],mode,size:1536}});
  assert.equal(encoder.inputs.resolution, 0);
  assert.deepEqual(encoder.inputs["images.image_2"], ["3", 0]);
  assert.deepEqual(scaled["10"], template["10"], "Other branches keep the original image and resolution");
}
for (const input of [undefined, ["10", 2]]) {
  const automatic = structuredClone(template);
  automatic["21"].inputs.input_resize = '{"mode":"longest","size":1536}';
  if (input) automatic["21"].inputs.latent = input;
  const result = applyGenerateReferences(automatic), node = result["21"];
  assert.deepEqual(node.inputs.latent, [node.inputs.positive[0], 2], "Only Qwen's automatic canvas tracks the resized reference");
}
for (const selected of [false, true]) {
  const switched = structuredClone(template);
  switched["30"] = {class_type:"ComfySwitchNode",inputs:{switch:selected,on_false:["10",2],on_true:["40",0]}};
  switched["40"] = {class_type:"EmptyLatentImage",inputs:{width:1536,height:864,batch_size:2}};
  Object.assign(switched["21"].inputs,{source_image:["1",0],latent:["30",0],input_resize:'{"mode":"longest","size":1024}'});
  const result = applyGenerateReferences(switched);
  assert.deepEqual(result["21"].inputs.latent,["30",0]);
  assert.deepEqual(result["30"],switched["30"]);
  assert.deepEqual(result["40"].inputs,{width:1536,height:864,batch_size:2});
}
const connected = structuredClone(template);
connected["21"].inputs.source_image = ["connected-image",0];
connected["21"].inputs.latent = ["old-latent",0];
connected["21"].inputs.input_resize = '{"mode":"longest","size":1024}';
const connectedResult = applyGenerateReferences(connected);
const connectedEncoder = connectedResult[connectedResult["21"].inputs.positive[0]];
assert.deepEqual(connectedResult[connectedEncoder.inputs["images.image_1"][0]].inputs.image, ["connected-image",0]);
assert.deepEqual(connectedResult["21"].inputs.latent, ["old-latent",0], "A direct source image is encoded by the generator");
const textOnly = {"10":{class_type:"TextEncodeQwenImage21",inputs:{prompt:"text"}},
  "20":{class_type:"AllBuyGenerate",inputs:{positive:["10",0],latent:["empty",0],input_resize:'{"mode":"longest","size":1024}'}}};
assert.deepEqual(applyGenerateReferences(structuredClone(textOnly)), textOnly, "Pure text generation has no image to resize");
const nested = structuredClone(textOnly);
nested["10"].inputs.images = {image_1:["source",0],image_2:["second",0]};
const nestedResult = applyGenerateReferences(nested);
const nestedEncoder = nestedResult[nestedResult["20"].inputs.positive[0]];
assert.deepEqual(nestedResult[nestedEncoder.inputs.images.image_1[0]].inputs.image, ["source",0]);
assert.deepEqual(nestedEncoder.inputs.images.image_2, ["second",0]);
installGeneratePromptHook();
const hook = __allbuyTestApp.graphToPrompt;
installGeneratePromptHook(); assert.equal(__allbuyTestApp.graphToPrompt, hook);
const queued = await __allbuyTestApp.graphToPrompt();
assert.notEqual(queued.output["20"].inputs.positive[0], "10");
assert.deepEqual(queued.workflow, { nodes: [] });
__allbuyTestApp.graph._nodes.push({ _aitImportBusy: true });
await assert.rejects(() => __allbuyTestApp.graphToPrompt(), /图片正在导入/);
console.log("Qwen imported reference routing and queue hook checks passed");
