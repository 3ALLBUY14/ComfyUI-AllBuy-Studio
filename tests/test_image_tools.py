"""Pixel and native-sampler contract tests; no GPU or running ComfyUI needed."""
import importlib
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import torch
from PIL import Image

_pkg = types.ModuleType("vpl")
_pkg.__path__ = [os.path.dirname(os.path.dirname(os.path.abspath(__file__))) ]
sys.modules.setdefault("vpl", _pkg)
tools = importlib.import_module("vpl.image_tools")
gen = importlib.import_module("vpl.generate_node")
store = importlib.import_module("vpl.asset_store")
media = importlib.import_module("vpl.media_asset")


def frame(rgb, w=16, h=8):
    return torch.tensor(rgb, dtype=torch.float32).reshape(1, 1, 1, 3).expand(1, h, w, 3).clone()


class GridTests(unittest.TestCase):
    def test_node_executes_optional_inputs_in_port_order(self):
        with patch.object(tools, "preview_result", side_effect=lambda image, **kwargs: image):
            output = tools.AllBuyImageGrid().execute(frame([1, 0, 0]), image_3=frame([0, 0, 1]), gap=0, padding=0)
        self.assertEqual(tuple(output.shape), (1, 8, 32, 3))
        self.assertEqual(output[0, 0, 0, 0], 1)
        self.assertEqual(output[0, 0, -1, 2], 1)

    def test_batch_order_and_independent_margins(self):
        a, b, c = frame([1, 0, 0]), frame([0, 1, 0]), frame([0, 0, 1])
        result = tools.compose_grid([torch.cat([a, b]), c], gap=3, padding=5, background="#ffffff")
        self.assertEqual(tuple(result.shape), (1, 18, 64, 3))
        self.assertTrue(torch.equal(result[0, 5, 5], a[0, 0, 0]))
        self.assertTrue(torch.equal(result[0, 5, 24], b[0, 0, 0]))
        self.assertTrue(torch.equal(result[0, 5, 43], c[0, 0, 0]))
        self.assertTrue(torch.equal(result[0, 5, 21], torch.ones(3)))

    def test_vertical_and_grid_and_reference_scaling(self):
        for layout, shape in [("纵向", (1, 24, 16, 3)), ("网格", (1, 16, 32, 3))]:
            output = tools.compose_grid([frame([1, 0, 0]).repeat(3, 1, 1, 1)], layout=layout, gap=0, padding=0)
            self.assertEqual(tuple(output.shape), shape)
        output = tools.compose_grid([frame([1, 0, 0], 32, 16)], cell_size=16, gap=0, padding=0)
        self.assertEqual(tuple(output.shape), (1, 8, 16, 3))

    def test_crop_alignment(self):
        stripe = torch.zeros((1, 8, 32, 3)); stripe[:, :, :16, 0] = 1; stripe[:, :, 16:, 2] = 1
        first = frame([0, 0, 0], 8, 8)
        left = tools.compose_grid([first, stripe], fit="居左裁切", gap=0, padding=0)
        right = tools.compose_grid([first, stripe], fit="居右裁切", gap=0, padding=0)
        self.assertEqual(left[0, 4, 12, 0], 1)
        self.assertEqual(right[0, 4, 12, 2], 1)

    def test_empty_and_oversized(self):
        with self.assertRaises(ValueError): tools.compose_grid([])
        with self.assertRaises(ValueError): tools.canvas_size(16384, 16384)


