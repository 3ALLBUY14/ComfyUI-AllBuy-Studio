"""Capture production UI with fictional fixtures; never reads personal model data.

python tests/capture_readme.py OUTPUT_DIR [--headed]
"""
import copy
import importlib
import io
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright
from browser_lora_trigger_sync import APP, API, BOOT, DEFS, ROOT
from browser_prompt_hover import BOOT as PROMPT_BOOT
from browser_image_tools import APP_JS as TOOLS_APP, API_JS as TOOLS_API, HTML as TOOLS_HTML, schemas, tools

PLUGIN_VERSION = importlib.import_module("vpl.constants").PLUGIN_VERSION


NAMES = ["风格/远山纸绘_v2.safetensors", "风格/柔光水彩_v1.safetensors",
         "光影/窗边暖光_v3.safetensors", "光影/暮色氛围_v2.safetensors",
         "构图/山间小屋_v1.safetensors", "构图/留白海报_v2.safetensors",
         "质感/细腻纸纹_v1.safetensors", "质感/复古颗粒_v2.safetensors"]
ENTRIES = [dict(id=str(i), name=name, weight=[.7, .3, .65, .4][i], min=-3, max=3,
                enabled=i != 1, trigger=["paper landscape", "soft watercolor", "warm window light", "dusk atmosphere"][i],
                group="画风" if i < 2 else "光影", group_off=False) for i, name in enumerate(NAMES[:4])]
GROUPS = [dict(id="landscape", name="山间旅行海报", note="用于旅行海报的主体构图；可搭配暖光与纸纹卡片。",
               categories=["场景", "海报"], tags=["山间", "留白"], cover="demo-0.png",
               positive="mountain cabin, layered mountains, {sunrise|dusk}, #主体#, open sky, space for a title",
               negative="blurry, low quality, cluttered composition", weight=.85),
          dict(id="light", name="窗边暖光", positive="warm window light, soft shadows", categories=["光影"], tags=["暖色"], cover="demo-1.png"),
          dict(id="paper", name="纸绘质感", positive="fine paper texture, muted palette", categories=["画风"], tags=["纸绘"], cover="demo-2.png"),
          dict(id="sky", name="暮色天空", positive="dusk sky, layered clouds", categories=["场景"], tags=["暮色"], cover="demo-3.png")]


def cover(index):
    image = Image.new("RGB", (480, 360)); draw = ImageDraw.Draw(image)
    palettes = [("#253d59", "#b8c4bb", "#466a75"), ("#775b6a", "#e9bd91", "#716a77"),
                ("#698b89", "#e6d8ad", "#577d76"), ("#3d4668", "#c68f98", "#4b5774")]
    top, bottom, ridge = palettes[index % 4]
    start, end = Image.new("RGB", (1, 1), top).getpixel((0, 0)), Image.new("RGB", (1, 1), bottom).getpixel((0, 0))
    for y in range(360):
        draw.line((0, y, 480, y), fill=tuple(round(a + (b-a)*y/360) for a, b in zip(start, end)))
    draw.ellipse((338, 45, 386, 93), fill="#f4dfb2")
    draw.polygon([(0, 238), (100, 116), (218, 238), (342, 135), (480, 235), (480, 360), (0, 360)], fill=ridge)
    draw.polygon([(0, 280), (160, 202), (305, 282), (480, 210), (480, 360), (0, 360)], fill="#354f59")
    draw.rectangle((207, 260, 301, 328), fill="#a88c71")
    draw.polygon([(194, 262), (254, 214), (314, 262)], fill="#293b48")
    draw.rectangle((221, 274, 243, 298), fill="#ffdb98")
    draw.rectangle((265, 274, 287, 298), fill="#ffdb98")
    buffer = io.BytesIO(); image.save(buffer, format="PNG"); return buffer.getvalue()


def demo_video():
    with tempfile.TemporaryDirectory(prefix="allbuy-docs-video-") as folder:
        poster = Path(folder) / 'poster.png'; poster.write_bytes(cover(1))
        target = Path(folder) / 'demo.mp4'
        subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-v', 'error', '-y', '-loop', '1', '-i', str(poster),
                        '-t', '6', '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(target)], check=True)
        return target.read_bytes()


