"""AllBuy image tools. Layouts reference durable, shared media assets."""
from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageColor, ImageDraw, ImageFont, ImageOps, ImageFilter


MAX_PIXELS = 32 * 1024 * 1024


def canvas_size(width, height):
    width, height = int(width), int(height)
    if min(width, height) < 1 or max(width, height) > 16384 or width * height > MAX_PIXELS:
        raise ValueError("画布过大：边长上限 16384，总像素上限 3200 万")
    return width, height


def color(value):
    try:
        return ImageColor.getrgb(str(value))[:3]
    except ValueError as exc:
        raise ValueError(f"无效颜色：{value}") from exc


def to_pil(tensor):
    return Image.fromarray((tensor.detach().cpu().float().clamp(0, 1).numpy() * 255).round().astype(np.uint8))


def to_tensor(image):
    return torch.from_numpy(np.asarray(image.convert("RGB"), dtype=np.float32).copy() / 255).unsqueeze(0)


def load_asset(name):
    from . import asset_store
    # Only content-addressed originals are accepted; no arbitrary local paths.
    path = asset_store.resolve(str(name).removeprefix("allbuy_media/"))
    if not path:
        raise ValueError("找不到合成素材，请重新导入图片：" + str(name))
    with Image.open(path) as image:
        canvas_size(*image.size)
        return ImageOps.exif_transpose(image).convert("RGBA")


def preview_result(images, *extra, prompt=None, extra_pnginfo=None):
    from nodes import PreviewImage
    ui = PreviewImage().save_images(images, filename_prefix="AllBuyTools", prompt=prompt,
                                    extra_pnginfo=extra_pnginfo)["ui"]
    # A private UI key prevents ComfyUI adding a second native preview widget.
    return {"ui": {"allbuy_images": ui.get("images", [])}, "result": (images, *extra)}


def finite(value, default=0):
    number = float(value if value is not None else default)
    if not math.isfinite(number):
        raise ValueError("图层参数必须是有限数值")
    return number


def compose_layers(layout):
    project = json.loads(layout) if isinstance(layout, str) else layout
    if not isinstance(project, dict) or not isinstance(project.get("layers", []), list):
        raise ValueError("合成布局格式无效")
    width, height = canvas_size(project.get("width", 1024), project.get("height", 1024))
    canvas = Image.new("RGBA", (width, height), (*color(project.get("background", "#171923")), 255))
    layers = project.get("layers", [])
    if len(layers) > 100:
        raise ValueError("最多支持 100 个图层")
    for layer in layers:
        if not layer.get("visible", True):
            continue
        image = load_asset(layer["asset"])
        if layer.get("flip_x"):
            image = ImageOps.mirror(image)
        if layer.get("flip_y"):
            image = ImageOps.flip(image)
        w = max(1, round(finite(layer.get("width"), image.width)))
        h = max(1, round(finite(layer.get("height"), image.height)))
        canvas_size(w, h)
        image = image.resize((w, h), Image.Resampling.LANCZOS)
        stroke = min(40, max(0, int(finite(layer.get("stroke")))))
        if stroke:
            alpha = image.getchannel("A")
            expanded = ImageOps.expand(alpha, stroke).filter(ImageFilter.MaxFilter(stroke * 2 + 1))
            outline = Image.new("RGBA", expanded.size, color(layer.get("stroke_color", "#ffffff")))
            outline.putalpha(expanded)
            outline.alpha_composite(image, (stroke, stroke))
            image = outline
        image = image.rotate(-finite(layer.get("rotation")), expand=True, resample=Image.Resampling.BICUBIC)
        opacity = min(1, max(0, finite(layer.get("opacity"), 1)))
        image.putalpha(image.getchannel("A").point(lambda v: round(v * opacity)))
        x = round(finite(layer.get("x"), width / 2) - image.width / 2)
        y = round(finite(layer.get("y"), height / 2) - image.height / 2)
        top = Image.new("RGBA", (width, height))
        top.alpha_composite(image, (x, y))
        mode = layer.get("blend", "normal")
        if mode != "normal":
            a = np.asarray(canvas.convert("RGB"), dtype=np.float32) / 255
            b = np.asarray(top.convert("RGB"), dtype=np.float32) / 255
            if mode == "multiply":
                b = a * b
            elif mode == "screen":
                b = 1 - (1 - a) * (1 - b)
            elif mode == "overlay":
                b = np.where(a <= .5, 2 * a * b, 1 - 2 * (1 - a) * (1 - b))
            else:
                raise ValueError("不支持的混合模式：" + str(mode))
            blended = Image.fromarray((b.clip(0, 1) * 255).round().astype(np.uint8)).convert("RGBA")
            blended.putalpha(top.getchannel("A"))
            top = blended
        canvas = Image.alpha_composite(canvas, top)
    return to_tensor(canvas), width, height


