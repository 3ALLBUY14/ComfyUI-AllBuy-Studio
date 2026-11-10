// Editor geometry is expressed in top-left pixels; the Python compiler owns export.
export const LABELS = { object: "物体", character: "角色", text: "文字" };
export const blankLayout = () => ({ width: 1024, height: 1024, bbox_coord_space: "abs", bbox_format: "xyxy", summary: { caption: "", canvas: "single" }, items: [] });
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
// OpenMOSS gradio_presets.py uses these pixel budgets and rounds each side to 16.
export const PIXEL_PRESETS = [[1048576, "1M · 推荐"], [1572864, "1.5M · 推荐"], [2097152, "2M · 推荐"], [262144, "0.25M · 轻量"], [4194304, "4M · 扩展"]];
export const ASPECT_PRESETS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"];
export function presetSize(pixels, aspect) {
  const [w, h] = aspect.split(":").map(Number), ratio = w / h;
  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(ratio) || ratio <= 0) throw new Error("分辨率档位或画布比例无效");
  return [Math.sqrt(pixels * ratio), Math.sqrt(pixels / ratio)].map(edge => Math.max(16, Math.floor(edge / 16 + .5) * 16));
}
export function sizePreset(width, height) {
  for (const [pixels] of PIXEL_PRESETS) for (const aspect of ASPECT_PRESETS) {
    const [w, h] = presetSize(pixels, aspect);
    if (w === width && h === height) return { pixels: String(pixels), aspect };
  }
  return { pixels: String(PIXEL_PRESETS.find(([pixels]) => Math.abs(width * height / pixels - 1) < .025)?.[0] || "custom"), aspect: ASPECT_PRESETS.find(aspect => {
    const [w, h] = aspect.split(":").map(Number); return Math.abs(w / h - width / height) < .001;
  }) || "custom" };
}
export const mpLabel = (width, height) => `${(width * height / 1000000).toFixed(2)} MP`;

export function resolutionInputs(node, fallbackGraph) {
  const graph = node.graph || fallbackGraph, connected = {}, resolved = {}, pending = [], cached = [], keys = [];
  for (const name of ["width", "height"]) {
    const input = node.inputs?.find(input => input.name === name);
    if (input?.link == null) continue;
    connected[name] = true;
    const link = graph?.links?.get?.(input.link) || graph?.links?.[input.link];
    const source = graph?.getNodeById?.(link?.origin_id);
    const output = source?.outputs?.[link?.origin_slot];
    const sourceKey = JSON.stringify([input.link, link?.origin_id, link?.origin_slot, source?.widgets?.map(w => [w.name, w.value]), source?.inputs?.map(input => [input.name, input.link])]);
    keys.push([name, sourceKey]);
    // Read named output widgets and primitive integers; dynamic outputs wait for execution.
    const widgetName = output?.widget?.name || output?.name;
    let widget = source?.widgets?.find(w => w.name === widgetName);
    if (!widget && ["INT", "PrimitiveNode", "PrimitiveInt"].includes(source?.comfyClass || source?.type)) widget = source.widgets?.find(w => w.name === "value");
    const converted = source?.inputs?.find(input => input.name === widget?.name && input.link != null);
    if (widget && !converted && typeof widget.value === "number" && Number.isInteger(widget.value) && widget.value >= 16 && widget.value <= 4096 && widget.value % 16 === 0) resolved[name] = widget.value;
    else pending.push(name);
  }
  const key = JSON.stringify(keys), previous = node.properties?.allbuyMossResolution;
  if (previous?.key === key) for (const name of [...pending]) {
    if (Number.isInteger(previous[name]) && previous[name] >= 16 && previous[name] <= 4096 && previous[name] % 16 === 0) { resolved[name] = previous[name]; cached.push(name); pending.splice(pending.indexOf(name), 1); }
  }
  return { ...resolved, connected, pending, cached, key };
}
export function newItem(draft, label = "object") {
  const w = Math.round(draft.width * .38), h = Math.round(draft.height * (label === "text" ? .13 : .3));
  const x = Math.min(draft.width - w, Math.round(draft.width * .12) + draft.items.length % 5 * 24);
  const y = Math.min(draft.height - h, Math.round(draft.height * .14) + draft.items.length % 5 * 24);
  return { label, caption: "", ...(label === "text" ? { text: "在这里输入文字" } : {}), bbox: [x, y, x + w, y + h] };
}
export function moveBox(box, dx, dy, width, height, grid = 1) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const x = clamp(Math.round((box[0] + dx) / grid) * grid, 0, width - w);
  const y = clamp(Math.round((box[1] + dy) / grid) * grid, 0, height - h);
  return [x, y, x + w, y + h];
}
export function resizeBox(box, handle, dx, dy, width, height, grid = 1) {
  const next = [...box], snap = v => Math.round(v / grid) * grid;
  if (handle.includes("w")) next[0] = clamp(snap(box[0] + dx), 0, box[2] - 1);
  if (handle.includes("e")) next[2] = clamp(snap(box[2] + dx), box[0] + 1, width);
  if (handle.includes("n")) next[1] = clamp(snap(box[1] + dy), 0, box[3] - 1);
  if (handle.includes("s")) next[3] = clamp(snap(box[3] + dy), box[1] + 1, height);
  return next;
}
export function resizeLayout(draft, width, height, scale) {
  const next = structuredClone(draft);
  if (scale) for (const item of next.items) item.bbox = item.bbox.map((n, i) => n * (i % 2 ? height / draft.height : width / draft.width));
  next.width = width; next.height = height;
  return next;
}
export function editEdge(box, edge, value, width, height) {
  const next = [...box];
  const limit = edge % 2 ? height : width;
  next[edge] = edge < 2 ? clamp(value, 0, next[edge + 2] - 1) : clamp(value, next[edge - 2] + 1, limit);
  return next;
}
export function template(kind) {
  const draft = blankLayout(); draft.height = 1536;
  draft.summary.caption = kind === "poster" ? "A clean editorial travel poster, cream paper, midnight blue mountains, restrained orange accents." : "A contemporary book cover with generous whitespace, bold typography and a single symbolic illustration.";
  draft.summary.meta = [kind === "poster" ? "poster" : "book cover"];
  draft.summary.palette = ["cream", "midnight blue", "muted orange"];
  draft.items = [
    { label: "object", caption: kind === "poster" ? "Layered mountain silhouettes, a small warm sun behind the ridge." : "A solitary tree in a quiet landscape, delicate graphic illustration.", bbox: [112, 400, 912, 1192] },
    { label: "text", caption: "Large expressive title, left aligned, no background panel.", text: kind === "poster" ? "远山\n来信" : "时间的\n形状", bbox: [112, 128, 912, 400] },
    { label: "text", caption: "Small subtitle with spacious letter spacing.", text: kind === "poster" ? "LET THE JOURNEY UNFOLD" : "THE SHAPE OF TIME", bbox: [112, 1280, 912, 1376] },
  ];
  return draft;
}
export class History {
  constructor(value) { this.entries = [JSON.stringify(value)]; this.cursor = 0; }
  push(value) {
    const raw = JSON.stringify(value);
    if (this.entries[this.cursor] === raw) return;
    this.entries.splice(this.cursor + 1); this.entries.push(raw);
    if (this.entries.length > 80) this.entries.shift();
    this.cursor = this.entries.length - 1;
  }
  step(offset) { const next = this.cursor + offset; if (next < 0 || next >= this.entries.length) return null; this.cursor = next; return JSON.parse(this.entries[next]); }
}
