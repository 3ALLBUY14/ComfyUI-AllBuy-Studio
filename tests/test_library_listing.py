"""Internal LoRA data stays out of prompt-library lists and cannot be overwritten."""
import asyncio
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


class LibraryListingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.user = Path(self.tmp.name) / "user"
        self.builtin = Path(self.tmp.name) / "builtin"
        self.user.mkdir()
        self.builtin.mkdir()
        self.folder_patch = patch.object(store, "get_user_libraries_folder", return_value=str(self.user))
        self.builtin_patch = patch.object(store.constants, "BUILTIN_LIBRARIES_FOLDER", str(self.builtin))
        self.folder_patch.start()
        self.builtin_patch.start()
        self.internal_names = ("lora_groups", "lora_catalog", "LORA_PRESETS")
        for name in self.internal_names:
            (self.user / f"{name}.json").write_text(json.dumps({"groups": [{"id": "internal"}]}), encoding="utf-8")
        store.create_library("Empty library")
        store.create_library("lora_catalog_extra")
        (self.builtin / "default.json").write_text(json.dumps({"name": "Example", "groups": [{"id": "a"}]}), encoding="utf-8")

    def tearDown(self):
        self.builtin_patch.stop()
        self.folder_patch.stop()
        self.tmp.cleanup()

    def test_internal_files_hidden_in_store_and_api_but_real_empty_libraries_remain(self):
        expected = {("builtin", "default"), ("user", "Empty library"), ("user", "lora_catalog_extra")}
        libraries = store.list_libraries()
        self.assertEqual({(entry["source"], entry["name"]) for entry in libraries}, expected)
        self.assertEqual(next(entry["count"] for entry in libraries if entry["name"] == "Empty library"), 0)
        response = asyncio.run(api.list_libraries(None))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)["libraries"], libraries)

    def test_cover_scan_only_includes_prompt_libraries(self):
        self.assertEqual({Path(path).stem for path in store.all_library_paths()},
                         {"default", "Empty library", "lora_catalog_extra"})

    def test_prompt_library_actions_cannot_modify_internal_data(self):
        original = {name: (self.user / f"{name}.json").read_bytes() for name in self.internal_names}
        for name in self.internal_names:
            for variant in (name, name.upper()):
                locator = {"source": "user", "name": variant}
                actions = [lambda: store.create_library(variant),
                           lambda: store.save_library(locator, {"groups": []}),
                           lambda: store.delete_library(variant),
                           lambda: store.rename_library(locator, "Renamed"),
                           lambda: store.rename_library({"source": "user", "name": "Empty library"}, variant)]
                for index, action in enumerate(actions):
                    with self.subTest(name=variant, action=index), self.assertRaises(ValueError):
                        action()
        for name, content in original.items():
            self.assertEqual((self.user / f"{name}.json").read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
