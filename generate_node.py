"""Native ComfyUI sampling, decoding, inpainting and outpainting in one node."""
from __future__ import annotations

import json
import math

import numpy as np

from .image_tools import load_asset, to_tensor, preview_result


def native_nodes():
    import nodes
    return nodes


def normalize_decoded(image):
    channels = image.shape[-1]
    if channels in (3, 4):
        return image[..., :3]
    factor = math.isqrt(channels // 3)
    if factor < 1 or 3 * factor * factor != channels:
        raise ValueError(f"VAE 输出了不支持的通道数：{channels}")
    import torch.nn.functional as F
    return F.pixel_shuffle(image.movedim(-1, 1), factor).movedim(1, -1)


def resize_image(image, mode="original", size=1024):
    if mode == "original":
        return image
    if mode not in ("longest", "shortest"):
        raise ValueError("请选择有效的图片缩放方式")
    target = float(size)
    if not math.isfinite(target) or not target.is_integer() or not 1 <= target <= 8192:
        raise ValueError("目标尺寸须为 1–8192 的整数")
    h, w = image.shape[1:3]
    scale = target / (max(h, w) if mode == "longest" else min(h, w))
    h, w = (max(1, math.floor(v * scale + .5)) for v in (h, w))
    if h * w > 16 * 1024 * 1024 or max(h, w) > 8192:
        raise ValueError(f"缩放后尺寸为 {w} × {h}，超过画布上限；请减小目标尺寸或改用最长边")
    if (h, w) == tuple(image.shape[1:3]):
        return image
    import torch.nn.functional as F
    return F.interpolate(image.movedim(-1, 1), (h, w), mode="bicubic",
                         align_corners=False, antialias=True).movedim(1, -1).clamp(0, 1)


class AllBuyImageResize:
    """Shared tensor resize for runtime reference encoders and connected images."""
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE", {"tooltip": "输入图片"}),
                             "mode": (["original", "longest", "shortest"],
                                      {"tooltip": "缩放基准：original 原尺寸 / longest 最长边 / shortest 最短边"}),
                             "size": ("INT", {"default": 1024, "min": 1, "max": 8192,
                                              "tooltip": "目标边长（像素）"})}}

    RETURN_TYPES = ("IMAGE",)
    DESCRIPTION = "内部辅助节点：按最长边/最短边/原尺寸把图片缩放到指定大小，供生成节点的参考图编码使用。一般不直接添加到工作流。"
    FUNCTION = "resize"
    CATEGORY = "AllBuy/图像工具"

    def resize(self, image, mode="original", size=1024):
        return (resize_image(image, mode, size),)