class TitleTests(unittest.TestCase):
    def test_numeric_suffix_matches_titles_one_through_twelve(self):
        source = frame([1, 1, 1], 180, 100).repeat(12, 1, 1, 1)
        options = dict(bar_height=50, font_size=20)
        numbered = tools.add_titles(source, titles="Item", suffix_mode=tools.TITLE_SUFFIX_MODES[1], **options)
        expected = tools.add_titles(source, titles="\n".join(f"Item{i}" for i in range(1, 13)), **options)
        self.assertTrue(torch.equal(numbered, expected))

    def test_alphabetic_suffix_continues_after_z(self):
        labels = [*"ABCDEFGHIJKLMNOPQRSTUVWXYZ", "AA", "AB", "AC", "AD"]
        source = frame([1, 1, 1], 180, 100).repeat(len(labels), 1, 1, 1)
        numbered = tools.add_titles(source, titles="Item", suffix_mode=tools.TITLE_SUFFIX_MODES[2], bar_height=50)
        expected = tools.add_titles(source, titles="\n".join("Item" + label for label in labels), bar_height=50)
        self.assertTrue(torch.equal(numbered, expected))

    def test_suffix_uses_global_input_order_including_blank_title_slots(self):
        source = frame([1, 1, 1], 180, 100)
        for mode, titles in [(tools.TITLE_SUFFIX_MODES[1], "First1\n\nThird3"),
                             (tools.TITLE_SUFFIX_MODES[2], "FirstA\n\nThirdC")]:
            with self.subTest(mode=mode), patch.object(tools, "preview_result", side_effect=lambda image, **kwargs: image):
                actual = tools.AllBuyImageTitle().execute(source, image_3=source.repeat(2, 1, 1, 1),
                                                         titles="First\n\nThird", suffix_mode=mode, bar_height=50)
                expected = tools.add_titles(source.repeat(3, 1, 1, 1), titles=titles, bar_height=50)
                self.assertTrue(torch.equal(actual, expected))

    def test_enabled_suffix_does_not_create_titles_for_empty_text(self):
        source = frame([1, 0, 0], 180, 100).repeat(3, 1, 1, 1)
        self.assertTrue(torch.equal(source, tools.add_titles(source, titles="", suffix_mode=tools.TITLE_SUFFIX_MODES[1])))

    def test_empty_overlay_is_identity(self):
        source = frame([1, 0, 0], 80, 40)
        self.assertTrue(torch.equal(source, tools.add_titles(source, titles="")))

    def test_outside_titles_keep_batch_geometry_and_image(self):
        source = torch.cat([frame([1, 0, 0], 80, 40), frame([0, 1, 0], 80, 40)])
        output = tools.add_titles(source, titles="标题\n", position="图外顶部", bar_height=25, font_size=8)
        self.assertEqual(tuple(output.shape), (2, 50, 80, 3))
        self.assertTrue(torch.equal(output[:, 10:], source))

    def test_alignment_and_alpha_and_single_title_repeat(self):
        source = frame([1, 1, 1], 120, 80).repeat(2, 1, 1, 1)
        output = tools.add_titles(source, titles="A", opacity=0, text_color="#000000", bar_height=50, align="居左", font_size=20)
        self.assertTrue(torch.equal(output[0], output[1]))
        self.assertEqual(output[0, -2, -2, 0], 1)
        self.assertTrue((output[0, 40:, :40] < .5).any())

    def test_output_size_preserves_aspect(self):
        output = tools.add_titles(frame([0, 0, 0], 80, 40), output_size="1K")
        self.assertEqual(tuple(output.shape), (1, 512, 1024, 3))

    def test_selected_font_is_loaded_and_unknown_font_is_actionable(self):
        available = tools.title_font(20)
        with patch.object(tools, "title_fonts", return_value={"Chosen.ttf": available.path}):
            self.assertEqual(tools.title_font(23, "Chosen.ttf").size, 23)
            output = tools.add_titles(frame([1, 1, 1], 120, 80), titles="Test", font_name="Chosen.ttf")
            self.assertEqual(tuple(output.shape), (1, 80, 120, 3))
        with self.assertRaisesRegex(ValueError, "找不到字体"):
            tools.add_titles(frame([0, 0, 0]), titles="A", font_name="missing-font.ttf")

    def test_rounded_translucent_band_preserves_source_at_corners(self):
        output = tools.add_titles(frame([1, 1, 1], 200, 100), titles="A", bar_height=40,
                                  opacity=50, background="#000000", corner_radius=16, font_size=16)
        self.assertTrue(torch.equal(output[0, 60, 0], torch.ones(3)))
        self.assertTrue(torch.allclose(output[0, 60, 100], torch.full((3,), 127 / 255)))
        self.assertTrue(torch.equal(output[0, 59, 100], torch.ones(3)))

    def test_stroke_shadow_and_transparent_band_are_independent(self):
        source = frame([1, 1, 1], 300, 200)
        output = tools.add_titles(source, titles="Ab", bar_height=60, opacity=0,
                                  text_color="#000000", font_size=36, stroke_width=3,
                                  stroke_color="#00ff00", shadow_opacity=100, shadow_color="#ff0000",
                                  shadow_offset_x=14, shadow_offset_y=10, shadow_blur=0)
        green = (output[..., 1] > .9) & (output[..., 0] < .1) & (output[..., 2] < .1)
        red = (output[..., 0] > .9) & (output[..., 1] < .1) & (output[..., 2] < .1)
        black = (output < .1).all(dim=-1)
        self.assertTrue(green.any())
        self.assertTrue(red.any())
        self.assertTrue(black.any())
        self.assertTrue(torch.equal(source[:, :80], output[:, :80]))
        blurred = tools.add_titles(source, titles="Ab", bar_height=60, opacity=0, font_size=36,
                                   shadow_opacity=100, shadow_offset_x=-12, shadow_offset_y=-6, shadow_blur=3)
        self.assertTrue(((blurred > 0) & (blurred < 1)).any())

    def test_rounded_bar_width_is_centered_and_preserves_batch_geometry(self):
        source = frame([1, 1, 1], 200, 100).repeat(2, 1, 1, 1)
        output = tools.add_titles(source, titles="A\nB", bar_height=40, bar_width=50,
                                  corner_radius=10, opacity=100, background="#000000", font_size=16)
        self.assertEqual(tuple(output.shape), tuple(source.shape))
        self.assertTrue(torch.equal(output[:, :, :50], source[:, :, :50]))
        self.assertTrue(torch.equal(output[:, :, 150:], source[:, :, 150:]))
        self.assertTrue(torch.equal(output[:, 60, 50], torch.ones(2, 3)))
        self.assertTrue(torch.equal(output[:, 60, 100], torch.zeros(2, 3)))

    def test_bar_width_is_only_applied_with_rounding_and_aligns_text_inside(self):
        source = frame([1, 1, 1], 200, 100)
        common = dict(titles="A", bar_height=60, opacity=100, background="#000000", font_size=20)
        self.assertTrue(torch.equal(tools.add_titles(source, **common, bar_width=40),
                                    tools.add_titles(source, **common)))
        bounds = []
        for align in ("居左", "居右"):
            output = tools.add_titles(source, **common, bar_width=50, corner_radius=8,
                                      text_color="#ff0000", padding=4, align=align)
            red = (output[0, ..., 0] > .8) & (output[0, ..., 1] < .2)
            xs = torch.where(red)[1]
            self.assertGreaterEqual(int(xs.min()), 50)
            self.assertLess(int(xs.max()), 150)
            bounds.append(int(xs.min()))
        self.assertLess(bounds[0], bounds[1])

    def test_outside_empty_rounded_bar_obeys_width(self):
        source = frame([0, 1, 0], 200, 100)
        output = tools.add_titles(source, titles="", position="图外底部", bar_height=40,
                                  bar_width=50, corner_radius=8, opacity=100, background="#ffffff")
        self.assertEqual(tuple(output.shape), (1, 140, 200, 3))
        self.assertTrue(torch.equal(output[:, :100], source))
        self.assertTrue(torch.equal(output[0, 120, 20], torch.zeros(3)))
        self.assertTrue(torch.equal(output[0, 120, 100], torch.ones(3)))

    def test_outside_rounded_band_and_blank_titles_share_style(self):
        source = frame([0, 1, 0], 160, 100).repeat(2, 1, 1, 1)
        for position in ("图外顶部", "图外底部"):
            output = tools.add_titles(source, titles="A\n", position=position, bar_height=40,
                                      background="#ffffff", opacity=100, corner_radius=16)
            y = 0 if position == "图外顶部" else 100
            self.assertTrue(torch.equal(output[:, y, 0], torch.zeros(2, 3)))
            self.assertTrue(torch.equal(output[:, y, 80], torch.ones(2, 3)))
            image_y = 40 if position == "图外顶部" else 0
            self.assertTrue(torch.equal(output[:, image_y:image_y + 100], source))

    def test_multiple_input_batches_keep_global_title_order(self):
        source = frame([1, 1, 1], 180, 100)
        with patch.object(tools, "preview_result", side_effect=lambda image, **kwargs: image):
            output = tools.AllBuyImageTitle().execute(source, image_3=source.repeat(2, 1, 1, 1),
                                                      titles="A\n\nB", opacity=0, text_color="#000000", bar_height=50)
        self.assertEqual(tuple(output.shape), (3, 100, 180, 3))
        self.assertTrue(torch.equal(output[1], source[0]))
        self.assertFalse(torch.equal(output[0], source[0]))
        self.assertFalse(torch.equal(output[2], output[0]))

    def test_mixed_input_sizes_are_padded_without_distortion(self):
        with patch.object(tools, "preview_result", side_effect=lambda image, **kwargs: image):
            output = tools.AllBuyImageTitle().execute(frame([1, 0, 0], 100, 50),
                                                      image_2=frame([0, 1, 0], 40, 80), background="#0000ff")
        self.assertEqual(tuple(output.shape), (2, 50, 100, 3))
        self.assertTrue(torch.equal(output[0, 25, 50], torch.tensor([1., 0., 0.])))
        self.assertTrue(torch.equal(output[1, 25, 50], torch.tensor([0., 1., 0.])))
        self.assertTrue(torch.equal(output[1, 25, 0], torch.tensor([0., 0., 1.])))

    def test_empty_batch_has_actionable_error(self):
        with self.assertRaisesRegex(ValueError, "批次不能为空"):
            tools.add_titles(torch.zeros((0, 20, 20, 3)))


class ComposerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patcher = patch.object(media, "media_root", return_value=str(self.root)); self.patcher.start()
        source = self.root / "source.png"; Image.new("RGBA", (8, 8), (255, 0, 0, 255)).save(source)
        self.asset = store.import_file(source, "source.png")["name"]

    def tearDown(self):
        self.patcher.stop(); self.tmp.cleanup()

    def project(self, **layer):
        return {"width": 16, "height": 16, "background": "#0000ff", "layers": [{"asset": self.asset, "x": 8, "y": 8, **layer}]}

    def test_durable_asset_transform_and_opacity(self):
        result, w, h = tools.compose_layers(json.dumps(self.project(opacity=.5)))
        self.assertEqual((w, h), (16, 16))
        self.assertTrue(torch.allclose(result[0, 8, 8], torch.tensor([128 / 255, 0, 127 / 255]), atol=.01))
        self.assertEqual(result[0, 0, 0, 2], 1)

    def test_visibility_rotation_and_clipping(self):
        output, *_ = tools.compose_layers(self.project(visible=False))
        self.assertTrue(torch.all(output[..., 2] == 1))
        output, *_ = tools.compose_layers(self.project(x=-2, rotation=90, width=8, height=4))
        self.assertEqual(tuple(output.shape), (1, 16, 16, 3))

    def test_blend_modes_and_stroke(self):
        for mode in ("normal", "multiply", "screen", "overlay"):
            output, *_ = tools.compose_layers(self.project(blend=mode, stroke=2))
            self.assertTrue(torch.isfinite(output).all())
            if mode == "multiply": self.assertTrue(torch.equal(output[0, 8, 8], torch.zeros(3)))
            if mode == "screen": self.assertTrue(torch.equal(output[0, 8, 8], torch.tensor([1., 0., 1.])))

    def test_arbitrary_paths_and_nonfinite_rejected(self):
        for bad in ("../../source.png", str(self.root / "source.png")):
            with self.assertRaises(ValueError): tools.load_asset(bad)
        with self.assertRaises(ValueError): tools.compose_layers(self.project(x=float("nan")))

    def test_optional_cutout_preserves_original_and_publishes_shared_asset(self):
        api = importlib.import_module("vpl.api")
        original = Path(store.resolve(self.asset)).read_bytes()
        fake = types.SimpleNamespace(new_session=lambda name: "session", remove=lambda image, **kwargs: Image.new("RGBA", image.size, (255, 0, 0, 0)))
        with patch.dict(sys.modules, {"rembg": fake}), patch.object(api, "_CUTOUT_SESSION", None):
            result = api._cutout_asset(self.asset)
        self.assertNotEqual(result["name"], self.asset)
        self.assertEqual(Path(store.resolve(self.asset)).read_bytes(), original)
        self.assertEqual(tools.load_asset(result["name"]).getpixel((0, 0))[3], 0)

    def test_cutout_errors_return_actionable_http_response(self):
        api = importlib.import_module("vpl.api")
        request = types.SimpleNamespace()
        async def body(): return {"name": self.asset}
        request.json = body
        with patch.object(api, "_cutout_asset", side_effect=RuntimeError("需要安装 rembg")):
            response = asyncio.run(api.image_tools_remove_background(request))
        self.assertEqual(response.status, 503)
        self.assertIn("rembg", json.loads(response.body)["error"])


