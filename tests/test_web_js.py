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


class WebJsSyntaxTests(unittest.TestCase):
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
