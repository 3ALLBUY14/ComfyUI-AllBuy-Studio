"""Exercise the actual editor, serialized widgets and Python compiler in Chrome."""
import io
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright, expect
from test_moss_layout import layout

ROOT = Path(__file__).resolve().parents[1]
APP = """export const app = window.testApp = {registerExtension(e){(window.extensions ||= {})[e.name]=e},graph:{change(){}},canvas:{setDirty(){}}};"""
API = """export const api = {apiURL:p=>p,fetchApi:(...a)=>fetch(...a),addEventListener(){},removeEventListener(){}};"""
BOOT = """
await import('/extensions/test/moss_layout.js');
class Node {
 constructor(id=1){this.id=id;this.type='AllBuyMossLayoutPrompt';this.properties={};this.mode=0;this.size=[560,540];this.graph=testApp.graph;this.widgets=[{name:'layout_json',value:JSON.stringify({width:1024,height:1024,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'',canvas:'single'},items:[]})}];}
 setSize(v){this.size=v;if(this._wrap)this._wrap.style.width=(v[0]-20)+'px';this.onResize?.(v)}
 setDirtyCanvas(){}
 addInput(name,type){(this.inputs||=[]).push({name,type,link:null})}
 addDOMWidget(name,type,container,options){const wrap=document.createElement('div');wrap.className='dom-widget';wrap.style.position='relative';wrap.style.width=(this.size[0]-20)+'px';this._wrap=wrap;wrap.append(container);document.querySelector('#mount').append(wrap);const w={name,type,options,y:80};this.widgets.push(w);return w}
}
window.NodeClass=Node;window.node=new Node();
const ext=extensions['AllBuy.MossLayoutPrompt'];ext.beforeRegisterNodeDef(Node,{name:'AllBuyMossLayoutPrompt'});node.onNodeCreated();ext.nodeCreated(node);
"""