class PreviewTests(unittest.TestCase):
    def test_grid_and_title_request_intermediate_cached_ui(self):
        for name in ("AllBuyImageGrid", "AllBuyImageTitle"):
            with self.subTest(node=name):
                self.assertTrue(tools.NODE_CLASS_MAPPINGS[name].HAS_INTERMEDIATE_OUTPUT)

    def test_custom_preview_does_not_request_native_duplicate(self):
        recorded = []
        class Preview:
            def save_images(self, images, **kwargs):
                recorded.append(kwargs)
                return {"ui": {"images": [{"filename": "preview.png", "type": "temp"}]}}
        with patch.dict(sys.modules, {"nodes": types.SimpleNamespace(PreviewImage=Preview)}):
            result = tools.preview_result(frame([1, 0, 0]), 16, 8, prompt={"a": 1})
        self.assertNotIn("images", result["ui"])
        self.assertEqual(result["ui"]["allbuy_images"][0]["filename"], "preview.png")
        self.assertEqual(result["result"][1:], (16, 8))
        self.assertEqual(recorded[0]["prompt"], {"a": 1})


class GenerateTests(unittest.TestCase):
    def test_cached_execution_replays_preview(self):
        self.assertTrue(gen.AllBuyGenerate.HAS_INTERMEDIATE_OUTPUT)

    def test_imported_source_does_not_request_connected_branches(self):
        prompt = {"552": {"inputs": {"latent": ["old-latent", 0], "source_image": ["old-image", 0], "mask": ["old-mask", 0]}}}
        requested = gen.AllBuyGenerate().check_lazy_status(
            edit_json=json.dumps({"enabled": True, "source": "imported.png", "mask": "painted.png"}),
            prompt=prompt, unique_id="552")
        self.assertEqual(requested, [])

    def test_connected_image_requests_mask_when_latent_unconnected(self):
        prompt = {"552": {"inputs": {"source_image": ["image", 0], "mask": ["mask", 0]}}}
        node = gen.AllBuyGenerate()
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552"), ["source_image", "mask"])
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552", source_image=frame([1, 0, 0])), ["mask"])
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552", source_image=frame([1, 0, 0]), mask=torch.ones(1, 8, 16)), [])

    def test_custom_latent_is_requested_ahead_of_connected_image(self):
        node = gen.AllBuyGenerate()
        prompt = self.loader_prompt()
        prompt["552"]["inputs"]["latent"] = ["custom-switch", 0]
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552"), ["mask"])
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552", mask=torch.zeros(1, 64, 64)), ["latent"])
        latent = {"samples": torch.zeros(2, 4, 64, 112), "downscale_ratio_spacial": 8}
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552", mask=torch.zeros(1, 64, 64), latent=latent), [])
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552", mask=torch.ones(1, 64, 64)), ["source_image"])
        del prompt["552"]["inputs"]["mask"]
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552"), ["latent"])

    def test_normal_generation_requests_latent_and_rejects_mask_without_image(self):
        node = gen.AllBuyGenerate()
        prompt = {"552": {"inputs": {"latent": ["latent", 0]}}}
        self.assertEqual(node.check_lazy_status(prompt=prompt, unique_id="552"), ["latent"])
        dynamic = types.SimpleNamespace(get_node=lambda ident: prompt[ident])
        self.assertEqual(node.check_lazy_status(dynprompt=dynamic, unique_id="552", latent={"samples": frame([0, 0, 0])}), [])
        prompt["552"]["inputs"]["mask"] = ["mask", 0]
        with self.assertRaisesRegex(ValueError, "遮罩需要"):
            node.check_lazy_status(prompt=prompt, unique_id="552")

    def test_scheduler_schema_marks_only_source_branches_lazy(self):
        samplers = types.ModuleType("comfy.samplers")
        samplers.KSampler = types.SimpleNamespace(SAMPLERS=["euler"], SCHEDULERS=["simple"])
        comfy = types.ModuleType("comfy"); comfy.samplers = samplers
        with patch.dict(sys.modules, {"comfy": comfy, "comfy.samplers": samplers}):
            schema = gen.AllBuyGenerate.INPUT_TYPES()
        for name in ("source_image", "mask", "latent"):
            self.assertTrue(schema["optional"][name][1]["lazy"])

    def setUp(self):
        self.calls = []
        calls = self.calls
        class Encode:
            def encode(self, vae, image, *args, **kwargs):
                calls.append(("encode", image, args, kwargs)); return ({"samples": image, "noise_mask": args[0] if args else None},)
        class Decode:
            def decode(self, vae, samples):
                latent = samples["samples"]
                if "downscale_ratio_spacial" in samples:
                    stride = samples.get("downscale_ratio_spacial", 8)
                    return (torch.ones(latent.shape[0], latent.shape[-2] * stride, latent.shape[-1] * stride, 3),)
                return (torch.ones_like(latent),)
        class Zero:
            def zero_out(self, positive): return ("zero",)
        def sample(*args, **kwargs): calls.append(("sample", args, kwargs)); return (args[8],)
        self.native = types.SimpleNamespace(VAEEncode=Encode, VAEEncodeForInpaint=Encode, VAEDecode=Decode,
                                            ConditioningZeroOut=Zero, common_ksampler=sample)
        self.patches = [patch.object(gen, "native_nodes", return_value=self.native),
                        patch.object(gen, "preview_result", side_effect=lambda *args, **kwargs: {"result": args})]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in self.patches: p.stop()

    def generate(self, **kwargs):
        args = dict(model="model", positive="positive", vae=object(), seed=123, steps=20, cfg=7,
                    sampler_name="euler", scheduler="normal", feather=0)
        return gen.AllBuyGenerate().generate(**(args | kwargs))["result"]

    def test_native_sampling_parameters_and_optional_negative(self):
        latent = {"samples": frame([0, 0, 0], 16, 16)}
        self.generate(latent=latent, denoise=.5)
        _, args, kwargs = self.calls[-1]
        self.assertEqual(args[:8], ("model", 123, 20, 7, "euler", "normal", "positive", "zero"))
        self.assertIs(args[8], latent); self.assertEqual(kwargs["denoise"], .5)

    def test_custom_latent_dimensions_and_metadata_survive_connected_image(self):
        latent = {"samples": torch.zeros(2, 4, 64, 112), "downscale_ratio_spacial": 8,
                  "noise_mask": torch.ones(2, 64, 112), "batch_index": [3, 4]}
        prompt = self.loader_prompt()
        prompt["552"]["inputs"]["latent"] = ["custom-switch", 0]
        for mask in (None, torch.zeros(1, 64, 64)):
            with self.subTest(mask=mask is not None):
                self.calls.clear()
                _, _, samples = self.generate(latent=latent, source_image=frame([1, 0, 0], 80, 160), mask=mask,
                    prompt=prompt, unique_id="552", input_resize='{"mode":"longest","size":1536}')
                self.assertEqual([call[0] for call in self.calls], ["sample"])
                self.assertIs(self.calls[0][1][8], latent)
                self.assertIs(samples, latent)
                self.assertEqual(tuple(samples["samples"].shape), (2, 4, 64, 112))
                self.assertEqual(samples["downscale_ratio_spacial"], 8)
                self.assertEqual(samples["batch_index"], [3, 4])

    def test_explicit_inpaint_keeps_image_canvas_even_with_latent(self):
        _, image, _ = self.generate(latent={"samples": torch.zeros(1, 4, 32, 64)},
            source_image=frame([1, 0, 0], 16, 16), mask=torch.ones(1, 16, 16))
        self.assertEqual(self.calls[0][0], "encode")
        self.assertEqual(tuple(image.shape), (1, 16, 16, 3))

    def test_latent_ratio_controls_sampling_size_and_preserves_batch_metadata(self):
        latent = {"samples": torch.zeros(2, 4, 32, 32), "downscale_ratio_spacial": 8,
                  "noise_mask": torch.ones(1, 32, 32), "batch_index": [7, 8]}
        for mode, ratio, target, width, height in (
            ("longest", "16:9", 256, 256, 144),
            ("shortest", "16:9", 144, 256, 144),
            ("longest", "9:16", 256, 144, 256),
            ("original", "1:1", 192, 192, 192),
        ):
            with self.subTest(mode=mode, ratio=ratio):
                self.calls.clear()
                _, image, result = self.generate(latent=latent, input_resize=json.dumps({"mode": mode, "ratio": ratio, "size": target}))
                self.assertEqual(tuple(image.shape), (2, height, width, 3))
                self.assertEqual(tuple(result["samples"].shape), (2, 4, height // 8, width // 8))
                self.assertEqual(result["batch_index"], [7, 8])
                self.assertIs(result["noise_mask"], latent["noise_mask"])
                self.assertEqual(result["downscale_ratio_spacial"], 8)
        self.assertEqual(tuple(latent["samples"].shape), (2, 4, 32, 32))

    def test_latent_ratio_follows_input_by_default_and_aligns_qwen(self):
        latent = {"samples": torch.zeros(1, 4, 32, 32), "downscale_ratio_spacial": 8}
        self.assertIs(gen.resize_latent(latent, {"size": 1536}, object()), latent)
        vae = types.SimpleNamespace(spacial_compression_encode=lambda: 16)
        result = gen.resize_latent(latent, {"mode": "longest", "ratio": "16:9", "size": 512}, vae, True)
        self.assertEqual(tuple(result["samples"].shape), (1, 4, 36, 64))
        for options in ({"ratio": "bad"}, {"ratio": "1:1", "size": 0},
                        {"ratio": "1:1", "size": 1.5}, {"ratio": "16:9", "mode": "shortest", "size": 8192}):
            with self.assertRaises(ValueError): gen.resize_latent(latent, options, vae)

    def test_saved_edit_ignores_latent_ratio_override(self):
        with patch.object(gen, "load_asset", return_value=Image.new("RGB", (16, 32), "red")):
            _, image, _ = self.generate(latent={"samples": torch.zeros(1, 4, 16, 16)},
                edit_json='{"enabled":true,"source":"saved.png"}',
                input_resize='{"mode":"longest","ratio":"1:1","size":256}')
        self.assertEqual(tuple(image.shape), (1, 32, 16, 3))

    def test_inpaint_preserves_unmasked_pixels(self):
        source = frame([1, 0, 0], 16, 16); mask = torch.zeros(1, 16, 16); mask[:, 4:12, 4:12] = 1
        _, image, samples = self.generate(source_image=source, mask=mask, negative="negative")
        self.assertTrue(torch.equal(image[0, 0, 0], source[0, 0, 0]))
        self.assertTrue(torch.equal(image[0, 8, 8], torch.ones(3)))
        self.assertIn("noise_mask", samples)

    def loader_prompt(self, loader_type="LoadImage"):
        return {"443": {"class_type": loader_type, "inputs": {}},
                "552": {"inputs": {"source_image": ["443", 0], "mask": ["443", 1]}}}

    def test_normal_generation_ignores_load_image_default_empty_mask(self):
        for loader_type in ("LoadImage", "LoadImageOutput"):
            with self.subTest(loader=loader_type):
                self.calls.clear()
                _, image, samples = self.generate(source_image=frame([1, 0, 0], 160, 80),
                    mask=torch.zeros(1, 64, 64), prompt=self.loader_prompt(loader_type), unique_id="552",
                    input_resize='{"mode":"longest","size":64}')
                self.assertEqual(tuple(image.shape), (1, 32, 64, 3))
                self.assertTrue(torch.equal(image, torch.ones_like(image)), "Generated pixels must reach the output")
                self.assertIsNone(samples["noise_mask"])
                _, args, _ = self.calls[-1]
                self.assertEqual((args[6], args[7]), ("positive", "zero"))

    def test_load_image_painted_mask_keeps_unpainted_pixels(self):
        mask = torch.zeros(1, 16, 16); mask[:, :, 8:] = 1
        _, image, samples = self.generate(source_image=frame([1, 0, 0], 16, 16), mask=mask,
            prompt=self.loader_prompt(), unique_id="552")
        self.assertTrue(torch.equal(image[0, 8, 2], torch.tensor([1., 0., 0.])))
        self.assertTrue(torch.equal(image[0, 8, 12], torch.ones(3)))
        self.assertIsNotNone(samples["noise_mask"])

    def test_explicit_black_mask_is_not_treated_as_loader_default(self):
        for prompt in (None, self.loader_prompt("ExplicitMask"),
                       {"443": {"class_type": "LoadImage"}, "552": {"inputs": {"source_image": ["443", 0], "mask": ["other", 0]}}}):
            with self.subTest(prompt=prompt):
                _, image, _ = self.generate(source_image=frame([1, 0, 0], 16, 16), mask=torch.zeros(1, 16, 16),
                    prompt=prompt, unique_id="552")
                self.assertTrue(torch.equal(image, frame([1, 0, 0], 16, 16)))

    def test_saved_black_mask_still_preserves_entire_image(self):
        def load(name): return Image.new("L", (16, 16), 0) if name == "mask.png" else Image.new("RGB", (16, 16), "red")
        with patch.object(gen, "load_asset", side_effect=load):
            _, image, _ = self.generate(edit_json='{"enabled":true,"source":"saved.png","mask":"mask.png"}',
                prompt=self.loader_prompt(), unique_id="552")
        self.assertTrue(torch.equal(image, frame([1, 0, 0], 16, 16)))

    def test_dynamic_prompt_detects_default_loader_mask(self):
        prompt = self.loader_prompt()
        dynamic = types.SimpleNamespace(get_node=lambda ident: prompt[ident])
        _, image, _ = self.generate(source_image=frame([1, 0, 0], 16, 16), mask=torch.zeros(1, 64, 64),
            unique_id="552", dynprompt=dynamic)
        self.assertTrue(torch.equal(image, torch.ones_like(image)))

    def test_outpaint_original_center_preserved(self):
        source = frame([0, 1, 0], 32, 32); mask = torch.ones(1, 32, 32); mask[:, 8:24, 8:24] = 0
        _, image, _ = self.generate(source_image=source, mask=mask)
        self.assertTrue(torch.equal(image[:, 8:24, 8:24], source[:, 8:24, 8:24]))
        self.assertTrue(torch.equal(image[0, 0, 0], torch.ones(3)))

    def test_edit_state_uses_saved_source_not_new_preview(self):
        with patch.object(gen, "load_asset", return_value=Image.new("RGB", (16, 16), "red")) as load:
            self.generate(edit_json=json.dumps({"enabled": True, "source": "saved.png"}),
                          source_image=frame([0, 1, 0]), mask=torch.ones(1, 8, 16),
                          latent={"samples": frame([0, 0, 0])}, denoise=.42)
        load.assert_called_once_with("saved.png")
        self.assertEqual(self.calls[0][0], "encode")
        self.assertTrue(torch.equal(self.calls[0][1], frame([1, 0, 0], 16, 16)))
        self.assertIsNone(self.calls[-1][1][8].get("noise_mask"))
        self.assertEqual(self.calls[-1][2]["denoise"], .42)

    def test_missing_inputs_are_actionable(self):
        for kwargs in ({}, {"mask": torch.ones(1, 16, 16)}, {"edit_json": '{"enabled":true}'}):
            with self.assertRaises(ValueError): self.generate(**kwargs)

    def test_original_output_preserves_imported_pixels_before_editing(self):
        assets = {"imported.png": Image.new("RGB", (55, 35), "red"), "edited.png": Image.new("RGB", (80, 64), "blue")}
        with patch.object(gen, "load_asset", side_effect=lambda name: assets[name]):
            original, generated, _ = self.generate(original_image="imported.png",
                edit_json=json.dumps({"enabled": True, "source": "edited.png"}))
        self.assertEqual(gen.AllBuyGenerate.RETURN_NAMES, ("原图", "图片", "Latent"))
        self.assertTrue(torch.equal(original, frame([1, 0, 0], 55, 35)))
        self.assertEqual(tuple(generated.shape), (1, 64, 80, 3))
        self.assertTrue(torch.equal(self.calls[0][1], frame([0, 0, 1], 80, 64)))

    def test_original_output_remains_available_in_normal_mode(self):
        latent = {"samples": frame([0, 0, 0], 16, 16)}
        with patch.object(gen, "load_asset", return_value=Image.new("RGB", (24, 16), "red")):
            original, _, _ = self.generate(original_image="imported.png", latent=latent)
        self.assertTrue(torch.equal(original, frame([1, 0, 0], 24, 16)))
        self.assertEqual(self.calls[0][0], "sample")
        self.assertIs(self.calls[0][1][8], latent)

    def test_normal_image_uses_selected_edge_before_encoding(self):
        for mode, width, height in (("longest", 64, 32), ("shortest", 128, 64)):
            with self.subTest(mode=mode):
                self.calls.clear()
                source = frame([1, 0, 0], 160, 80).repeat(2, 1, 1, 1)
                self.generate(source_image=source, input_resize=json.dumps({"mode": mode, "size": 64}))
                encoded = self.calls[0][1]
                self.assertEqual(tuple(encoded.shape), (2, height, width, 3))
                self.assertEqual(self.calls[-1][2]["denoise"], 1)
                self.assertEqual(tuple(source.shape), (2, 80, 160, 3))

    def test_normal_resize_preserves_mask_alignment(self):
        source = frame([1, 0, 0], 160, 80)
        mask = torch.zeros(1, 80, 160); mask[:, :, 80:] = 1
        _, image, samples = self.generate(source_image=source, mask=mask,
            input_resize='{"mode":"longest","size":64}')
        self.assertEqual(tuple(samples["noise_mask"].shape), (1, 32, 64))
        self.assertTrue(torch.equal(image[0, 16, 8], torch.tensor([1., 0., 0.])))
        self.assertTrue(torch.equal(image[0, 16, 56], torch.ones(3)))

    def test_saved_edit_canvas_is_not_resized_again(self):
        with patch.object(gen, "load_asset", return_value=Image.new("RGB", (160, 80), "red")):
            self.generate(edit_json='{"enabled":true,"source":"saved.png"}',
                input_resize='{"mode":"shortest","size":64}')
        self.assertEqual(tuple(self.calls[0][1].shape), (1, 80, 160, 3))

    def test_resize_utility_matches_import_rounding_and_portrait(self):
        for width, height, mode, target, expected in (
            (1600, 1200, "longest", 320, (240, 320)),
            (1600, 1200, "shortest", 320, (320, 427)),
            (320, 480, "longest", 256, (256, 171)),
            (160, 120, "shortest", 640, (640, 853)),
        ):
            with self.subTest(mode=mode, source=(width, height)):
                result = gen.AllBuyImageResize().resize(frame([1, 0, 0], width, height), mode, target)[0]
                self.assertEqual(tuple(result.shape[1:3]), expected)
                self.assertTrue(((result >= 0) & (result <= 1)).all())
        source = frame([1, 0, 0], 55, 35)
        self.assertIs(gen.resize_image(source), source)
        with self.assertRaises(ValueError): gen.resize_image(source, "shortest", 8192)
        for mode, size in (("bad", 64), ("longest", 0), ("shortest", 1.5), ("longest", float("nan"))):
            with self.assertRaises(ValueError): gen.resize_image(source, mode, size)

    def test_stride_batch_and_feather(self):
        source = frame([0, 0, 0], 35, 33).repeat(2, 1, 1, 1)
        mask = torch.zeros(1, 33, 35); mask[:, 10:20, 10:20] = 1
        base, result = gen.prepare_edit(source, mask, 2, stride=16)
        self.assertEqual(tuple(base.shape), (2, 32, 32, 3)); self.assertEqual(tuple(result.shape), (2, 32, 32))
        self.assertTrue(((result > 0) & (result < 1)).any())
        with self.assertRaises(ValueError): gen.prepare_edit(source, mask.repeat(3, 1, 1), 0)

    def test_qwen_import_matches_native_reference_alignment(self):
        source = frame([1, 0, 0], 55, 35)
        with patch.object(gen, "load_asset", return_value=tools.to_pil(source[0])):
            self.generate(edit_json=json.dumps({"enabled": True, "source": "resized.png", "reference_encoding": "qwen_image21"}))
        encoded = self.calls[0][1]
        self.assertEqual(tuple(encoded.shape), (1, 32, 64, 3))

    def test_packed_vae_decode(self):
        self.assertEqual(tuple(gen.normalize_decoded(torch.zeros(1, 8, 8, 12)).shape), (1, 16, 16, 3))
        with self.assertRaises(ValueError): gen.normalize_decoded(torch.zeros(1, 8, 8, 5))


if __name__ == "__main__": unittest.main()
