"""Keep the real add picker open for successive model, group and tag additions."""
import copy
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit
from unittest.mock import patch

from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, BOOT, DEFS, ROOT, store


def main():
    definitions = copy.deepcopy(DEFS)
    names = [f"candidate-{index:02d}.safetensors" for index in range(25)]
    definitions["AllBuyLoRAStack"]["input"]["required"]["lora_picker"][0].extend(names)
    groups = [{"id": "batch", "name": "批量演示", "loras": names[:2]}]
    with tempfile.TemporaryDirectory(prefix="allbuy-picker-") as folder, patch.object(store.library_store, "get_user_libraries_folder", return_value=folder):
        store.update_catalog({"action": "create_tag", "name": "风格"})
        store.update_catalog({"action": "set_tags", "models": names[2:4], "tags": ["风格"]})
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless=True)
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            errors = []
            fail_next_tag_save = [False]
            page.on("pageerror", lambda error: errors.append(str(error)))

            def route(request):
                path = urlsplit(request.request.url).path
                if path == "/":
                    return request.fulfill(content_type="text/html", body='<link rel="stylesheet" href="/extensions/test/style.css"><div id="mount" style="width:560px;margin-top:110px"></div><button id="outside">弹窗外部</button>')
                if path == "/scripts/app.js":
                    return request.fulfill(content_type="text/javascript", body=APP)
                if path == "/scripts/api.js":
                    return request.fulfill(content_type="text/javascript", body=API)
                if path.startswith("/extensions/test/"):
                    file = ROOT / "web" / path.removeprefix("/extensions/test/")
                    return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
                if path.endswith("/lora_catalog"):
                    return request.fulfill(json={"ok": True, **store.load_catalog()})
                if path.endswith("/lora_catalog/update"):
                    if fail_next_tag_save[0] and request.request.post_data_json["action"] == "patch_tags":
                        fail_next_tag_save[0] = False
                        return request.fulfill(status=503, json={"ok": False, "error": "测试标签保存失败"})
                    return request.fulfill(json={"ok": True, **store.update_catalog(request.request.post_data_json)})
                if path.endswith("/lora_groups"):
                    return request.fulfill(json={"ok": True, "groups": groups})
                if path == "/object_info/AllBuyLoRAStack":
                    return request.fulfill(json=definitions)
                return request.fulfill(json={"ok": True, "libraries": [], "groups": [], "presets": [], "models": {}})

            page.route("**/*", route)
            page.goto("http://127.0.0.1:9999/")
            page.add_script_tag(type="module", content=BOOT)
            page.locator(".alora-add").wait_for()
            page.wait_for_function("node._aloraDropdowns && document.querySelector('[aria-label=\"按标签筛选\"]').options.length===3")
            page.locator(".alora-add").click()
            pop = page.locator(".alora-pop")
            search = pop.locator(".alora-pop-search")
            search.fill("candidate-")
            sorting = pop.get_by_label("选择器排序", exact=True)
            sorting.select_option("name_desc")
            heading = pop.locator('.alora-grp-head[data-group="g:batch"]')
            heading.click()
            assert heading.get_attribute("aria-expanded") == "false"
            row = pop.locator('.alora-file-name[title="candidate-12.safetensors"]')
            row.scroll_into_view_if_needed()
            scroll_top = pop.locator(".alora-pop-list").evaluate("el=>el.scrollTop")
            assert scroll_top > 0
            pop.evaluate("el=>window.originalPicker=el")
            row.click()
            assert pop.is_visible() and pop.evaluate("el=>el===window.originalPicker"), "single add must preserve the same popup"
            assert search.input_value() == "candidate-" and sorting.input_value() == "name_desc"
            assert abs(pop.locator(".alora-pop-list").evaluate("el=>el.scrollTop") - scroll_top) <= 1
            assert heading.get_attribute("aria-expanded") == "false", "adding cannot rebuild collapsed sections"
            pop.locator('.alora-file-name[title="candidate-11.safetensors"]').click()
            assert page.evaluate("node._stackEntries.slice(-2).map(e=>e.name).join(',')") == ",".join([names[12], names[11]])
            assert pop.is_visible(), "a second model can be added without reopening"
            heading.get_by_title("整组加入堆栈", exact=True).click()
            assert pop.is_visible() and page.evaluate("node._stackEntries.length") == 5
            heading.get_by_title("整组加入堆栈", exact=True).click()
            assert page.evaluate("node._stackEntries.length") == 5, "whole-group add remains deduplicated"
            pop.get_by_label("选择器标签筛选", exact=True).select_option("#风格")
            pop.get_by_role("button", name="同标签加入", exact=True).click()
            assert pop.is_visible() and page.evaluate("node._stackEntries.length") == 7
            assert pop.get_by_role("button", name="同标签加入", exact=True).is_disabled(), "batch availability updates without dismissing the popup"
            assert pop.get_by_label("选择器标签筛选", exact=True).input_value() == "#风格"
            search.click()
            assert pop.is_visible(), "clicking controls inside the popup must not dismiss it"
            serialized = page.evaluate("JSON.parse(node.widgets.find(w=>w.name==='stack_json').value).map(e=>e.name)")
            assert serialized[-2:] == names[2:4], "all successive additions are serialized to the workflow"
            pop.get_by_label("选择器标签筛选", exact=True).select_option("")
            target = pop.locator('.alora-file-name[title="candidate-12.safetensors"]').locator("..")
            target.get_by_title("快速编辑此 LoRA 的标签", exact=True).click()
            quick = target.get_by_role("group", name="快速编辑标签：" + names[12], exact=True)
            assert quick.locator("label").first.evaluate("el=>getComputedStyle(el).color") != "rgb(0, 0, 0)", "quick tag labels must remain legible on the dark popup"
            quick.get_by_label("标签：风格", exact=True).check()
            page.wait_for_function("document.querySelector('.alora-quick-tags .alora-presets-message').textContent==='标签已保存'")
            assert store.load_catalog()["models"][names[12]] == ["风格"]
            assert page.evaluate("node._stackEntries.length") == 7, "quick tag editing must not add a model"
            assert pop.evaluate("el=>el===window.originalPicker"), "saving tags must preserve the original picker"
            assert sorting.input_value() == "name_desc" and search.input_value() == "candidate-"
            assert target.locator(".alora-picker-tags").get_by_role("button", name="风格", exact=True).count() == 1
            assert page.locator('.alora-row[data-name="candidate-12.safetensors"] .alora-tag-chip').inner_text() == "风格"
            tag_input = quick.get_by_label("搜索或新建标签", exact=True)
            tag_input.fill("新分类")
            tag_input.evaluate("el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))")
            assert "新分类" not in store.load_catalog()["tags"], "IME confirmation must not create a tag"
            tag_input.press("Enter")
            quick.get_by_label("标签：新分类", exact=True).wait_for()
            page.wait_for_function("!document.querySelector('.alora-quick-tags input').disabled")
            assert set(store.load_catalog()["models"][names[12]]) == {"风格", "新分类"}
            assert quick.get_by_label("标签：新分类", exact=True).is_checked()
            assert pop.get_by_label("选择器标签筛选", exact=True).locator('option[value="#新分类"]').count() == 1
            quick.get_by_label("标签：风格", exact=True).uncheck()
            page.wait_for_function("!document.querySelector('.alora-quick-tags input').disabled")
            assert store.load_catalog()["models"][names[12]] == ["新分类"], "removing one tag preserves other tags"
            fail_next_tag_save[0] = True
            quick.get_by_label("标签：风格", exact=True).check()
            quick.get_by_role("status").filter(has_text="测试标签保存失败").wait_for()
            assert store.load_catalog()["models"][names[12]] == ["新分类"]
            assert quick.is_visible() and not quick.get_by_label("标签：风格", exact=True).is_checked()
            quick.get_by_label("标签：风格", exact=True).check()
            page.wait_for_function("!document.querySelector('.alora-quick-tags input').disabled")
            assert set(store.load_catalog()["models"][names[12]]) == {"风格", "新分类"}, "failed saves can be retried"
            if "--artifacts" in sys.argv:
                output = Path(sys.argv[sys.argv.index("--artifacts") + 1]); output.mkdir(parents=True, exist_ok=True)
                quick.scroll_into_view_if_needed()
                pop.screenshot(path=str(output / "lora-picker-quick-tags.png"))
            quick.get_by_role("button", name="完成", exact=True).click()
            assert pop.is_visible() and quick.count() == 0
            assert page.evaluate("node._stackEntries.length") == 7
            assert pop.locator(".alora-pop-list").evaluate("el=>el.scrollTop") > 0, "tagging must not reset the scrolled picker to the top"
            target.locator(".alora-picker-tags").get_by_role("button", name="新分类", exact=True).click()
            assert pop.get_by_label("选择器标签筛选", exact=True).input_value() == "#新分类"
            assert pop.locator(".alora-file-name").count() == 1, "existing tag chips still filter models"
            page.locator("#outside").click()
            assert pop.count() == 0 and page.evaluate("node._aloraPickerClose===null"), "outside click closes and cleans up the picker"
            page.locator(".alora-add").click()
            page.keyboard.press("Escape")
            assert pop.count() == 0, "Escape remains available"
            # Replacing a row is a single choice and must not leave an orphaned anchor.
            page.locator(".alora-row .alora-name-btn").first.click()
            pop.get_by_label("选择器标签筛选", exact=True).select_option("")
            pop.locator(".alora-pop-search").fill("candidate-20")
            pop.locator('.alora-file-name[title="candidate-20.safetensors"]').click()
            assert pop.count() == 0 and page.evaluate("node._stackEntries.length") == 7
            assert page.evaluate("node._stackEntries[0].name") == names[20]
            assert not errors, errors
            browser.close()
    print("PASS: successive additions and inline quick tags preserve popup, filters and scroll; create/remove, save errors, retry, IME, outside dismissal and replacement work")


if __name__ == "__main__":
    main()
