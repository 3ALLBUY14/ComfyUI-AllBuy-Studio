"""MOSS layout drafts, normalization and the AllBuy workflow node.

Adapted from LinXce/Comfyui-Moss-LayoutPrompt layout.py (Apache-2.0),
commit 326ad58e3e5055cc59b90fe5b5d2bcddf3698a4d. Modified for AllBuy:
one import/preview/execution path, bounded input, compiled-prompt import and
an independent node ID. Attribution and license: third_party/moss-layout/.
"""
from __future__ import annotations

import copy
import json
import math

MAX_EDGE = 4096
MAX_ITEMS = 200
MAX_TEXT = 2 * 1024 * 1024
LABELS = {"object", "character", "text"}
SUMMARY_FIELDS = {"caption", "meta", "canvas", "palette"}
ITEM_FIELDS = {"label", "caption", "bbox", "text", "tags", "palette", "color"}
ROOT_FIELDS = {"width", "height", "bbox_coord_space", "bbox_format", "summary", "items"}


def blank_layout(width=1024, height=1024):
    return {"width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
            "summary": {"caption": "", "canvas": "single"}, "items": []}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _object(value):
    return isinstance(value, dict)


def _layout_shape(value):
    return _object(value) and any(key in value for key in ("summary", "items", "elements"))


def _read_json(raw):
    """Unwrap JSON strings/envelopes and find a layout in pasted prose."""
    if _object(raw):
        require(len(json.dumps(raw, ensure_ascii=False).encode("utf-8")) <= MAX_TEXT, "布局内容过大（最多 2 MB）")
        candidates = [raw]
    else:
        require(isinstance(raw, str) and len(raw.encode("utf-8")) <= MAX_TEXT, "布局须为 JSON，且不超过 2 MB")
        candidates = [raw]
    decoder = json.JSONDecoder()
    for _ in range(5):
        next_candidates = []
        for value in candidates:
            if _layout_shape(value):
                return copy.deepcopy(value)
            if _object(value):
                next_candidates.extend(value[key] for key in ("layout", "draft", "source") if key in value)
            elif isinstance(value, str):
                try:
                    parsed = json.loads(value)
                except (ValueError, RecursionError):
                    # Repair illegal escaped parentheses often pasted from prompt tools.
                    repaired, index = [], 0
                    while index < len(value):
                        if value[index] == "\\" and index + 1 < len(value):
                            repaired.append(("\\\\" if value[index + 1] in "()" else "\\") + value[index + 1])
                            index += 2
                        else:
                            repaired.append(value[index]); index += 1
                    value = "".join(repaired)
                    # A fenced JSON block or prose is accepted; never evaluate pasted code.
                    attempts = 0
                    for index, char in enumerate(value):
                        if char != "{":
                            continue
                        attempts += 1
                        if attempts > 64:
                            break
                        try:
                            parsed, _ = decoder.raw_decode(value[index:])
                        except (ValueError, RecursionError):
                            continue
                        if _layout_shape(parsed):
                            return copy.deepcopy(parsed)
                        if _object(parsed) and any(key in parsed for key in ("layout", "draft", "source")):
                            next_candidates.append(parsed)
                else:
                    next_candidates.append(parsed)
        candidates = next_candidates
    raise ValueError("未找到有效布局：需要 summary/items 或兼容的 elements 草稿；原布局未更改")


def _dimension(value, name):
    require(type(value) is int and 16 <= value <= MAX_EDGE and value % 16 == 0,
            f"{name}须为 16–{MAX_EDGE} 之间的 16 的整数倍")
    return value


def _strings(value, location):
    require(isinstance(value, list) and len(value) <= MAX_ITEMS and
            all(isinstance(item, str) and item.strip() for item in value), f"{location}须为非空文本列表")


