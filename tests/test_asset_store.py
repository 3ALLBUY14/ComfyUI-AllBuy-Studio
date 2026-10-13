"""Shared originals, legacy reads and streaming upload regression tests."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_pkg = types.ModuleType("vpl")
_pkg.__path__ = [PKG_DIR]
sys.modules.setdefault("vpl", _pkg)
store = importlib.import_module("vpl.asset_store")
media = importlib.import_module("vpl.media_asset")
cover = importlib.import_module("vpl.cover")
api = importlib.import_module("vpl.api")


def png(color=(12, 34, 56, 90)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (32, 24), color).save(buf, format="PNG")
    return buf.getvalue()


class StoreFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.managed = self.base / "media"
        self.legacy = self.base / "covers"
        self.managed.mkdir()
        self.legacy.mkdir()
        self.patches = [patch.object(media, "media_root", return_value=str(self.managed)),
                        patch.object(cover, "covers_root", return_value=str(self.legacy))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def original(self, name, raw):
        path = self.base / name
        path.write_bytes(raw)
        return path


class SharedOriginalTests(StoreFixture, unittest.TestCase):
    def test_renaming_or_removing_original_does_not_break_references(self):
        raw = png()
        original = self.original("original.png", raw)
        saved = store.import_file(original, "original.png")
        moved = original.rename(self.base / "moved.png")
        second = store.import_file(moved, "renamed.png")
        moved.unlink()
        self.assertEqual(saved["asset_id"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(second["name"], saved["name"])
        self.assertTrue(second["reused"])
        self.assertEqual(second["original_name"], "renamed.png")
        self.assertEqual(Path(store.resolve(saved["name"])).read_bytes(), raw)
        self.assertEqual(cover.resolve_cover_name(saved["name"]), media.resolve_media_path(saved["file"]))
        self.assertEqual(len(list(self.managed.iterdir())), 1)

    def test_same_name_different_content_is_never_overwritten(self):
        a = store.import_file(self.original("a.png", png()), "same.png")
        b_raw = png((0, 1, 2, 3))
        b = store.import_file(self.original("b.png", b_raw), "same.png")
        self.assertNotEqual(a["asset_id"], b["asset_id"])
        self.assertEqual(Path(store.resolve(a["name"])).read_bytes(), png())
        self.assertEqual(Path(store.resolve(b["name"])).read_bytes(), b_raw)

    def test_image_suffix_comes_from_actual_format_and_original_bytes_survive(self):
        raw = png()
        saved = store.import_file(self.original("wrong.jpg", raw), "wrong.jpg")
        self.assertTrue(saved["name"].endswith(".png"))
        self.assertEqual(Path(store.resolve(saved["name"])).read_bytes(), raw)

    def test_parallel_imports_publish_one_complete_file(self):
        raw = png()
        sources = [self.original(f"{i}.png", raw) for i in range(12)]
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda p: store.import_file(p, p.name), sources))
        self.assertEqual(len({r["asset_id"] for r in results}), 1)
        self.assertEqual(sum(not r["reused"] for r in results), 1)
        self.assertEqual(len(list(self.managed.iterdir())), 1)

    def test_duplicate_with_different_video_suffix_reuses_file(self):
        original = self.original("clip.mp4", b"test container bytes")
        a = store.import_file(original, "clip.mp4")
        b = store.import_file(original, "renamed.mov")
        self.assertEqual(a["name"], b["name"])
        self.assertTrue(b["reused"])

    def test_corrupt_managed_file_is_repaired(self):
        original = self.original("original.png", png())
        saved = store.import_file(original, original.name)
        target = Path(store.resolve(saved["name"]))
        target.write_bytes(b"x" * target.stat().st_size)
        repaired = store.import_file(original, original.name)
        self.assertFalse(repaired["reused"])
        self.assertEqual(target.read_bytes(), png())

    def test_invalid_names_and_external_consume_are_rejected(self):
        original = self.original("original.png", png())
        with self.assertRaises(ValueError):
            store.import_file(original, "original.png", consume_upload=True)
        self.assertTrue(original.exists())
        for name in ["", "../" + "a" * 64 + ".png", "a" * 64 + ".exe"]:
            self.assertEqual(store.resolve(name), "")

    def test_legacy_cover_and_media_references_stay_readable(self):
        old = cover.save_image(png())
        old_path = cover.resolve_cover_name(old)
        self.assertTrue(Path(old_path).is_file())
        original = self.managed / "old name.png"
        original.write_bytes(png())
        self.assertEqual(media.resolve_media_path("allbuy_media/old name.png"), str(original))

    def test_cover_cleanup_never_deletes_shared_originals(self):
        saved = store.import_file(self.original("original.png", png()), "original.png")
        with patch.object(cover, "_disk_refs", return_value=set()):
            cover.prune_orphans({"groups": [{"cover": saved["name"]}]})
            cover.prune_orphans({"groups": []})
        self.assertTrue(Path(store.resolve(saved["name"])).is_file())


class Part:
    def __init__(self, name, data, filename=None, fail=False):
        self.name, self.data, self.filename = name, data, filename
        self.offset, self.fail = 0, fail

    async def text(self):
        return self.data.decode()

    async def read_chunk(self, size):
        if self.fail and self.offset:
            raise ConnectionError("upload interrupted")
        chunk = self.data[self.offset:self.offset + min(size, 17)]
        self.offset += len(chunk)
        return chunk


class Request:
    def __init__(self, parts=(), query=None):
        self.parts, self.query = parts, query or {}

    async def multipart(self):
        async def reader():
            for part in self.parts:
                yield part
        return reader()


def upload_request(raw, filename, preview=False, fail=False):
    parts = [Part("file", raw, filename, fail)]
    if preview:
        parts.append(Part("group_id", b"group-1"))
    return Request(parts)


class UploadApiTests(StoreFixture, unittest.IsolatedAsyncioTestCase):
    async def test_media_and_cover_upload_share_an_original_in_either_order(self):
        for first_cover in (True, False):
            raw = png((1, 2, 3, 4) if first_cover else (5, 6, 7, 8))
            async def upload(preview):
                route = api.cover_upload if preview else api.media_upload
                response = await route(upload_request(raw, "renamed.png", preview))
                self.assertEqual(response.status, 200)
                return json.loads(response.body)
            first = await upload(first_cover)
            second = await upload(not first_cover)
            self.assertEqual(first["asset_id"], second["asset_id"])
            self.assertEqual(first["file"], second["file"])
            self.assertTrue(second["reused"])
            preview_data = first if first_cover else second
            response = await api.cover_file(Request(query={"name": preview_data["cover"], "w": "128"}))
            self.assertEqual(response.status, 200)
        self.assertEqual(len(list(self.managed.iterdir())), 2)
        self.assertEqual(list(self.legacy.iterdir()), [])

    async def test_video_preview_uses_same_original_for_first_frame(self):
        import cv2
        import numpy as np
        original = self.base / "video.mp4"
        writer = cv2.VideoWriter(str(original), cv2.VideoWriter_fourcc(*"mp4v"), 12, (32, 24))
        writer.write(np.zeros((24, 32, 3), dtype="uint8"))
        writer.release()
        raw = original.read_bytes()
        a = json.loads((await api.media_upload(upload_request(raw, "one.mp4"))).body)
        b = json.loads((await api.cover_upload(upload_request(raw, "two.mp4", True))).body)
        self.assertEqual(a["asset_id"], b["asset_id"])
        self.assertEqual(b["cover"], b["cover_video"])
        for _ in range(2):
            response = await api.cover_file(Request(query={"name": b["cover"], "w": "240"}))
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "image/jpeg")
        self.assertEqual(len(list(self.managed.iterdir())), 1)
        self.assertEqual(list(self.legacy.iterdir()), [])

    async def test_interrupted_invalid_and_oversized_uploads_leave_no_files(self):
        requests = [upload_request(png(), "broken.png", fail=True),
                    upload_request(b"invalid", "invalid.png"),
                    upload_request(png(), "too-large.png", True)]
        with patch.object(api, "_COVER_IMAGE_MAX", 10):
            for i, request in enumerate(requests):
                route = api.cover_upload if i == 2 else api.media_upload
                response = await route(request)
                self.assertGreaterEqual(response.status, 400)
                self.assertEqual(list(self.managed.iterdir()), [])

    async def test_missing_group_or_multiple_files_is_rejected_before_publication(self):
        response = await api.cover_upload(upload_request(png(), "missing-group.png"))
        self.assertEqual(response.status, 400)
        response = await api.media_upload(Request([Part("file", png(), "a.png"), Part("file", png(), "b.png")]))
        self.assertEqual(response.status, 400)
        self.assertEqual(list(self.managed.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
