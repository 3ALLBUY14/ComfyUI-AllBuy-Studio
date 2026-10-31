import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest

pkg = types.ModuleType("vpl")
pkg.__path__ = [str(Path(__file__).resolve().parents[1])]
sys.modules.setdefault("vpl", pkg)
content = importlib.import_module("vpl.lora_content")


class ContentTests(unittest.TestCase):
    def test_ratings_are_explicit_and_conflicts_choose_nsfw(self):
        for data, rating in [({}, "unknown"), ({"nsfw": "false"}, "unknown"), ({"nsfwLevel": 0}, "unknown"), ({"nsfwLevel": 2}, "sfw"), ({"nsfw_level": "16"}, "nsfw"), ({"model": {"nsfw": True}}, "nsfw"), ({"civitai": {"model": {"nsfw": True}}}, "nsfw"), ({"nsfw": False, "images": [{"nsfwLevel": 8}]}, "nsfw"), ({"civitai": None}, "unknown")]:
            with self.subTest(data=data):
                self.assertEqual(content.metadata_rating(data), rating)

    def test_local_sidecars_unknown_corrupt_and_cache_invalidation(self):
        with tempfile.TemporaryDirectory() as folder:
            model = Path(folder) / "nsfw-name.safetensors"; model.write_bytes(b"demo")
            self.assertEqual(content.local_content(model)["rating"], "unknown", "Never guess from a filename")
            info = model.with_suffix(".civitai.info"); info.write_text(json.dumps({"model": {"nsfw": True}}), encoding="utf-8")
            self.assertEqual(content.local_content(model)["rating"], "nsfw")

            info.write_text(json.dumps({"nsfw": False, "extra": "changed"}), encoding="utf-8")
            self.assertEqual(content.local_content(model)["rating"], "sfw")
            info.write_text("broken", encoding="utf-8")
            self.assertEqual(content.local_content(model)["rating"], "unknown")
            model.with_suffix(".cm-info.json").write_text('{"nsfw_level":8}', encoding="utf-8")
            self.assertEqual(content.local_content(model)["rating"], "nsfw")

    def test_base_and_version_parse_without_folder_inference(self):
        self.assertEqual(content.metadata_info({"baseModel": "Flux.1 D", "name": "v2"}), {"base_model": "Flux.1 D", "version": "v2"})
        self.assertEqual(content.metadata_info({"base_model": "SDXL", "civitai": {"name": "v1"}})["version"], "v1")
        self.assertEqual(content.metadata_info({"name": "a model title"})["version"], "")
