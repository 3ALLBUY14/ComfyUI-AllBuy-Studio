"""Exercise the real LoRA node and Manager against an isolated on-disk catalog."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
pkg = types.ModuleType("vpl")
pkg.__path__ = [str(ROOT)]
sys.modules.setdefault("vpl", pkg)
store = importlib.import_module("vpl.lora_catalog_store")
DEFS = {"AllBuyLoRAStack": {"input": {"required": {
    "lora_picker": [["None", "MOSS/pixel.safetensors", "MOSS/second.safetensors"]], "unet_name": [["model"]],
    "ckpt_name": [["None"]], "gguf_name": [["None"]],
}}}}
APP = """
export const app = window.testApp = {registerExtension(ext){(window.extensions ||= {})[ext.name]=ext},
canvas:{setDirty(){}},graph:{_nodes:[],change(){},setDirtyCanvas(){}}};
"""
API = """
export const api = {fetchApi:(...args)=>fetch(...args),addEventListener(){},removeEventListener(){}};
"""
BOOT = """
await import('/extensions/test/lora_stack.js');
class Node {
 constructor(){this.type='AllBuyLoRAStack';this.id=1;this.size=[560,620];this.flags={};this.graph=testApp.graph;
 this.widgets=[{name:'模型类型',value:'UNET'},{name:'unet_name',value:'model'},
 {name:'stack_json',value:JSON.stringify([{id:'pixel',name:'MOSS/pixel.safetensors',weight:1,min:-3,max:3,enabled:true,trigger:'existing pixel text',_editingRange:true}])}];}
 setSize(value){this.size=value}
 addDOMWidget(name,type,container,options){document.querySelector('#mount').append(container);const w={name,type,options,y:96};this.widgets.push(w);return w}
}
const ext=extensions['AllBuy.LoRAStack'];
await ext.beforeRegisterNodeDef(Node,{name:'AllBuyLoRAStack'});
window.node=new Node();testApp.graph._nodes=[node];node.onNodeCreated();await ext.nodeCreated(node);
await import('/extensions/test/manager.js');extensions['AllBuy.FullscreenManager'].setup();
"""


def main():
    with tempfile.TemporaryDirectory(prefix="lora-trigger-browser-") as folder, patch.object(store.library_store, "get_user_libraries_folder", return_value=folder):
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless=True)
            page = browser.new_page(viewport={"width": 1500, "height": 1000})
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))

            def route(request):
                path = urlsplit(request.request.url).path
                if path == "/":
                    return request.fulfill(content_type="text/html", body='<link rel="stylesheet" href="/extensions/test/style.css"><div id="mount" style="width:560px;margin-top:110px"></div>')
                if path == "/scripts/app.js":
                    return request.fulfill(content_type="text/javascript", body=APP)
                if path == "/scripts/api.js":
                    return request.fulfill(content_type="text/javascript", body=API)
                if path.startswith("/extensions/test/"):
                    file = ROOT / "web" / path.removeprefix("/extensions/test/")
                    return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
                if path.endswith('/lora_recommendation/fetch'):
                    return request.fulfill(json={'ok': True, 'recommendation': {'min': .4, 'max': .8, 'default': .6, 'source': 'Civitai', 'url': 'https://civitai.com/models/1?modelVersionId=2', 'version': 'demo', 'matchedBy': 'SHA256', 'evidence': 'Recommended LoRA strength: 0.4 - 0.8'}})
                if path.endswith("/lora_catalog/update"):
                    try:
                        data = store.update_catalog(request.request.post_data_json)
                        return request.fulfill(json={"ok": True, **data})
                    except ValueError as error:
                        return request.fulfill(status=400, json={"ok": False, "error": str(error)})
                if path.endswith("/lora_catalog"):
                    return request.fulfill(json={"ok": True, **store.load_catalog()})
                if path == "/object_info/AllBuyLoRAStack":
                    return request.fulfill(json=DEFS)
                data = {"ok": True, "libraries": [], "groups": [], "presets": [], "models": {}}
                return request.fulfill(json=data)

            page.route("**/*", route)
            page.goto("http://127.0.0.1:9999/")
            page.add_script_tag(type="module", content=BOOT)
            page.locator("#allbuy-manager-launcher").wait_for()
            page.locator(".alora-trigger").wait_for()
            assert "triggers" not in store.load_catalog(), "mounting alone does not write unrelated workflow values"

            def open_model():
                page.locator("#allbuy-manager-launcher").click()
                panel = page.locator(".abm-overlay")
                panel.get_by_role("button", name="LoRA 模型", exact=True).click()
                panel.get_by_role("article", name="MOSS/pixel.safetensors", exact=True).click()
                return panel, panel.get_by_label("激活提示词", exact=True)

            panel, trigger = open_model()
            assert trigger.input_value() == "existing pixel text", "existing node text must reach Manager without retyping"
            assert store.load_catalog()["triggers"]["MOSS/pixel.safetensors"] == "existing pixel text"
            panel.get_by_role("button", name="收起管理面板", exact=True).click()
            page.locator(".alora-trigger").fill("new pixel text")
            page.wait_for_function("document.querySelector('.alora-trigger').title.includes('已保存')")
            panel, trigger = open_model()
            assert trigger.input_value() == "new pixel text", "node typing must persist into the actual Manager textarea"
            trigger.fill("")
            page.wait_for_function("document.querySelector('.abm-detail textarea').title.includes('已保存')")
            panel.get_by_role("button", name="收起管理面板", exact=True).click()
            panel, trigger = open_model()
            assert trigger.input_value() == "", "a deliberately cleared model must not be reseeded from an older node"
            assert store.load_catalog()["triggers"]["MOSS/pixel.safetensors"] == ""
            recommended = panel.get_by_label("推荐权重", exact=True)
            recommended.fill("0.65")
            panel.get_by_label("应用权重", exact=True).click()
            page.wait_for_function("document.querySelector('[aria-label=推荐权重]').title.includes('已保存')")
            assert store.load_catalog()["recommended_weights"]["MOSS/pixel.safetensors"] == 0.65
            assert panel.get_by_label("应用权重", exact=True).input_value() == "1", "this application draft stays independent"
            panel.get_by_role("button", name="MOSS", exact=False).filter(has=page.locator(".abm-count")).first.click()
            panel.locator(".abm-search input").fill("pixel")
            panel.get_by_role("button", name="收起管理面板", exact=True).click()
            page.locator("#allbuy-manager-launcher").click()
            page.wait_for_function("document.querySelector('[aria-label=推荐权重]')?.value === '0.65'")
            assert panel.get_by_label("应用权重", exact=True).input_value() == "0.65"
            assert panel.locator(".abm-search input").input_value() == "pixel"
            assert "MOSS" in panel.locator(".abm-sidebar .abm-nav-item.is-active").inner_text()
            panel.get_by_role("button", name="LoRA 组合", exact=True).click()
            panel.get_by_role("button", name="LoRA 模型", exact=True).click()
            assert panel.get_by_label("推荐权重", exact=True).input_value() == "0.65"
            page.reload()
            page.add_script_tag(type="module", content=BOOT)
            page.locator("#allbuy-manager-launcher").click()
            page.wait_for_function("document.querySelector('[aria-label=推荐权重]')?.value === '0.65'")
            assert panel.locator(".abm-search input").input_value() == "pixel"
            # Weight interval and source review.
            panel.get_by_role('button', name='推荐设置 / 来源', exact=True).click()
            dialog=page.get_by_role('dialog',name='推荐权重与来源 · pixel.safetensors')
            dialog.get_by_role('button',name='从 C 站获取',exact=True).click()
            page.wait_for_function("document.querySelector('.abm-recommendation-evidence').textContent.includes('0.4 - 0.8')")
            assert dialog.get_by_label('推荐下限',exact=True).input_value()=='0.4'
            assert store.load_catalog()['recommended_weights']['MOSS/pixel.safetensors']==.65, 'Fetch never silently saves'
            dialog.get_by_role('button',name='保存',exact=True).click()
            page.wait_for_selector('input[aria-label="在推荐区间内调整应用权重"]')
            assert store.load_catalog()['recommendations']['MOSS/pixel.safetensors']['min']==.4
            panel.get_by_label('应用权重',exact=True).fill('1.2')
            assert '超出' in panel.locator('.abm-recommendation-range').inner_text()
            panel.get_by_role('button',name='使用推荐',exact=True).click()
            assert panel.get_by_label('应用权重',exact=True).input_value()=='0.6'
            panel.get_by_label('在推荐区间内调整应用权重',exact=True).fill('0.75')
            assert panel.get_by_label('应用权重',exact=True).input_value()=='0.75'
            # Tags: search, staged creation, cancel, and actual atomic persistence.
            for i in range(20): store.update_catalog({'action':'create_tag','name':f'演示标签{i:02}'})
            store.update_catalog({'action':'set_tags','models':['MOSS/pixel.safetensors'],'tags':['演示标签00','演示标签01']})
            panel.get_by_role('button',name='编辑标签',exact=True).click()
            tags=page.get_by_role('dialog',name='编辑 1 个 LoRA 的标签')
            tags.get_by_label('搜索 LoRA 标签',exact=True).fill('标签0')
            assert tags.locator('.abm-tag-choice').count()==10
            tags.get_by_role('button',name='选中搜索结果',exact=True).click()
            assert len(store.load_catalog()['models']['MOSS/pixel.safetensors'])==2, 'Selections are staged'
            tags.get_by_label('新标签名称（可用逗号分隔）',exact=True).fill('新建测试')
            tags.get_by_role('button',name='新建并选中',exact=True).click()
            assert '新建测试' not in store.load_catalog()['tags']
            tags.get_by_role('button',name='取消',exact=True).click()
            assert '新建测试' not in store.load_catalog()['tags']
            panel.get_by_role('button',name='编辑标签',exact=True).click()
            tags.get_by_label('新标签名称（可用逗号分隔）',exact=True).fill('新建测试')
            tags.get_by_role('button',name='新建并选中',exact=True).click()
            tags.get_by_role('button',name='保存',exact=True).click()
            page.wait_for_function("!document.querySelector('.abm-modal')")
            assert '新建测试' in store.load_catalog()['models']['MOSS/pixel.safetensors']
            assert '演示标签00' in store.load_catalog()['models']['MOSS/pixel.safetensors']
            panel.locator('.abm-header-settings button').first.click()
            panel.get_by_role('button',name='编辑标签',exact=True).click()
            page.set_viewport_size({'width':480,'height':840})
            assert not tags.locator('.abm-tag-choice-grid').evaluate('n=>n.scrollWidth>n.clientWidth')
            tags.get_by_role('button',name='取消',exact=True).click()
            page.set_viewport_size({'width':1500,'height':1000})
            store.update_catalog({'action':'set_tags','models':['MOSS/second.safetensors'],'tags':['演示标签00']})
            panel.locator('.abm-search input').fill('')
            panel.get_by_label('选择 MOSS/pixel.safetensors',exact=True).check()
            panel.get_by_label('选择 MOSS/second.safetensors',exact=True).check()
            panel.locator('.abm-batch').get_by_role('button',name='标签',exact=True).click()
            mixed=page.get_by_role('dialog',name='编辑 2 个 LoRA 的标签')
            assert mixed.get_by_label('演示标签01',exact=True).evaluate('n=>n.indeterminate')
            mixed.get_by_label('演示标签00',exact=True).uncheck()
            mixed.get_by_role('button',name='保存',exact=True).click()
            page.wait_for_function("!document.querySelector('.abm-modal')")
            assert '演示标签01' in store.load_catalog()['models']['MOSS/pixel.safetensors']
            assert store.load_catalog()['models']['MOSS/second.safetensors']==[], 'Untouched partial tags must not spread to other models'
            assert not errors, errors
            browser.close()
    print("PASS: trigger sync, recommended weights, per-tab browsing persistence, page reload and no browser errors")


if __name__ == "__main__":
    main()
