"""Civitai-only routing; never change ComfyUI's process-wide proxy settings."""
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, getproxies
import urllib.request
from . import library_store

_lock = threading.Lock()


def _path():
    return Path(library_store.get_user_libraries_folder()) / 'civitai_network.json'


def _proxy(value):
    if not isinstance(value, str) or len(value) > 1000: raise ValueError('HTTP 代理地址无效')
    value = value.strip()
    if any(c.isspace() for c in value): raise ValueError('HTTP 代理地址不能包含空白字符')
    if '://' not in value: value = 'http://' + value
    parsed = urlsplit(value)
    try: port = parsed.port
    except ValueError: raise ValueError('HTTP 代理端口无效') from None
    if parsed.scheme != 'http' or not parsed.hostname or not port or parsed.username is not None or parsed.password is not None or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('请填写 HTTP 代理地址，例如 http://127.0.0.1:7890；不要填写 SOCKS 端口或账户密码')
    return 'http://' + parsed.netloc


def _validate(data):
    if not isinstance(data, dict) or data.get('mode') not in ('auto', 'direct', 'custom'): raise ValueError('连接方式无效')
    return {'mode': data['mode'], 'proxy': _proxy(data.get('proxy', '')) if data['mode'] == 'custom' else ''}


def config():
    try: return _validate(json.loads(_path().read_text(encoding='utf-8')))
    except (OSError, ValueError): return {'mode': 'auto', 'proxy': ''}


def update(data):
    value = _validate(data)
    with _lock:
        path = _path(); temporary = path.with_suffix('.json.tmp')
        try:
            temporary.write_text(json.dumps(value), encoding='utf-8')
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    return status()


def route():
    value = config()
    if value['mode'] == 'direct': return {'proxy': '', 'label': '直连'}
    if value['mode'] == 'custom': return {'proxy': value['proxy'], 'label': '自定义代理 · ' + value['proxy']}
    # A launcher can set NO_PROXY=* or stale environment proxies. Prefer the
    # current Windows system proxy and apply it explicitly to Civitai only.
    system = getattr(urllib.request, 'getproxies_registry', lambda: {})()
    address = system.get('https') or system.get('http')
    origin = '系统代理'
    if not address:
        proxies = getproxies(); address = proxies.get('https') or proxies.get('http'); origin = '环境代理'
    if address:
        address = _proxy(address)
        return {'proxy': address, 'label': origin + ' · ' + address}
    return {'proxy': '', 'label': '直连（未检测到 HTTP 代理）'}


class _ExplicitProxy(ProxyHandler):
    def proxy_open(self, request, proxy, kind):
        # ProxyHandler normally obeys global NO_PROXY even for an explicit
        # proxy. This request is scoped to civitai.com, so bypass that check.
        request.set_proxy(urlsplit(proxy).netloc, 'http')


def handler():
    selected = route()
    return _ExplicitProxy({'https': selected['proxy']}) if selected['proxy'] else ProxyHandler({})


def status():
    return {**config(), 'route': route()['label']}


def test_connection():
    from .lora_recommendations import _get, CivitaiError
    start = time.monotonic()
    try:
        _get('me', token='')
    except CivitaiError as error:
        # An anonymous /me must reject auth; HTTP 401 proves this backend can
        # reach the authenticated API without reading or transmitting a key.
        if error.code != 401: raise
    return {'connected': True, 'route': route()['label'], 'elapsed_ms': round((time.monotonic()-start) * 1000)}
