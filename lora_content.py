"""Content labels from explicit local metadata, without filename guesses or image inference."""
import json
from functools import lru_cache


def metadata_rating(data):
    if not isinstance(data, dict):
        return "unknown"
    ratings = []
    for value in (data, data.get("model", {}), data.get("civitai", {}), data.get("civitai", {}).get("model", {}) if isinstance(data.get("civitai"), dict) else {}):
        if not isinstance(value, dict):
            continue
        level = value.get("nsfwLevel", value.get("nsfw_level"))
        if isinstance(level, str) and level.isdigit():
            level = int(level)
        if type(level) is int and level > 0:
            ratings.append("nsfw" if level >= 4 else "sfw")
        if type(value.get("nsfw")) is bool:
            ratings.append("nsfw" if value["nsfw"] else "sfw")
        images = value.get("images", [])
        if isinstance(images, list):
            for image in images[:200]:
                if isinstance(image, dict) and type(image.get("nsfwLevel")) is int and image["nsfwLevel"] >= 4:
                    ratings.append("nsfw")
    return "nsfw" if "nsfw" in ratings else "sfw" if "sfw" in ratings else "unknown"


@lru_cache(maxsize=512)
def _read(path, modified, size):
    try:
        with open(path, encoding="utf-8") as stream:
            data = json.load(stream)
            return {"rating": metadata_rating(data), **metadata_info(data)}
    except (OSError, ValueError):
        return {"rating": "unknown"}


def metadata_info(data):
    if not isinstance(data, dict):
        return {}
    civitai = data.get("civitai") if isinstance(data.get("civitai"), dict) else {}
    def text(*values):
        return next((value.strip()[:200] for value in values if isinstance(value, str) and value.strip()), "")
    return {"base_model": text(data.get("baseModel"), data.get("base_model"), civitai.get("baseModel")),
            "version": text(data.get("version_name"), data.get("versionName"), data.get("version"), civitai.get("name"), data.get("name") if "modelId" in data or "baseModel" in data else None)}


def local_metadata(model, filenames=None):
    found = []
    info = {"base_model": "", "version": "", "source": "本地来源信息"}
    names = {name.casefold(): name for name in filenames} if filenames is not None else None
    for suffix in (".civitai.info", ".cm-info.json", ".metadata.json"):
        for path in (model.with_suffix(suffix), model.with_name(model.name + suffix)):
            if names is not None:
                filename = names.get(path.name.casefold())
                if filename is None:
                    continue
                path = path.with_name(filename)
            try:
                if path.resolve().parent != model.parent.resolve() or not path.is_file():
                    continue
                stat = path.stat()
                if stat.st_size > 2 * 1024 * 1024:
                    continue
                data = _read(str(path), stat.st_mtime_ns, stat.st_size)
                for key in ("base_model", "version"):
                    info[key] = info[key] or data.get(key, "")
                rating = data["rating"]
                if rating != "unknown":
                    found.append({"rating": rating, "source": "本地来源信息"})
            except OSError:
                continue
    return {"content": next((value for value in found if value["rating"] == "nsfw"), found[0] if found else {"rating": "unknown", "source": "未评级"}), "model_info": info}


def local_content(model, filenames=None):
    return local_metadata(model, filenames)["content"]
