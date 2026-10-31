"""web/ 前端 JS 模块严格语法检查（不依赖 ComfyUI 环境）。

背景：node --check 对 .js 按 CommonJS 解析，`const` 重复声明等 ESM 早期错误
可能漏报（v3.92 事故：image_compare.js 重复声明 onMouseDown，浏览器模块解析
失败、扩展静默不加载）。这里把每个 .js 复制为 .mjs 后以 ESM 模式严格检查。

运行：python tests/test_web_js.py（需 node 在 PATH）
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")

# CI/离线环境补缺失模块桩（numpy/PIL 等，本机有真实库时不干预）；
# 下方两个与后端注册表交叉校验的测试会导入全部节点模块
try:
    from tests import _offline_stubs  # noqa: F401
except ImportError:
    import _offline_stubs  # noqa: F401


class WebJsSyntaxTests(unittest.TestCase):
    def test_lora_trigger_autosave(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH")
        script = os.path.join(os.path.dirname(__file__), "test_lora_triggers.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_image_compare_hover_and_drag(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH")
        script = os.path.join(os.path.dirname(__file__), "test_image_compare.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_workflow_library_storage_and_safety(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH")
        script = os.path.join(os.path.dirname(__file__), "test_workflow_library.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_generate_imported_qwen_reference_routing(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH")
        script = os.path.join(os.path.dirname(__file__), "test_generate_prompt.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fullscreen_manager_filters_and_workflow_adapters(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过全屏管理检查")
        script = os.path.join(os.path.dirname(__file__), "test_manager.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_library_picker_search_and_preferences(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过库菜单检查")
        script = os.path.join(os.path.dirname(__file__), "test_library_picker.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_lora_scroll_survives_canvas_switches(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过 LoRA 滚动位置检查")
        script = os.path.join(os.path.dirname(__file__), "test_lora_scroll.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_lora_multiselect_preserves_unselected_rows_and_validates_batches(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过 LoRA 多选检查")
        script = os.path.join(os.path.dirname(__file__), "test_lora_multi_select.mjs")
        result = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_library_rename_preserves_node_state(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过重命名检查")
        script = os.path.join(os.path.dirname(__file__), "test_library_rename.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_prompt_group_sorting_uses_exact_drop_position(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过拖拽排序检查")
        script = os.path.join(os.path.dirname(__file__), "test_list_reorder.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_library_list_height_stays_bounded(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过列表高度检查")
        script = os.path.join(os.path.dirname(__file__), "test_library_height.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_media_upload_uses_shared_storage(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过托管上传检查")
        script = os.path.join(os.path.dirname(__file__), "test_managed_upload.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_textbox_save_refreshes_matching_libraries(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过前端刷新检查")
        script = os.path.join(os.path.dirname(__file__), "test_library_refresh.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_help_badge_logic_and_geometry(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过帮助徽章检查")
        script = os.path.join(os.path.dirname(__file__), "test_help_badge.mjs")
        r = subprocess.run([shutil.which("node"), script], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_help_badge_covers_all_registered_nodes(self):
        # web/help_badge.js 的 HELP_NODES 必须与后端注册表完全一致：
        # 少一个 = 该节点没有帮助徽章；多一个 = 徽章挂在不存在的节点上。
        import importlib
        import types

        pkg_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pkg = types.ModuleType("vpl_helpcheck")
        pkg.__path__ = [pkg_dir]
        sys.modules.setdefault("vpl_helpcheck", pkg)
        backend = set()
        for name in ("nodes", "batch_image_node", "media_asset", "lora_stack_node",
                     "image_compare_node", "textbox_node", "image_tools", "generate_node"):
            backend |= set(importlib.import_module(f"vpl_helpcheck.{name}").NODE_CLASS_MAPPINGS)
        with open(os.path.join(WEB_DIR, "help_badge.js"), encoding="utf-8") as fh:
            js = fh.read()
        block = js.split("HELP_NODES = new Set([", 1)[1].split("]);", 1)[0]
        frontend = set()
        for line in block.splitlines():
            token = line.strip().strip('",')
            if token:
                frontend.add(token)
        self.assertEqual(frontend, backend,
                         "HELP_NODES 与后端 NODE_CLASS_MAPPINGS 不一致："
                         f"前端缺失 {sorted(backend - frontend)}，前端多出 {sorted(frontend - backend)}")

    def test_input_specs_are_two_element(self):
        # 输入 spec 必须是 (选项, 选项字典) 两元素：tooltip 拆到第三个元素会被
        # ComfyUI 的 schema 序列化静默丢弃，帮助卡片就看不到说明。
        # 依赖 ComfyUI 运行时的节点（如 Generate 需要 comfy.samplers）跳过。
        import importlib
        import types

        pkg_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        pkg = types.ModuleType("vpl_speccheck")
        pkg.__path__ = [pkg_dir]
        sys.modules.setdefault("vpl_speccheck", pkg)
        bad = []
        for mod_name in ("nodes", "batch_image_node", "media_asset", "lora_stack_node",
                         "image_compare_node", "textbox_node", "image_tools", "generate_node"):
            mod = importlib.import_module(f"vpl_speccheck.{mod_name}")
            for key, cls in getattr(mod, "NODE_CLASS_MAPPINGS", {}).items():
                try:
                    spec = cls.INPUT_TYPES()
                except Exception:
                    continue  # ComfyUI 运行时缺失，无法离线调用
                for group in ("required", "optional"):
                    for name, item in (spec.get(group) or {}).items():
                        if isinstance(item, tuple) and len(item) > 2:
                            bad.append(f"{key}.{name}: {len(item)} 元素")
                        elif (isinstance(item, tuple) and len(item) == 2
                              and item[1] is not None and not isinstance(item[1], dict)):
                            bad.append(f"{key}.{name}: 第二元素不是字典")
        self.assertEqual(bad, [], "输入 spec 不是两元素 (选项, 选项字典)：\n" + "\n".join(bad))

    def test_every_web_js_parses_as_esm(self):
        if shutil.which("node") is None:
            self.skipTest("node 不在 PATH，跳过前端语法检查")
        js_files = sorted(f for f in os.listdir(WEB_DIR) if f.endswith(".js"))
        self.assertTrue(js_files, "web/ 下没有任何 .js")
        with tempfile.TemporaryDirectory() as td:
            for name in js_files:
                dst = os.path.join(td, name + ".mjs")
                shutil.copyfile(os.path.join(WEB_DIR, name), dst)
                r = subprocess.run(
                    [shutil.which("node"), "--check", dst],
                    capture_output=True, text=True,
                )
                self.assertEqual(
                    r.returncode, 0,
                    f"{name} 无法按 ESM 模块解析（浏览器将静默不加载本扩展）:\n{r.stderr}",
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
