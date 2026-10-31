"""Shared user-defined LoRA tags, with atomic per-action updates."""
import json
import math
import os
import shutil
import threading
from urllib.parse import urlparse

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


def _recommendation(value):
    if not isinstance(value, dict):
        raise ValueError("推荐设置格式错误")
    low, high, default = (value.get(key) for key in ("min", "max", "default"))
    if any(type(number) not in (int, float) or not math.isfinite(number) for number in (low, high, default)) or not -3 <= low <= default <= high <= 3:
        raise ValueError("请填写 -3～3 的有效区间，默认权重须位于区间内")
    result = {"min": low, "max": high, "default": default}
    if isinstance(value.get("content"), dict) and value["content"].get("rating") in ("sfw", "nsfw", "unknown"):
        result["content"] = {"rating": value["content"]["rating"], "source": "Civitai"}
    for key, limit in (("source", 100), ("url", 1000), ("evidence", 2000), ("version", 200), ("base_model", 200), ("matchedBy", 100)):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > limit:
            raise ValueError("来源说明格式或长度无效")
        result[key] = text.strip()
    if result["url"]:
        parsed = urlparse(result["url"])
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("来源链接须为 HTTPS 网页地址")
    return result


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
            payload = {"version": 1, "tags": tags, "models": models}
            if isinstance(raw.get("model_info"), dict):
                for name, info in raw["model_info"].items():
                    try:
                        if isinstance(info, dict) and all(isinstance(info.get(key, ""), str) for key in ("base_model", "version")):
                            payload.setdefault("model_info", {})[_model(name)] = {key: info.get(key, "").strip()[:200] for key in ("base_model", "version")}
                    except ValueError:
                        continue
            content = raw.get("content_ratings", {})
            if isinstance(content, dict):
                for name, rating in content.items():
                    try:
                        if rating in ("sfw", "nsfw"):
                            payload.setdefault("content_ratings", {})[_model(name)] = rating
                    except ValueError:
                        continue
            recommendations = raw.get("recommendations", {})
            if isinstance(recommendations, dict):
                for name, value in recommendations.items():
                    try:
                        payload.setdefault("recommendations", {})[_model(name)] = _recommendation(value)
                    except ValueError:
                        continue
            weights = raw.get("recommended_weights", {})
            if isinstance(weights, dict):
                cleaned_weights = {}
                for name, value in weights.items():
                    try:
                        name = _model(name)
                    except ValueError:
                        continue
                    if type(value) in (int, float) and math.isfinite(value) and -3 <= value <= 3:
                        cleaned_weights[name] = value
                if cleaned_weights:
                    payload["recommended_weights"] = cleaned_weights
            triggers = raw.get("triggers", {})
            if isinstance(triggers, dict):
                cleaned = {}
                for name, trigger in triggers.items():
                    try:
                        name = _model(name)
                    except ValueError:
                        continue
                    if isinstance(trigger, str):
                        cleaned[name] = trigger.strip()
                if cleaned:
                    payload["triggers"] = cleaned
            return payload
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
    if action not in ("create_tag", "rename_tag", "delete_tag", "patch_tags", "set_tags", "set_trigger", "seed_triggers", "set_recommended_weight", "set_recommendation", "set_content_rating", "set_model_info"):
        raise ValueError("未知的标签操作")
    with _lock:
        payload = _read()
        tags, models = payload["tags"], payload["models"]
        if action == "set_model_info":
            name = _model(data.get("model")); info = data.get("info")
            if info is None:
                payload.get("model_info", {}).pop(name, None)
            elif not isinstance(info, dict) or any(not isinstance(info.get(key, ""), str) or len(info.get(key, "")) > 200 for key in ("base_model", "version")):
                raise ValueError("底模与版本须为不超过 200 字的文本")
            else:
                payload.setdefault("model_info", {})[name] = {key: info.get(key, "").strip() for key in ("base_model", "version")}
        elif action == "set_content_rating":
            targets, rating = data.get("models"), data.get("rating")
            if not isinstance(targets, list) or not targets or rating not in ("auto", "sfw", "nsfw"):
                raise ValueError("请选择模型和有效的内容评级")
            names = list(dict.fromkeys(_model(value) for value in targets))
            content = payload.setdefault("content_ratings", {})
            for name in names:
                if rating == "auto":
                    content.pop(name, None)
                else:
                    content[name] = rating
        elif action == "set_recommendation":
            name = _model(data.get("model"))
            recommendation = _recommendation(data.get("recommendation"))
            payload.setdefault("recommendations", {})[name] = recommendation
            payload.setdefault("recommended_weights", {})[name] = recommendation["default"]
        elif action == "set_recommended_weight":
            name = _model(data.get("model"))
            value = data.get("weight")
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or not -3 <= value <= 3):
                raise ValueError("推荐权重须为 -3 到 3 之间的数字")
            weights = payload.setdefault("recommended_weights", {})
            if value is None:
                weights.pop(name, None)
                payload.get("recommendations", {}).pop(name, None)
            else:
                recommendation = payload.get("recommendations", {}).get(name)
                if recommendation:
                    if not recommendation["min"] <= value <= recommendation["max"]:
                        raise ValueError("默认权重须位于推荐区间内，请通过推荐设置调整区间")
                    recommendation["default"] = value
                weights[name] = value
        elif action == "seed_triggers":
            entries = data.get("entries")
            if not isinstance(entries, list):
                raise ValueError("激活提示词条目必须是数组")
            for entry in entries:
                if not isinstance(entry, dict):
                    raise ValueError("激活提示词条目格式错误")
                name = _model(entry.get("name"))
                trigger = entry.get("trigger")
                if not isinstance(trigger, str) or len(trigger) > 16000:
                    raise ValueError("激活提示词必须是文本，且不能超过 16000 字符")
                if trigger.strip():
                    payload.setdefault("triggers", {}).setdefault(name, trigger.strip())
        elif action == "set_trigger":
            name = _model(data.get("model"))
            trigger = data.get("trigger")
            if not isinstance(trigger, str) or len(trigger) > 16000:
                raise ValueError("激活提示词必须是文本，且不能超过 16000 字符")
            triggers = payload.setdefault("triggers", {})
            # Keep explicit clearing so an older workflow cannot re-import stale text.
            triggers[name] = trigger.strip()
        elif action == "create_tag":
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
            if action == "patch_tags":
                create = data.get("create", [])
                if not isinstance(create, list):
                    raise ValueError("新标签必须是数组")
                for value in create:
                    name = _tag(value)
                    if not any(tag.casefold() == name.casefold() for tag in tags):
                        tags.append(name)
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
