"""Layout imports, compiler parity, validation and independent node outputs."""
import copy
import asyncio
import importlib
import importlib.util
import json
from pathlib import Path
import unittest
import sys
import types

spec = importlib.util.spec_from_file_location("allbuy_moss_test", Path(__file__).resolve().parents[1] / "backend" / "moss_layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def draft():
    value = layout.blank_layout(1536, 1024)
    value["summary"]["caption"] = "旅行海报"
    value["items"] = [{"label": "text", "caption": "标题", "text": "远山\n来信",
                       "bbox": [927.9999999999, 271.9999999999, 1408.0000000001, 448.0000000001]}]
    return value


class MossLayoutTests(unittest.TestCase):
    def test_http_preview_uses_the_same_compiler_as_execution(self):
        package = types.ModuleType("vpl_moss_api")
        package.__path__ = [str(Path(__file__).resolve().parents[1] / "backend")]
        sys.modules.setdefault("vpl_moss_api", package)
        api = importlib.import_module("vpl_moss_api.api")

        class Request:
            async def json(self):
                return {"layout": draft()}

        response = asyncio.run(api.compile_moss_layout(Request()))
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)["prompt"], layout.AllBuyMossLayoutPrompt().execute(json.dumps(draft()))[0])

        class BadRequest:
            async def json(self):
                return []

        self.assertEqual(asyncio.run(api.compile_moss_layout(BadRequest())).status, 400)

    def test_reference_rounding_and_output_ports(self):
        result = layout.compile_layout(draft())
        self.assertEqual(json.loads(result["prompt"])["items"][0]["bbox"], [-240, 160, -64, 640])
        prompt, width, height, raw = layout.AllBuyMossLayoutPrompt().execute(json.dumps(draft()))
        self.assertEqual((prompt, width, height), (result["prompt"], 1536, 1024))
        self.assertEqual(json.loads(raw), result["draft"])
        self.assertEqual(set(layout.NODE_CLASS_MAPPINGS), {"AllBuyMossLayoutPrompt"})

    def test_fractional_edges_and_compiled_import(self):
        value = draft(); value["items"][0]["bbox"] = [927.9999999, 271.9999999, 1408.0000001, 448.0000001]
        result = layout.compile_layout(value)
        self.assertEqual(json.loads(result["prompt"])["items"][0]["bbox"], [-241, 159, -63, 641])
        imported = layout.compile_layout(result["prompt"], 1536, 1024)
        self.assertEqual(imported["prompt"], result["prompt"])
        self.assertEqual((imported["width"], imported["height"]), (1536, 1024))

    def test_fenced_wrapped_and_double_encoded_drafts(self):
        value = draft()
        for raw in [value, json.dumps(value), "Here is the layout:\n```json\n" + json.dumps(value) + "\n```",
                    json.dumps(json.dumps(value)), {"draft": {"source": json.dumps(value)}}]:
            with self.subTest(raw=str(raw)[:60]):
                self.assertEqual(layout.normalize_layout(raw), value)

    def test_legacy_schema_and_appearance_fields(self):
        value = {"scene_type": "Poster", "gen_brief": "A tree", "must_not": ["borders"],
                 "elements": [{"type": "text", "identity": "标题", "text": "远山", "bbox": [-400, -400, -200, 400]}]}
        result = layout.compile_layout(value)
        self.assertEqual(result["draft"]["items"][0]["bbox"], [112, 112, 912, 312])
        self.assertIn("Avoid: borders", result["prompt"])
        value = draft(); value["items"][0]["color"] = "#ff0000"
        self.assertNotIn("color", layout.compile_layout(value)["prompt"])

    def test_empty_layout_remains_a_plain_caption(self):
        value = layout.blank_layout(); value["summary"]["caption"] = "  A tree.  "
        self.assertEqual(layout.compile_layout(value)["prompt"], "A tree.")
        self.assertEqual(layout.compile_layout(layout.blank_layout())["prompt"], "")

    def test_external_resolution_overrides_and_scales_all_outputs(self):
        value = draft(); before = copy.deepcopy(value)
        node_result = layout.AllBuyMossLayoutPrompt().execute(json.dumps(value), width=768, height=512)
        prompt, width, height, raw = node_result["result"]
        expected = layout.compile_layout(value, override_width=768, override_height=512)
        self.assertEqual((width, height), (768, 512))
        self.assertEqual(prompt, expected["prompt"])
        self.assertEqual(json.loads(raw)["items"][0]["bbox"], [edge / 2 for edge in value["items"][0]["bbox"]])
        self.assertEqual(node_result["ui"]["allbuy_moss_dimensions"], [768, 512])
        self.assertEqual(value, before)
        one_axis = layout.compile_layout(value, override_width=768)
        self.assertEqual(one_axis["height"], 1024)
        self.assertEqual(one_axis["draft"]["items"][0]["bbox"][1], value["items"][0]["bbox"][1])

    def test_external_resolution_validation_and_optional_sockets(self):
        spec = layout.AllBuyMossLayoutPrompt.INPUT_TYPES()
        self.assertEqual(set(spec["optional"]), {"width", "height"})
        self.assertTrue(spec["optional"]["width"][1]["forceInput"])
        for dimension in [0, True, 1000, 8192, 768.0]:
            with self.subTest(dimension=dimension), self.assertRaises(ValueError):
                layout.compile_layout(draft(), override_width=dimension)

    def test_http_external_size_matches_execution(self):
        package = types.ModuleType("vpl_moss_api"); package.__path__ = [str(Path(__file__).resolve().parents[1] / "backend")]
        sys.modules.setdefault("vpl_moss_api", package)
        api = importlib.import_module("vpl_moss_api.api")
        class Request:
            async def json(self):
                return {"layout": draft(), "override_width": 768, "override_height": 512}
        response = asyncio.run(api.compile_moss_layout(Request()))
        expected = layout.AllBuyMossLayoutPrompt().execute(json.dumps(draft()), width=768, height=512)["result"]
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)["prompt"], expected[0])

    def test_import_does_not_mutate_input(self):
        value = draft(); before = copy.deepcopy(value)
        layout.compile_layout(value)
        self.assertEqual(value, before)

    def test_prompt_parentheses_and_literal_backslashes_are_preserved(self):
        value = draft(); value["items"][0]["text"] = r"\(x\) and \\"
        raw = json.dumps(value, ensure_ascii=False)
        self.assertEqual(layout.normalize_layout(raw), value)
        self.assertEqual(layout.normalize_layout(raw.replace(r"\\(", r"\(").replace(r"\\)", r"\)")), value)

    def test_invalid_inputs_fail_before_execution(self):
        bad = []
        for width in [1000, True, 8192]:
            value = draft(); value["width"] = width; bad.append(value)
        for box in [[float("nan"), 0, 10, 10], [0, 0, 2000, 100], [4, 4, 4, 20]]:
            value = draft(); value["items"][0]["bbox"] = box; bad.append(value)
        value = draft(); value["items"][0]["text"] = " "; bad.append(value)
        value = draft(); value["items"] *= 201; bad.append(value)
        value = draft(); value["mystery"] = 1; bad.append(value)
        bad += ["not json", '{"hello":"world"}', "x" * (layout.MAX_TEXT + 1), "文" * layout.MAX_TEXT, {"summary": []}]
        for value in bad:
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                layout.compile_layout(value)


if __name__ == "__main__":
    unittest.main()