def capture_basic_nodes(page, output, stable):
    manifest = dict(assets=[dict(id=f'img{i}', name=f'demo-{i}.png', file=f'allbuy_media/demo-{i}.png',
                                type='image', label=['远山纸绘','窗边暖光','山间小屋','暮色天空'][i], w=480,h=360,size=48200) for i in range(4)]
                            + [dict(id='vid',name='demo.mp4',file='allbuy_media/demo.mp4',type='video',label='暖色山间 · 视频示例',w=480,h=360,duration=6,fps=24),
                               dict(id='aud',name='demo.wav',file='allbuy_media/demo.wav',type='audio',label='清晨氛围 · 音频示例',duration=6)],
                    selected=dict(image=['img0','img1'],video='vid',audio='aud'),video_params=dict(start=1,end=5,fps=12),audio_params=dict(start=1,duration=4))
    mapping = dict(folder='演示素材',library_locator=dict(source='user',name='demo'),
                   images=[dict(file=f'demo-{i}.png',abs=f'演示素材/demo-{i}.png',w=480,h=360,order=i) for i in range(4)],
                   links=[dict(abs='演示素材/demo-0.png',gid='landscape')])
    fixtures = [('AllBuy.TextBox','AllBuyTextBox', {'文本':'场景：山间旅行海报\n\n主体：山间小屋与层叠远山\n光线：柔和暮光，窗口透出暖色灯光\n构图：留出天空供标题排版\n质感：细腻纸纹与自然色彩\n参考素材：@远山 @小屋','替换表':'暮光=晨光\n暖色=柔和','去空行':True}),
                ('BatchImagePromptSelector','BatchImagePromptSelector',{'映射数据':json.dumps(mapping),'库数据':''}),
                ('AllBuy.MediaAssetLoader','MediaAssetLoader',{'素材清单':json.dumps(manifest)})]
    boot = """
await import('/extensions/test/textbox_node.js');await import('/extensions/test/batch_image_selector.js');await import('/extensions/test/media_asset_loader.js');
class Node {
 constructor(type,values){this.type=this.comfyClass=type;this.id=type;this.properties=values['素材清单']?{_media:values['素材清单']}:{};this.graph=testApp.graph;this.size=[620,620];this.flags={};this.outputs=[];this.widgets=Object.entries(values).map(([name,value])=>({name,value}));}
 setSize(value){this.size=value}setDirtyCanvas(){}
 addDOMWidget(name,type,container,options){const host=document.createElement('div');host.style.cssText='position:relative;margin-bottom:30px';host.append(container);document.querySelector('#mount').append(host);const w={name,type,options,y:70};this.widgets.push(w);return w}
}
for(const [extension,type,values] of FIXTURES){class T extends Node{}const ext=extensions[extension];await ext.beforeRegisterNodeDef(T,{name:type});const n=new T(type,values);testApp.graph._nodes.push(n);n.onNodeCreated?.();await ext.nodeCreated?.(n);}
""".replace('FIXTURES',json.dumps(fixtures))
    page.goto('http://127.0.0.1:9999/'); page.add_script_tag(type='module', content=boot)
    page.locator('.media-card').first.wait_for(); page.locator('.bips-card').first.wait_for(); stable()
    assert page.locator('.media-footer-ver').count()==0
    assert not re.search(r'[Vv]\d+\.\d+', page.locator('.media-footer').inner_text())
    for selector, name in [('.atb-node','node-textbox.png'),('.bips-node','node-batch-images.png'),('.media-node','node-media-loader.png')]:
        page.locator(selector).screenshot(path=str(output/name))
    for tab, title, name in [('image','编辑（裁剪 / 遮罩 / 缩放）','media-image-editor.png'),
                             ('video','视频参数与裁剪','media-video-editor.png'),('audio','音频裁剪','media-audio-editor.png')]:
        page.locator(f'.media-tabs [data-tab="{tab}"]').click()
        page.locator('.media-card').first.get_by_title(title, exact=True).click()
        dialog=page.locator('.media-dialog'); dialog.wait_for(); stable()
        if tab=='image': page.wait_for_function("document.querySelector('.media-dialog canvas')?.width>0")
        if tab=='video':
            page.wait_for_function("document.querySelector('.media-dialog .media-frames img')?.naturalWidth>0")
        if tab=='audio': page.wait_for_function("document.querySelector('.media-dialog canvas')?.width>0")
        dialog.screenshot(path=str(output/name))
        dialog.get_by_role('button', name='取消', exact=True).click()


