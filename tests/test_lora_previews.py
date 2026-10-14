"""Sidecar discovery, isolated overrides, safe resolution and playable HTTP media."""
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

ROOT = str(Path(__file__).resolve().parents[1])
pkg = types.ModuleType("vpl")
pkg.__path__ = [ROOT]
sys.modules.setdefault("vpl", pkg)
store = importlib.import_module("vpl.lora_preview_store")
api = importlib.import_module("vpl.api")


class Fixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.models = self.root / "loras"
        self.user = self.root / "user"
        self.managed = self.root / "managed"
        for directory in (self.models, self.user, self.managed):
            directory.mkdir()
        self.model = self.models / "sample.safetensors"
        self.model.write_bytes(b"model")
        self.installed = {"folder/sample.safetensors": self.model}
        self.patches = [patch.object(store, "installed_models", side_effect=lambda: self.installed),
                        patch.object(store.library_store, "get_user_libraries_folder", return_value=str(self.user)),
                        patch.object(store.asset_store, "root", return_value=self.managed)]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def image(self, path):
        Image.new("RGB", (64, 48), (80, 120, 180)).save(path)
        return path


class PreviewStoreTests(Fixture, unittest.TestCase):
    def test_discovery_prioritizes_matching_preview_and_keeps_both_kinds(self):
        self.image(self.models / "sample.jpg")
        self.image(self.models / "sample.preview.png")
        (self.models / "sample.preview.mp4").write_bytes(b"video")
        self.image(self.models / "sample-other.png")
        record = store.list_previews()["models"]["folder/sample.safetensors"]
        self.assertEqual(record["image"]["filename"], "sample.preview.png")
        self.assertEqual(record["video"]["filename"], "sample.preview.mp4")
        self.assertEqual(record["image"]["source"], "sidecar")
        self.assertIn("poster=1", record["video"]["poster"])
        self.assertEqual(parse_qs(urlparse(record["image"]["url"]).query)["model"], ["folder/sample.safetensors"])
        self.assertFalse((self.user / "lora_previews.json").exists(), "Discovery must not write metadata")

    def test_numbered_full_filename_case_and_unicode_matching(self):
        self.image(self.models / "sample.preview.0.jpg")
        self.assertEqual(Path(store.resolve_preview(r"folder\sample.safetensors", "image")).name, "sample.preview.0.jpg")
        self.image(self.models / "sample.safetensors.preview.JPG")
        self.assertEqual(Path(store.resolve_preview("folder/sample.safetensors", "image")).name, "sample.safetensors.preview.JPG")
        model = self.models / "猫 #1.safetensors"
        model.write_bytes(b"model")
        self.installed["角色/猫 #1.safetensors"] = model
        self.image(self.models / "猫 #1.png")
        record = store.list_previews()["models"]["角色/猫 #1.safetensors"]
        self.assertEqual(parse_qs(urlparse(record["image"]["url"]).query)["model"], ["角色/猫 #1.safetensors"])

    def test_same_basename_in_different_folders_stays_independent(self):
        other = self.root / "other"
        other.mkdir()
        second = other / "sample.safetensors"
        second.write_bytes(b"second")
        self.installed["other/sample.safetensors"] = second
        a, b = self.image(self.models / "sample.png"), self.image(other / "sample.jpg")
        self.assertEqual(store.resolve_preview("folder/sample.safetensors", "image"), str(a))
        self.assertEqual(store.resolve_preview("other/sample.safetensors", "image"), str(b))

    def test_custom_override_preserves_other_kind_and_reset_retains_files(self):
        sidecar = self.image(self.models / "sample.png")
        custom = self.image(self.root / "custom.png")
        video = self.root / "custom.mp4"
        video.write_bytes(b"0123456789")
        store.update_preview({"model": r"folder\sample.safetensors", "image": str(custom), "video": str(video)})
        result = store.update_preview({"model": "folder/sample.safetensors", "image": None})
        self.assertEqual(result["image"]["source"], "sidecar")
        self.assertEqual(result["video"]["source"], "custom")
        self.assertEqual(store.resolve_preview("folder/sample.safetensors", "image"), str(sidecar))
        self.assertTrue(custom.exists())
        self.assertTrue(video.exists())

    def test_uploaded_content_reference_and_missing_file_fallback(self):
        source = self.image(self.root / "upload.png")
        saved = store.asset_store.import_file(source, "upload.png")
        result = store.update_preview({"model": "folder/sample.safetensors", "image": saved["name"]})
        self.assertEqual(result["image"]["source"], "custom")
        self.assertEqual(store.resolve_preview("folder/sample.safetensors", "image"), store.asset_store.resolve(saved["name"]))
        Path(store.asset_store.resolve(saved["name"])).unlink()
        self.image(self.models / "sample.jpg")
        result = store.list_previews()["models"]["folder/sample.safetensors"]
        self.assertEqual(result["missing"], ["image"])
        self.assertEqual(result["image"]["source"], "sidecar")

    def test_invalid_update_does_not_change_existing_mapping(self):
        image = self.image(self.root / "custom.png")
        store.update_preview({"model": "folder/sample.safetensors", "image": str(image)})
        previous = store._path().read_bytes()
        invalid = [None, {}, {"model": "unknown", "image": str(image)},
                   {"model": "folder/sample.safetensors", "image": 123},
                   {"model": "folder/sample.safetensors", "video": str(image)},
                   {"model": "folder/sample.safetensors", "image": "relative.png"},
                   {"model": "folder/sample.safetensors", "image": "https://example.test/a.png"}]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises((ValueError, FileNotFoundError)):
                store.update_preview(item)
            self.assertEqual(store._path().read_bytes(), previous)
        for kind in ("audio", "image"):
            with self.assertRaises((ValueError, FileNotFoundError)):
                store.resolve_preview("not-a-registered-model", kind)

    def test_corrupt_primary_recovers_without_overwriting_valid_backup(self):
        image = self.image(self.root / "custom.png")
        store.update_preview({"model": "folder/sample.safetensors", "image": str(image)})
        store.update_preview({"model": "folder/sample.safetensors", "image": None})
        store._path().write_text('{"models":{"bad":{"image":123}}}', encoding="utf-8")
        store.update_preview({"model": "folder/sample.safetensors", "video": None})
        self.assertEqual(store.resolve_preview("folder/sample.safetensors", "image"), str(image))
        backup = json.loads(Path(str(store._path()) + ".backup").read_text(encoding="utf-8"))
        self.assertEqual(backup["models"]["folder/sample.safetensors"]["image"], str(image))

    def test_parallel_model_updates_preserve_every_override(self):
        image = self.image(self.root / "custom.png")
        for index in range(8):
            model = self.models / f"model{index}.safetensors"
            model.write_bytes(b"model")
            self.installed[f"model{index}.safetensors"] = model
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda index: store.update_preview({"model": f"model{index}.safetensors", "image": str(image)}), range(8)))
        self.assertEqual(len(store._read()["models"]), 8)

    def test_preview_metadata_is_not_a_prompt_library(self):
        self.assertIn("lora_previews", store.library_store._RESERVED_LIBRARY_NAMES)
        with self.assertRaises(ValueError):
            store.library_store.create_library("lora_previews")
        image = self.image(self.root / "custom.png")
        store.update_preview({"model": "folder/sample.safetensors", "image": str(image)})
        self.assertNotIn("lora_previews", [item["name"] for item in store.library_store.list_libraries()])

    def test_discovered_symlink_cannot_escape_model_folder(self):
        outside = self.image(self.root / "private.png")
        try:
            (self.models / "sample.png").symlink_to(outside)
        except OSError:
            self.skipTest("Symbolic links are unavailable on this host")
        with self.assertRaises(FileNotFoundError):
            store.resolve_preview("folder/sample.safetensors", "image")