def resize_latent(latent, options, vae, qwen_reference=False):
    ratio = options.get("ratio", "original")
    if ratio == "original":
        return latent
    if ratio not in ("1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"):
        raise ValueError("请选择有效的 Latent 比例")
    target = float(options.get("size", 1024))
    if not math.isfinite(target) or not target.is_integer() or not 1 <= target <= 8192:
        raise ValueError("目标尺寸须为 1–8192 的整数")
    mode = options.get("mode", "original")
    if mode not in ("original", "longest", "shortest"):
        raise ValueError("请选择有效的尺寸基准")
    w, h = (int(value) for value in ratio.split(":"))
    scale = target / (min(w, h) if mode == "shortest" else max(w, h))
    compression = int(vae.spacial_compression_encode()) if hasattr(vae, "spacial_compression_encode") else 8
    alignment = math.lcm(compression, 32) if qwen_reference else compression
    w, h = (max(alignment, round(value * scale / alignment) * alignment) for value in (w, h))
    if w * h > 16 * 1024 * 1024 or max(w, h) > 8192:
        raise ValueError(f"Latent 画布为 {w} × {h}，超过上限；请减小目标尺寸或改用最长边")
    downscale = int(latent.get("downscale_ratio_spacial", compression))
    samples = latent["samples"]
    if samples.ndim != 4 or downscale < 1:
        raise ValueError("比例设置仅支持图像 Latent")
    import torch.nn.functional as F
    return {**latent, "samples": F.interpolate(samples, (max(1, h // downscale), max(1, w // downscale)),
                                                mode="bilinear", align_corners=False)}


def prepare_edit(source, mask, feather, stride=8, round_to_stride=False):
    import torch
    import torch.nn.functional as F
    from PIL import Image, ImageFilter
    source = source[..., :3].clone()
    # VAE encoders crop to their stride. Align before sampling and compositing.
    h, w = ((max(stride, round(int(v) / stride) * stride) if round_to_stride else int(v) // stride * stride)
            for v in source.shape[1:3])
    if min(h, w) < stride:
        raise ValueError(f"重绘图片宽高必须至少为 {stride} 像素")
    source = F.interpolate(source.movedim(-1, 1), (h, w), mode="bilinear", align_corners=False).movedim(1, -1)
    if mask is None:
        return source, None
    if mask.ndim == 2:
        mask = mask.unsqueeze(0)
    mask = F.interpolate(mask.detach().cpu().float().reshape(-1, 1, *mask.shape[-2:]), (h, w), mode="bilinear", align_corners=False)[:, 0].clamp(0, 1)
    if mask.shape[0] == 1 and source.shape[0] > 1:
        mask = mask.repeat(source.shape[0], 1, 1)
    if mask.shape[0] != source.shape[0]:
        raise ValueError("遮罩批次数必须为 1 或与图片批次数相同")
    if feather:
        masks = []
        for frame in mask:
            image = Image.fromarray((frame.numpy() * 255).round().astype(np.uint8))
            image = image.filter(ImageFilter.GaussianBlur(float(feather)))
            masks.append(torch.from_numpy(np.asarray(image, dtype=np.float32).copy() / 255))
        mask = torch.stack(masks)
    return source, mask


def is_default_loader_mask(mask, prompt, unique_id, dynprompt):
    """Opaque LoadImage files emit a zero mask even without a painted mask."""
    import torch
    if mask is None or torch.any(mask != 0):
        return False
    def get_node(ident):
        return dynprompt.get_node(str(ident)) if dynprompt is not None else (prompt or {}).get(str(ident), {})
    inputs = get_node(unique_id).get("inputs", {})
    image_link, mask_link = inputs.get("source_image"), inputs.get("mask")
    if not (isinstance(image_link, (list, tuple)) and len(image_link) == 2
            and isinstance(mask_link, (list, tuple)) and len(mask_link) == 2):
        return False
    return (str(image_link[0]) == str(mask_link[0]) and image_link[1] == 0 and mask_link[1] == 1
            and get_node(mask_link[0]).get("class_type") in ("LoadImage", "LoadImageOutput"))


class AllBuyGenerate:
    HAS_INTERMEDIATE_OUTPUT = True

    @classmethod
    def INPUT_TYPES(cls):
        import comfy.samplers
        return {"required": {
            "model": ("MODEL", {"tooltip": "接底模加载器（如 LoRA 堆栈）的模型口"}),
            "positive": ("CONDITIONING", {"tooltip": "正向提示词的 CLIPTextEncode 输出"}),
            "vae": ("VAE", {"tooltip": "解码用的 VAE"}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True,
                             "tooltip": "随机种子；配合 control_after_generate 可固定或每轮换新"}),
            "steps": ("INT", {"default": 20, "min": 1, "max": 10000, "tooltip": "采样步数，越大越精细越慢"}),
            "cfg": ("FLOAT", {"default": 7.0, "min": 0, "max": 100, "step": .1,
                              "tooltip": "提示词跟随强度；Flux 等无 CFG 模型保持 1 即可"}),
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"tooltip": "采样器"}),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"tooltip": "调度器"}),
            "denoise": ("FLOAT", {"default": 1.0, "min": 0, "max": 1, "step": .01,
                                  "tooltip": "重绘幅度：1 为完全重画，越小越接近原图（图生图/重绘时调低）"}),
            "feather": ("INT", {"default": 8, "min": 0, "max": 128,
                                "tooltip": "重绘区域边缘的羽化像素，让新画面与原图过渡更自然"}),
            "edit_json": ("STRING", {"default": "{}"}),
            "original_image": ("STRING", {"default": ""}),
            "input_resize": ("STRING", {"default": "{}"})},
            "optional": {"negative": ("CONDITIONING", {"tooltip": "负向提示词的 CLIPTextEncode 输出；不接则为空条件"}),
                         "latent": ("LATENT", {"lazy": True, "tooltip": "普通生成优先使用接入的 Latent，保留上游尺寸、批次数与采样数据；重绘另按编辑画布处理"}),
                         "source_image": ("IMAGE", {"lazy": True, "tooltip": "可选：图生图 / 重绘的底图"}),
                         "mask": ("MASK", {"lazy": True, "tooltip": "可选：只重绘遮罩区域，需同时接底图"})},
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
                       "unique_id": "UNIQUE_ID", "dynprompt": "DYNPROMPT"}}

    def check_lazy_status(self, edit_json="{}", source_image=None, mask=None, latent=None,
                          prompt=None, unique_id=None, dynprompt=None, **kwargs):
        state = json.loads(edit_json or "{}")
        if not isinstance(state, dict):
            raise ValueError("生成编辑状态必须为对象")
        # Imported/saved media supplies both image and mask. Connected image,
        # mask and latent branches are unused and must not be scheduled.
        if state.get("enabled"):
            return []
        definition = dynprompt.get_node(str(unique_id)) if dynprompt is not None else (prompt or {}).get(str(unique_id), {})
        inputs = definition.get("inputs", {})
        if (mask is not None or "mask" in inputs) and source_image is None and "source_image" not in inputs:
            raise ValueError("遮罩需要同时连接图片或载入编辑底图")
        if latent is not None or "latent" in inputs:
            if mask is None and "mask" in inputs:
                return ["mask"]
            if mask is None or is_default_loader_mask(mask, prompt, unique_id, dynprompt):
                return ["latent"] if latent is None and "latent" in inputs else []
        if source_image is not None or "source_image" in inputs:
            return [name for name, value in (("source_image", source_image), ("mask", mask))
                    if value is None and name in inputs]
        if mask is not None or "mask" in inputs:
            raise ValueError("遮罩需要同时连接图片或载入编辑底图")
        return ["latent"] if latent is None and "latent" in inputs else []

    RETURN_TYPES = ("IMAGE", "IMAGE", "LATENT")
    RETURN_NAMES = ("原图", "图片", "Latent")
    OUTPUT_TOOLTIPS = (
        "图生图/重绘时的输入原图（纯文生图时与图片口相同）",
        "采样并解码后的最终图片",
        "解码前的 Latent，可继续接后续采样或编辑",
    )
    DESCRIPTION = (
        "原生采样与解码节点，覆盖文生图、图生图、遮罩重绘与扩图。"
        "接 source_image 即图生图；再接 mask 只重绘遮罩区域（配合羽化）；"
        "普通生成接 latent 时优先从该潜空间采样并沿用其尺寸；底图仍可用于上游参考图编码。"
        "节点内最近预览展示上一次运行结果。"
        "edit_json / original_image / input_resize 由前端面板管理，无需手动填写。"
    )
    FUNCTION = "generate"
    CATEGORY = "AllBuy/图像工具"
    OUTPUT_NODE = True
    SEARCH_ALIASES = ["生成", "采样", "重绘", "扩图", "generate", "inpaint"]

    def generate(self, model, positive, vae, seed, steps, cfg, sampler_name, scheduler,
                 denoise=1.0, feather=8, edit_json="{}", negative=None, latent=None,
                 source_image=None, mask=None, prompt=None, extra_pnginfo=None,
                 unique_id=None, dynprompt=None, original_image="", input_resize="{}"):
        import torch
        import torch.nn.functional as F
        nodes = native_nodes()
        state = json.loads(edit_json or "{}")
        if not isinstance(state, dict):
            raise ValueError("生成编辑状态必须为对象")
        original_ref = original_image or (state.get("source") if state.get("enabled") else None)
        imported_image = to_tensor(load_asset(original_ref)) if original_ref else None
        if state.get("enabled"):
            if not state.get("source"):
                raise ValueError("请先载入编辑底图")
            source_image = imported_image if original_ref == state["source"] else to_tensor(load_asset(state["source"]))
            mask = None
            if state.get("mask"):
                mask = torch.from_numpy(np.asarray(load_asset(state["mask"]).convert("L"), dtype=np.float32).copy() / 255)[None]
        else:
            # LoadImage's default black mask is not an instruction to discard
            # the whole generated result. Explicit/saved masks retain their meaning.
            if is_default_loader_mask(mask, prompt, unique_id, dynprompt):
                mask = None
            if latent is not None and mask is None:
                source_image = None
        if not state.get("enabled") and source_image is not None:
            options = json.loads(input_resize or "{}")
            if not isinstance(options, dict):
                raise ValueError("图片缩放设置必须为对象")
            source_image = resize_image(source_image, options.get("mode", "original"), options.get("size", 1024))
        if mask is not None and source_image is None:
            raise ValueError("遮罩需要同时连接图片或载入编辑底图")
        base, composite_mask = None, None
        if source_image is not None:
            stride = int(vae.spacial_compression_encode()) if hasattr(vae, "spacial_compression_encode") else 8
            qwen_reference = state.get("reference_encoding") == "qwen_image21"
            base, composite_mask = prepare_edit(source_image, mask, feather, 32 if qwen_reference else stride,
                                                round_to_stride=qwen_reference)
            if composite_mask is None:
                latent = nodes.VAEEncode().encode(vae, base)[0]
            else:
                latent = nodes.VAEEncodeForInpaint().encode(vae, base, composite_mask, grow_mask_by=6)[0]
        if latent is None:
            raise ValueError("普通生成请连接 Latent；图生图或重绘请连接图片，或载入编辑底图")
        if not state.get("enabled") and composite_mask is None:
            options = json.loads(input_resize or "{}")
            if not isinstance(options, dict):
                raise ValueError("图片缩放设置必须为对象")
            latent = resize_latent(latent, options, vae, state.get("reference_encoding") == "qwen_image21")
        if negative is None:
            negative = nodes.ConditioningZeroOut().zero_out(positive)[0]
        samples = nodes.common_ksampler(model, seed, steps, cfg, sampler_name, scheduler,
                                        positive, negative, latent, denoise=denoise)[0]
        image = normalize_decoded(nodes.VAEDecode().decode(vae, samples)[0])
        if composite_mask is not None:
            image = F.interpolate(image.movedim(-1, 1), base.shape[1:3], mode="bilinear", align_corners=False).movedim(1, -1)
            base = base.to(image.device, image.dtype)
            m = composite_mask.to(image.device, image.dtype)[..., None]
            image = image * m + base * (1 - m)
        result = preview_result(image, samples, prompt=prompt, extra_pnginfo=extra_pnginfo)
        result["result"] = (imported_image, *result["result"])
        return result


NODE_CLASS_MAPPINGS = {"AllBuyGenerate": AllBuyGenerate, "AllBuyImageResize": AllBuyImageResize}
NODE_DISPLAY_NAME_MAPPINGS = {"AllBuyGenerate": "AllBuy-生成", "AllBuyImageResize": "AllBuy-图片等比缩放"}