def capture_image_tools(page, output, stable):
    page.goto('http://127.0.0.1:9999/')
    page.wait_for_function("Object.keys(window.testNodes||{}).length===4")
    page.evaluate("""() => {
      const title=testNodes.AllBuyImageTitle;
      title.widgets.find(w=>w.name==='titles').value='远山来信';title._aitRefresh?.();
      const grid=testNodes.AllBuyImageGrid;grid.widgets.find(w=>w.name==='layout').value='网格';grid._aitRefresh?.();
      for(const [type,n] of Object.entries(testNodes))n.onExecuted({allbuy_images:[{filename:type==='AllBuyImageTitle'?'title-demo.png':type==='AllBuyImageGrid'?'grid-demo.png':'demo-0.png',type:'temp'}]});
      const composer=testNodes.AllBuyImageComposer;
      composer.widgets.find(w=>w.name==='layout_json').value=JSON.stringify({width:480,height:360,background:'#172028',layers:[{id:'one',name:'远山纸绘',asset:'demo-0.png',x:240,y:180,width:480,height:360,visible:true,opacity:1}]});
      composer.onConfigure();
    }""")
    page.wait_for_function("[...document.querySelectorAll('.ait-preview img')].some(i=>i.naturalWidth>0)"); stable()
    # Crop the actual node and its docked controls, without the fixture's English titles.
    for index, name in [(0,'node-image-composer.png'),(1,'node-image-grid.png'),(2,'node-image-title.png'),(3,'node-generate.png')]:
        card=page.locator('.host-card').nth(index)
        card.locator('h2').evaluate("el=>el.remove()")
        card.evaluate("el=>Object.assign(el.style,{minHeight:'0',alignSelf:'start',background:'#172028',borderRadius:'8px'})")
        stable(); card.screenshot(path=str(output/name))


def capture_canvas_nodes(page, output, stable):
    import threading
    from http.server import ThreadingHTTPServer
    from preview_node_tools import Handler
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    worker=threading.Thread(target=server.serve_forever,daemon=True); worker.start()
    try:
        page.goto(f'http://127.0.0.1:{server.server_port}/'); page.wait_for_function('window.previewReady')
        page.wait_for_function("compareNode._abWidget && document.querySelector('#compareCanvas')")
        stable(); page.locator('#compareMount').screenshot(path=str(output/'node-ab-compare.png'))
        page.get_by_role('button',name='打开布局工作台',exact=True).click()
        dialog=page.get_by_role('dialog',name='布局工作台',exact=True)
        dialog.get_by_label('像素档位',exact=True).select_option('1572864')
        dialog.get_by_label('画布比例',exact=True).select_option('3:2')
        for theme in ['dark','light']:
            page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
            stable()
            grid=Image.open(io.BytesIO(page.locator('.aml-sheet').screenshot())).convert('RGB')
            colors={grid.getpixel((x,y)) for x in range(4,44) for y in range(grid.height-48,grid.height-8)}
            assert len(colors)>2, 'Canvas grid missing from capture; use --headed with desktop Chrome'
            dialog.screenshot(path=str(output/f'moss-layout-{theme}.png'))
        assert dialog.get_by_role('button',name='预览遮罩',exact=True).count()==0
    finally:
        server.shutdown(); server.server_close(); worker.join(timeout=2)


