"""Production prompt node and Manager, with synthetic library data and cover images."""
import io
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, ROOT

BOOT = """
await import('/extensions/test/videoprompt_library.js');
class Node {
 constructor(){this.type='PromptLibrary';this.id=1;this.size=[520,700];this.flags={};this.graph=testApp.graph;this.properties={};
 this.widgets=Object.entries({'库':JSON.stringify({source:'user',name:'demo'}),'选中卡片':'[]','分隔符':', ',
 '前缀':'','后缀':'','忽略权重':false,'库数据':'','变量取值':'{}'}).map(([name,value])=>({name,value}));}
 setSize(value){this.size=value}
 setDirtyCanvas(){}
 addDOMWidget(name,type,container,options){document.querySelector('#mount').append(container);const w={name,type,options,y:70};this.widgets.push(w);return w}
}
const ext=extensions['ComfyUI-AllBuy-Studio'];
await ext.beforeRegisterNodeDef(Node,{name:'PromptLibrary'});
window.node=new Node();testApp.graph._nodes=[node];node.onNodeCreated();
class RandomNode {
 constructor(){this.type='PromptRandomDraw';this.id=2;this.size=[520,700];this.flags={};this.graph=testApp.graph;this.properties={};
 this.widgets=Object.entries({'库':'user:demo','数量':1,'随机种子':0,'分隔符':', ','分类筛选':'[]','标签筛选':'[]',
 '前缀':'','后缀':'','变量取值':'{}','锁定卡片':'[]'}).map(([name,value])=>({name,value}));}
 setSize(value){this.size=value}
 setDirtyCanvas(){}
 addDOMWidget(...args){return Node.prototype.addDOMWidget.apply(this,args)}
}
await ext.beforeRegisterNodeDef(RandomNode,{name:'PromptRandomDraw'});
window.randomNode=new RandomNode();testApp.graph._nodes.push(randomNode);randomNode.onNodeCreated();
await import('/extensions/test/manager.js');extensions['AllBuy.FullscreenManager'].setup();
"""