def normalize_layout(raw, width=1024, height=1024):
    draft = _read_json(raw)
    width = _dimension(draft.get("width", width), "宽度")
    height = _dimension(draft.get("height", height), "高度")
    if "elements" in draft:
        # Legacy scene drafts use centered yxyx unless explicitly marked abs/xyxy.
        elements = draft["elements"]
        require(isinstance(elements, list) and len(elements) <= MAX_ITEMS, "elements 须为不超过 200 项的列表")
        items = []
        for element in elements:
            require(_object(element), "每个 elements 元素须为对象")
            label = {"person": "character", "character": "character", "text": "text"}.get(str(element.get("type", "")), "object")
            caption = " ".join(element[key].strip() for key in ("identity", "shape", "note")
                               if isinstance(element.get(key), str) and element[key].strip())
            item = {"label": label, "caption": caption, "bbox": element.get("bbox")}
            if label == "text":
                item["text"] = element.get("text") or element.get("identity") or ""
            items.append(item)
        caption = ". ".join(draft[key] for key in ("scene_type", "gen_brief") if isinstance(draft.get(key), str))
        restrictions = draft.get("must_not", [])
        restrictions = [restrictions] if isinstance(restrictions, str) else restrictions
        if isinstance(restrictions, list):
            avoid = "; ".join(x for x in restrictions if isinstance(x, str) and x.strip())
            if avoid:
                caption += " Avoid: " + avoid
        summary = {"caption": caption}
        if "palette" in draft:
            summary["palette"] = draft["palette"]
        draft = {**blank_layout(width, height), "summary": summary, "items": items,
                 "bbox_coord_space": draft.get("bbox_coord_space", "abs_centralized"),
                 "bbox_format": draft.get("bbox_format", "xyxy" if draft.get("bbox_coord_space") == "abs" else "yxyx")}
    require(not set(draft) - ROOT_FIELDS, "布局包含未知字段：" + ", ".join(sorted(set(draft) - ROOT_FIELDS)))
    space, fmt = draft.get("bbox_coord_space", "abs"), draft.get("bbox_format", "xyxy")
    require((space, fmt) in (("abs", "xyxy"), ("abs_centralized", "yxyx")), "不支持的坐标格式")
    summary, items = draft.get("summary"), draft.get("items", [])
    require(_object(summary) and not set(summary) - SUMMARY_FIELDS, "summary 字段无效")
    require(isinstance(summary.get("caption"), str), "整体描述须为文本")
    require(summary.get("canvas", "single") in ("single", "multi_panel", "collage"), "画布类型无效")
    for key in ("meta", "palette"):
        if key in summary:
            _strings(summary[key], "summary." + key)
    require(isinstance(items, list) and len(items) <= MAX_ITEMS, "最多支持 200 个布局元素")
    clean_items = []
    for index, item in enumerate(items):
        location = f"第 {index + 1} 个元素"
        require(_object(item) and not set(item) - ITEM_FIELDS, location + "包含未知字段")
        require(isinstance(item.get("label"), str) and item["label"] in LABELS, location + "类型须为物体、角色或文字")
        require(isinstance(item.get("caption"), str), location + "描述须为文本")
        if item["label"] == "text" or "text" in item:
            require(isinstance(item.get("text"), str) and item["text"].strip(), location + "的文字内容不能为空")
        for key in ("tags", "palette"):
            if key in item:
                _strings(item[key], location + "." + key)
        box = item.get("bbox")
        require(isinstance(box, list) and len(box) == 4 and
                all(type(n) in (int, float) and math.isfinite(n) for n in box), location + "坐标须为四个有限数值")
        if space == "abs_centralized":
            y1, x1, y2, x2 = box
            box = [x1 + width // 2, y1 + height // 2, x2 + width // 2, y2 + height // 2]
        x1, y1, x2, y2 = box
        require(0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height,
                location + f"越出 {width} × {height} 画布或宽高无效，请调整尺寸或坐标")
        clean_items.append({**{key: value for key, value in item.items() if key != "color"}, "bbox": box})
    return {"width": width, "height": height, "bbox_coord_space": "abs", "bbox_format": "xyxy",
            "summary": summary, "items": clean_items}


def compile_layout(raw, width=1024, height=1024, *, override_width=None, override_height=None):
    draft = normalize_layout(raw, width, height)
    if override_width is not None or override_height is not None:
        target_width = _dimension(override_width, "外部宽度") if override_width is not None else draft["width"]
        target_height = _dimension(override_height, "外部高度") if override_height is not None else draft["height"]
        for item in draft["items"]:
            item["bbox"] = [edge * (target_height / draft["height"] if i % 2 else target_width / draft["width"])
                            for i, edge in enumerate(item["bbox"])]
        draft["width"], draft["height"] = target_width, target_height
    width, height = draft["width"], draft["height"]
    items = []
    for item in draft["items"]:
        x1, y1, x2, y2 = item["bbox"]
        box = [math.floor(round(y1, 9)) - height // 2, math.floor(round(x1, 9)) - width // 2,
               math.ceil(round(y2, 9)) - height // 2, math.ceil(round(x2, 9)) - width // 2]
        require(box[0] < box[2] and box[1] < box[3], "元素在像素精度下过小，请放大方框")
        items.append({**item, "bbox": box})
    prompt = json.dumps({"summary": draft["summary"], "items": items,
                         "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"},
                        ensure_ascii=False, separators=(",", ":"), allow_nan=False) if items else draft["summary"]["caption"].strip()
    return {"draft": draft, "prompt": prompt, "width": width, "height": height}


class AllBuyMossLayoutPrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"layout_json": ("STRING", {"default": json.dumps(blank_layout()), "multiline": True,
                                                         "tooltip": "工作台管理的布局草稿，随工作流保存；也可直接传入标准布局 JSON"})},
                "optional": {
                    "width": ("INT", {"default": 1024, "min": 16, "max": MAX_EDGE, "step": 16, "forceInput": True,
                                      "tooltip": "外部宽度优先覆盖工作台宽度，布局框同步缩放；不连接时使用工作台尺寸"}),
                    "height": ("INT", {"default": 1024, "min": 16, "max": MAX_EDGE, "step": 16, "forceInput": True,
                                       "tooltip": "外部高度优先覆盖工作台高度，布局框同步缩放；不连接时使用工作台尺寸"})}}

    RETURN_TYPES = ("STRING", "INT", "INT", "STRING")
    RETURN_NAMES = ("提示词", "宽度", "高度", "布局草稿")
    OUTPUT_TOOLTIPS = ("接 MOSS 正向文本编码；框线仅表示位置，不会画进生成图", "接 Latent 宽度", "接 Latent 高度",
                       "含画布尺寸的标准草稿，可导出或重新导入编辑")
    FUNCTION = "execute"
    CATEGORY = "AllBuy/图像工具"
    DESCRIPTION = "可视化编排文字、物体与角色，输出 MOSS-Image 布局提示词和尺寸。参考底图仅供编辑对照，不作为模型输入。"
    SEARCH_ALIASES = ["MOSS", "布局", "海报", "layout", "构图"]

    def execute(self, layout_json, width=None, height=None):
        result = compile_layout(layout_json, override_width=width, override_height=height)
        outputs = (result["prompt"], result["width"], result["height"], json.dumps(result["draft"], ensure_ascii=False))
        if width is not None or height is not None:
            return {"ui": {"allbuy_moss_dimensions": [result["width"], result["height"]]}, "result": outputs}
        return outputs


NODE_CLASS_MAPPINGS = {"AllBuyMossLayoutPrompt": AllBuyMossLayoutPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {"AllBuyMossLayoutPrompt": "AllBuy-布局提示词（MOSS）"}
