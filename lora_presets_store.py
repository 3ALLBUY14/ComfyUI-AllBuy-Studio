"""Shared LoRA stack presets, stored atomically in the ComfyUI user directory."""
import json
import math
import os
import shutil
import threading
import uuid
from datetime import datetime, timezone

from . import library_store

_lock = threading.Lock()
_SORTS = {"manual", "name_asc", "name_desc", "weight_desc", "weight_asc", "enabled", "favorite", "tag"}


def _view(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get("sort", "manual"), str) or raw.get("sort", "manual") not in _SORTS:
        raise ValueError("列表排序方式无效")
    return {"sort": raw.get("sort", "manual")}


def _path():
    return os.path.join(library_store.get_user_libraries_folder(), "lora_presets.json")


def _name(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写列表名称")
    return value.strip()[:100]


def _entries(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("LoRA 列表不能为空")
    entries = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ValueError("LoRA 条目格式错误")
        name = item["name"].strip() or "None"
        try:
            weight = float(item.get("weight", 1))
            lo = float(item.get("min", -3))
            hi = float(item.get("max", 3))
        except (TypeError, ValueError) as exc:
            raise ValueError("LoRA 权重和范围必须是数字") from exc
        if not all(math.isfinite(v) for v in (weight, lo, hi)) or hi <= lo:
            raise ValueError("LoRA 权重或范围无效")
        trigger = item.get("trigger", "")
        if not isinstance(trigger, str):
            raise ValueError("LoRA 触发词必须是文本")
        entries.append({
            "name": name, "weight": max(lo, min(hi, weight)),
            "min": lo, "max": hi, "enabled": item.get("enabled") is not False,
            "trigger": trigger.strip(),
        })
    return entries


def _load():
    path = _path()
    for candidate in (path, path + ".backup"):
        try:
            with open(candidate, encoding="utf-8") as stream:
                data = json.load(stream)
            if not isinstance(data, dict) or not isinstance(data.get("presets"), list):
                continue
            result = []
            ids = set()
            for i, item in enumerate(data["presets"]):
                try:
                    if not isinstance(item, dict):
                        continue
                    pid = item.get("id")
                    if not isinstance(pid, str) or not pid.strip() or pid in ids:
                        pid = f"p{i}"
                        while pid in ids:
                            pid += "_"
                    preset = {"id": pid, "name": _name(item.get("name")),
                              "entries": _entries(item.get("entries")),
                              "updated_at": str(item.get("updated_at", ""))}
                    if isinstance(item.get("view"), dict):
                        try:
                            preset["view"] = _view(item["view"])
                        except ValueError:
                            preset["view"] = {"sort": "manual"}
                except ValueError:
                    continue
                ids.add(pid)
                result.append(preset)
            if data["presets"] and not result:
                continue
            return {"version": 1, "presets": result}
        except (OSError, ValueError):
            continue
    return {"version": 1, "presets": []}


def load_presets():
    with _lock:
        return _load()


def update_presets(data):
    """Apply one named action under a lock, preserving other nodes' saved lists."""
    if not isinstance(data, dict):
        raise ValueError("列表操作格式错误")
    action = data.get("action")
    if action not in ("save", "overwrite", "rename", "delete"):
        raise ValueError("未知的列表操作")
    view = _view(data["view"]) if "view" in data else None
    with _lock:
        payload = _load()
        presets = payload["presets"]
        target = next((p for p in presets if p["id"] == data.get("id")), None)
        if action != "save" and target is None:
            raise ValueError("列表不存在，可能已被删除，请刷新")
        if action in ("save", "rename"):
            name = _name(data.get("name"))
            if any(p is not target and p["name"].casefold() == name.casefold() for p in presets):
                raise ValueError("同名列表已存在，请使用覆盖或更换名称")
        if action in ("save", "overwrite"):
            entries = _entries(data.get("entries"))
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if action == "save":
            presets.append({"id": uuid.uuid4().hex, "name": name,
                            "entries": entries, "updated_at": stamp})
            if view is not None:
                presets[-1]["view"] = view
        elif action == "overwrite":
            target.update(entries=entries, updated_at=stamp)
            if view is not None:
                target["view"] = view
        elif action == "rename":
            target.update(name=name, updated_at=stamp)
        else:
            presets.remove(target)

        path = _path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = path + ".tmp"
        try:
            with open(temporary, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, indent=2, allow_nan=False)
            if os.path.isfile(path):
                # A corrupt primary must not overwrite the last usable backup.
                try:
                    with open(path, encoding="utf-8") as stream:
                        previous = json.load(stream)
                    if isinstance(previous, dict) and isinstance(previous.get("presets"), list):
                        valid = True
                        for item in previous["presets"]:
                            if not isinstance(item, dict):
                                valid = False
                                break
                            _name(item.get("name"))
                            _entries(item.get("entries"))
                        if valid:
                            shutil.copy2(path, path + ".backup")
                except (OSError, ValueError):
                    pass
            os.replace(temporary, path)
        finally:
            if os.path.isfile(temporary):
                os.remove(temporary)
        return payload
