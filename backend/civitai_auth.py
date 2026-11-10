"""Optional Civitai credential, kept outside the plugin and model catalog."""
import json
import os
import tempfile
import threading
from pathlib import Path
from . import library_store

_lock = threading.Lock()


def _path():
    return Path(library_store.get_user_libraries_folder()) / 'civitai_auth.json'


def _validate(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value.strip()):
        raise ValueError('请填写有效的 C 站 API Key')
    return value.strip()


def _local_key():
    try:
        return _validate(json.loads(_path().read_text(encoding='utf-8')).get('api_key'))
    except (OSError, ValueError, AttributeError):
        return ''


def get_key():
    with _lock:
        return _validate(os.environ['CIVITAI_API_KEY']) if os.environ.get('CIVITAI_API_KEY') else _local_key()


def status():
    return {'configured': bool(get_key()), 'source': '环境变量' if os.environ.get('CIVITAI_API_KEY') else '本地密钥' if get_key() else '未配置'}


def update(data):
    if not isinstance(data, dict) or data.get('action') not in ('save', 'clear'):
        raise ValueError('授权设置格式错误')
    if data['action'] == 'save':
        if os.environ.get('CIVITAI_API_KEY'):
            raise ValueError('当前使用环境变量，请先移除 CIVITAI_API_KEY 再保存本地密钥')
        key = _validate(data.get('api_key'))
        from .lora_recommendations import _get
        profile = _get('me', token=key)
        if not profile.get('id') and not profile.get('username'):
            raise ValueError('C 站未返回有效授权，请检查 API Key')
        with _lock:
            target = _path()
            descriptor, name = tempfile.mkstemp(prefix='.civitai-', suffix='.tmp', dir=target.parent)
            try:
                with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                    json.dump({'api_key': key}, stream)
                os.chmod(name, 0o600)
                os.replace(name, target)
            finally:
                if os.path.exists(name): os.unlink(name)
    else:
        with _lock:
            _path().unlink(missing_ok=True)
    return status()
