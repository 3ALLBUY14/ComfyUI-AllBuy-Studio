"""Shared, content-addressed originals for media nodes and prompt previews.

Only uploads are stored here. Removing a node or a cover releases its reference;
it never deletes originals that may still be used by a saved workflow.
"""
import hashlib
import os
import pathlib
import re
import shutil
import tempfile
import threading

from . import media_asset

_lock = threading.Lock()
_NAME_RE = re.compile(r"([0-9a-f]{64})\.([a-z0-9]+)")
_IMAGE_FORMATS = {
    "JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp", "GIF": ".gif",
    "BMP": ".bmp", "TIFF": ".tiff",
}


def root():
    return pathlib.Path(media_asset.media_root()).resolve()


def is_managed_name(name):
    return isinstance(name, str) and bool(_NAME_RE.fullmatch(name)) and bool(media_asset.asset_type(name))


def resolve(name):
    """Resolve a content ID filename within the managed directory only."""
    if not is_managed_name(name):
        return ""
    base = root()
    target = (base / name).resolve()
    if target.parent != base or not target.is_file():
        return ""
    return str(target)


def _digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def import_file(source, original_name, *, consume_upload=False):
    """Keep one original per SHA-256, irrespective of upload name or node.

    External originals are copied. The API may consume its own .upload-*.tmp
    files; all published files appear atomically, after the upload completes.
    """
    source = pathlib.Path(source).resolve()
    original_name = (original_name or "").replace("\\", "/").rsplit("/", 1)[-1]
    kind = media_asset.asset_type(original_name)
    if not kind:
        raise ValueError("不支持的素材类型")
    base = root()
    if consume_upload and (source.parent != base or not source.name.startswith(".upload-")
                           or source.suffix != ".tmp"):
        raise ValueError("非法上传临时文件")
    ext = pathlib.Path(original_name).suffix.lower()
    if kind == "image":
        from PIL import Image
        try:
            with Image.open(source) as image:
                ext = _IMAGE_FORMATS.get(image.format)
                if not ext:
                    raise ValueError("不支持的图片格式")
                image.verify()
        except OSError as error:
            raise ValueError("图片无法解码") from error
    digest = _digest(source)
    size = source.stat().st_size
    temporary = None
    with _lock:
        # Also share byte-identical videos uploaded with different container suffixes.
        existing = next((p for p in sorted(base.glob(digest + ".*"))
                         if is_managed_name(p.name) and media_asset.asset_type(p.name) == kind
                         and resolve(p.name) and p.stat().st_size == size and _digest(p) == digest), None)
        reused = existing is not None
        target = existing or (base / (digest + ext))
        if not reused:
            # Refuse an escaped symlink even when the target is not yet readable.
            if target.resolve().parent != base:
                raise ValueError("非法素材路径")
            if consume_upload:
                os.replace(source, target)
            else:
                try:
                    with tempfile.NamedTemporaryFile(prefix=".upload-", suffix=".tmp", dir=base,
                                                     delete=False) as tmp:
                        temporary = pathlib.Path(tmp.name)
                        with open(source, "rb") as stream:
                            shutil.copyfileobj(stream, tmp, 1 << 20)
                    os.replace(temporary, target)
                finally:
                    if temporary:
                        temporary.unlink(missing_ok=True)
        elif consume_upload:
            source.unlink()
    return {
        "asset_id": digest, "name": target.name,
        "file": media_asset.MEDIA_SUBDIR + "/" + target.name,
        "original_name": original_name, "type": kind, "size": size, "reused": reused,
    }
