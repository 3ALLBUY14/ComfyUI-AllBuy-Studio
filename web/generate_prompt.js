import { app } from "./image_tools_ui.js";

// Clone reference encoders for this generation only. Other branches keep their
// original references, and the saved canvas connections remain unchanged.
export function applyGenerateReferences(output) {
  let nextId = Math.max(0, ...Object.keys(output).map(Number).filter(Number.isFinite)) + 1;
  const allocate = () => { while (String(nextId) in output) nextId++; return String(nextId++); };
  const sources = new Map();
  const loadSource = ref => {
    const source = String(ref || "").replace(/^allbuy_media\//, "");
    if (!/^[a-f0-9]{64}\.[a-z0-9]+$/.test(source)) throw new Error("请先导入底图，再使用「原图」输出");
    if (!sources.has(source)) {
      const id = allocate(); sources.set(source, id);
      output[id] = { class_type: "LoadImage", inputs: { image: `allbuy_media/${source}` } };
    }
    return sources.get(source);
  };
  for (const [id, node] of Object.entries(output)) {
    if (node.class_type !== "AllBuyGenerate") continue;
    let state;
    try { state = JSON.parse(node.inputs?.edit_json || "{}"); } catch { continue; }
    const original = node.inputs.original_image || (state?.enabled ? state.source : null);
    // Read the original output independently, including when wired back into
    // an upstream encoder. The sampler must not become its own dependency.
    const redirect = value => {
      if (Array.isArray(value)) {
        if (value.length === 2 && value[0] === id && value[1] === 0) return [loadSource(original), 0];
        return value.map(redirect);
      }
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redirect(entry)]));
      return value;
    };
    for (const target of Object.values(output)) target.inputs = redirect(target.inputs);
    const imported = Boolean(state?.enabled && state.source);
    const resize = JSON.parse(node.inputs.input_resize || "{}");
    const resizeNormal = !state?.enabled && ["longest", "shortest"].includes(resize?.mode);
    if (!imported && !resizeNormal) continue;
    const source = imported ? String(state.source).replace(/^allbuy_media\//, "") : null;
    if (imported && !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(source)) continue;
    const encoders = new Map();
    const resized = new Map();
    let positiveEncoderId = null;
    for (const input of ["positive", "negative"]) {
      const link = node.inputs[input];
      if (!Array.isArray(link)) continue;
      const original = output[link[0]];
      if (original?.class_type !== "TextEncodeQwenImage21") continue;
      let encoderId = encoders.get(String(link[0]));
      if (!encoderId) {
        let reference = imported ? [loadSource(source), 0] : node.inputs.source_image
          || original.inputs.images?.image_1 || original.inputs["images.image_1"];
        // A text-only Qwen encoder has no image to resize.
        if (!Array.isArray(reference)) continue;
        if (resizeNormal) {
          const key = JSON.stringify(reference);
          if (!resized.has(key)) {
            const resizeId = allocate(); resized.set(key, resizeId);
            output[resizeId] = { class_type: "AllBuyImageResize", inputs: { image: reference, mode: resize.mode, size: resize.size ?? 1024 } };
          }
          reference = [resized.get(key), 0];
        }
        encoderId = allocate();
        const encoder = structuredClone(original);
        // Preserve the selected image size (rounded to Qwen's native 32 px grid).
        encoder.inputs.resolution = 0;
        if (encoder.inputs.images && !Array.isArray(encoder.inputs.images) && typeof encoder.inputs.images === "object") {
          encoder.inputs.images.image_1 = reference;
        } else encoder.inputs["images.image_1"] = reference;
        output[encoderId] = encoder; encoders.set(String(link[0]), encoderId);
      }
      node.inputs[input] = [encoderId, link[1]];
      if (input === "positive") positiveEncoderId = encoderId;
    }
    if (encoders.size) node.inputs.edit_json = JSON.stringify({ ...state, reference_encoding: "qwen_image21" });
    // Native Qwen's third output is an empty latent matched to its first image.
    // Use that canvas when the normal path gets its image through the encoder.
    if (resizeNormal && positiveEncoderId && !node.inputs.source_image) node.inputs.latent = [positiveEncoderId, 2];
  }
  return output;
}

let installed = false;
export function installGeneratePromptHook() {
  if (installed || typeof app.graphToPrompt !== "function") return;
  const original = app.graphToPrompt;
  app.graphToPrompt = async function(...args) {
    const graph = app.rootGraph || app.graph;
    if ((graph?._nodes || []).some(node => node._aitImportBusy)) throw new Error("图片正在导入，请等待预览更新后再运行");
    const result = await original.apply(this, args);
    if (result?.output) applyGenerateReferences(result.output);
    return result;
  };
  installed = true;
}