class PreviewApiTests(Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        application = web.Application()
        application.router.add_get("/previews", api.lora_previews)
        application.router.add_post("/update", api.lora_previews_update)
        application.router.add_get("/file", api.lora_preview_file)
        self.client = TestClient(TestServer(application))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_image_thumbnail_and_original_are_readable(self):
        image = self.image(self.models / "sample.png")
        response = await self.client.get("/file", params={"model": "folder/sample.safetensors", "kind": "image", "w": 32})
        self.assertEqual(response.status, 200)
        self.assertEqual(Image.open(io.BytesIO(await response.read())).size, (32, 24))
        response = await self.client.get("/file", params={"model": "folder/sample.safetensors", "kind": "image"})
        self.assertEqual(await response.read(), image.read_bytes())

    async def test_video_range_requests_support_seeking(self):
        (self.models / "sample.mp4").write_bytes(b"0123456789")
        response = await self.client.get("/file", params={"model": "folder/sample.safetensors", "kind": "video"}, headers={"Range": "bytes=2-5"})
        self.assertEqual(response.status, 206)
        self.assertEqual(await response.read(), b"2345")

    async def test_update_roundtrip_and_invalid_media_route(self):
        image = self.image(self.root / "custom.png")
        response = await self.client.post("/update", json={"model": "folder/sample.safetensors", "image": str(image)})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["preview"]["image"]["source"], "custom")
        response = await self.client.get("/previews")
        self.assertEqual((await response.json())["models"]["folder/sample.safetensors"]["image"]["source"], "custom")
        for params, status in [({"model": "unknown", "kind": "image"}, 404), ({"model": "folder/sample.safetensors", "kind": "audio"}, 400)]:
            response = await self.client.get("/file", params=params)
            self.assertEqual(response.status, status)

    async def test_video_poster_is_generated_without_persisting_a_copy(self):
        import cv2
        import numpy as np
        video = self.models / "sample.mp4"
        writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 12, (64, 48))
        writer.write(np.zeros((48, 64, 3), dtype="uint8"))
        writer.release()
        before = set(self.models.iterdir())
        response = await self.client.get("/file", params={"model": "folder/sample.safetensors", "kind": "video", "poster": 1, "w": 32})
        self.assertEqual(response.status, 200)
        self.assertEqual(Image.open(io.BytesIO(await response.read())).size, (32, 24))
        self.assertEqual(set(self.models.iterdir()), before)