def main():
    output = Path(sys.argv[sys.argv.index("--artifacts") + 1]) if "--artifacts" in sys.argv else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    image = io.BytesIO(); Image.new("RGB", (640, 960), "#e0d8c5").save(image, "PNG")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless="--headed" not in sys.argv)
        page = browser.new_page(viewport={"width": 1680, "height": 1050}, device_scale_factor=1)
        errors = []; page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: dialog.accept())
        fail_next = [False]

        def route(request):
            path = urlsplit(request.request.url).path
            if path == "/":
                return request.fulfill(content_type="text/html", body='<style>body{margin:0;background:#10131c;color:#ddd;font-family:Arial,sans-serif}#mount{width:560px;margin:30px}</style><div id="mount"></div>')
            if path == "/scripts/app.js": return request.fulfill(content_type="text/javascript", body=APP)
            if path == "/scripts/api.js": return request.fulfill(content_type="text/javascript", body=API)
            if path.startswith("/extensions/test/"):
                file = ROOT / "web" / path.removeprefix("/extensions/test/")
                return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
            if path.endswith("/moss_layout/compile"):
                if fail_next[0]:
                    fail_next[0] = False
                    return request.fulfill(status=503, json={"ok": False, "error": "测试编译暂不可用"})
                try:
                    body = request.request.post_data_json
                    result = layout.compile_layout(body["layout"], body.get("width", 1024), body.get("height", 1024))
                    return request.fulfill(json={"ok": True, **result})
                except (ValueError, TypeError) as error:
                    return request.fulfill(status=400, json={"ok": False, "error": str(error)})
            if path.endswith("/media/upload"): return request.fulfill(json={"ok": True, "name": "reference.png"})
            if path.endswith("/cover/file"): return request.fulfill(content_type="image/png", body=image.getvalue())
            return request.fulfill(status=404, body="Not found")

        page.route("**/*", route); page.goto("http://127.0.0.1:9999/"); page.add_script_tag(type="module", content=BOOT)
        # Node and DOM widget follow the actual preview and text height.
        ready = "window.node && document.querySelector('.aml-node') && Math.abs(node.size[1]-(node.widgets.find(w=>w.name==='allbuy_image_tools').y+28+document.querySelector('.aml-node').offsetHeight))<=1"
        page.wait_for_function(ready)
        original = page.evaluate("node.widgets[0].value")
        def preview_size(width, height):
            page.evaluate("([w,h])=>{const d=JSON.parse(node.widgets[0].value);d.width=w;d.height=h;node.widgets[0].value=JSON.stringify(d);node._amlRefresh()}", [width, height])
            page.wait_for_function(ready)
            return page.locator(".aml-thumbnail").evaluate("el=>el.offsetHeight")
        portrait = preview_size(512, 1024)
        if output: page.locator("#mount").screenshot(path=str(output / "moss-node-portrait.png"))
        landscape = preview_size(1024, 512)
        assert portrait > landscape + 100, (portrait, landscape)
        if output: page.locator("#mount").screenshot(path=str(output / "moss-node-landscape.png"))
        page.evaluate("node.setSize([760,node.size[1]])")
        page.wait_for_function("document.querySelector('.aml-thumbnail').offsetHeight>300 && " + ready)
        wide_height = page.evaluate("node.size[1]")
        page.evaluate("node._wrap.style.transform='scale(.7)';node.onDrawBackground()")
        page.wait_for_function(ready)
        assert page.evaluate("node.size[1]") == wide_height, "Canvas zoom must not alter node size"
        page.evaluate("node._wrap.style.display='none';node.onDrawBackground()")
        assert page.evaluate("node.size[1]") == wide_height, "Offscreen widgets preserve their size"
        page.evaluate("node._wrap.style.display='';node._wrap.style.transform='';node.widgets.find(w=>w.name==='allbuy_image_tools').y=140;node.onDrawBackground()")
        page.wait_for_function(ready)
        assert page.evaluate("node.size[1]") == wide_height + 60, "Changed socket height must be accounted for"
        page.evaluate("node.size[1]+=300;node.onDrawBackground()")
        page.wait_for_function(ready)
        assert page.evaluate("node.size[1]") == wide_height + 60, "Old excess height must collapse to the content"
        page.evaluate("original=>{node.widgets[0].value=original;node.widgets.find(w=>w.name==='allbuy_image_tools').y=80;node.setSize([560,node.size[1]]);node._amlRefresh()}", original)
        page.wait_for_function(ready)
        assert page.locator(".aml-node").evaluate("el=>el.scrollWidth<=el.clientWidth && el.scrollHeight<=el.clientHeight")
        page.get_by_role("button", name="打开布局工作台", exact=True).click()
        dlg = page.locator(".aml-dialog"); stage = dlg.get_by_label("布局画布，方向键微调，Delete 删除选中元素", exact=True)
        save = dlg.get_by_role("button", name="保存并应用", exact=True)
        expect(save).to_be_enabled()
        dlg.get_by_label("示例布局", exact=True).select_option("poster")
        expect(dlg.locator(".aml-box")).to_have_count(3)
        assert page.evaluate("JSON.parse(node.widgets[0].value).items.length") == 0, "Editing does not apply prematurely"
        text = dlg.get_by_label("画面中的文字", exact=True)
        text.fill("ALLBUY\n远山来信")
        expect(save).to_be_enabled()
        expected = json.loads(dlg.get_by_label("编译结果", exact=True).input_value())
        assert expected["items"][1]["text"] == "ALLBUY\n远山来信"
        if output: page.screenshot(path=str(output / "moss-layout-dark.png"))
        # Remote HTTP ComfyUI can lack clipboard permission; keep a manual-copy path.
        page.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied')}}})")
        dlg.locator(".aml-output > summary").click()
        dlg.get_by_role("button", name="复制提示词", exact=True).click()
        expect(dlg.locator(".aml-footer > .ait-status")).to_contain_text("已选中文本")
        assert dlg.get_by_label("编译结果", exact=True).evaluate("el=>el.selectionEnd-el.selectionStart===el.value.length")
        dlg.locator(".aml-output > summary").click()
        # Text editing keys must not delete a selected element.
        text.press("Home"); text.press("Delete")
        expect(dlg.locator(".aml-box")).to_have_count(3)
        text.fill("ALLBUY\n远山来信")
        dlg.get_by_role("button", name="复制元素", exact=True).click()
        expect(dlg.locator(".aml-box")).to_have_count(4)
        dlg.get_by_role("button", name="撤销", exact=True).click()
        expect(dlg.locator(".aml-box")).to_have_count(3)
        # A failed import keeps all original elements.
        dlg.get_by_role("button", name="导入布局", exact=True).click()
        dlg.get_by_label("导入布局 JSON", exact=True).fill('{"unrelated":true}')
        dlg.get_by_role("button", name="应用导入", exact=True).click()
        expect(dlg.locator(".aml-import")).to_contain_text("未找到有效布局")
        expect(dlg.locator(".aml-box")).to_have_count(3)
        dlg.get_by_role("button", name="取消", exact=True).click()
        # Restore an unapplied draft after closing; no stale text overwrites it.
        dlg.get_by_role("button", name="关闭 ×", exact=True).click()
        page.get_by_role("button", name="打开布局工作台", exact=True).click()
        dlg.get_by_role("button", name="恢复草稿", exact=True).click()
        expect(dlg.locator(".aml-box")).to_have_count(3)
        dlg.get_by_label("选择元素 2 文字", exact=True).click()
        assert dlg.get_by_label("画面中的文字", exact=True).input_value() == "ALLBUY\n远山来信"
        # Move by drag, keyboard and percentage coordinates.
        box = dlg.locator('.aml-box[data-index="1"]'); before = box.evaluate("el=>parseFloat(el.style.left)")
        tab = box.locator(".aml-box-tab").bounding_box()
        page.mouse.move(tab["x"] + 15, tab["y"] + 5); page.mouse.down(); page.mouse.move(tab["x"] + 55, tab["y"] + 25, steps=5); page.mouse.up()
        assert box.evaluate("el=>parseFloat(el.style.left)") > before
        stage.focus(); stage.press("ArrowRight")
        dlg.get_by_label("坐标单位", exact=True).select_option("%")
        dlg.get_by_label("左 X", exact=True).fill("20"); dlg.get_by_label("左 X", exact=True).press("Tab")
        assert abs(box.evaluate("el=>parseFloat(el.style.left)") - 204.8) < 1
        # Reference is a stored local asset, independent of prompt output.
        dlg.locator('input[type="file"][accept="image/*"]').set_input_files({"name": "reference.png", "mimeType": "image/png", "buffer": image.getvalue()})
        expect(dlg.locator(".aml-reference")).to_have_count(1)
        expect(save).to_be_enabled(); save.click()
        expect(dlg).to_have_count(0)
        saved = page.evaluate("JSON.parse(node.widgets[0].value)")
        assert len(saved["items"]) == 3 and "reference" not in saved
        assert page.evaluate("node.properties.allbuyMossReference.asset") == "reference.png"
        assert page.evaluate("node.properties.allbuyMossRecovery===undefined")
        # Simulate workflow reload into another node and ensure isolated editing.
        page.evaluate("window.reloaded=new NodeClass(2);reloaded.widgets[0].value=node.widgets[0].value;reloaded.properties=structuredClone(node.properties);reloaded.onNodeCreated();reloaded.onConfigure()")
        page.get_by_role("button", name="打开布局工作台", exact=True).last.click()
        expect(dlg.locator(".aml-box")).to_have_count(3)
        dlg.get_by_label("宽度", exact=True).fill("512"); dlg.get_by_label("高度", exact=True).fill("768")
        dlg.get_by_role("button", name="应用尺寸", exact=True).click()
        expect(dlg.locator(".aml-metric")).to_contain_text("512 × 768")
        assert page.evaluate("JSON.parse(node.widgets[0].value).width") == 1024
        expect(save).to_be_enabled()
        # Compilation failure disables saving and a subsequent edit retries.
        fail_next[0] = True
        dlg.get_by_label("整体场景", exact=True).fill("A second poster")
        expect(dlg.locator(".aml-footer > .ait-status")).to_contain_text("测试编译暂不可用")
        expect(save).to_be_disabled()
        dlg.get_by_label("整体场景", exact=True).fill("A second poster, revised")
        expect(save).to_be_enabled()
        page.evaluate("document.documentElement.dataset.theme='light'")
        if output: page.screenshot(path=str(output / "moss-layout-light.png"))
        page.set_viewport_size({"width": 1100, "height": 800})
        assert not dlg.evaluate("el=>el.scrollWidth>el.clientWidth"), "Desktop resize must not overflow"
        if output: page.screenshot(path=str(output / "moss-layout-compact.png"))
        save.click(); expect(dlg).to_have_count(0)
        assert layout.compile_layout(page.evaluate("reloaded.widgets[0].value"))["width"] == 512
        # Compiled imports use the current canvas size; overlap selection and snapping remain usable.
        page.get_by_role("button", name="打开布局工作台", exact=True).last.click()
        overlap = layout.blank_layout(512, 768)
        overlap["summary"]["caption"] = "Two overlapping elements"
        overlap["items"] = [{"label": label, "caption": label, "bbox": [64, 64, 320, 320]} for label in ("object", "character")]
        dlg.get_by_role("button", name="导入布局", exact=True).click()
        dlg.get_by_label("导入布局 JSON", exact=True).fill("```json\n" + layout.compile_layout(overlap)["prompt"] + "\n```")
        dlg.get_by_role("button", name="应用导入", exact=True).click()
        expect(dlg.locator(".aml-box")).to_have_count(2)
        dlg.get_by_label("选择元素 1 物体", exact=True).click()
        target = dlg.locator('.aml-box[data-index="1"]').bounding_box()
        page.mouse.click(target["x"] + target["width"] * .5, target["y"] + target["height"] * .5)
        assert dlg.locator(".aml-box.selected").get_attribute("data-index") == "0"
        page.mouse.click(target["x"] + target["width"] * .5, target["y"] + target["height"] * .5)
        assert dlg.locator(".aml-box.selected").get_attribute("data-index") == "1"
        handle = dlg.locator(".aml-box.selected .aml-handle.se").bounding_box()
        old_width = dlg.locator(".aml-box.selected").evaluate("el=>parseFloat(el.style.width)")
        page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
        page.mouse.down(); page.mouse.move(handle["x"] + 35, handle["y"] + 35, steps=5); page.mouse.up()
        assert dlg.locator(".aml-box.selected").evaluate("el=>parseFloat(el.style.width)") > old_width
        dlg.get_by_label("吸附到 16 像素网格", exact=True).check()
        dlg.get_by_role("button", name="画框", exact=True).click()
        sheet = dlg.locator(".aml-sheet").bounding_box()
        page.mouse.move(sheet["x"] + sheet["width"] * .2, sheet["y"] + sheet["height"] * .55)
        page.mouse.down(); page.mouse.move(sheet["x"] + sheet["width"] * .65, sheet["y"] + sheet["height"] * .85, steps=5); page.mouse.up()
        expect(dlg.locator(".aml-box")).to_have_count(3)
        assert page.evaluate("reloaded.properties.allbuyMossRecovery.draft.items[2].bbox.every(n=>n%16===0)")
        stage.focus(); stage.press("Delete"); expect(dlg.locator(".aml-box")).to_have_count(2)
        dlg.get_by_role("button", name="撤销", exact=True).click(); expect(dlg.locator(".aml-box")).to_have_count(3)
        # Large type and a reduced window must leave the apply action reachable.
        dlg.get_by_label("界面字号", exact=True).select_option("32")
        dlg.get_by_label("窗口大小 · 100%", exact=True).evaluate("el=>{el.value=50;el.dispatchEvent(new Event('input',{bubbles:true}))}")
        assert not dlg.evaluate("el=>el.scrollWidth>el.clientWidth")
        assert save.evaluate("el=>{const a=el.getBoundingClientRect(),b=el.closest('.aml-dialog').getBoundingClientRect();return a.bottom<=b.bottom&&a.top>=b.top}")
        # Deleting the host node releases an open workspace without retaining listeners.
        page.evaluate("reloaded.onRemoved()")
        expect(dlg).to_have_count(0)
        # Undoing node deletion restores automatic height and theme observers.
        page.evaluate("reloaded.onAdded();reloaded.size[1]+=300;reloaded.onDrawBackground()")
        page.wait_for_function("Math.abs(reloaded.size[1]-(reloaded.widgets.find(w=>w.name==='allbuy_image_tools').y+28+reloaded._wrap.querySelector('.aml-node').offsetHeight))<=1")
        page.evaluate("window.broken=new NodeClass(3);broken.widgets[0].value=JSON.stringify({width:1024,height:1024,summary:{caption:''},items:[{label:'text',bbox:null}]});broken.onNodeCreated()")
        expect(page.locator(".aml-node").last).to_contain_text("布局 JSON 无效")
        assert not errors, errors
        browser.close()
    print("PASS: editor output, undo, safe imports, recovery, references, reload, isolation, retry, themes, overlap cycling, resize, grid snapping, keyboard deletion and cleanup")


if __name__ == "__main__":
    main()
