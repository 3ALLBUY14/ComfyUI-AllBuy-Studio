"""LoRA sidecar previews and per-model overrides; originals are never deleted."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import threading
from urllib.parse import urlencode

from . import asset_store, constants, library_store, media_asset

_lock = threading.RLock()
KINDS = {"image": media_asset.IMAGE_EXTS, "video": media_asset.VIDEO_EXTS}


def model_key(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError("请选择 LoRA 模型")
    return name.strip().replace("\\", "/")


def installed_models():
    import folder_paths
    result = {}
    for name in folder_paths.get_filename_list("loras"):
        path = folder_paths.get_full_path("loras", name)
        if path and os.path.isfile(path):
            result[model_key(name)] = Path(path).absolute()
    return result


def _path():
    return Path(library_store.get_user_libraries_folder()) / "lora_previews.json"


def _read():
    path = _path()
    for candidate in (path, Path(str(path) + ".backup")):
        try:
            raw = json.loads(candidate.read_text(encoding="utf-8"))
            if not isinstance(raw, dict) or not isinstance(raw.get("models"), dict):
                continue
            models = {}
            for name, entry in raw["models"].items():
                if not isinstance(entry, dict) or any(not isinstance(ref, str) for kind, ref in entry.items() if kind in KINDS):
                    raise ValueError("预览记录格式错误")
                models[model_key(name)] = {kind: entry[kind] for kind in KINDS if entry.get(kind)}
            return {"version": 1, "models": models}
        except (OSError, ValueError):
            continue
    return {"version": 1, "models": {}}


def _resolve_reference(ref, kind):
    if not isinstance(ref, str) or not ref:
        return None
    if asset_store.is_managed_name(ref):
        resolved = asset_store.resolve(ref)
        path = Path(resolved) if resolved else None
    else:
        path = Path(ref).expanduser()
        if not path.is_absolute():
            return None
    if path and path.suffix.lower() in KINDS[kind] and path.is_file():
        return path.resolve()
    return None


def _sidecars(model_path, filenames=None):
    directory = model_path.parent.resolve()
    if filenames is None:
        try:
            filenames = [entry.name for entry in directory.iterdir() if entry.is_file()]
        except OSError:
            filenames = []
    candidates = {kind: [] for kind in KINDS}
    stem, full = model_path.stem.casefold(), model_path.name.casefold()
    for name in filenames:
        path = directory / name
        extension = path.suffix.lower()
        kind = next((kind for kind, extensions in KINDS.items() if extension in extensions), None)
        if not kind:
            continue
        base = name[:-len(extension)].casefold()
        if base == stem + ".preview":
            priority = 0
        elif base == stem:
            priority = 1
        elif base in (full + ".preview", stem + ".cover", full):
            priority = 2
        elif re.fullmatch(re.escape(stem) + r"\.(?:preview\.)?\d+", base):
            priority = 3
        else:
            continue
        # Automatically discovered symlinks must not escape the model directory.
        if path.resolve().parent == directory and path.is_file():
            candidates[kind].append((priority, KINDS[kind].index(extension), name.casefold(), path))
    return {kind: min(values, key=lambda value: value[:3])[3] for kind, values in candidates.items() if values}


def _record(name, model_path, overrides, filenames=None):
    sidecars = _sidecars(model_path, filenames)
    record = {"custom": dict(overrides), "missing": []}
    for kind in KINDS:
        path = _resolve_reference(overrides.get(kind), kind)
        source = "custom" if path else "sidecar"
        if overrides.get(kind) and not path:
            record["missing"].append(kind)
        path = path or sidecars.get(kind)
        if not path:
            continue
        try:
            stamp = path.stat()
        except OSError:
            continue
        reference = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
        query = {"model": name, "kind": kind, "v": f"{reference}-{stamp.st_mtime_ns}-{stamp.st_size}"}
        url = constants.API_PREFIX + "/lora_preview/file?" + urlencode(query)
        record[kind] = {"url": url, "source": source, "filename": path.name}
        if kind == "video":
            record[kind]["poster"] = url + "&poster=1&w=480"
    return record


def list_previews():
    with _lock:
        overrides = _read()["models"]
    directories = {}
    result = {}
    for name, path in installed_models().items():
        directory = path.parent.resolve()
        if directory not in directories:
            try:
                directories[directory] = [entry.name for entry in directory.iterdir() if entry.is_file()]
            except OSError:
                directories[directory] = []
        result[name] = _record(name, path, overrides.get(name, {}), directories[directory])
    return {"version": 1, "models": result}


def resolve_preview(name, kind):
    if kind not in KINDS:
        raise ValueError("预览类型只能是 image 或 video")
    name = model_key(name)
    path = installed_models().get(name)
    if not path:
        raise FileNotFoundError("LoRA 模型不存在")
    with _lock:
        overrides = _read()["models"].get(name, {})
    target = _resolve_reference(overrides.get(kind), kind) or _sidecars(path).get(kind)
    if not target:
        raise FileNotFoundError("此 LoRA 没有对应预览")
    return str(target)


def update_preview(data):
    if not isinstance(data, dict) or not any(kind in data for kind in KINDS):
        raise ValueError("请提供图片或视频预览设置")
    name = model_key(data.get("model"))
    path = installed_models().get(name)
    if not path:
        raise FileNotFoundError("LoRA 模型不存在，请刷新")
    changes = {}
    for kind in KINDS:
        if kind not in data:
            continue
        ref = data[kind]
        if ref is None or ref == "":
            changes[kind] = None  # Removing the override restores sidecar discovery.
        elif not isinstance(ref, str) or not _resolve_reference(ref.strip(), kind):
            raise ValueError("图片或视频文件不存在、路径不是绝对路径，或文件类型不匹配")
        else:
            changes[kind] = ref.strip()
    with _lock:
        payload = _read()
        entry = payload["models"].setdefault(name, {})
        for kind, ref in changes.items():
            if ref is None:
                entry.pop(kind, None)
            else:
                entry[kind] = ref
        if not entry:
            payload["models"].pop(name, None)
        target = _path()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(str(target) + ".tmp")
        try:
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            if target.is_file():
                try:
                    previous = json.loads(target.read_text(encoding="utf-8"))
                    if (isinstance(previous, dict) and isinstance(previous.get("models"), dict)
                            and all(isinstance(entry, dict) and all(isinstance(value, str) for kind, value in entry.items() if kind in KINDS)
                                    for entry in previous["models"].values())):
                        shutil.copy2(target, str(target) + ".backup")
                except (OSError, ValueError):
                    pass
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return _record(name, path, entry)
