"""Read author recommendations without importing unrelated image-generation weights."""
import hashlib
import html
import json
import re
from functools import lru_cache
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import lora_preview_store
from .lora_content import metadata_rating


class _CivitaiRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "civitai.com" or parsed.username or parsed.port:
            raise ValueError("来源站返回了意外的跳转")
        return super().redirect_request(request, response, code, message, headers, url)


def _get(path):
    try:
        with build_opener(_CivitaiRedirect()).open(Request("https://civitai.com/api/v1/" + path, headers={"User-Agent": "AllBuy-Studio/1", "Accept": "application/json"}), timeout=20) as response:
            if urlparse(response.url).hostname != "civitai.com":
                raise ValueError("来源站返回了意外的跳转")
            raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("来源说明过大，请手动填写推荐权重")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("来源站数据格式错误")
        return data
    except HTTPError as error:
        raise ValueError({404: "C 站未找到对应版本，请填写准确的版本链接", 401: "此版本需要登录，暂无法从公开接口读取", 403: "C 站拒绝访问，可稍后重试或手动填写", 429: "C 站请求过于频繁，请稍后重试"}.get(error.code, "来源站暂时不可用")) from error
    except (URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
        raise ValueError("无法读取 C 站，请检查网络或手动填写推荐权重") from error


@lru_cache(maxsize=128)
def _sha256(path, size, modified):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_recommendation(description):
    text = html.unescape(re.sub(r"<[^>]*>", " ", str(description or "")))
    text = re.sub(r"\s+", " ", text)
    number = r"(-?(?:\d+(?:\.\d+)?|\.\d+))"
    label = r"(?:recommended\s+(?:lora\s+)?(?:weight|strength)|(?:lora\s+)?(?:weight|strength)\s*(?:recommendation|recommended|range)?|推荐(?:使用)?(?:权重|强度)|建议(?:使用)?(?:权重|强度)|(?:权重|强度)(?:推荐|建议|范围)?)"
    pattern = label + r"\s*(?:is|of|:|：|=|为|在|建议|推荐)?\s*" + number + r"(?:\s*(?:-|–|—|~|～|至|到|to)\s*" + number + r")?"
    candidates = []
    defaults = list(re.finditer(r"(?:default|默认)\s*(?:weight|strength|权重|强度)?\s*(?:is|:|：|=|为)?\s*" + number, text, re.I))
    for match in re.finditer(pattern, text, re.I):
        if any(default.start() <= match.start() < default.end() for default in defaults):
            continue
        low = float(match[1]); high = float(match[2]) if match[2] is not None else low
        if -3 <= low <= high <= 3:
            candidates.append({"min": low, "max": high, "default": round((low + high) / 2, 4), "evidence": text[max(0, match.start() - 35):match.end() + 80]})
    unique = {(row["min"], row["max"]) for row in candidates}
    if len(unique) == 1:
        result = candidates[0]
        values = {float(match[1]) for match in defaults}
        if len(values) == 1 and result["min"] <= next(iter(values)) <= result["max"]:
            result["default"] = next(iter(values))
            result["evidence"] += " · " + defaults[0][0]
        elif values:
            return {"evidence": text[:1600], "notice": "默认权重存在歧义或超出推荐区间，请核对后填写"}
        return result
    return {"evidence": text[:1600], "notice": "说明中存在多个权重建议，请核对原文后填写" if unique else "未识别到明确的权重建议，请参照作者说明手动填写"}


def fetch_recommendation(model, source_url=""):
    installed = lora_preview_store.installed_models()
    key = lora_preview_store.model_key(model)
    path = installed.get(key)
    if not path:
        raise ValueError("本机未找到此 LoRA 模型")
    version_id = None
    if source_url:
        if not isinstance(source_url, str) or len(source_url) > 1000:
            raise ValueError("来源链接无效")
        parsed = urlparse(source_url)
        if parsed.scheme != "https" or parsed.hostname not in ("civitai.com", "www.civitai.com") or parsed.username or parsed.port:
            raise ValueError("自动读取目前支持 Civitai HTTPS 版本链接；其他来源可手动填写")
        version_id = parse_qs(parsed.query).get("modelVersionId", [None])[0]
        direct = re.fullmatch(r"/api/v1/model-versions/(\d+)/?", parsed.path)
        version_id = version_id or (direct[1] if direct else None)
        if not version_id or not str(version_id).isdigit():
            raise ValueError("请复制包含 modelVersionId 的 C 站版本链接；留空可按本机文件哈希匹配")
    if version_id:
        version = _get("model-versions/" + str(int(version_id)))
        match = "版本链接"
    else:
        stamp = path.stat()
        digest = _sha256(str(path), stamp.st_size, stamp.st_mtime_ns)
        version = _get("model-versions/by-hash/" + digest)
        match = "本机文件 SHA256"
    if type(version.get("id")) is not int or type(version.get("modelId")) is not int:
        raise ValueError("来源站未返回有效的模型版本")
    result = parse_recommendation(version.get("description"))
    rating = metadata_rating(version)
    # Version-level advice takes priority; the model description is only a fallback.
    if "min" not in result and result.get("notice", "").startswith("未识别"):
        model_data = _get("models/" + str(version["modelId"]))
        if rating == "unknown":
            rating = metadata_rating(model_data)
        fallback = parse_recommendation(model_data.get("description"))
        if "min" in fallback:
            result = fallback
    result.update(source="Civitai", url=f'https://civitai.com/models/{version["modelId"]}?modelVersionId={version["id"]}', version=str(version.get("name", ""))[:200], matchedBy=match)
    result["content"] = {"rating": rating, "source": "Civitai"}
    result["base_model"] = str(version.get("baseModel") or "")[:200]
    return result
