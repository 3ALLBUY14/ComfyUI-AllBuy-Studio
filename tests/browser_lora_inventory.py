"""Exercise metadata, saved filters and background hashing with synthetic local models."""
import copy
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch
from PIL import Image
from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, BOOT, DEFS, ROOT, store

duplicates = importlib.import_module("vpl.lora_duplicates")
content = importlib.import_module("vpl.lora_content")


def main():
    definitions = copy.deepcopy(DEFS); definitions["AllBuyLoRAStack"]["input"]["required"]["lora_picker"][0].append("safe.safetensors")
    names = ["MOSS/pixel.safetensors", "MOSS/second.safetensors", "safe.safetensors"]
    png = io.BytesIO(); Image.new("RGB", (240, 240), "#657ad0").save(png, format="PNG")
    with tempfile.TemporaryDirectory() as folder, patch.object(store.library_store, "get_user_libraries_folder", return_value=folder):
        files = {}
        for index, name in enumerate(names):
            path = Path(folder) / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"same" if index < 2 else b"different size")
            path.with_suffix(".civitai.info").write_text(json.dumps({"baseModel": "Flux" if index < 2 else "SDXL", "name": "v2" if index != 1 else "v1"}), encoding="utf-8"); files[name] = path
        for tag in ["画风", "人物", "工具"]: store.update_catalog({"action": "create_tag", "name": tag})
        store.update_catalog({"action": "set_tags", "models": [names[0]], "tags": ["画风", "人物"]})
        store.update_catalog({"action": "set_tags", "models": [names[1]], "tags": ["画风"]})
        scanner = duplicates.DuplicateScanner(); original_hash = scanner._hash
        def slow_hash(path, stop): time.sleep(.25); return original_hash(path, stop)
        scanner._hash = slow_hash
        with patch.object(duplicates.lora_preview_store, "installed_models", return_value=files), sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless="--headed" not in sys.argv)
            page = browser.new_page(viewport={"width": 1600, "height": 1000}); errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
            def shot(name):
                if "--artifacts" in sys.argv:
                    target = Path(sys.argv[sys.argv.index("--artifacts") + 1]); target.mkdir(parents=True, exist_ok=True)
                    page.locator(".abm-modal").evaluate("n=>Promise.all(n.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))")
                    page.screenshot(path=str(target / name))

            def route(request):
                url = urlsplit(request.request.url); path = url.path
                if path == "/": return request.fulfill(content_type="text/html", body='<link rel="stylesheet" href="/extensions/test/style.css"><div id="mount"></div>')
                if path == "/scripts/app.js": return request.fulfill(content_type="text/javascript", body=APP)
                if path == "/scripts/api.js": return request.fulfill(content_type="text/javascript", body=API)
                if path.startswith("/extensions/test/"):
                    file = ROOT / "web" / path.removeprefix("/extensions/test/")
                    return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
                if path == "/demo.png": return request.fulfill(content_type="image/png", body=png.getvalue())
                if path.endswith("/lora_catalog/update"): return request.fulfill(json={"ok": True, **store.update_catalog(request.request.post_data_json)})
                if path.endswith("/lora_catalog"): return request.fulfill(json={"ok": True, **store.load_catalog()})
                if path.endswith("/lora_previews"): return request.fulfill(json={"models": {name: {**content.local_metadata(file), "image": {"url": "/demo.png"}} for name, file in files.items()}})
                if path == "/object_info/AllBuyLoRAStack": return request.fulfill(json=definitions)
                if path.endswith("/lora_duplicates/start"): return request.fulfill(json={"ok": True, "job": scanner.start(request.request.post_data_json["models"])})
                if path.endswith("/lora_duplicates/state"): return request.fulfill(json={"ok": True, "job": scanner.snapshot(parse_qs(url.query)["id"][0])})
                if path.endswith("/lora_duplicates/cancel"): return request.fulfill(json={"ok": True, "job": scanner.cancel(request.request.post_data_json["id"])})
                return request.fulfill(json={"libraries": [], "presets": [], "groups": [], "models": {}})
            page.route("**/*", route); page.goto("http://127.0.0.1:9999/"); page.add_script_tag(type="module", content=BOOT); page.locator("#allbuy-manager-launcher").click()
            panel = page.locator(".abm-overlay"); panel.get_by_role("button", name="LoRA 模型", exact=True).click(); pixel = panel.get_by_role("article", name=names[0], exact=True); pixel.click()
            assert "Flux · v2" in pixel.inner_text()
            panel.get_by_role("button", name="底模 / 版本", exact=True).click(); dialog = page.get_by_role("dialog", name="底模与版本 · pixel.safetensors", exact=True)
            dialog.get_by_label("模型版本", exact=True).fill("custom"); dialog.get_by_role("button", name="保存", exact=True).click(); dialog.wait_for(state="detached"); assert "custom" in pixel.inner_text()
            panel.get_by_role("button", name="底模 / 版本", exact=True).click(); dialog.get_by_label("恢复自动读取", exact=True).check(); dialog.get_by_role("button", name="保存", exact=True).click(); dialog.wait_for(state="detached"); assert "v2" in pixel.inner_text()
            panel.get_by_role("button", name="高级筛选", exact=True).click(); filters = page.get_by_role("dialog", name="高级筛选与预设", exact=True)
            filters.get_by_label("筛选底模 Flux", exact=True).check(); filters.get_by_role("button", name="包含标签 画风", exact=True).click(); filters.get_by_role("button", name="排除标签 人物", exact=True).click()
            filters.get_by_label("筛选预设名称", exact=True).fill("Flux画风"); filters.get_by_role("button", name="新建预设", exact=True).click(); shot("lora-advanced-filters.png")
            filters.get_by_role("button", name="应用", exact=True).click(); filters.wait_for(state="detached")
            assert panel.locator(".abm-card").count() == 1; assert panel.get_by_role("article", name=names[1], exact=True).count() == 1
            panel.get_by_role("button", name="高级筛选", exact=True).click(); filters.get_by_role("button", name="清除本次筛选条件", exact=True).click(); filters.get_by_role("button", name="应用", exact=True).click(); filters.wait_for(state="detached"); assert panel.locator(".abm-card").count() == 3
            panel.get_by_role("button", name="应用筛选预设 Flux画风", exact=True).click(); assert panel.locator(".abm-card").count() == 1
            panel.get_by_role("button", name="高级筛选", exact=True).click(); filters.get_by_role("combobox", name="筛选预设", exact=True).click(); page.get_by_role("option", name="Flux画风", exact=True).click(); filters.get_by_role("button", name="应用", exact=True).click(); filters.wait_for(state="detached"); assert panel.locator(".abm-card").count() == 1
            page.reload(); page.add_script_tag(type="module", content=BOOT); page.locator("#allbuy-manager-launcher").click(); panel.get_by_role("article", name=names[1], exact=True).wait_for(); assert panel.locator(".abm-card").count() == 1
            panel.get_by_role("button", name="重复检测", exact=True).click(); result = page.get_by_role("dialog", name="模型重复检测", exact=True); result.get_by_role("button", name="开始 / 重新检测", exact=True).click()
            result.get_by_role("button", name="取消", exact=True).click(); panel.get_by_role("button", name="查看查重结果", exact=True).click(); result.locator(".abm-duplicate-group").wait_for()
            assert result.locator(".abm-duplicate-row").count() == 2; shot("lora-duplicate-results.png")
            result.locator(".abm-duplicate-row").filter(has_text=names[0]).get_by_role("button", name="定位模型", exact=True).click(); result.wait_for(state="detached")
            assert panel.locator(".abm-card.is-focused").get_attribute("aria-label") == names[0]
            assert not page.locator(".abm-stack-editor").count(), "Viewing a result must never apply it to workflow"
            store.update_catalog({"action": "set_content_rating", "models": [names[1]], "rating": "nsfw"})
            panel.get_by_role("button", name="↻ 刷新", exact=True).click(); panel.get_by_role("button", name="内容显示 ·", exact=False).click()
            display = page.get_by_role("dialog", name="模型内容显示", exact=True); display.get_by_role("combobox", name="NSFW 显示方式", exact=True).click(); page.get_by_role("option", name="隐藏模型", exact=True).click(); display.get_by_role("button", name="保存", exact=True).click(); display.wait_for(state="detached")
            panel.get_by_role("button", name="查看查重结果", exact=True).click(); result.get_by_text("未发现相同内容的可见模型", exact=True).wait_for(); assert names[1] not in result.locator(".abm-duplicate-results").inner_text(); result.get_by_role("button", name="完成", exact=True).click(); result.wait_for(state="detached")
            panel.locator(".abm-header-settings button").first.click(); panel.get_by_role("button", name="高级筛选", exact=True).click(); shot("lora-advanced-light.png")
            page.set_viewport_size({"width": 480, "height": 840}); assert not filters.evaluate("n=>n.scrollWidth>n.clientWidth")
            assert not errors, errors; browser.close()
        scanner.executor.shutdown(wait=True)
    print("PASS: source metadata, manual/auto restore, include/exclude/base filters, named preset persistence, background duplicate results and locate-only action")


if __name__ == "__main__": main()
