"""AllBuy-LoRA 堆栈节点：内置 Checkpoint / UNET / GGUF 模型加载 + 可排序 LoRA 堆栈 + 触发词输出。

数据模型（隐藏 widget `stack_json` 的 JSON）：
[ {"id", "name", "weight", "min", "max", "enabled", "trigger"} ]

- schema v1 契约：字段白名单 id/name/weight/min/max/enabled/trigger，未知键忽略、缺省值兜底
- 模型文件（ckpt/unet/gguf）不入 IS_CHANGED 键（与 ComfyUI 原生 UNETLoader 语义对齐）；
  LoRA 文件 mtime:size 必须入键——同名替换 LoRA 后输入不变，仅哈希输入会复用旧输出
- GGUF 支持经 nodes.UnetLoaderGGUF（ComfyUI-GGUF 插件或新版核心注册）；插件缺失时
  节点照常注册，仅选择 GGUF 执行时抛可操作错误
"""
import hashlib
import json
import math
import os

_NO_LORA = "None"
_WEIGHT_EPSILON = 0.000001

_MODEL_TYPES = ["Checkpoint", "UNET", "GGUF"]
_WEIGHT_DTYPES = ["default", "float8_e4m3fn", "float8_e4m3fn_fast", "float8_e5m2"]
_GGUF_DTYPES = ["default", "target", "float32", "float16", "bfloat16"]

_ENTRY_KEYS = ("id", "name", "weight", "min", "max", "enabled", "trigger")


def _folder_paths():
    import folder_paths
    return folder_paths


def _comfy_nodes():
    import nodes
    return nodes


def _loader_class(name):
    nodes = _comfy_nodes()
    loader = getattr(nodes, name, None) or getattr(nodes, "NODE_CLASS_MAPPINGS", {}).get(name)
    if loader is None:
        raise RuntimeError(f"AllBuy-LoRA 堆栈：未找到 ComfyUI {name} 加载器，请升级 ComfyUI")
    return loader


def _loader_options(loader_name, field, fallback):
    try:
        definition = _loader_class(loader_name).INPUT_TYPES()["required"][field][0]
        if isinstance(definition, (list, tuple)) and definition:
            return list(definition)
    except Exception:
        pass
    return fallback


def _parse_entries(stack_json):
    """解析 stack_json → 条目列表。非法 JSON / 非列表抛 ValueError（含中文说明）。"""
    try:
        entries = json.loads(stack_json or "[]")
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("AllBuy-LoRA 堆栈：stack 数据不是合法 JSON") from exc
    if not isinstance(entries, list):
        raise ValueError("AllBuy-LoRA 堆栈：stack 数据必须是数组")
    return entries


def _normalize_entry(entry, index):
    """条目 schema v1 归一化：未知键忽略、缺省值兜底；非法类型抛 ValueError。"""
    if not isinstance(entry, dict):
        raise ValueError(f"AllBuy-LoRA 堆栈：第 {index + 1} 条必须是对象")
    name = str(entry.get("name", _NO_LORA)).strip() or _NO_LORA
    try:
        weight = float(entry.get("weight", 0.0))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"AllBuy-LoRA 堆栈：第 {index + 1} 条权重非法（{name}）"
        ) from exc
    if not math.isfinite(weight):
        raise ValueError(f"AllBuy-LoRA 堆栈：第 {index + 1} 条权重必须是有限数（{name}）")
    try:
        lo = float(entry.get("min", 0.0))
        hi = float(entry.get("max", 2.0))
    except (TypeError, ValueError):
        lo, hi = 0.0, 2.0
    if not math.isfinite(lo) or not math.isfinite(hi) or hi <= lo:
        lo, hi = 0.0, 2.0
    return {
        "id": str(entry.get("id") or f"e{index}"),
        "name": name,
        "weight": weight,
        "min": lo,
        "max": hi,
        "enabled": bool(entry.get("enabled", True)),
        "trigger": str(entry.get("trigger", "")).strip(),
    }


def _validated_entries(stack_json):
    return [_normalize_entry(e, i) for i, e in enumerate(_parse_entries(stack_json))]


