import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
pkg = types.ModuleType("vpl")
pkg.__path__ = [str(ROOT)]
sys.modules.setdefault("vpl", pkg)
source = importlib.import_module("vpl.lora_recommendations")


class RecommendationTests(unittest.TestCase):
    def test_author_single_and_ranges(self):
        for text, expected in [("<p>Recommended weight: 0.6 - 0.9</p>", (.6, .9, .75)), ("推荐权重：0.5～0.8", (.5, .8, .65)), ("Strength: -0.8 to -0.2", (-.8, -.2, -.5)), ("建议权重为 0", (0, 0, 0)), ("weight: .7", (.7, .7, .7))]:
            with self.subTest(text=text):
                result = source.parse_recommendation(text)
                self.assertEqual(tuple(result[key] for key in ("min", "max", "default")), expected)

    def test_ambiguous_missing_invalid_advice_is_not_invented(self):
        for text in ("CFG: 7. Steps: 20", "weight: 0.9-0.4", "strength: 8", "weight: .4-.8. Recommended weight: 1"):
            self.assertNotIn("min", source.parse_recommendation(text))

    def test_explicit_default_overrides_interval_midpoint(self):
        result = source.parse_recommendation("Recommended weight: .4-.8. Default weight: .7")
        self.assertEqual((result["min"], result["max"], result["default"]), (.4, .8, .7))
        self.assertNotIn("min", source.parse_recommendation("Recommended weight: .4-.8. Default weight: 1"))

    def test_version_lookup_and_hash_lookup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "demo.safetensors"; path.write_bytes(b"demo")
            data = {"id": 123, "modelId": 45, "name": "v1", "description": "Recommended strength: 0.4-0.8"}
            with patch.object(source.lora_preview_store, "installed_models", return_value={"demo": path}), patch.object(source, "_get", return_value=data) as get:
                result = source.fetch_recommendation("demo", "https://civitai.com/models/45?modelVersionId=123")
                get.assert_called_once_with("model-versions/123")
                self.assertEqual(result["default"], .6)
                self.assertIn("modelVersionId=123", result["url"])
                get.reset_mock(); source.fetch_recommendation("demo")
                self.assertTrue(get.call_args.args[0].startswith("model-versions/by-hash/"))
                self.assertEqual(len(get.call_args.args[0].split("/")[-1]), 64)

    def test_bad_source_links_never_make_requests(self):
        with patch.object(source.lora_preview_store, "installed_models", return_value={"demo": Path("unused")}), patch.object(source, "_get") as get:
            for url in ("http://127.0.0.1/test", "https://civitai.com.evil/models/1?modelVersionId=2", "https://user@civitai.com/models/1?modelVersionId=2", "https://civitai.com/models/1", "file:///private", "https://civitai.com:443/models/1?modelVersionId=2"):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    source.fetch_recommendation("demo", url)
            get.assert_not_called()

    def test_model_fallback_and_ambiguous_version(self):
        with patch.object(source.lora_preview_store, "installed_models", return_value={"demo": Path("unused")}):
            version = {"id": 1, "modelId": 2, "description": "A LoRA"}
            with patch.object(source, "_get", side_effect=[version, {"description": "Weight: 0.7"}]):
                self.assertEqual(source.fetch_recommendation("demo", "https://civitai.com/models/2?modelVersionId=1")["default"], .7)
            version["description"] = "weight: .5; weight: .9"
            with patch.object(source, "_get", side_effect=[version, {"description": "Weight: 0.7"}]):
                self.assertNotIn("default", source.fetch_recommendation("demo", "https://civitai.com/models/2?modelVersionId=1"))
