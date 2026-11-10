"""Read author recommendations without importing unrelated image-generation weights."""
import hashlib
import html
import json
import os
import re
import socket
import ssl
import threading
import time
from collections import OrderedDict
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from . import lora_preview_store, civitai_auth, civitai_network
from .lora_content import metadata_rating


class _CivitaiRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "civitai.com" or parsed.username or parsed.port:
            raise ValueError("来源站返回了意外的跳转")
        return super().redirect_request(request, response, code, message, headers, url)


class CivitaiError(ValueError):
    def __init__(self, message, code=0, retry_after=0):
        super().__init__(message)
        self.code, self.retry_after = code, retry_after


def _get(path, token=None):
    token = civitai_auth.get_key() if token is None else token
    headers = {"User-Agent": "AllBuy-Studio/1", "Accept": "application/json"}
    if token: headers['Authorization'] = 'Bearer ' + token
    try:
        with build_opener(civitai_network.handler(), _CivitaiRedirect()).open(Request("https://civitai.com/api/v1/" + path, headers=headers), timeout=8) as response:
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
        retry = error.headers.get('Retry-After', '') if error.headers else ''
        raise CivitaiError({404: "C 站未找到对应版本，请填写准确的版本链接", 401: "API Key 无效或需要授权，请检查 C 站 API 授权设置", 403: "C 站拒绝访问，请检查账户权限或稍后重试", 429: "C 站请求过于频繁，请稍后重试"}.get(error.code, "来源站暂时不可用"), error.code, int(retry) if retry.isdigit() else 0) from error
    except json.JSONDecodeError as error:
        raise CivitaiError('C 站返回了网页或无效数据，可能触发了安全验证，请检查当前代理线路', -1) from error
    except (URLError, TimeoutError, OSError) as error:
        reason = getattr(error, 'reason', error)
        route = civitai_network.route()['label']
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise CivitaiError('HTTPS 证书验证失败，请检查代理 HTTPS 拦截和 Python 证书配置；当前使用' + route, -1) from error
        if isinstance(reason, ssl.SSLError):
            raise CivitaiError('TLS 握手失败，请检查 HTTP 代理端口与线路；当前使用' + route, -1) from error
        if isinstance(reason, socket.gaierror): message = '域名解析失败，请检查 DNS 或代理'
        elif isinstance(reason, ConnectionRefusedError): message = '连接被拒绝，请检查代理软件和端口是否开启'
        elif isinstance(reason, TimeoutError): message = '连接 C 站超时，请检查代理线路'
        else: message = '无法连接 C 站，请检查代理和网络'
        raise CivitaiError(message + '；当前使用' + route) from error


_hash_cache = OrderedDict()
_hash_lock = threading.Lock()


class FetchCancelled(ValueError):
    pass


def _sha256(path, size, modified, stop=None, progress=None):
    key = (path, size, modified)
    with _hash_lock:
        if key in _hash_cache:
            _hash_cache.move_to_end(key)
            return _hash_cache[key]
    digest = hashlib.sha256()
    done = 0; last = 0
    with open(path, "rb") as stream:
        while True:
            if stop and stop.is_set(): raise FetchCancelled('获取已停止')
            block = stream.read(4 * 1024 * 1024)
            if not block: break
            digest.update(block)
            done += len(block)
            if progress and (time.monotonic() - last >= .2 or done >= size):
                progress('计算文件 SHA256', done, size); last = time.monotonic()
    if stop and stop.is_set(): raise FetchCancelled('获取已停止')
    stamp = os.stat(path)
    if (stamp.st_size, stamp.st_mtime_ns) != (size, modified): raise ValueError('读取期间模型文件发生变化，请重试')
    result = digest.hexdigest()
    with _hash_lock:
        _hash_cache[key] = result
        while len(_hash_cache) > 128: _hash_cache.popitem(last=False)
    return result


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


def _lookup_version(model, source_url="", stop=None, progress=None):
    if stop and stop.is_set(): raise FetchCancelled('获取已停止')
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
        if progress: progress('读取 C 站版本信息', 0, 0)
        version = _get("model-versions/" + str(int(version_id)))
        match = "版本链接"
    else:
        stamp = path.stat()
        if progress: progress('计算文件 SHA256', 0, stamp.st_size)
        digest = _sha256(str(path), stamp.st_size, stamp.st_mtime_ns, stop, progress)
        if stop and stop.is_set(): raise FetchCancelled('获取已停止')
        if progress: progress('按文件哈希匹配 C 站版本', 0, 0)
        version = _get("model-versions/by-hash/" + digest)
        match = "本机文件 SHA256"
    if type(version.get("id")) is not int or type(version.get("modelId")) is not int:
        raise ValueError("来源站未返回有效的模型版本")
    return version, match


def fetch_recommendation(model, source_url=""):
    version, match = _lookup_version(model, source_url)
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


def fetch_model_info(model, source_url="", *, stop=None, progress=None):
    version, match = _lookup_version(model, source_url, stop, progress)
    if stop and stop.is_set(): raise FetchCancelled('获取已停止')
    if progress: progress('读取作者说明与模型信息', 0, 0)
    parent = _get("models/" + str(version["modelId"]))
    if parent.get("type") not in (None, "LORA", "LoCon", "DoRA"):
        raise ValueError("此链接对应的不是 LoRA 模型，请检查版本链接")
    def text(value, limit):
        return html.unescape(re.sub(r"<[^>]*>", " ", value if isinstance(value, str) else "")).strip()[:limit]
    description = text(version.get("description"), 10000)
    model_description = text(parent.get("description"), 10000)
    advice = parse_recommendation(version.get("description"))
    if advice.get("notice", "").startswith("未识别"):
        advice = parse_recommendation(parent.get("description"))
    rating = metadata_rating(version)
    parent_rating = metadata_rating(parent)
    if parent_rating == "nsfw" or rating == "unknown": rating = parent_rating
    url = f'https://civitai.com/models/{version["modelId"]}?modelVersionId={version["id"]}'
    advice.update(source="Civitai", url=url, version=text(version.get("name"), 200), matchedBy=match, base_model=text(version.get("baseModel"), 200), content={"rating": rating, "source": "Civitai"})
    words = version.get("trainedWords", [])
    return {"name": text(parent.get("name"), 200), "base_model": advice["base_model"], "version": advice["version"], "url": url,
            "description": (description + ("\n\n" + model_description if model_description and model_description != description else "")).strip()[:20000],
            "trigger": ", ".join(dict.fromkeys(text(word, 200) for word in words[:200] if isinstance(word, str) and word.strip()))[:16000] if isinstance(words, list) else "",
            "tags": [],  # Classification is managed by the user, independently of Civitai metadata.
            "rating": rating, "matchedBy": match, "recommendation": advice}