def _effective_entry_signature(entries):
    """有效条目签名（IS_CHANGED 键）：enabled/None/权重≈0/有效条目分别规范化。"""
    signature = []
    for entry in entries:
        enabled = entry["enabled"]
        name = entry["name"]
        weight = entry["weight"]
        if not enabled:
            signature.append({"enabled": False})
        elif name == _NO_LORA:
            signature.append({"enabled": True, "name": _NO_LORA})
        elif abs(weight) <= _WEIGHT_EPSILON:
            signature.append({"enabled": True, "name": name, "weight": 0.0})
        else:
            signature.append({
                "enabled": True,
                "name": name,
                "weight": round(weight, 6),
                "trigger": entry["trigger"],
            })
    return signature


def _lora_files_signature(entries):
    """已启用且权重≠0 的 LoRA 文件 mtime:size 签名，防止同名替换文件后缓存不失效。

    文件缺失记 "missing"，解析失败整体回退空（不阻塞执行）。
    """
    names = []
    for entry in entries:
        if entry["enabled"] and entry["name"] != _NO_LORA and abs(entry["weight"]) > _WEIGHT_EPSILON:
            names.append(entry["name"])
    if not names:
        return []
    sigs = []
    try:
        for name in names:
            path = _folder_paths().get_full_path("loras", name)
            if not path or not os.path.isfile(path):
                sigs.append((name, "missing"))
                continue
            st = os.stat(path)
            sigs.append((name, f"{st.st_mtime_ns}:{st.st_size}"))
    except Exception:
        return []
    return sigs


def _gguf_list():
    """unet_gguf + diffusion_models/unet 里的 .gguf 文件，去重排序；异常回退 []。

    不依赖 ComfyUI-GGUF 插件存在：插件缺失时列表为空，节点照常注册。
    """
    try:
        fp = _folder_paths()
        names = []
        try:
            names += list(fp.get_filename_list("unet_gguf"))
        except Exception:
            pass
        for key in ("diffusion_models", "unet"):
            try:
                names += [n for n in fp.get_filename_list(key) if n.lower().endswith(".gguf")]
            except Exception:
                pass
        return sorted(set(names))
    except Exception:
        return []


def _trigger_words(entries):
    """已启用且权重≠0 条目的触发词：去空格、casefold 去重、保序、逗号连接。"""
    triggers = []
    seen = set()
    for entry in entries:
        if not entry["enabled"] or entry["name"] == _NO_LORA:
            continue
        if abs(entry["weight"]) <= _WEIGHT_EPSILON:
            continue
        trigger = entry["trigger"].strip()
        if not trigger:
            continue
        key = trigger.casefold()
        if key in seen:
            continue
        seen.add(key)
        triggers.append(trigger)
    return ", ".join(triggers)