def compose_grid(batches, layout="横向", columns=0, gap=12, padding=12,
                 background="#171923", fit="适应", cell_size=0):
    frames = [to_pil(frame).convert("RGB") for batch in batches if batch is not None for frame in batch]
    if not frames:
        raise ValueError("请至少连接一张图片")
    if len(frames) > 256:
        raise ValueError("单张拼接最多支持 256 张图片")
    ref_w, ref_h = frames[0].size
    scale = int(cell_size) / max(ref_w, ref_h) if cell_size else 1
    cw, ch = max(1, round(ref_w * scale)), max(1, round(ref_h * scale))
    count = len(frames)
    cols = count if layout == "横向" else 1 if layout == "纵向" else min(count, int(columns) or math.ceil(math.sqrt(count)))
    rows = math.ceil(count / cols)
    gap, padding = max(0, int(gap)), max(0, int(padding))
    size = canvas_size(cols * cw + (cols - 1) * gap + 2 * padding,
                       rows * ch + (rows - 1) * gap + 2 * padding)
    canvas = Image.new("RGB", size, color(background))
    for i, frame in enumerate(frames):
        x, y = padding + (i % cols) * (cw + gap), padding + (i // cols) * (ch + gap)
        if fit == "拉伸":
            frame = frame.resize((cw, ch), Image.Resampling.LANCZOS)
        elif fit == "适应":
            frame = ImageOps.contain(frame, (cw, ch), Image.Resampling.LANCZOS)
            x += (cw - frame.width) // 2
            y += (ch - frame.height) // 2
        else:
            center = {"居左裁切": (0, .5), "居中裁切": (.5, .5), "居右裁切": (1, .5)}.get(fit, (.5, .5))
            frame = ImageOps.fit(frame, (cw, ch), Image.Resampling.LANCZOS, centering=center)
        canvas.paste(frame, (x, y))
    return to_tensor(canvas)


AUTO_FONT = "自动（中文优先）"
TITLE_SUFFIX_MODES = ("关闭", "数字（1、2、3…）", "字母（A、B、C…）")


def title_suffix(index, mode):
    if mode == TITLE_SUFFIX_MODES[1]:
        return str(index + 1)
    if mode == TITLE_SUFFIX_MODES[2]:
        # Continue after Z with AA, AB, ... for batches longer than 26 images.
        letters, number = "", index + 1
        while number:
            number, digit = divmod(number - 1, 26)
            letters = chr(65 + digit) + letters
        return letters
    return ""


@lru_cache(maxsize=1)
def title_fonts():
    """Discover installed and plugin-local fonts once, using portable filenames as IDs."""
    roots = [Path(__file__).parent / "fonts",
             Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
             Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Microsoft/Windows/Fonts",
             Path("/usr/share/fonts"), Path("/usr/local/share/fonts"),
             Path.home() / ".local/share/fonts", Path.home() / ".fonts",
             Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library/Fonts"]
    fonts = {}
    for root in roots:
        if not root.is_dir():
            continue
        for directory, folders, files in os.walk(root):
            folders.sort()
            for name in sorted(files):
                if Path(name).suffix.lower() in (".ttf", ".ttc", ".otf", ".otc"):
                    fonts.setdefault(name, str(Path(directory) / name))
    return dict(sorted(fonts.items(), key=lambda pair: pair[0].casefold()))


def title_font(size, font_name=AUTO_FONT):
    if font_name and font_name != AUTO_FONT:
        path = title_fonts().get(font_name)
        if not path:
            raise ValueError(f"找不到字体：{font_name}，请安装该字体并重启 ComfyUI，或选择自动字体")
        try:
            return ImageFont.truetype(path, size)
        except OSError as exc:
            raise ValueError(f"无法加载字体：{font_name}，请选择其他字体") from exc
    # CJK-capable system fonts first; never require a new dependency.
    candidates = [os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts", "msyh.ttc"),
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                  "/System/Library/Fonts/PingFang.ttc", "DejaVuSans.ttf"]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def add_titles(images, titles="", position="图内底部", bar_height=12, opacity=70,
               background="#171923", text_color="#ffffff", font_size=36,
               align="居中", padding=16, output_size="原始尺寸", font_name=AUTO_FONT,
               stroke_width=0, stroke_color="#000000", shadow_opacity=0,
               shadow_color="#000000", shadow_offset_x=2, shadow_offset_y=2,
               shadow_blur=4, corner_radius=0, bar_width=100, suffix_mode="关闭"):
    if suffix_mode not in TITLE_SUFFIX_MODES:
        raise ValueError("不支持的标题序号方式：" + str(suffix_mode))
    lines = str(titles).replace("\r\n", "\n").split("\n")
    output = []
    reference = None
    font_size = max(1, min(512, int(finite(font_size, 36))))
    stroke_width = max(0, min(40, int(finite(stroke_width))))
    shadow_opacity = max(0, min(100, finite(shadow_opacity)))
    shadow_offset_x = max(-512, min(512, int(finite(shadow_offset_x))))
    shadow_offset_y = max(-512, min(512, int(finite(shadow_offset_y))))
    shadow_blur = max(0, min(64, finite(shadow_blur)))
    corner_radius = max(0, finite(corner_radius))
    bar_width = max(1, min(100, finite(bar_width, 100))) if corner_radius else 100
    padding = max(0, int(finite(padding, 16)))
    opacity = max(0, min(100, finite(opacity, 70)))
    bar_height = max(1, min(100, finite(bar_height, 12)))
    bg = color(background)
    for i, frame in enumerate(images):
        image = to_pil(frame).convert("RGBA")
        if reference is None:
            target = {"1K": 1024, "2K": 2048, "4K": 4096}.get(output_size)
            scale = target / max(image.size) if target else 1
            reference = canvas_size(max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        if image.size != reference:
            image = ImageOps.pad(image, reference, method=Image.Resampling.LANCZOS, color=(*bg, 255))
        text = lines[0] if len(lines) == 1 else lines[i] if i < len(lines) else ""
        if text:
            text += title_suffix(i, suffix_mode)
        height = max(1, round(image.height * bar_height / 100))
        outside = position in ("图外顶部", "图外底部")
        # Reserve a consistent canvas for every frame, including blank titles.
        if outside:
            canvas_size(image.width, image.height + height)
            # IMAGE is RGB: flatten the outside band and rounded corners onto black.
            canvas = Image.new("RGBA", (image.width, image.height + height), (0, 0, 0, 255))
            canvas.alpha_composite(image, (0, height if position == "图外顶部" else 0))
        else:
            canvas = image.copy()
        if text or outside:
            y = 0 if "顶部" in position else (canvas.height - height) // 2 if position == "中部" else canvas.height - height
            band_width = max(1, round(canvas.width * bar_width / 100))
            bar_x = (canvas.width - band_width) // 2
            bar = Image.new("RGBA", (band_width, height))
            draw = ImageDraw.Draw(bar)
            radius = min(corner_radius, height / 2, bar.width / 2)
            draw.rounded_rectangle((0, 0, bar.width - 1, height - 1), radius=radius,
                                   fill=(*bg, round(255 * opacity / 100)))
            if not text:
                canvas.alpha_composite(bar, (bar_x, y))
                output.append(to_tensor(canvas))
                continue
            inset = min(padding, max(0, (bar.width - 1) // 2))
            max_width = max(1, bar.width - inset * 2)
            size = font_size
            # Fit the entire decoration, scaling effects along with text if needed.
            while True:
                font = title_font(size, font_name)
                ratio = size / font_size
                stroke = round(stroke_width * ratio)
                dx, dy = round(shadow_offset_x * ratio), round(shadow_offset_y * ratio)
                blur = shadow_blur * ratio
                box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
                spread = math.ceil(blur * 3) if shadow_opacity else 0
                left, top, right, bottom = box
                if shadow_opacity:
                    left, top = min(left, left + dx - spread), min(top, top + dy - spread)
                    right, bottom = max(right, right + dx + spread), max(bottom, bottom + dy + spread)
                tw, th = right - left, bottom - top
                if size == 1 or (tw <= max_width and th <= max(1, height - 4)):
                    break
                size = max(1, size - max(1, size // 10))
            x = inset if align == "居左" else bar.width - inset - tw if align == "居右" else (bar.width - tw) / 2
            origin = (x - left, (height - th) / 2 - top)
            if shadow_opacity:
                shadow = Image.new("RGBA", bar.size)
                ImageDraw.Draw(shadow).text((origin[0] + dx, origin[1] + dy), text, font=font,
                                           fill=(*color(shadow_color), round(255 * shadow_opacity / 100)),
                                           stroke_width=stroke,
                                           stroke_fill=(*color(shadow_color), round(255 * shadow_opacity / 100)))
                if blur:
                    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
                bar.alpha_composite(shadow)
            # Separate text layer preserves translucent glyph edges over the bar.
            lettering = Image.new("RGBA", bar.size)
            ImageDraw.Draw(lettering).text(origin, text, font=font, fill=(*color(text_color), 255),
                                          stroke_width=stroke, stroke_fill=(*color(stroke_color), 255))
            bar.alpha_composite(lettering)
            canvas.alpha_composite(bar, (bar_x, y))
        output.append(to_tensor(canvas))
    if not output:
        raise ValueError("请至少连接一张图片，输入批次不能为空")
    return torch.cat(output)


class AllBuyImageComposer:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"layout_json": ("STRING", {"default": '{"width":1024,"height":1024,"background":"#171923","layers":[]}'})},
                "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("图片", "宽度", "高度")
    OUTPUT_TOOLTIPS = (
        "按画布设置合成全部图层后的最终图片",
        "画布宽度（像素），可接后续节点的尺寸输入",
        "画布高度（像素），可接后续节点的尺寸输入",
    )
    DESCRIPTION = (
        "自由画布图层合成：在面板里添加图层，拖动排序、缩放旋转、调混合模式，"
        "支持描边、橡皮擦与可选自动抠图。layout_json 由面板管理，无需手动填写。"
    )
    FUNCTION = "execute"
    CATEGORY = "AllBuy/图像工具"
    SEARCH_ALIASES = ["图层", "合成器", "composer"]

    def execute(self, layout_json, prompt=None, extra_pnginfo=None):
        image, width, height = compose_layers(layout_json)
        return preview_result(image, width, height, prompt=prompt, extra_pnginfo=extra_pnginfo)


class AllBuyImageGrid:
    # Preserve the preview when downstream outputs reuse this node's cached image.
    HAS_INTERMEDIATE_OUTPUT = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image_1": ("IMAGE",), "layout": (["横向", "纵向", "网格"],
                                              {"tooltip": "排布方式：横向 / 纵向 / 网格"}),
            "fit": (["适应", "居左裁切", "居中裁切", "居右裁切", "拉伸"],
                    {"tooltip": "每路图片放进格子的方式：适应（完整放入不裁切）、三种裁切、拉伸"}),
            "columns": ("INT", {"default": 0, "min": 0, "max": 32,
                                "tooltip": "网格列数；0 = 按图片数量自动排列"}),
            "cell_size": ("INT", {"default": 0, "min": 0, "max": 4096,
                                  "tooltip": "统一格子边长（像素）；0 = 按各图片原始尺寸"}),
            "gap": ("INT", {"default": 12, "min": 0, "max": 1024,
                            "tooltip": "格子之间的间距（像素）"}),
            "padding": ("INT", {"default": 12, "min": 0, "max": 1024,
                                "tooltip": "整张拼接图的外边距（像素）"}),
            "background": ("STRING", {"default": "#171923",
                                      "tooltip": "底色，支持 #RRGGBB"})},
            "optional": {f"image_{i}": ("IMAGE",) for i in range(2, 13)},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("拼接图片",)
    OUTPUT_TOOLTIPS = ("12 路输入按所选排布拼接成的一张图",)
    DESCRIPTION = (
        "把最多 12 路图片或 batch 拼接为一张：横向、纵向或网格排列，"
        "每路可按适应/裁切/拉伸放进格子，格子大小、间距、外边距与底色可调。"
        "某一路未连接时自动跳过。"
    )
    FUNCTION = "execute"
    CATEGORY = "AllBuy/图像工具"
    SEARCH_ALIASES = ["多图拼接", "grid", "拼图"]

    def execute(self, image_1, prompt=None, extra_pnginfo=None, **kwargs):
        batches = [image_1] + [kwargs.pop(f"image_{i}", None) for i in range(2, 13)]
        return preview_result(compose_grid(batches, **kwargs), prompt=prompt, extra_pnginfo=extra_pnginfo)


class AllBuyImageTitle:
    # Ask ComfyUI to replay this node's UI even when downstream outputs are cached.
    HAS_INTERMEDIATE_OUTPUT = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE", {"tooltip": "多路图片或 batch（最多 12 路）；标题按行逐帧对应"}), "titles": ("STRING", {"default": "", "multiline": True,
                                                        "tooltip": "标题文本，每行一条，与图片顺序一一对应"}),
            "position": (["图内底部", "图内顶部", "中部", "图外顶部", "图外底部"],
                         {"tooltip": "标题栏位置"}),
            "bar_height": ("INT", {"default": 12, "min": 1, "max": 100,
                                   "tooltip": "标题栏高度，占图片高度的百分比（%）"}),
            "opacity": ("INT", {"default": 70, "min": 0, "max": 100,
                                "tooltip": "标题栏不透明度（%）"}),
            "background": ("STRING", {"default": "#171923", "tooltip": "标题栏底色"}),
            "text_color": ("STRING", {"default": "#ffffff", "tooltip": "标题文字颜色"}),
            "font_size": ("INT", {"default": 36, "min": 1, "max": 512,
                                  "tooltip": "标题字号（像素）"}),
            "align": (["居中", "居左", "居右"], {"tooltip": "文字在标题栏内的对齐"}),
            "padding": ("INT", {"default": 16, "min": 0, "max": 1024,
                                "tooltip": "文字与标题栏边缘的内边距（像素）"}),
            "output_size": (["原始尺寸", "1K", "2K", "4K"],
                            {"tooltip": "输出尺寸档位"})},
            "optional": {
                "font_name": ([AUTO_FONT, *title_fonts()],
                              {"tooltip": "字体；自动（中文优先）会挑一个可用的中文字体"}),
                "stroke_width": ("INT", {"default": 0, "min": 0, "max": 40,
                                         "tooltip": "文字描边粗细（像素）；0 = 不描边"}),
                "stroke_color": ("STRING", {"default": "#000000", "tooltip": "描边颜色"}),
                "shadow_opacity": ("INT", {"default": 0, "min": 0, "max": 100,
                                           "tooltip": "阴影不透明度（%）；0 = 无阴影"}),
                "shadow_color": ("STRING", {"default": "#000000", "tooltip": "阴影颜色"}),
                "shadow_offset_x": ("INT", {"default": 2, "min": -512, "max": 512,
                                            "tooltip": "阴影水平偏移（像素，可负）"}),
                "shadow_offset_y": ("INT", {"default": 2, "min": -512, "max": 512,
                                            "tooltip": "阴影垂直偏移（像素，可负）"}),
                "shadow_blur": ("INT", {"default": 4, "min": 0, "max": 64,
                                        "tooltip": "阴影模糊半径（像素）"}),
                "corner_radius": ("INT", {"default": 0, "min": 0, "max": 4096,
                                          "tooltip": "标题栏圆角半径（像素）"}),
                "bar_width": ("INT", {"default": 100, "min": 1, "max": 100,
                                      "tooltip": "标题栏宽度，占图片宽度的百分比（%）；无圆角时固定铺满"}),
                "suffix_mode": (list(TITLE_SUFFIX_MODES), {"default": "关闭",
                                  "tooltip": "多张图标题自动加编号：关闭 / 数字（1、2、3…）/ 字母（A、B、C…）"}),
                **{f"image_{i}": ("IMAGE",) for i in range(2, 13)}},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("标题图片",)
    OUTPUT_TOOLTIPS = ("逐帧加过标题的图片 batch",)
    DESCRIPTION = (
        "给最多 12 路图片逐张加标题：标题栏位置/颜色/不透明度、字体、描边、阴影、"
        "圆角标题栏与数值拖动都可调；标题按行与图片顺序一一对应，batch 逐帧展开。"
    )
    FUNCTION = "execute"
    CATEGORY = "AllBuy/图像工具"
    SEARCH_ALIASES = ["图片标题", "caption", "title"]

    def execute(self, images, prompt=None, extra_pnginfo=None, **kwargs):
        batches = [images] + [kwargs.pop(f"image_{i}", None) for i in range(2, 13)]
        frames = (frame for batch in batches if batch is not None for frame in batch)
        return preview_result(add_titles(frames, **kwargs), prompt=prompt, extra_pnginfo=extra_pnginfo)


NODE_CLASS_MAPPINGS = {c.__name__: c for c in (AllBuyImageComposer, AllBuyImageGrid, AllBuyImageTitle)}
NODE_DISPLAY_NAME_MAPPINGS = {"AllBuyImageComposer": "AllBuy-图层合成器", "AllBuyImageGrid": "AllBuy-多图拼接", "AllBuyImageTitle": "AllBuy-图片标题"}
