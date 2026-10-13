"""Shared user-defined LoRA tags, with atomic per-action updates."""
import json
import os
import shutil
import threading

from . import library_store

_lock = threading.Lock()


def _path():
    return os.path.join(library_store.get_user_libraries_folder(), "lora_catalog.json")


def _tag(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写标签名称")
    return value.strip()[:64]


def _model(value):
    if not isinstance(value, str) or not value.strip() or value.strip() == "None":
        raise ValueError("请先选择 LoRA 模型")
    return value.strip().replace("\\", "/")


def _read():
    for candidate in (_path(), _path() + ".backup"):
        try:
            with open(candidate, encoding="utf-8") as stream:
                raw = json.load(stream)
            if not isinstance(raw, dict) or not isinstance(raw.get("tags"), list) or not isinstance(raw.get("models"), dict):
                continue
            tags = []
            canonical = {}
            for value in raw["tags"]:
                try:
                    name = _tag(value)
                except ValueError:
                    continue
                if name.casefold() not in canonical:
                    tags.append(name)
                    canonical[name.casefold()] = name
            if raw["tags"] and not tags:
                continue
            models = {}
            for key, values in raw["models"].items():
                try:
                    key = _model(key)
                except ValueError:
                    continue
                if not isinstance(values, list):
                    continue
                labels = [canonical[value.strip().casefold()] for value in values
                          if isinstance(value, str) and value.strip().casefold() in canonical]
                models[key] = list(dict.fromkeys(labels))
            return {"version": 1, "tags": tags, "models": models}
        except (OSError, ValueError):
            continue
    return {"version": 1, "tags": [], "models": {}}


def load_catalog():
    with _lock:
        return _read()


def update_catalog(data):
    if not isinstance(data, dict):
        raise ValueError("标签操作格式错误")
    action = data.get("action")
    if action not in ("create_tag", "rename_tag", "delete_tag", "patch_tags", "set_tags"):
        raise ValueError("未知的标签操作")
    with _lock:
        payload = _read()
        tags, models = payload["tags"], payload["models"]
        if action == "create_tag":
            name = _tag(data.get("name"))
            if any(tag.casefold() == name.casefold() for tag in tags):
                raise ValueError("标签名称已存在")
            tags.append(name)
        elif action in ("rename_tag", "delete_tag"):
            name = _tag(data.get("name"))
            if name not in tags:
                raise ValueError("标签不存在，请刷新")
            if action == "rename_tag":
                new_name = _tag(data.get("new_name"))
                if any(tag != name and tag.casefold() == new_name.casefold() for tag in tags):
                    raise ValueError("标签名称已存在")
                tags[tags.index(name)] = new_name
                for key, values in models.items():
                    models[key] = [new_name if value == name else value for value in values]
            else:
                tags.remove(name)
                for key, values in models.items():
                    models[key] = [value for value in values if value != name]
        else:
            targets = data.get("models")
            if not isinstance(targets, list) or not targets:
                raise ValueError("请选择要设置标签的 LoRA")
            targets = list(dict.fromkeys(_model(value) for value in targets))

            def labels(key):
                values = data.get(key, [])
                if not isinstance(values, list):
                    raise ValueError("标签必须是数组")
                names = list(dict.fromkeys(_tag(value) for value in values))
                if any(name not in tags for name in names):
                    raise ValueError("标签不存在，请刷新")
                return names

            if action == "set_tags":
                if "tags" not in data:
                    raise ValueError("缺少标签字段")
                chosen = labels("tags")
                for key in targets:
                    models[key] = list(chosen)
            else:
                add, remove = labels("add"), labels("remove")
                if set(add) & set(remove):
                    raise ValueError("同一标签不能同时添加和移除")
                for key in targets:
                    models[key] = list(dict.fromkeys([value for value in models.get(key, []) if value not in remove] + add))
        path = _path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, ensure_ascii=False, indent=2)
            if os.path.isfile(path):
                try:
                    with open(path, encoding="utf-8") as stream:
                        previous = json.load(stream)
                    if (isinstance(previous, dict) and isinstance(previous.get("tags"), list)
                            and all(isinstance(tag, str) and tag.strip() for tag in previous["tags"])
                            and isinstance(previous.get("models"), dict)
                            and all(isinstance(values, list) and all(isinstance(value, str) for value in values)
                                    for values in previous["models"].values())):
                        shutil.copy2(path, path + ".backup")
                except (OSError, ValueError):
                    pass
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
        return payload
