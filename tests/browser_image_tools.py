"""Browser interaction smoke test in a simulated ComfyUI host.

Run explicitly: python tests/browser_image_tools.py [artifact-directory]
Requires Python Playwright + Chromium; ordinary pytest does not require a browser.
Actual sampling is covered separately by test_image_tools.py's native-node mocks.
"""
import asyncio
from email import policy
from email.parser import BytesParser
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
pkg = types.ModuleType("vpl"); pkg.__path__ = [str(ROOT)]; sys.modules.setdefault("vpl", pkg)
tools = importlib.import_module("vpl.image_tools")
gen = importlib.import_module("vpl.generate_node")
samplers = types.ModuleType("comfy.samplers")
samplers.KSampler = types.SimpleNamespace(SAMPLERS=["euler", "dpmpp_2m"], SCHEDULERS=["normal", "simple"])
comfy = types.ModuleType("comfy"); comfy.samplers = samplers
sys.modules["comfy"] = comfy; sys.modules["comfy.samplers"] = samplers


def schemas():
    result = {}
    for name, cls in (tools.NODE_CLASS_MAPPINGS | gen.NODE_CLASS_MAPPINGS).items():
        if name == "AllBuyImageResize": continue
        inputs = cls.INPUT_TYPES()
        result[name] = inputs["required"] | inputs.get("optional", {})
    return result


