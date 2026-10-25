"""Library renaming keeps saved references, groups and media intact."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

pkg = types.ModuleType("vpl")
pkg.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules.setdefault("vpl", pkg)

# CI/离线环境补缺失模块桩（本机有真实库时不干预）；必须在导入 vpl.* 之前
try:
    from tests import _offline_stubs  # noqa: F401  (unittest 包路径)
except ImportError:
    import _offline_stubs  # noqa: F401  (pytest 顶层模块路径)

store = importlib.import_module("vpl.library_store")
api = importlib.import_module("vpl.api")


class RenameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = patch.object(store, "get_user_libraries_folder", return_value=self.tmp.name)
        self.folder.start()
        self.locator = store.create_library("Original")
        self.data = {"name": "Original", "groups": [{"id": "a", "positive": "内容",
                     "cover": "same.png", "coverVideo": "same.mp4"}],
                     "meta": {"categories": ["人物"]}, "unknown": {"keep": True}}
        store.save_library(self.locator, self.data)
        self.path = Path(self.tmp.name) / "Original.json"

    def tearDown(self):
        self.folder.stop()
        self.tmp.cleanup()

    def test_rename_keeps_file_and_old_locator_valid(self):
        result = store.rename_library(self.locator, "  新名称  ")
        self.assertEqual(result, self.locator)
        expected = {**self.data, "name": "新名称", "version": 1}
        self.assertEqual(store.load_library(self.locator), expected)
        self.assertTrue(self.path.is_file())
        self.assertFalse((Path(self.tmp.name) / "新名称.json").exists())
        entry = next(l for l in store.list_libraries() if l["source"] == "user")
        self.assertEqual((entry["name"], entry["display_name"], entry["count"]), ("Original", "新名称", 1))
        self.assertEqual(json.loads(Path(str(self.path) + ".backup").read_text(encoding="utf-8")), self.data)

    def test_repeated_rename_and_save_using_original_locator(self):
        store.rename_library(json.dumps(self.locator), "First")
        store.rename_library(self.locator, "Second")
        data = store.load_library(self.locator)
        data["groups"].append({"id": "b", "positive": "new"})
        store.save_library(self.locator, data)
        self.assertEqual(store.load_library(self.locator)["name"], "Second")
        self.assertEqual(len(store.load_library(self.locator)["groups"]), 2)

    def test_invalid_names_and_readonly_sources_leave_disk_unchanged(self):
        before = self.path.read_bytes()
        for name in [None, "", "   ", 12, "lora_groups", "LORA_GROUPS"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                store.rename_library(self.locator, name)
        for source in ["builtin", "custom", "inline", "unknown"]:
            with self.subTest(source=source), self.assertRaises(PermissionError):
                store.rename_library({"source": source, "name": "Original"}, "Other")
        self.assertEqual(self.path.read_bytes(), before)

    def test_duplicate_display_or_file_names_rejected(self):
        other = store.create_library("Other")
        store.rename_library(other, "Display")
        for name in ["other", "DISPLAY"]:
            with self.subTest(name=name), self.assertRaises(FileExistsError):
                store.rename_library(self.locator, name)
        self.assertEqual(store.load_library(self.locator)["name"], "Original")

    def test_missing_or_corrupt_library_is_not_recreated(self):
        with self.assertRaises(FileNotFoundError):
            store.rename_library({"source": "user", "name": "missing"}, "New")
        self.path.write_text("broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            store.rename_library(self.locator, "New")
        self.assertEqual(self.path.read_text(encoding="utf-8"), "broken")

    def test_atomic_write_failure_preserves_original(self):
        before = self.path.read_bytes()
        with patch.object(store.os, "replace", side_effect=OSError("write failed")):
            with self.assertRaises(OSError):
                store.rename_library(self.locator, "New")
        self.assertEqual(self.path.read_bytes(), before)

    def test_concurrent_rename_cannot_create_duplicate_names(self):
        other = store.create_library("Other")

        def rename(locator):
            try:
                store.rename_library(locator, "Shared")
                return True
            except FileExistsError:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(rename, [self.locator, other]))
        self.assertEqual(sum(results), 1)

    def test_api_validation_success_and_errors(self):
        class Request:
            def __init__(self, body):
                self.body = body

            async def json(self):
                return self.body

        cases = [(None, 400), ({}, 400), ({"locator": self.locator, "name": 5}, 400),
                 ({"locator": {"source": "builtin", "name": "default"}, "name": "New"}, 403),
                 ({"locator": {"source": "user", "name": "missing"}, "name": "New"}, 404),
                 ({"locator": self.locator, "name": " New "}, 200)]
        for body, status in cases:
            with self.subTest(body=body):
                response = asyncio.run(api.rename_library(Request(body)))
                self.assertEqual(response.status, status)
                result = json.loads(response.body)
                self.assertEqual(result["ok"], status == 200)
                if status == 200:
                    self.assertEqual(result["display_name"], "New")
                    self.assertEqual(result["locator"], self.locator)


if __name__ == "__main__":
    unittest.main()