def main():
    started=time.time()
    output = Path(sys.argv[1]); output.mkdir(parents=True, exist_ok=True)
    definitions = copy.deepcopy(DEFS)
    required = definitions["AllBuyLoRAStack"]["input"]["required"]
    required["lora_picker"][0] = ["None", *NAMES]
    required["unet_name"][0] = ["None", "MOSS_Image_demo.safetensors"]
    definitions["AllBuyLoRAStack"]["input"]["optional"] = {
        "on_missing": [["error", "skip"]], "clip_name": [["None", "moss_text_demo.safetensors"]],
        "clip_type": [["stable_diffusion", "minimax"]], "vae_name": [["None", "moss_vae_demo.safetensors"]]}
    catalog = dict(tags=["画风", "光影", "构图", "质感"], models={n: [["画风", "光影", "构图", "质感"][i//2]] for i, n in enumerate(NAMES)},
                   triggers={e["name"]: e["trigger"] for e in ENTRIES}, recommended_weights={}, recommendations={})
    previews = {n: dict(image=dict(url=f"/demo-{i}.png"), model_info=dict(base_model="MOSS Image", version=f"v{i%3+1}"),
                       content=dict(rating="sfw", source="演示")) for i, n in enumerate(NAMES)}
    video = demo_video()
    frames=[tools.to_tensor(Image.open(io.BytesIO(cover(i)))) for i in range(4)]
    outputs={}
    for name, pixels in [('grid-demo.png',tools.compose_grid(frames,layout='网格',columns=2)),
                         ('title-demo.png',tools.add_titles(frames[0],titles='远山来信',font_size=32))]:
        buffer=io.BytesIO(); tools.to_pil(pixels[0]).save(buffer,format='PNG'); outputs[name]=buffer.getvalue()
    image_host=False
    previews[NAMES[1]]['video'] = dict(url='/demo.mp4', poster='/demo-1.png')
    presets = [dict(id='poster', name='山间海报 · 纸绘暖光', entries=ENTRIES, note='画风与光影的常用搭配'),
               dict(id='simple', name='留白构图', entries=ENTRIES[:1])]
    boot = BOOT.replace("value:'model'", "value:'MOSS_Image_demo.safetensors'")
    boot = boot.replace("window.node=new Node();", "window.node=new Node();node.title='海报创作 · LoRA 堆栈';node.widgets.find(w=>w.name==='stack_json').value="
                        + json.dumps(json.dumps(ENTRIES)) + ";node.widgets.push({name:'on_missing',value:'error'},"
                        + "{name:'clip_name',value:'moss_text_demo.safetensors'},{name:'clip_type',value:'minimax'},"
                        + "{name:'vae_name',value:'moss_vae_demo.safetensors'});")
    # Each DOM widget needs its own positioned host, as on the ComfyUI canvas.
    prompt_boot = PROMPT_BOOT.replace("document.querySelector('#mount').append(container);",
        "const host=document.createElement('div');host.style.cssText='position:relative;margin-bottom:30px';"
        "host.append(container);document.querySelector('#mount').append(host);")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless="--headed" not in sys.argv)
        page = browser.new_page(viewport={"width": 1500, "height": 1080}, device_scale_factor=1)
        page.set_default_timeout(10000)
        errors = []; page.on("pageerror", lambda error: errors.append(str(error)))

        def route(request):
            url = urlsplit(request.request.url); path = url.path
            if path == "/":
                if image_host: return request.fulfill(content_type='text/html',body=TOOLS_HTML.replace('background:#151720','background:#111a22'))
                return request.fulfill(content_type="text/html", body='''<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<link rel="stylesheet" href="/extensions/test/style.css"><style>
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:#111a22;font:14px "Segoe UI","Microsoft YaHei",sans-serif;color:#e4ebef}
#mount{width:650px;margin:110px 36px 36px}#mount>.vpl-node{margin-bottom:30px}
</style><div id="mount"></div></html>''')
            if path == "/scripts/app.js": return request.fulfill(content_type="text/javascript", body=TOOLS_APP.replace('SCHEMAS',json.dumps(schemas())) if image_host else APP.replace('graph:{_nodes:[]','graph:{getNodeById(id){return this._nodes.find(n=>String(n.id)===String(id))},_nodes:[]'))
            if path == "/scripts/api.js": return request.fulfill(content_type="text/javascript", body=TOOLS_API if image_host else API)
            if path == '/demo.mp4' or path.endswith('/cover/video'):
                return request.fulfill(content_type='video/mp4', body=video)
            if path.endswith('/media/probe'): return request.fulfill(json=dict(ok=True,w=480,h=360,duration=6,fps=24))
            if path.endswith('/media/wave'): return request.fulfill(json=dict(ok=True,duration=6,peaks=[.15+.75*abs(math.sin(i*.14)*math.cos(i*.037)) for i in range(240)]))
            if path.endswith('/folders'): return request.fulfill(json=dict(ok=True,folders=['演示素材']))
            if path.endswith('/images'): return request.fulfill(json=dict(ok=True,root='演示素材',images=[dict(name=f'demo-{i}.png',abs=f'演示素材/demo-{i}.png',w=480,h=360) for i in range(4)]))
            if path.startswith(("/extensions/test/",'/web/')):
                file = ROOT / "web" / path.removeprefix("/extensions/test/").removeprefix('/web/')
                return request.fulfill(content_type="text/css" if file.suffix == ".css" else "text/javascript", body=file.read_bytes())
            if path.startswith("/demo-") or path.endswith(("/cover/file",'/image','/media/thumb','/media/vthumb')) or path=='/view':
                query=parse_qs(url.query); name=query.get('name',query.get('filename',query.get('path',[path])))[0]
                if path=='/view' and name.endswith('.mp4'): return request.fulfill(content_type='video/mp4', body=video)
                if name in outputs: return request.fulfill(content_type='image/png',body=outputs[name])
                index = next((int(c) for c in name if c.isdigit()), 0)
                return request.fulfill(content_type="image/png", body=cover(index))
            if path == "/object_info/AllBuyLoRAStack": return request.fulfill(json=definitions)
            if path.endswith("/lora_catalog/update"):
                return request.fulfill(json={"ok": True, **catalog})
            if path.endswith("/lora_catalog"): return request.fulfill(json={"ok": True, **catalog})
            if path.endswith("/lora_previews"): return request.fulfill(json={"ok": True, "models": previews})
            if path.endswith("/lora_groups"):
                return request.fulfill(json={"ok": True, "groups": [dict(id="style", name="画风收藏", loras=NAMES[:2]), dict(id="fav", name="我的收藏", loras=NAMES[:1])]})
            if path.endswith('/lora_presets'): return request.fulfill(json={"ok":True,"presets":presets})
            if path.endswith("/libraries"):
                return request.fulfill(json={"ok": True, "libraries": [dict(source="user", name="demo", display_name="海报创作 · 示例", count=len(GROUPS))]})
            if path.endswith("/library"): return request.fulfill(json={"ok": True, "library": dict(name="海报创作 · 示例", groups=GROUPS)})
            return request.fulfill(json={"ok": True, "version": PLUGIN_VERSION, "groups": [], "models": {}, "presets": [], "libraries": []})

        def stable():
            page.evaluate("Promise.all([...document.images].map(i=>i.decode().catch(()=>{})))")
            page.evaluate("Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))")

        page.route("**/*", route)
        page.goto("http://127.0.0.1:9999/"); page.add_script_tag(type="module", content=boot)
        page.locator('.alora-stack-group').first.wait_for(); stable()
        # Include the CLIP/VAE controls positioned above the main widget by production CSS.
        mount = page.locator('#mount'); box = mount.bounding_box()
        page.screenshot(path=str(output / "node-lora-stack.png"), clip={"x": 24, "y": 30, "width": 674, "height": box["height"] + 100})
        page.locator('.alora-add').click(); popup = page.locator('.alora-pop')
        popup.get_by_role('button', name='勾选添加', exact=True).click()
        popup.locator('.alora-pop-search').fill('v')
        for name in NAMES[4:6]: popup.get_by_label('勾选模型：' + name, exact=True).check()
        stable(); popup.screenshot(path=str(output / "lora-picker-batch.png"))
        page.keyboard.press('Escape')
        page.set_viewport_size({"width":1600,"height":960})
        page.locator('#allbuy-manager-launcher').click()
        panel = page.locator('.abm-overlay')
        panel.get_by_role('button', name='LoRA 模型', exact=True).click()
        page.get_by_role('article', name=NAMES[0], exact=True).click(); stable()
        page.screenshot(path=str(output / 'manager-loras.png'))
        page.get_by_role('article', name=NAMES[0], exact=True).click(button='right'); stable()
        page.screenshot(path=str(output / 'manager-context-menu.png')); page.keyboard.press('Escape')
        panel.get_by_role('button', name='管理标签', exact=True).click(); stable()
        page.locator('.abm-modal').screenshot(path=str(output / 'manager-tags.png'))
        page.locator('.abm-modal').get_by_role('button', name='取消', exact=True).click()
        panel.get_by_role('button', name='LoRA 堆栈', exact=True).click()
        page.locator('.abm-stack-row').first.wait_for(); stable()
        assert page.locator('.abm-error:visible').count()==0
        page.screenshot(path=str(output / 'manager-stack.png'))
        panel.get_by_role('button', name='LoRA 组合', exact=True).click()
        page.get_by_role('article', name=presets[0]['name'], exact=True).click(); stable()
        page.screenshot(path=str(output / 'manager-presets.png'))
        panel.get_by_role('button', name='LoRA 模型', exact=True).click()
        first = page.get_by_role('article', name=NAMES[0], exact=True)
        first.get_by_role('button', name='放大预览', exact=True).dblclick(); stable()
        page.locator('.abm-lightbox').screenshot(path=str(output / 'preview-image.png'))
        page.keyboard.press('Escape')
        second = page.get_by_role('article', name=NAMES[1], exact=True)
        second.get_by_role('button', name='▶ 视频', exact=True).click()
        page.locator('.abm-lightbox video').wait_for()
        page.wait_for_function("document.querySelector('.abm-lightbox video').readyState>=2")
        page.locator('.abm-lightbox video').evaluate('v=>v.pause()'); stable()
        page.locator('.abm-lightbox').screenshot(path=str(output / 'preview-video.png'))
        page.keyboard.press('Escape')
        panel.get_by_role('button', name='收起管理面板', exact=True).click()
        page.goto('http://127.0.0.1:9999/'); page.add_script_tag(type='module', content=prompt_boot)
        full = page.locator('.vpl-list .vpl-item[data-id="landscape"]'); full.wait_for(); stable()
        page.locator('#mount .vpl-dd-trigger').first.click()
        page.locator('.vpl-library-picker:visible').screenshot(path=str(output / 'library-picker.png'))
        page.locator('#mount .vpl-dd-trigger').first.click()
        page.locator('.vpl-library-picker').first.wait_for(state='hidden')
        assert page.locator('.vpl-library-picker:visible').count()==0
        page.locator('#mount').evaluate("el=>el.style.marginTop='36px'")
        page.wait_for_function("document.querySelectorAll('#mount .vpl-node')[1]?.getBoundingClientRect().height>200")
        assert not re.search(r'[Vv]\d+\.\d+', page.locator('.vpl-count').inner_text())
        assert page.locator('.vpl-rd-footer').is_hidden()
        page.locator('#mount .vpl-node').first.screenshot(path=str(output / 'node-prompt-library.png'))
        page.locator('#mount .vpl-node').nth(1).screenshot(path=str(output / 'node-random-draw.png'))
        page.locator('#mount .vpl-node').nth(1).evaluate("el=>el.style.display='none'")
        page.evaluate('window.scrollTo(0,0)')
        full.hover(); page.locator('.vpl-prompt-info').get_by_text(GROUPS[0]['note'], exact=True).wait_for(); stable()
        page.screenshot(path=str(output / 'prompt-hover.png'), clip={"x":24,"y":24,"width":1020,"height":740})
        page.keyboard.press('Escape'); page.mouse.move(1480, 10)
        page.locator('#allbuy-manager-launcher').click()
        panel = page.locator('.abm-overlay'); panel.get_by_role('button', name='提示词组', exact=True).click()
        page.get_by_role('article', name=GROUPS[0]['name'], exact=True).wait_for(); stable()
        page.screenshot(path=str(output / 'manager-prompts.png'))
        capture_basic_nodes(page, output, stable)
        image_host=True
        capture_image_tools(page, output, stable)
        page.unroute('**/*',route)
        capture_canvas_nodes(page, output, stable)
        assert not errors, errors
        required=set(re.findall(r'<img[^>]+src="docs/images/([^"]+)"',(ROOT/'README.md').read_text('utf-8')))
        assert required=={p.name for p in output.glob('*.png')}, 'Every README illustration must be recaptured'
        for name in required:
            assert (output/name).stat().st_mtime>=started, f'Stale capture: {name}'
            with Image.open(output / name) as image:
                assert image.height > 200 and image.width>200, f'Unexpectedly collapsed capture: {name}'
                assert not image.info, f'Unexpected metadata: {name}'
        browser.close()
    print(f'PASS: all {len(required)} README views freshly captured from production UI; dimensions, metadata and page errors checked')


if __name__ == '__main__':
    main()