class AllBuyLoRAStack:
    """AllBuy-LoRA 堆栈：内置模型加载（Checkpoint/UNET/GGUF）+ 多 LoRA 堆叠 + 触发词输出。"""

    @classmethod
    def INPUT_TYPES(cls):
        fp = _folder_paths()
        try:
            ckpts = fp.get_filename_list("checkpoints")
        except Exception:
            ckpts = []
        try:
            unets = fp.get_filename_list("diffusion_models")
        except Exception:
            unets = []
        ggufs = _gguf_list()
        try:
            loras = ["None"] + fp.get_filename_list("loras")
        except Exception:
            loras = ["None"]
        try:
            encoders = fp.get_filename_list("text_encoders")
        except Exception:
            try:
                encoders = fp.get_filename_list("clip")
            except Exception:
                encoders = []
        try:
            vaes = fp.get_filename_list("vae")
        except Exception:
            vaes = []
        clips = _loader_options("CLIPLoader", "clip_name", encoders)
        clip_types = _loader_options("CLIPLoader", "type", ["stable_diffusion"])
        vaes = _loader_options("VAELoader", "vae_name", vaes)
        return {
            "required": {
                "模型类型": (_MODEL_TYPES, {"default": "UNET",
                                    "tooltip": "底模类型：Checkpoint（完整大模型）、UNET（扩散模型）或 GGUF（量化版扩散模型），三选一"}),
                "ckpt_name": (ckpts or ["None"], {"default": (ckpts or ["None"])[0],
                                        "tooltip": "Checkpoint 底模文件；仅模型类型为 Checkpoint 时生效"}),
                "unet_name": (unets or ["None"], {"default": (unets or ["None"])[0],
                                       "tooltip": "UNET 扩散模型文件；仅模型类型为 UNET 时生效"}),
                "gguf_name": (ggufs or ["None"], {"default": (ggufs or ["None"])[0],
                                       "tooltip": "GGUF 量化模型文件；仅模型类型为 GGUF 时生效"}),
                # 以下两个 widget 由前端 DOM 面板接管并隐藏原生输入
                "lora_picker": (loras,),
                "stack_json": ("STRING", {"default": "[]", "multiline": True}),
            },
            "optional": {
                "weight_dtype": (_WEIGHT_DTYPES, {"default": "default",
                                        "tooltip": "模型加载精度；默认跟随 ComfyUI 自动选择"}),
                "gguf_dequant_dtype": (_GGUF_DTYPES, {"default": "default",
                                            "tooltip": "GGUF 反量化精度；仅 GGUF 底模生效"}),
                "gguf_patch_dtype": (_GGUF_DTYPES, {"default": "default",
                                          "tooltip": "GGUF LoRA patch 计算精度；仅 GGUF 底模生效"}),
                "gguf_patch_on_device": ("BOOLEAN", {"default": False,
                                            "tooltip": "开启后 LoRA patch 在显卡上计算，更快但更吃显存；仅 GGUF 底模生效"}),
                # Append new optional widgets to preserve the positional values of older workflows.
                # 注意：输入 spec 必须是 (选项, 选项字典) 两元素，tooltip 只能写进第二个
                # 元素——拆成第三个元素会被 ComfyUI 的 schema 序列化静默丢弃
                "clip_name": (["None"] + [name for name in clips if name != "None"],
                              {"default": "None",
                               "tooltip": "文本编码器（CLIP）；选 None 则由工作流上游的加载节点提供"}),
                "clip_type": (clip_types,
                              {"default": clip_types[0],
                               "tooltip": "CLIP 类型，需与所选编码器模型匹配（如 Flux、SD3）"}),
                "vae_name": (["None"] + [name for name in vaes if name != "None"],
                             {"default": "None",
                              "tooltip": "VAE；选 None 则跟随底模内置 VAE"}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "STRING")
    RETURN_NAMES = ("模型", "CLIP", "VAE", "触发词")
    OUTPUT_TOOLTIPS = (
        "加载底模并按顺序叠加全部启用的 LoRA 后的模型",
        "文本编码器：优先用上方所选 CLIP，否则跟随 Checkpoint 自带",
        "VAE：优先用上方所选，否则跟随 Checkpoint 自带",
        "各 LoRA 触发词按顺序拼接的文本，可直接接正/负提示词",
    )
    DESCRIPTION = (
        "一个节点完成底模加载（Checkpoint/UNET/GGUF 三选一）与多 LoRA 堆叠。"
        "LoRA 行在前端面板里添加：选文件、调权重、填触发词，可整体启停与调序；"
        "顶部还可按需指定 CLIP 与 VAE。全选 None 时各口退化为纯底模输出。"
        "也可在「资源管理」面板的 LoRA 堆栈页签里编辑后应用到本节点。"
    )
    CATEGORY = "AllBuy/模型工具"
    FUNCTION = "run"
    SEARCH_ALIASES = ["lora", "lora堆栈", "lora stack", "模型加载"]

    @classmethod
    def IS_CHANGED(cls, 模型类型, ckpt_name, unet_name, gguf_name, lora_picker, stack_json,
                   **kwargs):
        entries = _validated_entries(stack_json)
        h = hashlib.sha1()
        inputs = {
            "模型类型": 模型类型,
            "ckpt_name": ckpt_name,
            "unet_name": unet_name,
            "gguf_name": gguf_name,
            "weight_dtype": kwargs.get("weight_dtype", "default"),
            "gguf_dequant_dtype": kwargs.get("gguf_dequant_dtype", "default"),
            "gguf_patch_dtype": kwargs.get("gguf_patch_dtype", "default"),
            "gguf_patch_on_device": bool(kwargs.get("gguf_patch_on_device", False)),
            "clip_name": kwargs.get("clip_name", "None"),
            "clip_type": kwargs.get("clip_type", "stable_diffusion"),
            "vae_name": kwargs.get("vae_name", "None"),
        }
        h.update(json.dumps(inputs, ensure_ascii=False, sort_keys=True).encode("utf-8"))
        h.update(json.dumps(_effective_entry_signature(entries),
                            ensure_ascii=False, sort_keys=True).encode("utf-8"))
        h.update(json.dumps(_lora_files_signature(entries),
                            ensure_ascii=False, sort_keys=True).encode("utf-8"))
        return h.hexdigest()

    @staticmethod
    def _load_base_model(模型类型, ckpt_name, unet_name, gguf_name, **kwargs):
        """按类型加载底模，返回 (model, clip, vae)。先校验选择再惰性 import，避免无谓报错。"""
        if 模型类型 == "Checkpoint":
            if not ckpt_name or ckpt_name == _NO_LORA:
                raise ValueError("AllBuy-LoRA 堆栈：请选择 Checkpoint 模型")
            nodes = _comfy_nodes()
            return nodes.CheckpointLoaderSimple().load_checkpoint(ckpt_name)
        if 模型类型 == "UNET":
            if not unet_name or unet_name == _NO_LORA:
                raise ValueError("AllBuy-LoRA 堆栈：请选择 UNET 模型")
            nodes = _comfy_nodes()
            model = nodes.UNETLoader().load_unet(
                unet_name, weight_dtype=kwargs.get("weight_dtype", "default"))[0]
            return model, None, None
        # GGUF
        if not gguf_name or gguf_name == _NO_LORA:
            raise ValueError("AllBuy-LoRA 堆栈：请选择 GGUF 模型")
        nodes = _comfy_nodes()
        # 自定义节点类只注册进 NODE_CLASS_MAPPINGS 字典（宿主从不 setattr 到模块），
        # getattr(nodes, ...) 恒为 None——必须查字典
        loader = nodes.NODE_CLASS_MAPPINGS.get("UnetLoaderGGUF")
        if loader is None:
            raise RuntimeError(
                "AllBuy-LoRA 堆栈：未检测到 GGUF 支持，请安装 ComfyUI-GGUF 插件"
                "（或升级到自带 GGUF 加载的 ComfyUI 版本）"
            )
        model = loader().load_unet(
            gguf_name,
            dequant_dtype=kwargs.get("gguf_dequant_dtype", "default"),
            patch_dtype=kwargs.get("gguf_patch_dtype", "default"),
            patch_on_device=bool(kwargs.get("gguf_patch_on_device", False)),
        )[0]
        return model, None, None

    @staticmethod
    def _apply_loras(model, entries):
        """逐条应用 LoRA（仅模型，clip 强度恒 0）。返回应用后的 model。"""
        import comfy.sd
        import comfy.utils
        fp = _folder_paths()
        lora_cache = {}
        for index, entry in enumerate(entries):
            if not entry["enabled"] or entry["name"] == _NO_LORA:
                continue
            if abs(entry["weight"]) <= _WEIGHT_EPSILON:
                continue
            path = fp.get_full_path("loras", entry["name"])
            if not path or not os.path.isfile(path):
                raise FileNotFoundError(
                    f"AllBuy-LoRA 堆栈：第 {index + 1} 条 LoRA 文件不存在（{entry['name']}）"
                )
            lora_sd = lora_cache.get(path)
            if lora_sd is None:
                lora_sd = comfy.utils.load_torch_file(path, safe_load=True)
                lora_cache[path] = lora_sd
            model, _ = comfy.sd.load_lora_for_models(model, None, lora_sd, entry["weight"], 0.0)
        return model

    def run(self, 模型类型, ckpt_name, unet_name, gguf_name, lora_picker, stack_json, **kwargs):
        entries = _validated_entries(stack_json)
        model, clip, vae = self._load_base_model(
            模型类型, ckpt_name, unet_name, gguf_name, **kwargs)
        clip_name = kwargs.get("clip_name", "None")
        if clip_name and clip_name != "None":
            clip = _loader_class("CLIPLoader")().load_clip(
                clip_name, kwargs.get("clip_type", "stable_diffusion"))[0]
        vae_name = kwargs.get("vae_name", "None")
        if vae_name and vae_name != "None":
            vae = _loader_class("VAELoader")().load_vae(vae_name)[0]
        model = self._apply_loras(model, entries)
        return (model, clip, vae, _trigger_words(entries))


NODE_CLASS_MAPPINGS = {
    "AllBuyLoRAStack": AllBuyLoRAStack,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AllBuyLoRAStack": "AllBuy-LoRA 堆栈",
}
