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

    def test_model_info_override_and_auto_restore(self):
        store.update_catalog({"action": "set_model_info", "model": r"folder\a", "info": {"base_model": "Flux", "version": "v2"}})
        self.create("工具")
        original = store.load_catalog()
        self.assertEqual(original["model_info"]["folder/a"], {"base_model": "Flux", "version": "v2"})
        for info in ({"version": 1}, {"base_model": "x" * 201}, []):
            with self.assertRaises(ValueError): store.update_catalog({"action": "set_model_info", "model": "folder/a", "info": info})
            self.assertEqual(store.load_catalog(), original)
        store.update_catalog({"action": "set_model_info", "model": "folder/a", "info": None})
        self.assertNotIn("folder/a", store.load_catalog().get("model_info", {}))

    def test_content_manual_overrides_roundtrip_and_restore_auto(self):
        store.update_catalog({"action": "set_content_rating", "models": [r"folder\a", "b"], "rating": "nsfw"})
        self.create("工具")
        self.assertEqual(store.load_catalog()["content_ratings"], {"folder/a": "nsfw", "b": "nsfw"})
        store.update_catalog({"action": "set_content_rating", "models": ["b"], "rating": "sfw"})
        before = store.load_catalog()
        for targets, rating in [([], "nsfw"), (["a", None], "sfw"), (["a"], "invalid")]:
            with self.assertRaises(ValueError):
                store.update_catalog({"action": "set_content_rating", "models": targets, "rating": rating})
            self.assertEqual(store.load_catalog(), before)
        store.update_catalog({"action": "set_content_rating", "models": ["folder/a"], "rating": "auto"})
        self.assertEqual(store.load_catalog()["content_ratings"], {"b": "sfw"})

    def test_recommended_weight_roundtrip_clear_and_validation(self):
        original = store.update_catalog({"action": "set_recommended_weight", "model": r"MOSS\pixel", "weight": 0.65})
        self.assertEqual(store.load_catalog()["recommended_weights"], {"MOSS/pixel": 0.65})
        for value in (True, "1", float("nan"), float("inf"), -3.01, 3.01):
            with self.assertRaises(ValueError):
                store.update_catalog({"action": "set_recommended_weight", "model": "MOSS/pixel", "weight": value})
            self.assertEqual(store.load_catalog(), original)
        store.update_catalog({"action": "set_trigger", "model": "MOSS/pixel", "trigger": "keep"})
        self.create("工具")
        self.assertEqual(store.load_catalog()["recommended_weights"]["MOSS/pixel"], 0.65)
        store.update_catalog({"action": "set_recommended_weight", "model": "MOSS/pixel", "weight": 0})
        self.assertEqual(store.load_catalog()["recommended_weights"]["MOSS/pixel"], 0)
        store.update_catalog({"action": "set_recommended_weight", "model": "MOSS/pixel", "weight": None})
        self.assertEqual(store.load_catalog().get("recommended_weights", {}), {})
        self.assertEqual(store.load_catalog()["triggers"]["MOSS/pixel"], "keep")

    def test_trigger_persists_independently_of_tags(self):
        self.create("工具")
        store.update_catalog({"action": "set_trigger", "model": r"folder\a.safetensors", "trigger": "  pxl8x  "})
        store.update_catalog({"action": "set_tags", "models": ["folder/a.safetensors"], "tags": ["工具"]})
        saved = store.load_catalog()
        self.assertEqual(saved["triggers"], {"folder/a.safetensors": "pxl8x"})
        self.assertEqual(saved["models"]["folder/a.safetensors"], ["工具"])
        store.update_catalog({"action": "set_trigger", "model": "other", "trigger": "keep"})
        store.update_catalog({"action": "set_trigger", "model": "folder/a.safetensors", "trigger": ""})
        self.assertEqual(store.load_catalog()["triggers"], {"other": "keep", "folder/a.safetensors": ""})

    def test_recommendation_range_default_and_other_catalog_mutations(self):
        recommendation = {"min": .4, "max": .8, "default": .6, "source": "Civitai", "url": "https://civitai.com/models/1?modelVersionId=2", "evidence": "Recommended weight: 0.4-0.8"}
        store.update_catalog({"action": "set_recommendation", "model": "demo", "recommendation": recommendation})
        store.update_catalog({"action": "patch_tags", "models": ["demo"], "create": ["新标签"], "add": ["新标签"]})
        saved = store.load_catalog()
        self.assertEqual(saved["recommendations"]["demo"]["min"], .4)
        self.assertEqual(saved["recommended_weights"]["demo"], .6)
        self.assertEqual(saved["models"]["demo"], ["新标签"])
        for value in ({**recommendation, "default": .9}, {**recommendation, "min": 1}, {**recommendation, "url": "javascript:alert(1)"}, {**recommendation, "max": float("nan")}):
            with self.assertRaises(ValueError):
                store.update_catalog({"action": "set_recommendation", "model": "demo", "recommendation": value})
            self.assertEqual(store.load_catalog(), saved)
        with self.assertRaises(ValueError):
            store.update_catalog({"action": "set_recommended_weight", "model": "demo", "weight": .9})
        store.update_catalog({"action": "set_recommended_weight", "model": "demo", "weight": .7})
        self.assertEqual(store.load_catalog()["recommendations"]["demo"]["default"], .7)
        store.update_catalog({"action": "set_recommended_weight", "model": "demo", "weight": None})
        self.assertNotIn("demo", store.load_catalog().get("recommendations", {}))

    def test_inline_tag_creation_is_atomic_on_error(self):
        original = store.load_catalog()
        with self.assertRaises(ValueError):
            store.update_catalog({"action": "patch_tags", "models": ["demo"], "create": ["新标签"], "add": ["missing"]})
        self.assertEqual(store.load_catalog(), original)

    def test_existing_workflow_triggers_import_without_overwriting_model_edits(self):
        store.update_catalog({"action": "set_trigger", "model": "edited", "trigger": "manager text"})
        store.update_catalog({"action": "set_trigger", "model": "cleared", "trigger": ""})
        result = store.update_catalog({"action": "seed_triggers", "entries": [
            {"name": r"folder\old", "trigger": "existing workflow text"},
            {"name": "edited", "trigger": "stale text"},
            {"name": "cleared", "trigger": "stale text"},
        ]})
        self.assertEqual(result["triggers"], {"folder/old": "existing workflow text", "edited": "manager text", "cleared": ""})
        self.assertEqual(store.load_catalog()["triggers"], result["triggers"])

    def test_invalid_trigger_does_not_erase_saved_data(self):
        original = store.update_catalog({"action": "set_trigger", "model": "a", "trigger": "original"})
        for model, trigger in [("None", "test"), ("a", None), ("a", "x" * 16001)]:
            with self.assertRaises(ValueError):
                store.update_catalog({"action": "set_trigger", "model": model, "trigger": trigger})
            self.assertEqual(store.load_catalog(), original)

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
