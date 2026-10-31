"""Synthetic media and isolated catalog: verify content display without personal assets."""
import copy
import io
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit
from unittest.mock import patch

from PIL import Image
from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, BOOT, DEFS, ROOT, store


def main():
    definitions = copy.deepcopy(DEFS)
    definitions["AllBuyLoRAStack"]["input"]["required"]["lora_picker"][0].append("safe.safetensors")
    png = io.BytesIO(); Image.new("RGB", (240, 240), "#657ad0").save(png, format="PNG")
    with tempfile.TemporaryDirectory() as folder, patch.object(store.library_store, "get_user_libraries_folder", return_value=folder):
        store.update_catalog({"action": "set_content_rating", "models": ["MOSS/pixel.safetensors"], "rating": "nsfw"})
        previews = {"MOSS/pixel.safetensors": {"video": {"url": "/demo.mp4", "poster": "/demo.png"}}, "MOSS/second.safetensors": {"image": {"url": "/demo.png"}}, "safe.safetensors": {"content": {"rating": "sfw", "source": "本地来源信息"}, "image": {"url": "/demo.png"}}}
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless="--headed" not in sys.argv)
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            def shot(name):
                if "--artifacts" in sys.argv:
                    directory = Path(sys.argv[sys.argv.index("--artifacts") + 1]); directory.mkdir(parents=True, exist_ok=True)
                    page.locator(".abm-overlay").evaluate("n=>Promise.all(n.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})))")
                    page.screenshot(path=str(directory / name))
            errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
            video_requests = []

            def route(request):
                path = urlsplit(request.request.url).path
                if path == "/": return request.fulfill(content_type="text/html", body='<link rel="stylesheet" href="/extensions/test/style.css"><div id="mount"></div>')
                if path == "/scripts/app.js": return request.fulfill(content_type="text/javascript", body=APP)
                if path == "/scripts/api.js": return request.fulfill(content_type="text/javascript", body=API)
                if path.startswith("/extensions/test/"):
                    file = ROOT / "web" / path.removeprefix("/extensions/test/")
                    return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
                if path == "/demo.png": return request.fulfill(content_type="image/png", body=png.getvalue())
                if path == "/demo.mp4": video_requests.append(path); return request.fulfill(status=404)
                if path.endswith("/lora_catalog/update"):
                    return request.fulfill(json={"ok": True, **store.update_catalog(request.request.post_data_json)})
                if path.endswith("/lora_catalog"): return request.fulfill(json={"ok": True, **store.load_catalog()})
                if path.endswith("/lora_previews"): return request.fulfill(json={"models": previews})
                if path == "/object_info/AllBuyLoRAStack": return request.fulfill(json=definitions)
                return request.fulfill(json={"libraries": [], "presets": [], "groups": [{"id": "fav", "name": "我的收藏", "loras": ["MOSS/pixel.safetensors"]}], "models": {}})

            page.route("**/*", route); page.goto("http://127.0.0.1:9999/"); page.add_script_tag(type="module", content=BOOT)
            page.locator("#allbuy-manager-launcher").click()
            panel = page.locator(".abm-overlay"); panel.get_by_role("button", name="LoRA 模型", exact=True).click()
            card = panel.get_by_role("article", name="MOSS/pixel.safetensors", exact=True)
            card.locator(".abm-media-concealed").wait_for(); card.hover()
            assert card.locator("video").count() == 0 and not video_requests, "Blurred video must not autoplay or load a decoder"
            card.click(); assert panel.locator(".abm-detail .abm-media-concealed").count() == 1
            image_filter = card.locator(".abm-concealed-image").evaluate("n=>getComputedStyle(n).filter")
            assert "blur" in image_filter
            shot("lora-nsfw-blur-dark.png")
            card.locator(".abm-media-concealed").dblclick(position={"x": 50, "y": 40}); assert panel.locator(".abm-lightbox").count() == 0
            page.get_by_role("dialog", name="临时显示模型预览", exact=True).get_by_role("button", name="取消", exact=True).click()
            card.get_by_role("button", name="临时显示", exact=True).click(); assert card.locator(".abm-media-concealed").count() == 0
            panel.get_by_role("button", name="恢复模糊", exact=True).click(); card.locator(".abm-media-concealed").wait_for()
            panel.get_by_role("button", name="收起管理面板", exact=True).click(); page.locator("#allbuy-manager-launcher").click(); card.locator(".abm-media-concealed").wait_for()

            def mode(text, unknown=False):
                panel.get_by_role("button", name="内容显示 ·", exact=False).click()
                dialog = page.get_by_role("dialog", name="模型内容显示", exact=True)
                dialog.get_by_role("combobox", name="NSFW 显示方式", exact=True).click()
                page.get_by_role("option", name=text, exact=True).click()
                dialog.get_by_label("未评级的模型也按 NSFW 处理", exact=True).set_checked(unknown)
                dialog.get_by_role("button", name="保存", exact=True).click(); dialog.wait_for(state="detached")

            mode("隐藏模型")
            assert card.count() == 0 and panel.locator(".abm-detail video, .abm-detail img").count() == 0
            shot("lora-nsfw-hidden.png")
            panel.locator(".abm-search input").fill("pixel"); assert panel.locator(".abm-card").count() == 0
            panel.locator(".abm-search input").fill("")
            panel.get_by_role("button", name="★ 我的收藏", exact=False).click(); assert panel.locator(".abm-card").count() == 0
            panel.get_by_role("button", name="全部LoRA 模型", exact=False).click()
            mode("隐藏模型", True); assert panel.locator(".abm-card").count() == 1
            assert panel.get_by_role("article", name="safe.safetensors", exact=True).count() == 1
            mode("正常显示"); assert panel.locator(".abm-card").count() == 3
            card.click(); panel.get_by_role("button", name="内容评级", exact=True).click()
            dialog = page.get_by_role("dialog", name="设置模型内容评级", exact=True)
            dialog.get_by_role("combobox", name="内容评级", exact=True).click(); page.get_by_role("option", name="SFW", exact=True).click(); dialog.get_by_role("button", name="保存", exact=True).click(); dialog.wait_for(state="detached")
            assert store.load_catalog()["content_ratings"]["MOSS/pixel.safetensors"] == "sfw"
            mode("模糊预览"); assert card.locator(".abm-media-concealed").count() == 0, "Manual SFW overrides sources"
            mode("模糊预览", True)
            assert panel.get_by_role("article", name="MOSS/second.safetensors", exact=True).locator(".abm-media-concealed").count() == 1
            panel.locator(".abm-header-settings button").first.click()
            assert panel.evaluate("n=>n.dataset.theme") == "light"
            shot("lora-nsfw-blur-light.png")
            page.reload(); page.add_script_tag(type="module", content=BOOT); page.locator("#allbuy-manager-launcher").click()
            panel.get_by_role("article", name="MOSS/second.safetensors", exact=True).locator(".abm-media-concealed").wait_for()
            assert not errors, errors
            browser.close()
    print("PASS: blur/hide/show, no video loading while concealed, temporary reveal reset, search/favorite protection, unknown handling, manual rating and persistence")


if __name__ == "__main__": main()
