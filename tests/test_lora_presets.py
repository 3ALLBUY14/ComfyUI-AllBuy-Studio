"""Saved LoRA lists preserve stack settings and survive failed/concurrent edits."""
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
store = importlib.import_module("vpl.lora_presets_store")


class PresetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "lora_presets.json")
        self.folder = patch.object(store.library_store, "get_user_libraries_folder", return_value=self.tmp.name)
        self.folder.start()

    def tearDown(self):
        self.folder.stop()
        self.tmp.cleanup()

    def save(self, name="组合一", entries=None):
        if entries is None:
            entries = [{"name": "portrait/a.safetensors", "weight": -0.83,
                        "min": -3, "max": 3, "enabled": False, "trigger": "face",
                        "id": "transient", "_editingRange": True},
                       {"name": "b.safetensors", "weight": 1.25}]
        return store.update_presets({"action": "save", "name": name, "entries": entries})

    def test_roundtrip_preserves_order_and_settings_without_ui_state(self):
        saved = self.save()
        self.assertEqual(store.load_presets(), saved)
        entries = saved["presets"][0]["entries"]
        self.assertEqual([e["name"] for e in entries], ["portrait/a.safetensors", "b.safetensors"])
        self.assertEqual(entries[0], {"name": "portrait/a.safetensors", "weight": -0.83,
                                    "min": -3.0, "max": 3.0, "enabled": False, "trigger": "face"})

    def test_actions_preserve_other_saved_lists(self):
        first = self.save()["presets"][0]["id"]
        second = self.save("组合二")["presets"][1]["id"]
        store.update_presets({"action": "rename", "id": first, "name": "新名称"})
        overwritten = store.update_presets({"action": "overwrite", "id": first,
                                            "entries": [{"name": "new.safetensors", "weight": 0.65}]})
        self.assertEqual(overwritten["presets"][0]["entries"][0]["weight"], 0.65)
        self.assertEqual(overwritten["presets"][1]["id"], second)
        deleted = store.update_presets({"action": "delete", "id": first})
        self.assertEqual([p["id"] for p in deleted["presets"]], [second])

    def test_invalid_mutations_do_not_change_disk(self):
        saved = self.save()
        pid = saved["presets"][0]["id"]
        invalid = [None, {}, {"action": "delete", "id": "missing"},
                   {"action": "save", "name": "", "entries": []},
                   {"action": "overwrite", "id": pid, "entries": []},
                   {"action": "overwrite", "id": pid, "entries": [{"name": "x", "weight": float("nan")}]},
                   {"action": "overwrite", "id": pid, "entries": [{"name": "x", "min": 3, "max": 2}]},
                   {"action": "rename", "id": pid, "name": "  "}]
        for action in invalid:
            with self.subTest(action=action), self.assertRaises(ValueError):
                store.update_presets(action)
            self.assertEqual(store.load_presets(), saved)

    def test_duplicate_names_rejected(self):
        self.save("List")
        with self.assertRaises(ValueError):
            self.save(" list ")
        second = self.save("Another")["presets"][1]
        with self.assertRaises(ValueError):
            store.update_presets({"action": "rename", "id": second["id"], "name": "LIST"})

    def test_concurrent_saves_keep_all_lists(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda i: self.save(f"组合{i}"), range(18)))
        saved = store.load_presets()["presets"]
        self.assertEqual(len(saved), 18)
        self.assertEqual(len({p["id"] for p in saved}), 18)

    def test_backup_recovers_corruption_and_is_not_overwritten_by_corrupt_primary(self):
        original = self.save()
        self.save("组合二")
        with open(self.path, "w", encoding="utf-8") as stream:
            stream.write("{bad-json")
        self.assertEqual(store.load_presets(), original)
        recovered = self.save("恢复后")
        self.assertEqual([p["name"] for p in recovered["presets"]], ["组合一", "恢复后"])
        with open(self.path + ".backup", encoding="utf-8") as stream:
            self.assertEqual(json.load(stream), original)

    def test_failed_atomic_publish_retains_existing_data(self):
        saved = self.save()
        with patch.object(store.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.save("不能写入")
        self.assertEqual(store.load_presets(), saved)
        self.assertFalse(os.path.exists(self.path + ".tmp"))

    def test_backup_recovers_valid_json_with_invalid_presets(self):
        original = self.save()
        self.save("组合二")
        with open(self.path, "w", encoding="utf-8") as stream:
            json.dump({"presets": [{"name": "损坏项", "entries": []}]}, stream)
        self.assertEqual(store.load_presets(), original)
        self.save("恢复后")
        with open(self.path + ".backup", encoding="utf-8") as stream:
            self.assertEqual(json.load(stream), original)

    def test_empty_and_corrupt_store_are_tolerated(self):
        self.assertEqual(store.load_presets()["presets"], [])
        for data in ([], {"presets": 7}, {"presets": [None, {"entries": []}]}):
            with open(self.path, "w", encoding="utf-8") as stream:
                json.dump(data, stream)
            self.assertEqual(store.load_presets()["presets"], [])

    def test_sort_preferences_survive_save_rename_and_editor_overwrite(self):
        saved = store.update_presets({"action": "save", "name": "排序列表", "entries": [{"name": "a", "weight": 1}], "view": {"sort": "tag"}})
        pid = saved["presets"][0]["id"]
        store.update_presets({"action": "rename", "id": pid, "name": "改名"})
        store.update_presets({"action": "overwrite", "id": pid, "entries": [{"name": "b", "weight": .8}]})
        self.assertEqual(store.load_presets()["presets"][0]["view"], {"sort": "tag"})
        with self.assertRaises(ValueError):
            store.update_presets({"action": "overwrite", "id": pid, "entries": [{"name": "c"}], "view": {"sort": []}})
        self.assertEqual(store.load_presets()["presets"][0]["entries"][0]["name"], "b")


if __name__ == "__main__":
    unittest.main()