def main():
    groups = [{"id": "full", "name": "自填说明示例", "note": "这是我们自己填写的用途说明。",
               "categories": ["人物", "镜头"], "tags": ["参考用"], "cover": "demo.png",
               "positive": "保留 {晴天|阴天} 和 #主体#，不展开。<script>window.badHover=true</script>",
               "negative": "模糊、噪点", "prefix": "画面：", "suffix": "。", "weight": .8},
              {"id": "empty", "name": "仅名称", "positive": "", "note": "", "weight": 1},
              {"id": "long", "name": "长说明", "note": "说明行\n" * 120, "negative": "说明末尾", "cover": "missing.png"},
              {"id": "video", "name": "视频封面", "coverVideo": "poster.mp4", "note": "使用现有视频首帧"}]
    library = {"name": "悬停演示", "groups": groups}
    png = io.BytesIO(); Image.new("RGB", (480, 320), "#547e8a").save(png, format="PNG")
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe", headless="--headed" not in sys.argv)
        page = browser.new_page(viewport={"width": 1250, "height": 900})
        page.set_default_timeout(10000)
        errors, writes, media = [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route(request):
            path = urlsplit(request.request.url).path
            if path == "/":
                return request.fulfill(content_type="text/html", body='<link rel="stylesheet" href="/extensions/test/style.css"><div id="mount" style="width:520px;margin:80px 30px"></div><button id="outside">外部</button>')
            if path == "/scripts/app.js": return request.fulfill(content_type="text/javascript", body=APP)
            if path == "/scripts/api.js": return request.fulfill(content_type="text/javascript", body=API)
            if path.startswith("/extensions/test/"):
                file = ROOT / "web" / path.removeprefix("/extensions/test/")
                return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
            if path.endswith("/libraries"):
                return request.fulfill(json={"ok": True, "libraries": [{"source": "user", "name": "demo", "display_name": library["name"], "count": 4}]})
            if path.endswith("/library"): return request.fulfill(json={"ok": True, "library": library})
            if path.endswith("/cover/file"):
                media.append(request.request.url)
                if "missing.png" in request.request.url: return request.fulfill(status=404)
                return request.fulfill(content_type="image/png", body=png.getvalue())
            if request.request.method == "POST" and not path.endswith("/draw"): writes.append(path)
            return request.fulfill(json={"ok": True, "version": "test", "groups": [], "models": {}, "presets": [], "libraries": []})

        page.route("**/*", route)
        page.goto("http://127.0.0.1:9999/"); page.add_script_tag(type="module", content=BOOT)
        full = page.locator('.vpl-list .vpl-item[data-id="full"]')
        full.wait_for()
        before = page.evaluate("JSON.stringify(node._vplInputs())")
        full.hover(); tooltip = page.locator(".vpl-prompt-info")
        tooltip.get_by_text(groups[0]["note"], exact=True).wait_for()
        assert tooltip.locator("img").evaluate("el=>el.complete && el.naturalWidth>0")
        assert tooltip.locator('[data-field="正向提示词"]').inner_text().endswith(groups[0]["positive"])
        assert not page.evaluate("window.badHover") and tooltip.locator("script").count() == 0
        assert "底模" not in tooltip.inner_text() and "未填写" not in tooltip.inner_text()
        assert page.evaluate("JSON.stringify(node._vplInputs())") == before and not writes
        tooltip.hover(); page.wait_for_timeout(180); assert tooltip.is_visible(), "The card remains available for selecting/copying text"
        if "--artifacts" in sys.argv:
            output = Path(sys.argv[sys.argv.index("--artifacts") + 1]); output.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output / "prompt-hover.png"))
        page.locator("#outside").hover(); tooltip.wait_for(state="detached")
        page.locator('.vpl-item[data-id="empty"]').hover(); tooltip.wait_for()
        assert tooltip.locator(".vpl-prompt-info-field, img").count() == 0
        page.locator('.vpl-item[data-id="long"]').hover(); tooltip.get_by_text("长说明", exact=True).wait_for()
        tooltip.locator("img").wait_for(state="detached")
        tooltip.hover(); tooltip.evaluate("el=>el.scrollTop=el.scrollHeight")
        assert tooltip.is_visible() and tooltip.get_by_text("说明末尾", exact=True).is_visible()
        page.locator('.vpl-item[data-id="video"]').hover(); tooltip.get_by_text("视频封面", exact=True).wait_for()
        assert tooltip.locator("img").get_attribute("src").find("poster.mp4") >= 0 and tooltip.locator("video").count() == 0
        page.locator("#outside").hover(); tooltip.wait_for(state="detached")
        original_style = full.get_attribute("style") or ""
        full.evaluate("el=>Object.assign(el.style,{position:'fixed',left:'1080px',top:'845px',width:'160px',zIndex:50})")
        full.hover(); tooltip.get_by_text(groups[0]["note"], exact=True).wait_for()
        bounds = tooltip.bounding_box()
        assert bounds["x"] >= 8 and bounds["x"] + bounds["width"] <= 1242
        assert bounds["y"] >= 8 and bounds["y"] + bounds["height"] <= 892
        page.keyboard.press("Escape"); tooltip.wait_for(state="detached")
        full.evaluate("(el,style)=>el.style.cssText=style", original_style)
        page.get_by_title("卡片视图", exact=True).click()
        page.locator('.vpl-item-card[data-id="full"]').hover(); tooltip.get_by_text(groups[0]["note"], exact=True).wait_for()
        candidate = page.locator('.vpl-rd-card').filter(has=page.get_by_text(groups[1]["name"], exact=True))
        page.mouse.move(1245, 20)
        candidate.scroll_into_view_if_needed(); page.wait_for_timeout(150); candidate.hover()
        tooltip.get_by_text(groups[1]["name"], exact=True).wait_for()
        assert tooltip.locator('.vpl-prompt-info-field').count() == 0
        page.locator("#allbuy-manager-launcher").click()
        panel = page.locator(".abm-overlay")
        panel.get_by_role("button", name="提示词组", exact=True).click()
        item = panel.get_by_role("article", name=groups[0]["name"], exact=True)
        item.hover(); tooltip.get_by_text(groups[0]["note"], exact=True).wait_for()
        panel.get_by_role("button", name="收起管理面板", exact=True).click(); tooltip.wait_for(state="detached")
        page.evaluate("node.onRemoved();randomNode.onRemoved()")
        assert tooltip.count() == 0 and not errors, errors
        browser.close()
    print("PASS: prompt node list/cards, random draw and Manager hover, filled fields only, raw text safety, images/video poster, scroll/copy, edge placement and cleanup")


if __name__ == "__main__":
    main()
