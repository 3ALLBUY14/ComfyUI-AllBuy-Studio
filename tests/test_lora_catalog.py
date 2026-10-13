"""Classification records must survive edits, backups and concurrent callers."""
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = types.ModuleType("vpl")
pkg.__path__ = [ROOT]
sys.modules.setdefault("vpl", pkg)
store = importlib.import_module("vpl.lora_catalog_store")


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "lora_catalog.json")
        self.folder = patch.object(store.library_store, "get_user_libraries_folder", return_value=self.tmp.name)
        self.folder.start()

    def tearDown(self):
        self.folder.stop()
        self.tmp.cleanup()

    def create(self, name):
        return store.update_catalog({"action": "create_tag", "name": name})

    def test_multi_tag_roundtrip_and_windows_paths(self):
        self.create("人像")
        self.create("画质")
        saved = store.update_catalog({"action": "set_tags", "models": [r"portrait\a.safetensors"], "tags": ["人像", "画质", "人像"]})
        self.assertEqual(saved["models"], {"portrait/a.safetensors": ["人像", "画质"]})
        self.assertEqual(saved, store.load_catalog())

    def test_batch_patch_preserves_mixed_labels(self):
        for tag in ("原有", "新标签", "个人"):
            self.create(tag)
        store.update_catalog({"action": "set_tags", "models": ["a"], "tags": ["原有", "个人"]})
        store.update_catalog({"action": "set_tags", "models": ["b"], "tags": ["原有"]})
        data = store.update_catalog({"action": "patch_tags", "models": ["a", "b"], "add": ["新标签"], "remove": ["原有"]})
        self.assertEqual(data["models"], {"a": ["个人", "新标签"], "b": ["新标签"]})

    def test_rename_and_delete_update_all_model_links(self):
        self.create("旧名")
        store.update_catalog({"action": "set_tags", "models": ["a", "b"], "tags": ["旧名"]})
        data = store.update_catalog({"action": "rename_tag", "name": "旧名", "new_name": "新名"})
        self.assertEqual(data["models"], {"a": ["新名"], "b": ["新名"]})
        data = store.update_catalog({"action": "delete_tag", "name": "新名"})
        self.assertEqual(data, {"version": 1, "tags": [], "models": {"a": [], "b": []}})

    def test_invalid_mutations_do_not_modify_existing_records(self):
        original = self.create("tag")
        bad = [None, {}, {"action": "create_tag", "name": " TAG "},
               {"action": "rename_tag", "name": "missing", "new_name": "new"},
               {"action": "set_tags", "models": ["a"]},
               {"action": "set_tags", "models": ["a"], "tags": ["missing"]},
               {"action": "set_tags", "models": ["None"], "tags": []},
               {"action": "patch_tags", "models": ["a"], "add": ["tag"], "remove": ["tag"]},
               {"action": "patch_tags", "models": ["a", None], "add": ["tag"]}]
        for item in bad:
            with self.subTest(item=item), self.assertRaises(ValueError):
                store.update_catalog(item)
            self.assertEqual(store.load_catalog(), original)

    def test_concurrent_assignments_keep_all_models(self):
        self.create("共同标签")
        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(lambda i: store.update_catalog({"action": "set_tags", "models": [f"m{i}.safetensors"], "tags": ["共同标签"]}), range(20)))
        self.assertEqual(len(store.load_catalog()["models"]), 20)

    def test_corrupt_primary_recovers_backup_without_destroying_it(self):
        original = self.create("原标签")
        self.create("第二标签")
        with open(self.path, "w", encoding="utf-8") as stream:
            json.dump({"tags": [None], "models": {}}, stream)
        self.assertEqual(store.load_catalog(), original)
        self.create("恢复后")
        with open(self.path + ".backup", encoding="utf-8") as stream:
            self.assertEqual(json.load(stream), original)

    def test_atomic_write_failure_keeps_previous_records(self):
        original = self.create("原标签")
        with patch.object(store.os, "replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
            self.create("写入失败")
        self.assertEqual(store.load_catalog(), original)
        self.assertFalse(os.path.exists(self.path + ".tmp"))


if __name__ == "__main__":
    unittest.main()
