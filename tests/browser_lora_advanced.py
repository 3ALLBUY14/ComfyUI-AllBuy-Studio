"""Use production node UI with isolated state; no GPU or personal models required."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit
from unittest.mock import patch

from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, BOOT, DEFS, ROOT, store


def main():
    names = ["new/moved.safetensors", "other.safetensors", "third.safetensors", "fourth.safetensors"]
    definitions = copy.deepcopy(DEFS)
    definitions["AllBuyLoRAStack"]["input"]["required"]["lora_picker"][0] = ["None", *names]
    definitions["AllBuyLoRAStack"]["input"]["required"]["模型类型"] = [["UNET", "Checkpoint", "GGUF", "None"]]
    definitions["AllBuyLoRAStack"]["input"]["optional"] = {"on_missing": [["error", "skip"]],
        "clip_name": [["None", "text/encoder.safetensors"]], "clip_type": [["stable_diffusion", "minimax"]], "vae_name": [["None", "vae.safetensors"]]}
    entries = [{"id": "a", "name": "old/moved.safetensors", "weight": .6, "min": -3, "max": 3, "enabled": True, "trigger": "style"},
               {"id": "b", "name": names[1], "weight": .3, "min": -3, "max": 3, "enabled": False, "trigger": "off"},
               {"id": "c", "name": names[2], "weight": .8, "min": -3, "max": 3, "enabled": True, "trigger": "third"}]
    boot = BOOT.replace("window.node=new Node();", "window.node=new Node();node.widgets.find(w=>w.name==='stack_json').value="
                        + json.dumps(json.dumps(entries)) + ";node.widgets.push({name:'on_missing',value:'error'},{name:'clip_name',value:'text/encoder.safetensors'},"
                        + "{name:'clip_type',value:'stable_diffusion'},{name:'vae_name',value:'vae.safetensors'});")
    with tempfile.TemporaryDirectory(prefix="lora-advanced-browser-") as folder, patch.object(store.library_store, "get_user_libraries_folder", return_value=folder):
        store.update_catalog({"action": "create_tag", "name": "文件分类"})
        store.update_catalog({"action": "set_tags", "models": [entries[0]["name"]], "tags": ["文件分类"]})
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless="--headed" not in sys.argv)
            page = browser.new_page(viewport={"width": 1300, "height": 1100})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("dialog", lambda dialog: dialog.accept("画风组") if dialog.type == "prompt" else dialog.accept())

            def route(request):
                path = urlsplit(request.request.url).path
                if path == "/":
                    return request.fulfill(content_type="text/html", body='<meta charset="utf-8"><link rel="stylesheet" href="/extensions/test/style.css"><div id="mount" style="width:650px;margin-top:110px"></div><button id="outside">外部</button>')
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
                    return request.fulfill(json={"ok": True, **store.update_catalog(request.request.post_data_json)})
                if path.endswith("/lora_previews"):
                    return request.fulfill(json={"ok": True, "models": {names[0]: {"model_info": {"base_model": "MOSS", "version": "v1"}}}})
                if path == "/object_info/AllBuyLoRAStack":
                    return request.fulfill(json=definitions)
                return request.fulfill(json={"ok": True, "libraries": [], "groups": [], "presets": [], "models": {}})

            page.route("**/*", route)
            page.goto("http://127.0.0.1:9999/")
            page.add_script_tag(type="module", content=boot)
            page.wait_for_function("window.node?._aloraDropdowns && node._aloraAdvanced")
            header = page.locator(".alora-encoders")
            assert header.locator("select").count() == 0
            clip = header.get_by_role("button", name="CLIP 模型", exact=True)
            clip.click()
            clip_options = header.locator(".alora-encoder-dd").nth(0).get_by_role("listbox")
            clip_options.get_by_role("option", name="无", exact=True).click()
            assert page.evaluate("node.widgets.find(w=>w.name==='clip_name').value") == "None"
            assert header.get_by_role("button", name="CLIP 类型", exact=True).is_disabled()
            clip.click()
            clip_options.get_by_role("option", name="text/encoder.safetensors", exact=True).click()
            clip_type = header.get_by_role("button", name="CLIP 类型", exact=True)
            clip_type.press("ArrowDown")
            page.keyboard.press("ArrowDown")
            page.keyboard.press("Enter")
            assert page.evaluate("node.widgets.find(w=>w.name==='clip_type').value") == "minimax"
            vae = header.get_by_role("button", name="VAE 模型", exact=True)
            vae.click()
            header.locator(".alora-vae-dd").get_by_role("option", name="无", exact=True).click()
            assert page.evaluate("node.widgets.find(w=>w.name==='vae_name').value") == "None"
            vae.click()
            page.locator("#outside").click()
            assert vae.get_attribute("aria-expanded") == "false"
            model = page.locator(".alora-model-dd")
            model.locator(".vpl-dd-trigger").click()
            model.get_by_role("option", name="无", exact=True).click()
            assert page.evaluate("node.widgets.find(w=>w.name==='unet_name').value") == "None"
            page.locator(".alora-seg").get_by_role("button", name="无", exact=True).click()
            assert page.evaluate("node._allbuyManagerStack.snapshot().settings['模型类型']") == "None"
            page.evaluate("node.onConfigure()")
            page.wait_for_function("document.querySelector('.alora-seg button.on').dataset.t==='None'")
            page.locator(".alora-seg").get_by_role("button", name="UNET", exact=True).click()
            model.locator(".vpl-dd-trigger").click()
            model.get_by_role("option", name="model", exact=True).click()
            vae.click()
            header.locator(".alora-vae-dd").get_by_role("option", name="vae.safetensors", exact=True).click()
            if "--artifacts" in sys.argv:
                output = Path(sys.argv[sys.argv.index("--artifacts") + 1]); output.mkdir(parents=True, exist_ok=True)
                clip.click()
                page.wait_for_timeout(220)
                page.screenshot(path=str(output / "lora-header-dropdown-dark.png"))
                page.evaluate("document.documentElement.dataset.theme='light'")
                page.wait_for_timeout(220)
                page.screenshot(path=str(output / "lora-header-dropdown-light.png"))
                page.evaluate("delete document.documentElement.dataset.theme")
                page.locator("#outside").click()
            bar = page.locator(".alora-advanced-toolbar")
            for stale in [None, "", "None", "缺失时停止", False]:
                page.evaluate("value=>{node.widgets.find(w=>w.name==='on_missing').value=value;node.onConfigure()}", stale)
                page.wait_for_function("node.widgets.find(w=>w.name==='on_missing').value==='error'")
                assert bar.get_by_label("缺失 LoRA 处理", exact=True).input_value() == "error"
            # Queueing immediately after a late widget restore must still emit a valid combo value.
            for stale in [None, "", "None", "skip", "error"]:
                encoded = page.evaluate("async value=>{const w=node.widgets.find(w=>w.name==='on_missing');w.value=value;return w.serializeValue()}", stale)
                assert encoded == ("skip" if stale == "skip" else "error")
            page.evaluate("node.onConfigure()")
            page.locator(".alora-list-head").get_by_role("button", name="多选", exact=True).click()
            page.locator('.alora-row[data-id="a"] .alora-row-select').check()
            page.locator('.alora-row[data-id="b"] .alora-row-select').check()
            bar.get_by_role("button", name="选中分组", exact=True).click()
            header = page.locator('.alora-stack-group[data-group="画风组"]')
            header.wait_for()
            header.get_by_role("button", name="停用组", exact=True).click()
            assert page.evaluate("node._stackEntries[0].enabled && !node._stackEntries[1].enabled && node._stackEntries[0].group_off")
            assert page.locator(".alora-trig-summary").inner_text() == "third"
            bar.get_by_role("button", name="停用全部", exact=True).click()
            assert page.evaluate("node._stackEntries.every(e=>!e.enabled)")
            bar.get_by_role("button", name="恢复原启用", exact=True).click()
            assert page.evaluate("node._stackEntries[0].enabled && !node._stackEntries[1].enabled && node._stackEntries[0].group_off && node._stackEntries[2].enabled")
            header.get_by_role("button", name="启用组", exact=True).click()
            assert page.evaluate("!node._stackEntries[0].group_off && !node._stackEntries[1].enabled")
            header.get_by_role("button", name="▾ 画风组", exact=True).click()
            assert page.locator('.alora-row[data-id="a"]').is_hidden()
            assert page.evaluate("JSON.parse(node.widgets.find(w=>w.name==='stack_json').value).length") == 3
            page.evaluate("node.onConfigure()")
            page.wait_for_timeout(100)
            assert page.locator('.alora-row[data-id="a"]').is_hidden()
            header.get_by_role("button", name="▸ 画风组", exact=True).click()
            header.get_by_role("button", name="↓", exact=True).click()
            assert page.evaluate("node._stackEntries.map(e=>e.id).join(',')") == "c,a,b"
            bar.get_by_role("button", name="检查 / 找回文件", exact=True).click()
            page.wait_for_function("node._stackEntries.find(e=>e.id==='a').name==='new/moved.safetensors'")
            assert page.evaluate("node._stackEntries.find(e=>e.id==='a').name") == names[0]
            assert store.load_catalog()["models"][names[0]] == ["文件分类"]
            assert "已找回 1 条" in bar.inner_text()
            bar.get_by_label("缺失 LoRA 处理", exact=True).select_option("skip")
            assert page.evaluate("node.widgets.find(w=>w.name==='on_missing').value") == "skip"
            row = page.locator('.alora-row[data-id="a"]')
            row.get_by_title("强度 +0.05（Shift +0.01，Alt +1）", exact=True).click(modifiers=["Shift"])
            assert page.evaluate("node._stackEntries.find(e=>e.id==='a').weight") == .61
            row.get_by_label("LoRA 权重", exact=True).press("Shift+ArrowUp")
            assert page.evaluate("node._stackEntries.find(e=>e.id==='a').weight") == .62
            assert "linear-gradient" in row.locator(".alora-name-btn").evaluate("el=>el.style.backgroundImage")
            row.locator(".alora-name-btn").hover()
            page.locator(".alora-info-card").get_by_text("底模：MOSS · 版本：v1", exact=True).wait_for()
            page.locator("#outside").hover()
            assert page.locator(".alora-info-card").count() == 0
            page.locator(".alora-add").click()
            popup = page.locator(".alora-pop")
            popup.get_by_role("button", name="勾选添加", exact=True).click()
            popup.locator(".alora-pop-search").fill("other")
            popup.get_by_label("勾选模型：" + names[1], exact=True).check()
            popup.locator(".alora-pop-search").fill("fourth")
            popup.get_by_label("勾选模型：" + names[3], exact=True).check()
            assert page.evaluate("node._stackEntries.length") == 3, "checking is a draft until Add"
            popup.get_by_role("button", name="加入已选 (2)", exact=True).click()
            assert popup.is_visible() and page.evaluate("node._stackEntries.length") == 5
            assert popup.get_by_role("button", name="加入已选 (0)", exact=True).is_disabled()
            page.locator("#outside").click()
            page.evaluate("""(()=>{const graph=node.graph;node.outputs=[{type:'MODEL',links:[10]}];
              window.loader={id:2,type:'LoraLoaderModelOnly',mode:0,inputs:[{type:'MODEL',link:10}],outputs:[{type:'MODEL',links:[11]}],widgets:[{name:'lora_name',value:'third.safetensors'},{name:'strength_model',value:.4}]};
              const end={id:3,type:'KSampler'};graph.links={10:{target_id:2,target_slot:0},11:{target_id:3,target_slot:0}};graph.getNodeById=id=>({2:loader,3:end})[id];})()""")
            bar.get_by_role("button", name="合并后方 LoRA 链", exact=True).click()
            assert page.evaluate("loader.mode===4 && node._stackEntries.length===6 && node._stackEntries.at(-1).weight===.4")
            assert page.evaluate("node.graph.links[11].target_id") == 3, "absorb keeps original connections"
            assert page.evaluate("node._allbuyManagerStack.snapshot().settings.on_missing") == "skip"
            page.evaluate("node._stackEntries.push({id:'missing',name:'absent.safetensors',weight:1,min:-3,max:3,enabled:true,trigger:'must-not-appear'});node.widgets.find(w=>w.name==='stack_json').value=JSON.stringify(node._stackEntries);node.onConfigure()")
            page.wait_for_function("document.querySelector('.alora-row[data-id=missing]')")
            assert "must-not-appear" not in page.locator(".alora-trig-summary").inner_text()
            bar.get_by_label("缺失 LoRA 处理", exact=True).select_option("error")
            assert "must-not-appear" in page.locator(".alora-trig-summary").inner_text()
            bar.get_by_label("缺失 LoRA 处理", exact=True).select_option("skip")
            page.locator(".alora-seg").get_by_role("button", name="无", exact=True).click()
            assert "must-not-appear" in page.locator(".alora-trig-summary").inner_text(), "without a base, trigger output does not require model files"
            page.locator(".alora-seg").get_by_role("button", name="UNET", exact=True).click()
            assert "must-not-appear" not in page.locator(".alora-trig-summary").inner_text()
            if "--artifacts" in sys.argv:
                output = Path(sys.argv[sys.argv.index("--artifacts") + 1]); output.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(output / "lora-stack-advanced.png"), full_page=True)
            for index in range(28): store.update_catalog({"action":"create_tag","name":f"分类 {index:02d}"})
            page.evaluate("node._aloraCatalog.refresh()")
            page.get_by_role("button",name="标签管理",exact=True).click()
            tag_list = page.locator('.alora-tag-list')
            tag_list.wait_for()
            for theme in ['dark','light']:
                page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
                page.locator('.vpl-dialog').evaluate("el=>Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})))")
                tag_list.evaluate('el=>el.scrollTop=el.scrollHeight')
                metrics=tag_list.evaluate("""el=>{const r=el.getBoundingClientRect(),last=el.querySelector('.alora-tag-manage-row:last-child button:last-child').getBoundingClientRect();
                  return {overflow:el.scrollHeight>el.clientHeight,width:getComputedStyle(el).scrollbarWidth,gutter:getComputedStyle(el).scrollbarGutter,
                    gap:r.left+el.clientLeft+el.clientWidth-last.right,horizontal:el.scrollWidth>el.clientWidth};}""")
                assert metrics['overflow'] and metrics['width']=='thin' and metrics['gutter']=='stable' and metrics['gap']>=8 and not metrics['horizontal'],metrics
                if '--artifacts' in sys.argv:
                    page.locator('.vpl-dialog').screenshot(path=str(output/f'lora-tags-scroll-{theme}.png'))
            page.locator('.vpl-dialog').get_by_role('button',name='关闭',exact=True).last.click()
            assert not errors, errors
            browser.close()
    print("PASS: custom header dropdowns, None selections, keyboard, stack groups, master restore, reload, repair, missing policy, hover, fine strength, batch picker and model-only absorb")


if __name__ == "__main__":
    main()