APP_JS = """
const schemas = SCHEMAS;
globalThis.testNodes = {};
globalThis.hostStats = { removed: 0, dirty: 0, queued: 0 };
export const app = {
 nodeOutputs: {},
 graph: { change() {}, setDirtyCanvas() {}, getNodeById(id) { return this._nodes?.find(node=>String(node.id)===String(id)) || testNodes[id]; } },
 async graphToPrompt() { return {output:structuredClone(globalThis.testPrompt || {}),workflow:{nodes:[]}}; },
 async queuePrompt(number, count, targets) { const prompt=await this.graphToPrompt();hostStats.queued++;hostStats.queueTargets=targets;hostStats.queueOutput=prompt.output; },
 registerExtension(ext) {
  if (ext.name !== 'AllBuy.ImageTools') return;
  for (const [type, inputs] of Object.entries(schemas)) {
   const card = document.createElement('article'); card.className = 'host-card';
   const title = document.createElement('h2'); title.textContent = type; card.append(title);
   const widgets = [];
   for (const [name, [kind, options = {}]] of Object.entries(inputs)) {
    if (['MODEL','VAE','IMAGE','CONDITIONING','LATENT','MASK'].includes(kind)) continue;
    widgets.push({name, value: options.default ?? (Array.isArray(kind) ? kind[0] : 0), options: {...options, ...(['INT','FLOAT'].includes(kind) ? {step: (options.step ?? 1) * 10} : {}), ...(Array.isArray(kind) ? {values: kind} : {})}});
    if (name === 'seed') widgets.push({name:'control_after_generate', value:'randomize', options:{values:['fixed','increment','decrement','randomize']}});
   }
   function NodeType() {}
   ext.beforeRegisterNodeDef(NodeType, {name:type, input:{required:inputs}});
   const sockets = Object.entries(inputs).filter(([, [kind]]) => ['MODEL','VAE','IMAGE','CONDITIONING','LATENT','MASK'].includes(kind)).map(([name]) => ({name}));
   const node = Object.assign(new NodeType(), {type, comfyClass:type, id:type, widgets, inputs:sockets, properties:{}, size:[500,850], graph:app.graph,
    outputs:type==='AllBuyGenerate'?[{name:'原图',type:'IMAGE',links:[]},{name:'图片',type:'IMAGE',links:[]},{name:'Latent',type:'LATENT',links:[]}]:[],
    addOutput(name,type){this.outputs.push({name,type,links:[]})},
    setDirtyCanvas(){hostStats.dirty++}, setSize(size){this.size=size;if(this._testWrapper && ['AllBuyImageTitle','AllBuyImageGrid','AllBuyImageComposer'].includes(type))this._testWrapper.style.width=(size[0]-20)+'px';if(this._testSocketArea && type==='AllBuyImageComposer')this._testSocketArea.style.width=(size[0]-20)+'px';this.onResize?.(size)},
    addDOMWidget(name, kind, root, options){
     const y = ['AllBuyImageTitle','AllBuyImageGrid','AllBuyGenerate'].includes(type) ? sockets.length*20+10 : 100;
     if(['AllBuyImageTitle','AllBuyImageGrid','AllBuyGenerate'].includes(type)) {
      const area=document.createElement('div');area.className='host-sockets';area.style.height=(y+10)+'px';
      sockets.forEach((input,i)=>{const label=document.createElement('span');label.className='host-input-label';label.style.top=(i*20+4)+'px';label.textContent='○ '+(input.label||input.name);area.append(label)});
      if(type==='AllBuyGenerate')this.outputs.forEach((item,i)=>{const output=document.createElement('span');output.className='host-output-label';output.style.top=(i*20+4)+'px';output.textContent=item.name+' ○';area.append(output)});
      else {const output=document.createElement('span');output.className='host-output-label';output.textContent=(type==='AllBuyImageGrid'?'拼接图片':'标题图片')+' ○';area.append(output)}
      card.append(area);this._testSocketArea=area;
     }
     if(type==='AllBuyImageComposer') {
      this.outputs=['图片','宽度','高度'].map(name=>({name}));
      const area=document.createElement('div');area.className='host-sockets';area.style.height=(y+10)+'px';area.style.width=(this.size[0]-20)+'px';
      this.outputs.forEach((output,i)=>{const label=document.createElement('span');label.className='host-output-label';label.style.top=(i*20+4)+'px';label.textContent=output.name+' ○';area.append(label)});
      card.append(area);this._testSocketArea=area;
     }
     const wrapper=document.createElement('div');wrapper.className='dom-widget';wrapper.style.position='relative';wrapper.append(root);card.append(wrapper);this._testWrapper=wrapper;
     if(type==='AllBuyImageComposer')wrapper.style.width=(this.size[0]-20)+'px';
     return this._testDom={name,y,options};
    },
    onRemoved(){hostStats.removed++}
   });
   document.querySelector('main').append(card); testNodes[type]=node;
   ext.nodeCreated(node);
  }
  globalThis.testExtension = ext;
 }
};
globalThis.testApp=app;
"""
API_JS = """
const target = new EventTarget();
export const api = {apiURL:s=>s,fetchApi:(url,opts)=>fetch(url,opts),
addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target)};
globalThis.testApiEmit=(type,detail)=>target.dispatchEvent(new CustomEvent(type,{detail}));
"""
HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#151720;color:#f1f5fb;font:13px 'Segoe UI',sans-serif;padding:20px}
main{display:grid;grid-template-columns:repeat(2,520px);gap:24px}h2{font-size:14px;color:#a4acc1;margin:0 0 12px}
.host-card{background:#20232e;padding:14px;border-radius:14px;min-height:860px}.host-card>.ait-node{width:100%}
.host-sockets{position:relative;background:#181b22}.host-input-label{position:absolute;left:0;font:14px Arial;color:#b6bcc8}.host-output-label{position:absolute;right:0;top:4px;font:14px Arial;color:#b6bcc8}
</style></head><body><main></main><script type="module" src="/web/image_tools.js"></script></body></html>"""


async def check_generate_resize_and_reimport(page, png, asset, destination):
    generate = page.locator(".ait-generate-node")
    preview = generate.locator(".ait-preview > img")
    assert await generate.locator(":scope > .ait-status").count() == 0
    assert await generate.locator(".ait-generate-controls > :last-child .ait-section-title").inner_text() == "重绘"
    # Loading a two-output workflow shifts old image/latent links without changing their meaning.
    await page.evaluate("const n=testNodes.AllBuyGenerate;n.outputs=[{name:'图片',type:'IMAGE',links:[70]},{name:'Latent',type:'LATENT',links:[71]}];n.graph.links={70:{origin_slot:0},71:{origin_slot:1}};n.onConfigure()")
    await page.wait_for_function("testNodes.AllBuyGenerate.outputs.length===3")
    assert await page.evaluate("testNodes.AllBuyGenerate.outputs.map(o=>o.name)") == ["原图", "图片", "Latent"]
    assert await page.evaluate("[testNodes.AllBuyGenerate.graph.links[70].origin_slot,testNodes.AllBuyGenerate.graph.links[71].origin_slot]") == [1, 2]
    assert await page.evaluate("testNodes.AllBuyGenerate._testDom.computeSize()[1]") == 540
    # Real canvas resizing mutates size directly, including at the minimum.
    for height, chrome, scale in [(1000, 100, 1), (668, 100, 1), (788, 220, .7), (1100, 220, 1)]:
        await page.evaluate("""({height,chrome,scale}) => {
          const n=testNodes.AllBuyGenerate;n.size[1]=height;n._testDom.y=chrome;
          n._testWrapper.style.transform=`scale(${scale})`;n._testWrapper.style.transformOrigin='top left';
          n.onDrawBackground();
        }""", {"height": height, "chrome": chrome, "scale": scale})
        bounds = await generate.evaluate("""root => {
          const n=testNodes.AllBuyGenerate;
          return {height:root.offsetHeight,max:n.size[1]-n._testDom.y-10,
            overflow:getComputedStyle(root.querySelector('.ait-generate-controls')).overflowY,scroll:root.querySelector('.ait-generate-controls').scrollHeight,client:root.querySelector('.ait-generate-controls').clientHeight};
        }""")
        assert bounds["height"] <= bounds["max"], bounds
        assert bounds["overflow"] == "auto" and bounds["scroll"] >= bounds["client"], bounds
        if height == chrome + 568: assert bounds["scroll"] > bounds["client"], bounds
    # An input-layout change must resize the panel even if node height is unchanged.
    await page.evaluate("testNodes.AllBuyGenerate._testDom.y=280;testNodes.AllBuyGenerate.onDrawBackground()")
    assert await generate.evaluate("root=>root.offsetHeight <= testNodes.AllBuyGenerate.size[1]-290")
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=root.scrollHeight")
    rect = await generate.bounding_box()
    run_rect = await generate.get_by_role("button", name="运行生成", exact=True).bounding_box()
    assert run_rect["y"] + run_rect["height"] < rect["y"], (run_rect, rect)
    assert run_rect["x"] >= rect["x"] and run_rect["x"] + run_rect["width"] <= rect["x"] + rect["width"]
    await page.evaluate("const n=testNodes.AllBuyGenerate;n._testDom.y=150;n.size[1]=740;n._testWrapper.style.transform='';n.onDrawBackground();n._aitRoot.querySelector('.ait-generate-controls').scrollTop=0")
    before_scroll = await generate.get_by_role("button", name="运行生成", exact=True).bounding_box()
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=root.scrollHeight")
    after_scroll = await generate.get_by_role("button", name="运行生成", exact=True).bounding_box()
    assert before_scroll == after_scroll, (before_scroll, after_scroll)
    for label in await page.locator(".host-card").nth(3).locator(".host-sockets span").all():
        label_rect = await label.bounding_box()
        assert not (label_rect['x'] < after_scroll['x'] + after_scroll['width'] and label_rect['x'] + label_rect['width'] > after_scroll['x'] and label_rect['y'] < after_scroll['y'] + after_scroll['height'] and label_rect['y'] + label_rect['height'] > after_scroll['y'])
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=0")
    await page.locator(".host-card").nth(3).screenshot(path=str(destination / "generate-bounded-panel.png"))

    replacement = Image.new("RGB", (320, 480), "#dc2626")
    buf = io.BytesIO(); replacement.save(buf, format="PNG"); replacement_png = buf.getvalue()
    replacement_asset = hashlib.sha256(replacement_png).hexdigest() + ".png"
    started, release = asyncio.Event(), asyncio.Event()
    resized_assets, resized_sizes = {}, []
    async def upload_route(route):
        body = route.request.post_data_buffer or b""
        if b'filename="slow.png"' in body:
            started.set(); await release.wait()
        name = replacement_asset if b'filename="replacement.png"' in body else asset
        if b'-resized.png"' in body:
            content_type = route.request.headers["content-type"]
            message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + content_type.encode() + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
            payload = next(part.get_payload(decode=True) for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "file")
            name = hashlib.sha256(payload).hexdigest() + ".png"
            resized_assets[name] = payload
            with Image.open(io.BytesIO(payload)) as uploaded: resized_sizes.append(uploaded.size)
        await route.fulfill(json={"ok": True, "name": name})
    async def replacement_route(route):
        await route.fulfill(body=replacement_png, content_type="image/png")
    await page.route("**/media/upload", upload_route)
    replacement_pattern = "**/cover/file?name=" + replacement_asset
    await page.route(replacement_pattern, replacement_route)
    async def resized_route(route):
        name = parse_qs(urlsplit(route.request.url).query).get("name", [""])[0]
        if name in resized_assets: await route.fulfill(body=resized_assets[name], content_type="image/png")
        else: await route.fallback()
    await page.route("**/cover/file?name=*", resized_route)

    async def drop(name, data):
        await generate.locator(".ait-preview").evaluate("""(element,{name,bytes}) => {
          const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array(bytes)],name,{type:'image/png'}));
          element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
        }""", {"name": name, "bytes": list(data)})
    async def wait_source(name):
        await page.wait_for_function("name=>JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value).source===name", arg=name)

    try:
        await drop("first.png", png); await wait_source(asset)
        assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='original_image').value") == asset
        strength = generate.locator('[data-widget="denoise"] input')
        assert float(await strength.input_value()) == 1
        await strength.fill("0.42")
        before_normal = await page.evaluate("hostStats.queued")
        await generate.get_by_role("button", name="普通生成", exact=True).click()
        assert await page.evaluate("hostStats.queued") == before_normal
        assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value") == "{}"
        assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='original_image').value") == asset
        assert float(await strength.input_value()) == 1
        await drop("replacement.png", replacement_png); await wait_source(replacement_asset)
        assert float(await strength.input_value()) == 1
        await page.wait_for_function("testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-preview img').naturalWidth===320")
        assert replacement_asset in await preview.get_attribute("src")
        # Cancel an in-flight old upload, then drop a new image. Late A must not replace B.
        await drop("slow.png", png); await asyncio.wait_for(started.wait(), timeout=5)
        await generate.get_by_role("button", name="普通生成", exact=True).click()
        await drop("replacement.png", replacement_png); await wait_source(replacement_asset)
        release.set()
        await page.wait_for_timeout(100)
        assert await page.evaluate("JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value).source") == replacement_asset
        assert float(await strength.input_value()) == 1
        await generate.get_by_role("button", name="普通生成", exact=True).click()
        mode = generate.get_by_label("导入缩放", exact=True)
        target = generate.get_by_label("目标尺寸 px", exact=True)
        assert await mode.input_value() == "original" and await target.is_disabled()
        # The actual uploaded pixels must be resized, for picker and drag imports.
        for option, edge, data, original_name, expected in [
            ("longest", 320, png, "landscape.png", (320, 240)),
            ("shortest", 320, png, "landscape.png", (427, 320)),
            ("longest", 256, replacement_png, "portrait.png", (171, 256)),
            ("shortest", 640, png, "upscale.png", (853, 640)),
        ]:
            await mode.select_option(option); await target.fill(str(edge))
            if option == "longest" and edge == 320:
                async with page.expect_file_chooser() as chooser:
                    await generate.get_by_role("button", name="导入底图", exact=True).click()
                await (await chooser.value).set_files({"name": original_name, "mimeType": "image/png", "buffer": data})
            else:
                await drop(original_name, data)
            await page.wait_for_function("size=>{const n=testNodes.AllBuyGenerate;const image=n._aitRoot.querySelector('.ait-preview img');return !n._aitImportBusy&&image.complete&&image.naturalWidth===size[0]&&image.naturalHeight===size[1]}", arg=list(expected))
            assert resized_sizes[-1] == expected
            assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='denoise').value") == 1
        await page.evaluate("testNodes.AllBuyGenerate.onConfigure()")
        await page.wait_for_function("testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-import-resize select').value==='shortest'")
        assert await target.input_value() == "640"
        assert await page.evaluate("JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='input_resize').value)") == {"mode": "shortest", "size": 640}
        await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=0")
        await generate.screenshot(path=str(destination / "generate-import-resize.png"))
        await generate.get_by_role("button", name="普通生成", exact=True).click()
        normal_resize = await page.evaluate("""async () => {
          const n=testNodes.AllBuyGenerate;
          testPrompt={
            '1':{class_type:'LoadImage',inputs:{image:'connected.png'}},
            '2':{class_type:'TextEncodeQwenImage21',inputs:{'images.image_1':['1',0],resolution:1024}},
            '3':{class_type:'AllBuyGenerate',inputs:{positive:['2',0],negative:['2',1],latent:['old-latent',0],
              edit_json:n.widgets.find(w=>w.name==='edit_json').value,input_resize:n.widgets.find(w=>w.name==='input_resize').value}}
          };
          const {output}=await testApp.graphToPrompt();testPrompt={};
          const node=output['3'],encoder=output[node.inputs.positive[0]],resize=output[encoder.inputs['images.image_1'][0]];
          return {resize,latent:node.inputs.latent,encoder:node.inputs.positive[0],enabled:JSON.parse(node.inputs.edit_json).enabled||false,original:output['2'].inputs};
        }""")
        assert normal_resize["resize"] == {"class_type":"AllBuyImageResize", "inputs":{"image":["1",0], "mode":"shortest", "size":640}}
        assert normal_resize["latent"] == [normal_resize["encoder"], 2] and not normal_resize["enabled"]
        assert normal_resize["original"] == {"images.image_1":["1",0], "resolution":1024}
        await mode.select_option("original")
        uploads_before = len(resized_sizes)
        await drop("replacement.png", replacement_png); await wait_source(replacement_asset)
        assert len(resized_sizes) == uploads_before and await target.is_disabled()
        await generate.get_by_role("button", name="普通生成", exact=True).click()
    finally:
        release.set()
        await page.unroute("**/media/upload", upload_route)
        await page.unroute(replacement_pattern, replacement_route)
        await page.unroute("**/cover/file?name=*", resized_route)


async def check_generate_preview(page, png, asset, destination, scrub=None):
    # Generation preview: live frames stay local to this node, then yield to final/cached output.
    generate = page.locator(".ait-node").nth(3)
    generate_image = generate.locator(".ait-preview > img")
    await page.evaluate("testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'session-start.png',type:'temp'}]})")
    await generate_image.wait_for(state="visible")
    await page.evaluate("""async () => {
      globalThis.generateBlob=await (await fetch('/view?filename=live.png')).blob();
      testApiEmit('executing',{node:'other-node'});
      testApiEmit('b_preview',generateBlob);
    }""")
    assert "session-start.png" in await generate_image.get_attribute("src")
    history_count = await generate.locator(".ait-history button").count()
    await page.evaluate("testApiEmit('executing',{node:testNodes.AllBuyGenerate.id});testApiEmit('b_preview',generateBlob)")
    await page.wait_for_function("testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-preview img').src.startsWith('blob:')")
    live_url = await generate_image.get_attribute("src")
    await page.wait_for_function("testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-preview img').naturalWidth > 0")
    assert await generate.locator(".ait-history button").count() == history_count
    await page.evaluate("const foreign=new Blob([generateBlob],{type:'image/png'});testApiEmit('b_preview_with_metadata',{nodeId:'other-node',blob:foreign});testApiEmit('b_preview',foreign)")
    assert await generate_image.get_attribute("src") == live_url
    await page.evaluate("testApiEmit('executed',{node:testNodes.AllBuyGenerate.id,output:{allbuy_images:[{filename:'generate-final.png',type:'temp'}]}})")
    assert "generate-final.png" in await generate_image.get_attribute("src")
    assert not await page.evaluate("async url=>{try{await fetch(url);return true}catch{return false}}", live_url)
    await page.evaluate("testApiEmit('executed',{node:testNodes.AllBuyGenerate.id,output:null})")
    assert "generate-final.png" in await generate_image.get_attribute("src")
    # Drop into the visible preview without opening an editor or creating a LoadImage node.
    await generate.locator(".ait-preview").evaluate("""async preview => {
      const png=await (await fetch('/view?filename=drop.png')).blob();
      const transfer=new DataTransfer();transfer.items.add(new File([png],'dropped.png',{type:'image/png'}));
      preview.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      if(!preview.closest('.ait-node').classList.contains('ait-dragover'))throw new Error('Missing drop highlight');
      preview.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    }""")
    await page.wait_for_function("JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value).enabled")
    assert asset in await generate_image.get_attribute("src")
    assert await generate.locator(".ait-empty").is_hidden()
    assert await page.locator(".ait-overlay").count() == 0
    assert not await generate.evaluate("root=>root.classList.contains('ait-dragover')")
    assert "图生图" in await generate.inner_text()
    # Saved sources restore ahead of stale output; native canvas drops accept MIME-less images.
    await page.evaluate("testNodes.AllBuyGenerate.onConfigure()")
    await page.wait_for_timeout(50)
    assert asset in await generate_image.get_attribute("src")
    await generate.get_by_role("button", name="普通生成", exact=True).click()
    assert await generate_image.is_hidden(), "Reopening must not restore stale output history"
    await page.evaluate("""() => {
      const transfer=new DataTransfer();transfer.items.add(new File([generateBlob],'from-canvas.png'));
      if(!testNodes.AllBuyGenerate.onDragOver({dataTransfer:transfer}))throw new Error('Canvas drag rejected');
      if(!testNodes.AllBuyGenerate.onDragDrop({dataTransfer:transfer}))throw new Error('Canvas drop rejected');
    }""")
    await page.wait_for_function("JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value).enabled")
    assert asset in await generate_image.get_attribute("src")
    # Paste and picker share the same durable image import, clearing an old mask.
    await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value=JSON.stringify({enabled:true,source:'old.png',mask:'old-mask.png'})")
    await generate.evaluate("""root => {
      const transfer=new DataTransfer();transfer.items.add(new File([generateBlob],'pasted.png',{type:'image/png'}));
      root.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));
    }""")
    await page.wait_for_function("!JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value).mask")
    await page.evaluate("testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'after-edit.png',type:'temp'}]})")
    assert "after-edit.png" in await generate_image.get_attribute("src")
    async with page.expect_file_chooser() as chooser:
        await generate.get_by_role("button", name="导入底图", exact=True).click()
    await (await chooser.value).set_files({"name": "picked.png", "mimeType": "image/png", "buffer": png})
    await page.wait_for_function("asset=>!testNodes.AllBuyGenerate._aitImportBusy&&testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-preview img').src.includes(asset)", arg=asset)
    assert asset in await generate_image.get_attribute("src")
    await generate.screenshot(path=str(destination / "generate-import-preview.png"))
    # The actual app queue hook must replace Qwen's old reference, not just the sampler's image.
    queued_reference = await page.evaluate("""async () => {
      testPrompt={
        '1':{class_type:'LoadImage',inputs:{image:'old-reference.png'}},
        '2':{class_type:'TextEncodeQwenImage21',inputs:{clip:['clip',0],prompt:'edit',negative_prompt:'',resolution:1024,'images.image_1':['1',0]}},
        '3':{class_type:'AllBuyGenerate',inputs:{positive:['2',0],negative:['2',1],edit_json:testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value}}
      };
      const result=await testApp.graphToPrompt();
      const encoder=result.output[result.output['3'].inputs.positive[0]];
      const source=result.output[encoder.inputs['images.image_1'][0]];
      testPrompt={};
      return {file:source.inputs.image,resolution:encoder.inputs.resolution,original:result.output['2'].inputs['images.image_1']};
    }""")
    assert queued_reference == {"file": "allbuy_media/" + asset, "resolution": 0, "original": ["1", 0]}
    # Metadata previews also work without relying on a legacy executing event.
    await page.evaluate("testApiEmit('b_preview_with_metadata',{displayNodeId:testNodes.AllBuyGenerate.id,blob:new Blob([generateBlob],{type:'image/png'})})")
    assert (await generate_image.get_attribute("src")).startswith("blob:")
    # Generation editor: use the imported source, paint a continuous mask, expand, save.
    denoise = generate.locator('[data-widget="denoise"] input')
    await denoise.fill("0.5")
    if scrub: await scrub(denoise, 40)
    else: await denoise.fill("0.6")
    assert abs(float(await denoise.input_value()) - .6) < .000001
    await generate.get_by_role("button", name="局部重绘 / 扩图").click()
    await page.get_by_text("640 × 480", exact=False).wait_for()
    editor = page.locator(".ait-generate-dialog")
    editor_font = editor.get_by_label("界面字号", exact=True)
    assert await editor_font.locator("option").count() == 7
    await editor_font.select_option("24")
    assert await editor.locator(".ait-inspector .ait-label").first.evaluate("e=>getComputedStyle(e).fontSize") == "24px"
    assert await editor.get_by_role("button", name="保存编辑", exact=True).evaluate("e=>getComputedStyle(e).fontSize") == "26px"
    await editor_font.select_option("32")
    await page.set_viewport_size({"width": 900, "height": 650})
    window_slider = editor.locator(".ait-window-size input")
    await window_slider.fill("50")
    compact = await editor.bounding_box()
    footer = await editor.locator(".ait-editor-footer").bounding_box()
    assert compact["x"] >= 0 and compact["y"] >= 0 and compact["x"] + compact["width"] <= 900 and compact["y"] + compact["height"] <= 650
    assert footer["y"] + footer["height"] <= compact["y"] + compact["height"]
    assert await editor.evaluate("e=>e.scrollWidth <= e.clientWidth")
    assert await editor.locator(".ait-stage").evaluate("e=>e.clientHeight > 40")
    await editor.screenshot(path=str(destination / "generate-editor-compact.png"))
    await editor_font.select_option("20")
    await page.set_viewport_size({"width": 1500, "height": 1000})
    await window_slider.fill("100")
    slider_rect = await window_slider.bounding_box()
    x, y = slider_rect["x"] + slider_rect["width"] - 8, slider_rect["y"] + slider_rect["height"] / 2
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(slider_rect["x"] + slider_rect["width"] / 2, y, steps=8); await page.mouse.up()
    assert await window_slider.input_value() == "75"
    await window_slider.fill("100")
    brush_slider = editor.get_by_role("slider", name="画笔大小滑条", exact=True)
    await brush_slider.fill("128")
    assert await editor.get_by_label("画笔直径 px", exact=True).input_value() == "128"
    await editor.get_by_label("画笔直径 px", exact=True).fill("40")
    assert await brush_slider.input_value() == "40"
    await editor.get_by_role("button", name="擦除遮罩", exact=True).click()
    assert await editor.get_by_role("button", name="擦除遮罩", exact=True).get_attribute("aria-pressed") == "true"
    await editor.get_by_role("button", name="涂抹", exact=True).click()
    box = await page.locator(".ait-dialog canvas").bounding_box()
    await page.mouse.move(box["x"] + box["width"] * .4, box["y"] + box["height"] * .5)
    await page.mouse.down(); await page.mouse.move(box["x"] + box["width"] * .6, box["y"] + box["height"] * .5, steps=10); await page.mouse.up()
    await page.get_by_role("button", name="应用扩图", exact=True).click()
    await page.get_by_text("896 × 736", exact=False).wait_for()
    await page.screenshot(path=str(destination / "generate-editor.png"))
    await page.get_by_role("button", name="保存编辑", exact=True).click()
    await page.locator(".ait-overlay").wait_for(state="hidden")
    edit = await page.evaluate("JSON.parse(testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value)")
    assert edit["enabled"] and edit["source"] == asset and edit["mask"] == asset
    assert asset in await generate_image.get_attribute("src")
    mask_preview = generate.locator(".ait-generate-mask")
    await mask_preview.wait_for(state="visible")
    # Verify mask pixels and object-fit alignment, rather than just a visible canvas.
    test_mask = Image.new("L", (640, 480), 0)
    ImageDraw.Draw(test_mask).rectangle((320, 0, 639, 479), fill=255)
    mask_buffer = io.BytesIO(); test_mask.save(mask_buffer, format="PNG")
    async def mask_route(route):
        await route.fulfill(body=mask_buffer.getvalue(), content_type="image/png")
    mask_pattern = "**/cover/file?name=preview-mask.png"
    await page.route(mask_pattern, mask_route)
    await page.evaluate("const n=testNodes.AllBuyGenerate;const s=JSON.parse(n.widgets.find(w=>w.name==='edit_json').value);s.mask='preview-mask.png';n.widgets.find(w=>w.name==='edit_json').value=JSON.stringify(s);n._aitRefresh(true)")
    await page.wait_for_function("()=>{const c=testNodes.AllBuyGenerate._aitRoot.querySelector('.ait-generate-mask');return !c.hidden&&c.getContext('2d').getImageData(c.width*3/4,c.height/2,1,1).data[3]===115}")
    pixels = await mask_preview.evaluate("c=>{const x=c.getContext('2d');return {black:[...x.getImageData(c.width/4,c.height/2,1,1).data],white:[...x.getImageData(c.width*3/4,c.height/2,1,1).data]}}")
    assert pixels["black"][3] == 0
    assert pixels["white"][3] == 115 and all(abs(a-b) <= 2 for a,b in zip(pixels["white"][:3], [99,102,241]))
    for width in (620, 500):
        await page.evaluate("width=>{const n=testNodes.AllBuyGenerate;n._testWrapper.style.width=(width-20)+'px'}", width)
        await page.wait_for_function("()=>{const r=testNodes.AllBuyGenerate._aitRoot;return Math.abs(r.querySelector('.ait-generate-mask').getBoundingClientRect().width-r.querySelector('.ait-preview img').getBoundingClientRect().width)<1}")
        mask_rect, image_rect = await mask_preview.bounding_box(), await generate_image.bounding_box()
        assert all(abs(mask_rect[key]-image_rect[key]) < 1 for key in ("x", "y", "width", "height"))
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=0")
    await generate.screenshot(path=str(destination / "generate-saved-mask-preview.png"))
    await generate.locator(".ait-history-pick").first.click()
    assert await mask_preview.is_hidden()
    await page.evaluate("testNodes.AllBuyGenerate._aitRestorePreview()")
    await mask_preview.wait_for(state="visible")
    await page.evaluate("testApiEmit('b_preview_with_metadata',{displayNodeId:testNodes.AllBuyGenerate.id,blob:new Blob([generateBlob],{type:'image/png'})})")
    assert await mask_preview.is_hidden()
    await page.evaluate("testNodes.AllBuyGenerate._aitRestorePreview()")
    await mask_preview.wait_for(state="visible")
    await page.evaluate("testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'mask-final.png',type:'temp'}]})")
    assert await mask_preview.is_hidden()
    await page.unroute(mask_pattern, mask_route)
    before_normal = await page.evaluate("hostStats.queued")
    await generate.get_by_role("button", name="普通生成", exact=True).click()
    assert await page.evaluate("hostStats.queued") == before_normal
    assert await mask_preview.is_hidden()
    assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value") == "{}"
    # Include reachable output consumers, through routers/shared paths, without unrelated outputs.
    await page.evaluate("""() => {
      const n=testNodes.AllBuyGenerate,g=n.graph;
      n._savedOutputLinks=n.outputs.map(output=>output.links);
      n.outputs[1].links=[700,701,704];
      g.links={700:{target_id:'preview'},701:{target_id:'router'},702:{target_id:'save'},703:{target_id:'preview'},704:{target_id:'missing'}};
      g._nodes=[
        {id:'preview',graph:g,outputs:[]},
        {id:'router',graph:g,outputs:[{links:[702,703]}]},
        {id:'save',graph:g,outputs:[{links:[703]}]},
        {id:'unrelated-preview',graph:g,outputs:[]}
      ];
    }""")
    for offset, link_store in enumerate(("object", "map"), 1):
        if link_store == "map": await page.evaluate("const g=testNodes.AllBuyGenerate.graph;g.links=new Map(Object.entries(g.links).map(([id,link])=>[Number(id),link]))")
        await generate.get_by_role("button", name="运行生成", exact=True).click()
        await page.wait_for_function("count=>hostStats.queued===count", arg=before_normal+offset)
        assert set(await page.evaluate("hostStats.queueTargets")) == {"AllBuyGenerate", "preview", "router", "save"}
    await page.evaluate("const n=testNodes.AllBuyGenerate;n.outputs.forEach((output,i)=>output.links=n._savedOutputLinks[i]);n.graph._nodes=[];n.graph.links={}")
    # A thumbnail's close button removes only that history entry, including after cached replay.
    await page.evaluate("testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'remove-me.png',type:'temp'},{filename:'keep-me.png',type:'temp'}]})")
    before_delete = await generate.locator(".ait-history-item").count()
    first = generate.locator(".ait-history-item").first
    await first.locator(".ait-history-pick").click()
    assert "remove-me.png" in await generate_image.get_attribute("src")
    remove_rect, item_rect = await first.locator(".ait-history-delete").bounding_box(), await first.bounding_box()
    assert abs(item_rect["width"] - item_rect["height"]) < 1
    pick_rect = await first.locator(".ait-history-pick").bounding_box()
    image_rect = await first.locator("img").bounding_box()
    assert abs(pick_rect["height"] - item_rect["height"]) < 1
    assert image_rect["y"] + image_rect["height"] <= item_rect["y"] + item_rect["height"]
    assert abs(remove_rect["x"] + remove_rect["width"] - item_rect["x"] - item_rect["width"]) < 1
    assert abs(remove_rect["y"] + remove_rect["height"] - item_rect["y"] - item_rect["height"]) < 1
    await first.locator(".ait-history-delete").click()
    assert await generate.locator(".ait-history-item").count() == before_delete - 1
    assert "remove-me.png" not in await generate_image.get_attribute("src")
    await page.evaluate("testNodes.AllBuyGenerate._aitRefresh();testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'remove-me.png',type:'temp'}]})")
    assert await generate.locator(".ait-history-item").count() == before_delete - 1
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=0")
    await generate.screenshot(path=str(destination / "generate-history-delete.png"))
    # Only the latest four unique results survive, and history is not serialized.
    await page.evaluate("for(let i=0;i<6;i++)testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'recent-'+i+'.png',type:'temp'}]})")
    assert await generate.locator(".ait-history-item").count() == 4
    urls = await generate.locator(".ait-history img").evaluate_all("images=>images.map(image=>image.src)")
    assert all(f"recent-{5-index}.png" in url for index, url in enumerate(urls))
    assert not await page.evaluate("'allbuy_generate_history' in testNodes.AllBuyGenerate.properties")
    await generate.locator(".ait-generate-controls").evaluate("root=>root.scrollTop=0")
    await page.locator(".host-card").nth(3).screenshot(path=str(destination / "generate-latest-four.png"))
    clear = generate.get_by_role("button", name="清空", exact=True)
    normal = generate.get_by_role("button", name="普通生成", exact=True)
    clear_rect, normal_rect = await clear.bounding_box(), await normal.bounding_box()
    assert clear_rect["x"] > normal_rect["x"] and abs(clear_rect["y"]-normal_rect["y"]) < 1
    await page.keyboard.press("Tab")
    await clear.focus()
    assert await clear.evaluate("button=>button.matches(':focus-visible')")
    await generate_image.evaluate("image=>image.dispatchEvent(new Event('error'))")
    assert await generate.locator(".ait-empty").inner_text() == "预览加载失败"
    await clear.click()
    assert await generate.locator(".ait-history-item").count() == 0 and await clear.is_disabled()
    assert await generate_image.is_hidden()
    assert "拖入图片" in await generate.locator(".ait-empty").inner_text()
    assert await generate_image.get_attribute("src") is None
    await page.evaluate("testNodes.AllBuyGenerate._aitRestorePreview();testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'recent-5.png',type:'temp'}]})")
    assert await generate.locator(".ait-history-item").count() == 0 and await generate_image.is_hidden()
    # Clear/reopen must keep the imported source and painted mask intact.
    await page.evaluate("asset=>{const n=testNodes.AllBuyGenerate;n.widgets.find(w=>w.name==='edit_json').value=JSON.stringify({enabled:true,source:asset,mask:asset});n._aitRefresh();n.onExecuted({allbuy_images:[{filename:'clear-with-source.png',type:'temp'}]})}", asset)
    saved_edit = await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value")
    original_asset = await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='original_image').value")
    await clear.click()
    assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value") == saved_edit
    assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='original_image').value") == original_asset
    assert asset in await generate_image.get_attribute("src")
    await page.evaluate("const n=testNodes.AllBuyGenerate;n.onExecuted({allbuy_images:[{filename:'before-reopen.png',type:'temp'}]});n.properties.allbuy_generate_history=[{filename:'legacy.png'}];testApp.nodeOutputs[n.id]={allbuy_images:[{filename:'before-reopen.png',type:'temp'}]};n.onConfigure()")
    await page.wait_for_function("testNodes.AllBuyGenerate._aitRoot.querySelectorAll('.ait-history-item').length===0")
    assert not await page.evaluate("'allbuy_generate_history' in testNodes.AllBuyGenerate.properties")
    assert await page.evaluate("testNodes.AllBuyGenerate.widgets.find(w=>w.name==='edit_json').value") == saved_edit
    assert asset in await generate_image.get_attribute("src")
    await page.evaluate("testNodes.AllBuyGenerate._aitRestorePreview();testNodes.AllBuyGenerate.onExecuted(testApp.nodeOutputs.AllBuyGenerate)")
    assert await generate.locator(".ait-history-item").count() == 0
    await page.locator(".host-card").nth(3).screenshot(path=str(destination / "generate-cleared-history.png"))
    await generate.get_by_role("button", name="普通生成", exact=True).click()
    assert await generate.locator(".ait-empty").is_visible()
    assert await generate_image.is_hidden()
    await page.evaluate("testApiEmit('b_preview_with_metadata',{displayNodeId:testNodes.AllBuyGenerate.id,blob:new Blob([generateBlob],{type:'image/png'})})")
    removed_url = await generate_image.get_attribute("src")
    await page.evaluate("testNodes.AllBuyGenerate.onRemoved();testApiEmit('b_preview_with_metadata',{displayNodeId:testNodes.AllBuyGenerate.id,blob:new Blob([generateBlob],{type:'image/png'})})")
    assert await generate_image.get_attribute("src") == removed_url
    assert not await page.evaluate("async url=>{try{await fetch(url);return true}catch{return false}}", removed_url)


async def main():
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="allbuy-tools-browser-"))
    destination.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (640, 480), "#222640"); draw = ImageDraw.Draw(image)
    draw.ellipse((170, 80, 470, 380), fill="#6366f1"); draw.ellipse((250, 160, 390, 300), fill="#a5b4fc")
    buffer = io.BytesIO(); image.save(buffer, format="PNG"); png = buffer.getvalue()
    stripes = Image.new("RGB", (640, 480), "black")
    bands = ImageDraw.Draw(stripes)
    bands.rectangle((0, 0, 639, 95), fill="red")
    bands.rectangle((0, 192, 639, 287), fill="green")
    bands.rectangle((0, 384, 639, 479), fill="blue")
    stripe_buffer = io.BytesIO(); stripes.save(stripe_buffer, format="PNG"); stripe_png = stripe_buffer.getvalue()
    grid_previews = {}
    for name, size in [("grid-wide.png", (1600, 240)), ("grid-tall.png", (240, 1200))]:
        full = Image.new("RGB", size)
        quadrants = ImageDraw.Draw(full)
        w, h = size
        quadrants.rectangle((0, 0, w // 2 - 1, h // 2 - 1), fill="red")
        quadrants.rectangle((w // 2, 0, w - 1, h // 2 - 1), fill="green")
        quadrants.rectangle((0, h // 2, w // 2 - 1, h - 1), fill="blue")
        quadrants.rectangle((w // 2, h // 2, w - 1, h - 1), fill="yellow")
        full_buffer = io.BytesIO(); full.save(full_buffer, format="PNG")
        grid_previews[name] = full_buffer.getvalue()
    titled = tools.add_titles(tools.to_tensor(image), titles="标题区域预览", bar_height=20, font_size=40,
                              corner_radius=24, stroke_width=2, shadow_opacity=60, shadow_blur=3)
    title_buffer = io.BytesIO(); tools.to_pil(titled[0]).save(title_buffer, format="PNG"); title_png = title_buffer.getvalue()
    asset = hashlib.sha256(png).hexdigest() + ".png"
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"))
        page = await browser.new_page(viewport={"width": 1500, "height": 1000}, device_scale_factor=1)
        page.on("pageerror", lambda error: errors.append(str(error)))
        async def route(request):
            path = request.request.url.split("allbuy.test", 1)[-1].split("?", 1)[0]
            if path == "/": await request.fulfill(body=HTML, content_type="text/html")
            elif path == "/scripts/app.js": await request.fulfill(body=APP_JS.replace("SCHEMAS", json.dumps(schemas())), content_type="text/javascript")
            elif path == "/scripts/api.js": await request.fulfill(body=API_JS, content_type="text/javascript")
            elif path.endswith("/media/upload") or path.endswith("/image-tools/remove-background"):
                await request.fulfill(json={"ok": True, "name": asset, "asset_id": asset[:-4], "file": "allbuy_media/" + asset})
            elif path.endswith("/cover/file") or path == "/view":
                url = request.request.url
                output = stripe_png if "focus.png" in url else title_png if "title-result.png" in url else png
                for name, data in grid_previews.items():
                    if name in url: output = data
                await request.fulfill(body=output, content_type="image/png")
            elif path.startswith("/web/"):
                target = (ROOT / path.lstrip("/")).resolve()
                if target.parent != ROOT / "web": await request.fulfill(status=404)
                else: await request.fulfill(body=target.read_bytes(), content_type="text/css" if path.endswith(".css") else "text/javascript")
            else: await request.fulfill(status=404)
        await page.route("**/*", route)
        await page.goto("http://allbuy.test/")
        await page.wait_for_function("Object.keys(globalThis.testNodes || {}).length === 4")
        await page.locator(".ait-node").last.wait_for()
        if "--generate-only" in sys.argv:
            await check_generate_resize_and_reimport(page, png, asset, destination)
            await page.evaluate("testNodes.AllBuyGenerate.onExecuted({allbuy_images:[{filename:'demo.png',type:'temp'}]})")
            await check_generate_preview(page, png, asset, destination)
            assert not errors, errors
            await browser.close()
            print("Generation browser interactions passed; screenshots:", destination)
            return
        # The real controls must write through immediately, before queue serialization.
        title = page.locator(".ait-node").nth(2)
        docked = title.locator(".ait-title-preview")
        controls = title.locator(".ait-title-controls")
        crop = docked.locator("canvas.ait-title-crop")
        await docked.wait_for()
        assert await title.locator(".ait-heading").count() == 0
        assert await crop.is_hidden()
        dock_rect, panel_rect = await docked.bounding_box(), await title.bounding_box()
        sockets_rect = await page.locator(".host-card").nth(2).locator(".host-sockets").bounding_box()
        labels_rect = await page.locator(".host-card").nth(2).locator(".host-input-label").first.bounding_box()
        assert dock_rect["y"] >= sockets_rect["y"]
        assert dock_rect["y"] + dock_rect["height"] < panel_rect["y"]
        assert dock_rect["x"] > labels_rect["x"] + labels_rect["width"]
        assert await controls.locator(".ait-preview").count() == 0
        assert await controls.locator(".ait-section").first.locator(".ait-section-title").inner_text() == "标题文本"
        sequence = title.locator('[data-widget="suffix_mode"] select')
        assert await sequence.input_value() == "关闭"
        assert await sequence.locator("option").count() == 3
        for mode in ("数字（1、2、3…）", "字母（A、B、C…）", "关闭"):
            await sequence.select_option(mode)
            assert await page.evaluate("testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='suffix_mode').value") == mode
        heading = title.locator(".ait-title-text-heading")
        assert (await heading.bounding_box())["height"] <= 22
        # Other AllBuy panels can append the shared theme after image_tools.css.
        await page.add_style_tag(content=".vpl-node { position: relative; }")
        assert await docked.evaluate("element=>getComputedStyle(element).position") == "absolute"
        first_section = await controls.locator(".ait-section").first.bounding_box()
        assert first_section["y"] - (await title.bounding_box())["y"] < 20
        # Hidden widget sockets in the real frontend must not widen the gutter.
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.inputs.push({name:'shadow_offset_x',label:'shadow_offset_x',widget:{name:'shadow_offset_x'},link:null});n.onDrawBackground()")
        assert abs((await docked.bounding_box())["width"] - dock_rect["width"]) < 1
        # Moving the canvas size directly must still resize/reposition the header.
        await page.evaluate("testNodes.AllBuyImageTitle.size[0]=620;testNodes.AllBuyImageTitle._testWrapper.style.width='600px';testNodes.AllBuyImageTitle.onDrawBackground()")
        larger = await docked.bounding_box()
        assert abs(larger["width"] - dock_rect["width"] - 120) < 1
        assert abs(larger["y"] - dock_rect["y"]) < 1
        await page.evaluate("testNodes.AllBuyImageTitle.size[0]=500;testNodes.AllBuyImageTitle._testWrapper.style.width='480px';testNodes.AllBuyImageTitle.onDrawBackground()")
        await page.evaluate("testNodes.AllBuyImageTitle.flags={collapsed:true};testNodes.AllBuyImageTitle.onDrawBackground()")
        assert await docked.is_hidden()
        await page.evaluate("testNodes.AllBuyImageTitle.flags.collapsed=false;testNodes.AllBuyImageTitle.onDrawBackground()")
        # Actual pixels must come from the title band, for all five positions.
        for position, previous_height, expected_rgb in [
            ("图内顶部", 144, [255, 0, 0]), ("中部", 192, [0, 128, 0]),
            ("图内底部", 144, [0, 0, 255]), ("图外顶部", 120, [255, 0, 0]),
            ("图外底部", 120, [0, 0, 255]),
        ]:
            await page.evaluate("position=>{const n=testNodes.AllBuyImageTitle;n.widgets.find(w=>w.name==='position').value=position;n.widgets.find(w=>w.name==='bar_height').value=20;n._aitRefresh();n.onExecuted({allbuy_images:[{filename:'focus.png',type:'temp'}]})}", position)
            await crop.wait_for(state="visible")
            pixels = await crop.evaluate("(canvas,position)=>{const y=position.includes('顶部')?0:position==='中部'?Math.floor(canvas.height/2):canvas.height-1;return {width:canvas.width,height:canvas.height,rgb:[...canvas.getContext('2d').getImageData(canvas.width/2,y,1,1).data].slice(0,3)}}", position)
            assert pixels["width"] == 640 and previous_height < pixels["height"] <= 480, (position, pixels)
            assert pixels["rgb"] == expected_rgb, (position, pixels)
            # Show more context to fill the socket area, preserving the title
            # and matching the visible frame's ratio without black letterboxing.
            letterbox = await crop.evaluate("canvas=>{const r=canvas.getBoundingClientRect();return Math.abs(r.height-r.width*canvas.height/canvas.width)}")
            assert letterbox < 1.1, (position, letterbox)
            full_rect = await docked.bounding_box()
            assert abs(full_rect["y"] - dock_rect["y"]) < 1
            assert abs(full_rect["height"] - dock_rect["height"]) < 1
        # Edits must not redirect a crop belonging to an earlier output.
        previous_crop = await crop.evaluate("canvas=>canvas.toDataURL()")
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.widgets.find(w=>w.name==='position').value='图内顶部';n._aitRefresh()")
        assert await crop.evaluate("canvas=>canvas.toDataURL()") == previous_crop
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.widgets.find(w=>w.name==='position').value='图内底部';n.onExecuted({allbuy_images:[]})")
        assert await crop.is_hidden()
        # An API event must reach the preview even if another extension replaces
        # the node callback; an empty cached event must preserve that preview.
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n._testExecuted=n.onExecuted;n.onExecuted=()=>{};testApiEmit('executed',{node:n.id,output:{allbuy_images:[{filename:'focus.png',type:'temp'}]}})")
        await crop.wait_for(state="visible")
        cached_crop = await crop.evaluate("canvas=>canvas.toDataURL()")
        await page.evaluate("const n=testNodes.AllBuyImageTitle;testApiEmit('executed',{node:n.id,output:null});n._testExecuted({})")
        assert await crop.evaluate("canvas=>canvas.toDataURL()") == cached_crop
        assert await crop.is_visible()
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.onExecuted=n._testExecuted;n.onExecuted({allbuy_images:[]})")
        assert await crop.is_hidden()
        await page.evaluate("async()=>{const {app}=await import('/scripts/app.js');const n=testNodes.AllBuyImageTitle;app.nodeOutputs[n.id]={allbuy_images:[{filename:'focus.png',type:'temp'}]};n.onConfigure()}")
        await crop.wait_for(state="visible")
        # Loaded workflows may still contain the old long first-input label.
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.inputs[0].label='图片 / 批次 1';n.onConfigure()")
        await page.wait_for_function("testNodes.AllBuyImageTitle.inputs[0].label==='图片'")
        for width in (620, 500):
            await page.evaluate("width=>{const n=testNodes.AllBuyImageTitle;n.size[0]=width;n._testWrapper.style.width=(width-20)+'px';n.onDrawBackground()}", width)
            letterbox = await crop.evaluate("canvas=>{const r=canvas.getBoundingClientRect();return Math.abs(r.height-r.width*canvas.height/canvas.width)}")
            assert letterbox < 1.1, (width, letterbox)
        await title.locator('[data-widget="titles"] textarea').fill("第一张\n第二张")
        radius_control = title.locator('[data-widget="corner_radius"] input')
        width_control = title.locator('[data-widget="bar_width"]')
        bar_section = width_control.locator("xpath=ancestor::section[1]")
        assert await width_control.is_hidden()
        original_bar_height = (await bar_section.bounding_box())["height"]
        await radius_control.fill("12")
        await width_control.wait_for(state="visible")
        assert abs((await bar_section.bounding_box())["height"] - original_bar_height) < 1
        assert abs((await radius_control.bounding_box())["y"] - (await width_control.locator("input").bounding_box())["y"]) < 1
        await width_control.locator("input").fill("75")
        assert await page.evaluate("testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='bar_width').value") == 75
        await radius_control.fill("0")
        assert await width_control.is_hidden()
        # Space stays constant even at the minimum node width.
        assert abs((await bar_section.bounding_box())["height"] - original_bar_height) < 1
        assert await page.evaluate("testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='titles').value") == "第一张\n第二张"
        # Font/effect controls serialize through the same native widgets.
        fonts = title.locator('[data-widget="font_name"] select')
        assert await fonts.locator("option").count() > 1
        selected_font = await fonts.locator("option").nth(1).get_attribute("value")
        await fonts.select_option(selected_font)
        assert await page.evaluate("testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='font_name').value") == selected_font
        for name, setting in [("stroke_width", "3"), ("shadow_opacity", "75"), ("shadow_offset_x", "-5"),
                              ("shadow_offset_y", "6"), ("shadow_blur", "8"), ("corner_radius", "20")]:
            await title.locator(f'[data-widget="{name}"] input').fill(setting)
            assert await page.evaluate("name=>testNodes.AllBuyImageTitle.widgets.find(w=>w.name===name).value", name) == int(setting)
        async def scrub(control, distance, modifier=None):
            await control.scroll_into_view_if_needed()
            rect = await control.bounding_box()
            x, y = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
            if modifier: await page.keyboard.down(modifier)
            await page.mouse.move(x, y); await page.mouse.down()
            await page.mouse.move(x + distance, y, steps=8); await page.mouse.up()
            if modifier: await page.keyboard.up(modifier)
        # Drag from either the value or its label; clamp and release capture.
        radius = title.locator('[data-widget="corner_radius"] input')
        await scrub(radius, 40)
        assert await radius.input_value() == "30", await radius.input_value()
        await scrub(radius, -40)
        assert await radius.input_value() == "20"
        await scrub(title.locator('[data-widget="corner_radius"] .ait-label'), 8, "Shift")
        assert await radius.input_value() == "40"
        await scrub(radius, 40, "Alt")
        assert await radius.input_value() == "41"
        opacity = title.locator('[data-widget="shadow_opacity"] input')
        await scrub(opacity, 80, "Shift")
        assert await opacity.input_value() == "100"
        await scrub(opacity, -80, "Shift")
        assert await opacity.input_value() == "0"
        await radius.fill("24")
        await radius.press("ArrowUp")
        assert await radius.input_value() == "25"
        await title.evaluate("root=>root.classList.add('vpl-locked')")
        await scrub(radius, 40)
        assert await radius.input_value() == "25"
        await title.evaluate("root=>root.classList.remove('vpl-locked')")
        # Pointer cancellation must stop subsequent movements changing the value.
        await radius.scroll_into_view_if_needed()
        rect = await radius.bounding_box()
        await radius.evaluate("input=>input.addEventListener('pointerdown',e=>input.dataset.lastPointer=e.pointerId,{once:true})")
        await page.mouse.move(rect["x"] + 30, rect["y"] + 10); await page.mouse.down()
        await radius.evaluate("input=>input.dispatchEvent(new PointerEvent('pointercancel',{pointerId:Number(input.dataset.lastPointer)}))")
        await page.mouse.move(rect["x"] + 70, rect["y"] + 10); await page.mouse.up()
        assert await radius.input_value() == "25"
        await page.evaluate("testNodes.AllBuyImageTitle.onExecuted({allbuy_images:[{filename:'a.png',type:'temp'},{filename:'b.png',type:'temp'}]})")
        await title.get_by_role("button", name="›", exact=True).click()
        await crop.wait_for(state="visible")
        assert "b.png" in await title.locator(".ait-preview img").get_attribute("src")
        assert await title.locator(".ait-preview .ait-row").inner_text() == "‹\n2 / 2\n›"
        letterbox = await crop.evaluate("canvas=>{const r=canvas.getBoundingClientRect();return Math.abs(r.height-r.width*canvas.height/canvas.width)}")
        assert letterbox < 1.1, letterbox
        frame_height = (await docked.bounding_box())["height"]
        assert abs(frame_height - (await crop.bounding_box())["height"] - 40) < 1.1
        before_scroll = await docked.bounding_box()
        await controls.evaluate("area=>area.scrollTop=area.scrollHeight")
        scrolled = await docked.bounding_box()
        assert abs(scrolled["y"] - before_scroll["y"]) < 1
        assert await controls.evaluate("area=>area.scrollTop") > 0
        await title.get_by_role("button", name="‹", exact=True).click()
        assert "a.png" in await title.locator(".ait-preview img").get_attribute("src")
        grid = page.locator(".ait-node").nth(1)
        grid_header = grid.locator(".ait-grid-preview")
        grid_controls = grid.locator(".ait-grid-controls")
        assert await grid.locator(".ait-heading").count() == 0
        assert await grid_controls.locator(".ait-preview").count() == 0
        assert await grid.locator(".ait-grid-caption").inner_text() == "多图拼接 · 布局与留白"
        grid_rect = await grid.bounding_box()
        header_rect = await grid_header.bounding_box()
        assert header_rect["y"] + header_rect["height"] < grid_rect["y"]
        await grid.locator('[data-widget="gap"] input').fill("24")
        assert await page.evaluate("testNodes.AllBuyImageGrid.widgets.find(w=>w.name==='gap').value") == 24
        # Grid uses the full-image preview and shares cached UI event handling.
        grid_image = grid.locator(".ait-preview img")
        heights = []
        image_tops = []
        for name in grid_previews:
            await page.evaluate("name=>testNodes.AllBuyImageGrid.onExecuted({allbuy_images:[{filename:name,type:'temp'}]})", name)
            await grid_image.evaluate("async image=>{await image.decode();await new Promise(requestAnimationFrame)}")
            heights.append((await grid_header.bounding_box())["height"])
            image_tops.append((await grid_header.bounding_box())["y"] - (await grid.bounding_box())["y"])
            assert await grid.locator("canvas").count() == 0
            size = await grid_image.evaluate("e=>({w:e.naturalWidth,h:e.naturalHeight,fit:getComputedStyle(e).objectFit})")
            assert size["fit"] == "contain"
            # All four corners must survive fitting, for wide and tall outputs.
            rendered = Image.open(io.BytesIO(await grid_image.screenshot())).convert("RGB")
            scale = min(rendered.width / size["w"], rendered.height / size["h"])
            fitted_w, fitted_h = size["w"] * scale, size["h"] * scale
            x, y = (rendered.width - fitted_w) / 2, (rendered.height - fitted_h) / 2
            for fx, fy, rgb in [(0.1, 0.1, (255, 0, 0)), (.9, .1, (0, 128, 0)), (.1, .9, (0, 0, 255)), (.9, .9, (255, 255, 0))]:
                assert rendered.getpixel((int(x + fitted_w * fx), int(y + fitted_h * fy))) == rgb
            await page.locator(".host-card").nth(1).screenshot(path=str(destination / name))
        assert heights[0] < heights[1]
        assert abs(image_tops[0] - image_tops[1]) < 1
        before_grid_scroll = await grid_header.bounding_box()
        await grid_controls.evaluate("e=>e.scrollTop=e.scrollHeight")
        assert abs((await grid_header.bounding_box())["y"] - before_grid_scroll["y"]) < 1
        await grid_controls.evaluate("e=>e.scrollTop=0")
        await page.evaluate("testApiEmit('executed',{node:testNodes.AllBuyImageGrid.id,output:{allbuy_images:[{filename:'grid.png',type:'temp'}]}})")
        await grid_image.wait_for(state="visible")
        assert "grid.png" in await grid_image.get_attribute("src")
        await page.evaluate("testApiEmit('executed',{node:testNodes.AllBuyImageGrid.id,output:null})")
        assert await grid_image.is_visible()
        await page.evaluate("async()=>{const {app}=await import('/scripts/app.js');const n=testNodes.AllBuyImageGrid;n.onExecuted({allbuy_images:[]});app.nodeOutputs[n.id]={allbuy_images:[{filename:'grid-restored.png',type:'temp'}]};n.onConfigure()}")
        await grid_image.wait_for(state="visible")
        assert "grid-restored.png" in await grid_image.get_attribute("src")
        await page.evaluate("for(const node of Object.values(testNodes)) node.onExecuted({allbuy_images:[{filename:'demo.png',type:'temp',subfolder:''}]})")
        await page.evaluate("testNodes.AllBuyImageTitle.onExecuted({allbuy_images:[{filename:'title-result.png',type:'temp'}]})")
        await crop.wait_for(state="visible")
        await page.screenshot(path=str(destination / "nodes.png"), full_page=True)
        await controls.evaluate("area=>area.scrollTop=0")
        await page.locator(".host-card").nth(2).screenshot(path=str(destination / "title-node.png"))
        # Composer: actual file picker, loading, numeric transforms, undo, save, reload.
        await page.get_by_role("button", name="打开图层工作台").click()
        dialog = page.locator(".ait-composer-dialog")
        font_picker = dialog.get_by_label("界面字号", exact=True)
        assert await font_picker.input_value() == "20"
        await page.add_style_tag(content=".ait-composer-overlay.vpl-node { font-size: 12.5px; }")
        await font_picker.select_option("20")
        for element in [dialog.locator(".ait-label").first, dialog.get_by_role("button", name="保存布局", exact=True), dialog.locator(".ait-status").last]:
            assert await element.evaluate("e=>getComputedStyle(e).fontSize") == "22px"
        for name in ["＋ 导入图片", "关闭 ×"]:
            assert await dialog.get_by_role("button", name=name, exact=True).evaluate("e=>getComputedStyle(e).fontSize") == "22px"
        assert await font_picker.evaluate("e=>getComputedStyle(e).fontSize") == "22px"
        assert await dialog.locator(".ait-inspector .ait-label").first.evaluate("e=>getComputedStyle(e).fontSize") == "20px"
        await font_picker.select_option("32")
        assert await dialog.get_by_role("button", name="保存布局", exact=True).evaluate("e=>getComputedStyle(e).fontSize") == "34px"
        assert await dialog.evaluate("e=>e.scrollWidth <= e.clientWidth")
        await page.screenshot(path=str(destination / "composer-font-32.png"))
        await font_picker.select_option("16")
        assert await dialog.locator(".ait-window-size").count() == 1
        assert await page.locator(".ait-composer-overlay > .ait-window-size").count() == 0
        full_size = await dialog.bounding_box()
        slider = await dialog.locator(".ait-window-size").bounding_box()
        assert slider["x"] > full_size["x"] + full_size["width"] / 2
        assert slider["y"] + slider["height"] < full_size["y"] + full_size["height"]
        # Drag against the original track while resizing moves the footer itself.
        track = await dialog.locator(".ait-window-size input").bounding_box()
        y = track["y"] + track["height"] / 2
        await page.mouse.move(track["x"] + track["width"] - 8, y)
        await page.mouse.down()
        await page.mouse.move(track["x"] + track["width"] / 2, y, steps=8)
        await page.mouse.up()
        assert await dialog.locator(".ait-window-size input").input_value() == "75"
        await page.locator(".ait-window-size input").fill("100")
        await page.locator(".ait-window-size input").fill("65")
        small_size = await dialog.bounding_box()
        assert small_size["width"] < full_size["width"] and small_size["height"] < full_size["height"]
        await page.locator(".ait-window-size input").fill("100")
        await page.set_viewport_size({"width": 900, "height": 650})
        await page.locator(".ait-window-size input").fill("50")
        compact = await dialog.bounding_box()
        assert compact["x"] >= 0 and compact["y"] >= 0 and compact["x"] + compact["width"] <= 900 and compact["y"] + compact["height"] <= 650
        await font_picker.select_option("20")
        assert await dialog.evaluate("e=>e.scrollWidth <= e.clientWidth")
        footer = await dialog.locator(".ait-composer-footer").bounding_box()
        assert footer["y"] >= compact["y"] and footer["y"] + footer["height"] <= compact["y"] + compact["height"]
        assert await dialog.locator(".ait-stage").evaluate("e=>e.clientHeight > 40")
        await font_picker.select_option("16")
        await page.locator(".ait-window-size input").fill("100")
        await page.set_viewport_size({"width": 1500, "height": 1000})
        await page.get_by_label("画布比例", exact=True).select_option("16:9")
        for edge in [1024, 2048, 3072, 4096]:
            await page.get_by_label("分辨率（长边）", exact=True).select_option(str(edge))
            controls = page.locator(".ait-inspector > .ait-section").first
            assert await controls.get_by_label("宽", exact=True).input_value() == str(edge)
            assert await controls.get_by_label("高", exact=True).input_value() == str(round(edge * 9 / 16 / 8) * 8)
        await page.get_by_label("画布比例", exact=True).select_option("9:16")
        assert await controls.get_by_label("高", exact=True).input_value() == "4096"
        await page.get_by_label("画布比例", exact=True).select_option("1:1")
        await page.get_by_label("分辨率（长边）", exact=True).select_option("1024")
        await page.locator(".ait-zoom-control input").fill("150")
        assert "150%" in await page.locator(".ait-zoom-control").inner_text()
        await page.get_by_role("button", name="适应画布", exact=True).click()
        assert await page.locator(".ait-zoom-control input").input_value() == "100"
        assert await page.locator(".ait-window-size input").evaluate("e=>getComputedStyle(e).accentColor === getComputedStyle(e).getPropertyValue('--vpl-primary').trim() || getComputedStyle(e).accentColor === 'rgb(99, 102, 241)'")
        async with page.expect_file_chooser() as fc:
            await page.get_by_role("button", name="＋ 导入图片").click()
        await (await fc.value).set_files({"name": "demo.png", "mimeType": "image/png", "buffer": png})
        await page.get_by_text("所选图层", exact=True).wait_for()
        await page.get_by_label("旋转 °", exact=True).fill("15")
        await page.get_by_role("button", name="复制", exact=True).click()
        assert await page.locator(".ait-layer").count() == 2
        # Drag the lower row above the upper row; undo preserves layer identity.
        before_ids = await page.locator(".ait-layer").evaluate_all("rows=>rows.map(r=>r.dataset.layerId)")
        source = page.locator(".ait-layer").nth(1)
        target = page.locator(".ait-layer").nth(0)
        await page.locator(".ait-inspector").evaluate("e=>e.scrollTop=0")
        await source.drag_to(target, source_position={"x": 12, "y": 20}, target_position={"x": 70, "y": 3})
        assert await page.locator(".ait-layer").evaluate_all("rows=>rows.map(r=>r.dataset.layerId)") == before_ids[::-1]
        await page.get_by_role("button", name="撤销", exact=True).click()
        assert await page.locator(".ait-layer").evaluate_all("rows=>rows.map(r=>r.dataset.layerId)") == before_ids
        await page.locator(".ait-layer").first.drag_to(page.locator(".ait-layer").nth(1), source_position={"x": 12, "y": 20}, target_position={"x": 70, "y": 40})
        assert await page.locator(".ait-layer").evaluate_all("rows=>rows.map(r=>r.dataset.layerId)") == before_ids[::-1]
        await page.get_by_role("button", name="撤销", exact=True).click()
        await page.locator(".ait-layer").first.get_by_role("button", name="◇", exact=True).click()
        assert await page.locator(".ait-layer").first.get_attribute("draggable") == "false"
        await page.locator(".ait-layer").first.get_by_role("button", name="🔒", exact=True).click()
        await page.get_by_role("button", name="撤销", exact=True).click()
        await page.get_by_role("button", name="撤销", exact=True).click()
        await page.locator(".ait-layer").first.click()
        await page.get_by_label("名称", exact=True).fill("very-long-layer-name-" * 20 + ".png")
        assert await page.locator(".ait-layer-list").evaluate("e=>e.scrollWidth <= e.clientWidth")
        await page.get_by_role("button", name="撤销", exact=True).click()
        await page.get_by_role("button", name="撤销", exact=True).click()
        assert await page.locator(".ait-layer").count() == 1
        await page.locator(".ait-layer-name").click()
        cutout_button = page.get_by_role("button", name="自动抠图（RMBG）", exact=True)
        await page.get_by_role("tooltip").wait_for(state="hidden")
        await cutout_button.hover()
        await page.get_by_role("tooltip").filter(has_text="RMBG 自动抠图").wait_for()
        await page.mouse.move(10, 10)
        await page.get_by_role("tooltip").wait_for(state="hidden")
        # Delayed response exposes progress; errors leave controls usable for retry.
        async def fail_cutout(request):
            await asyncio.sleep(.3)
            await request.fulfill(status=500, json={"ok": False, "error": "测试：请安装 rembg"})
        await page.route("**/image-tools/remove-background", fail_cutout)
        await cutout_button.click()
        await page.locator(".ait-processing").wait_for()
        assert await page.locator(".ait-inspector").evaluate("e=>e.inert")
        await page.locator(".ait-error").filter(has_text="测试：请安装 rembg").wait_for()
        assert not await page.locator(".ait-inspector").evaluate("e=>e.inert")
        await page.unroute("**/image-tools/remove-background", fail_cutout)
        await cutout_button.click()
        await page.get_by_text("抠图完成，可调整描边", exact=True).wait_for()
        await page.locator(".ait-layer-name").click()
        await page.get_by_text("所选图层", exact=True).wait_for()
        original_x = float(await page.get_by_label("X", exact=True).input_value())
        box = await page.locator(".ait-dialog canvas").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 40, cy + 10, steps=5); await page.mouse.up()
        assert float(await page.get_by_label("X", exact=True).input_value()) > original_x
        await page.locator(".ait-stage").press("ArrowRight")
        moved_x = float(await page.get_by_label("X", exact=True).input_value())
        await page.locator(".ait-stage").press("Control+z")
        await page.locator(".ait-layer-name").click()
        assert float(await page.get_by_label("X", exact=True).input_value()) == moved_x - 1
        await page.screenshot(path=str(destination / "composer.png"))
        await font_picker.select_option("20")
        await page.screenshot(path=str(destination / "composer-large-font.png"))
        await page.get_by_role("button", name="保存布局", exact=True).click()
        layout = await page.evaluate("JSON.parse(testNodes.AllBuyImageComposer.widgets.find(w=>w.name==='layout_json').value)")
        assert len(layout["layers"]) == 1 and layout["layers"][0]["rotation"] == 15
        composer = page.locator(".ait-composer-node")
        layout_preview = composer.locator(".ait-composer-preview")
        await layout_preview.wait_for(state="visible")
        # A save renders the composition without queueing a workflow.
        assert await page.evaluate("hostStats.queued") == 0
        assert await composer.locator(".ait-empty").is_hidden()
        assert await composer.locator(".ait-preview img").is_hidden()
        assert await layout_preview.evaluate("c=>[...c.getContext('2d').getImageData(c.width/2,c.height/2,1,1).data]") == [165, 180, 252, 255]
        info = composer.locator(".ait-composer-info")
        assert "1024 × 1024 · 1 个图层" in await info.inner_text()
        assert "布局预览已更新" in await info.inner_text()
        assert "在工作台中导入、排列" in await info.inner_text()
        assert await composer.locator(":scope > .ait-status").count() == 0
        metadata = await info.bounding_box()
        panel = await composer.bounding_box()
        socket = await page.locator(".host-card").first.locator(".host-output-label").first.bounding_box()
        assert metadata["y"] + metadata["height"] <= panel["y"]
        assert metadata["x"] + metadata["width"] < socket["x"]
        assert await info.evaluate("e=>e.scrollHeight <= e.clientHeight")
        # Metadata follows node resizing without covering output labels.
        await page.evaluate("testNodes.AllBuyImageComposer.setSize([650,850])")
        wider = await info.bounding_box()
        assert wider["width"] > metadata["width"]
        assert await composer.locator(".ait-preview").is_visible()
        await page.locator(".host-card").first.screenshot(path=str(destination / "composer-node-info.png"))
        await page.evaluate("testNodes.AllBuyImageComposer.setSize([500,850]); testNodes.AllBuyImageComposer.flags={collapsed:true}; testNodes.AllBuyImageComposer.onDrawBackground()")
        assert await info.is_hidden()
        await page.evaluate("testNodes.AllBuyImageComposer.flags.collapsed=false; testNodes.AllBuyImageComposer.onDrawBackground()")
        await info.wait_for(state="visible")
        await page.locator(".host-card").first.screenshot(path=str(destination / "composer-node-preview.png"))
        # Workflow restoration must draw the saved layout, ahead of old cached output.
        await page.evaluate("""async () => {
          const {app} = await import('/scripts/app.js');
          const n = testNodes.AllBuyImageComposer;
          globalThis.savedComposerLayout = n.widgets.find(w=>w.name==='layout_json').value;
          app.nodeOutputs[n.id] = {allbuy_images:[{filename:'old-output.png',type:'temp'}]};
          n.widgets.find(w=>w.name==='layout_json').value = JSON.stringify({width:512,height:256,background:'#ff0000',layers:[]});
          n.onConfigure();
        }""")
        await layout_preview.wait_for(state="hidden")
        await page.evaluate("testNodes.AllBuyImageComposer.widgets.find(w=>w.name==='layout_json').value=savedComposerLayout; testNodes.AllBuyImageComposer.onConfigure()")
        await layout_preview.wait_for(state="visible")
        assert await layout_preview.evaluate("c=>c.width") == 1024
        assert await page.evaluate("hostStats.queued") == 0
        # Actual executed images still replace the draft preview.
        await page.evaluate("testNodes.AllBuyImageComposer.onExecuted({allbuy_images:[{filename:'fresh-output.png',type:'temp'}]})")
        await layout_preview.wait_for(state="hidden")
        assert await composer.locator(".ait-preview img").is_visible()
        assert "fresh-output.png" in await composer.locator(".ait-preview img").get_attribute("src")
        # Missing durable assets must report an error and permit a later retry.
        async def missing_asset(request):
            await request.fulfill(status=404)
        await page.route("**/cover/file?name=missing.png", missing_asset)
        await page.evaluate("""() => {
          const p=JSON.parse(savedComposerLayout); p.layers[0].asset='missing.png';
          testNodes.AllBuyImageComposer.widgets.find(w=>w.name==='layout_json').value=JSON.stringify(p);
          testNodes.AllBuyImageComposer._aitRefresh();
        }""")
        await composer.get_by_text("布局预览加载失败，请打开工作台检查素材", exact=True).wait_for()
        await page.unroute("**/cover/file?name=missing.png", missing_asset)
        await page.evaluate("testNodes.AllBuyImageComposer.widgets.find(w=>w.name==='layout_json').value=savedComposerLayout; testNodes.AllBuyImageComposer._aitRefresh()")
        await layout_preview.wait_for(state="visible")
        await page.get_by_role("button", name="打开图层工作台").click()
        assert await font_picker.input_value() == "20"
        await font_picker.select_option("16")
        await page.get_by_text("所选图层", exact=True).wait_for(state="hidden")
        assert await page.locator(".ait-layer").count() == 1
        await page.get_by_role("button", name="关闭 ×", exact=True).click()
        await check_generate_resize_and_reimport(page, png, asset, destination)
        await check_generate_preview(page, png, asset, destination, scrub)
        # Modal cleanup must bypass dirty prompts and disconnect its observer.
        await page.get_by_role("button", name="打开图层工作台").click()
        await page.evaluate("testNodes.AllBuyImageComposer.onRemoved()")
        assert await page.locator(".ait-overlay").count() == 0
        # Serialized widget restoration refreshes existing controls.
        await page.evaluate("testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='titles').value='恢复的标题'; testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='corner_radius').value=32; testNodes.AllBuyImageTitle.widgets.find(w=>w.name==='suffix_mode').value='字母（A、B、C…）'; testNodes.AllBuyImageTitle._aitRefresh()")
        assert await title.locator("textarea").input_value() == "恢复的标题"
        assert await radius.input_value() == "32"
        assert await sequence.input_value() == "字母（A、B、C…）"
        # Expand only the browser fixture to capture all title controls for QA.
        await title.evaluate("root=>{root.style.height='auto';root.scrollTop=0}")
        await title.screenshot(path=str(destination / "title-controls.png"))
        await page.evaluate("document.documentElement.dataset.theme='light'")
        await page.screenshot(path=str(destination / "nodes-light.png"), full_page=True)
        await page.evaluate("const n=testNodes.AllBuyImageTitle;n.onRemoved();testApiEmit('executed',{node:n.id,output:{allbuy_images:[]}})")
        assert await crop.is_visible()
        assert not errors, errors
        await browser.close()
    print("Browser interactions passed; screenshots:", destination)


if __name__ == "__main__": asyncio.run(main())
