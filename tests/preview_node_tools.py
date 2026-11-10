"""Local review host for the real MOSS and A/B editors; no model is loaded.

python tests/preview_node_tools.py --port 8199
"""
import argparse
from email import policy
from email.parser import BytesParser
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import types
from urllib.parse import parse_qs, urlsplit

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
package = types.ModuleType("vpl"); package.__path__ = [str(ROOT / "backend")]; sys.modules.setdefault("vpl", package)
layout = importlib.import_module("vpl.moss_layout")
assets = importlib.import_module("vpl.asset_store")
TEMP = tempfile.TemporaryDirectory(prefix="allbuy-node-preview-")
assets.root = lambda: Path(TEMP.name)


def picture(warm=False):
    # Deterministic review fixtures make brush changes easy to inspect.
    image = Image.new("RGB", (720, 900)); draw = ImageDraw.Draw(image)
    top, bottom = ((61, 70, 109), (228, 163, 114)) if warm else ((31, 62, 87), (123, 176, 178))
    for y in range(900):
        t = y / 900; draw.line((0, y, 720, y), fill=tuple(round(a * (1-t) + b * t) for a, b in zip(top, bottom)))
    draw.ellipse((460, 125, 560, 225), fill="#ffda9f" if warm else "#c8e4e2")
    draw.polygon([(0, 560), (160, 290), (350, 545), (530, 350), (720, 590), (720, 900), (0, 900)], fill="#566779" if warm else "#385d71")
    draw.polygon([(0, 650), (270, 420), (500, 660), (720, 490), (720, 900), (0, 900)], fill="#4b5c5d" if warm else "#274c5b")
    draw.polygon([(0, 745), (220, 640), (460, 740), (720, 680), (720, 900), (0, 900)], fill="#263f42")
    draw.rectangle((255, 607, 457, 770), fill="#ac7a52" if warm else "#7b7163")
    draw.polygon([(220, 610), (355, 505), (490, 610)], fill="#343b41")
    draw.rectangle((290, 635, 340, 693), fill="#ffd68c" if warm else "#98c6c7")
    draw.rectangle((375, 635, 425, 693), fill="#ffd68c" if warm else "#98c6c7")
    draw.rectangle((341, 710, 376, 770), fill="#313f40")
    draw.polygon([(350, 770), (380, 770), (500, 900), (200, 900)], fill="#a39b7a" if warm else "#778f88")
    return image


IMAGES = {"a.png": picture(), "b.png": picture(True)}


APP = """export const app=window.testApp={registerExtension(e){(window.extensions||={})[e.name]=e},graph:{change(){},setDirtyCanvas(){}},canvas:{setDirty(){}}};"""
API = """export const api={apiURL:p=>p,fetchApi:(...a)=>fetch(...a),addEventListener(){},removeEventListener(){}};"""
HTML = """<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AllBuy Studio · 节点预览</title>
<link rel="stylesheet" href="/extensions/allbuy/style.css"><link rel="stylesheet" href="/extensions/allbuy/image_tools.css">
<style>body{margin:0;background:#101720;color:#e6edf3;font:15px 'Segoe UI','Microsoft YaHei',sans-serif}header{max-width:1160px;margin:42px auto 28px;display:flex;justify-content:space-between;align-items:center}h1{font-size:27px;letter-spacing:.5px;margin:8px 0}p{line-height:1.7;color:#95a7b7;margin:8px 0}.eyebrow{color:#5db8b1;font-size:12px;letter-spacing:3px}main{max-width:1160px;margin:auto;display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}.preview-card{padding:20px;border:1px solid #334453;border-radius:14px;background:#1a242e;min-width:0}h2{font-size:18px;margin:0 0 10px}.ports{color:#77bdb7;font-size:12px;line-height:1.8;padding:10px 0}.dom-widget{height:auto}#compareCanvas{width:100%;height:460px;display:block;border-radius:9px}.host-button{margin:12px 0;width:100%;min-height:38px;border-radius:7px;border:1px solid #48827f;background:#224440;color:#bcdfd8;font:inherit;cursor:pointer}.host-button:hover{background:#2e5853}header button{border:1px solid #40505c;border-radius:7px;background:#1c2934;color:#c1d6dd;padding:9px 14px;cursor:pointer}body[data-light]{background:#e9edf0;color:#253744}body[data-light] .preview-card{background:#f6f8fa;border-color:#cad5dc}body[data-light] p{color:#5a6e7b}.notice{max-width:1160px;margin:22px auto;color:#8498a6;font-size:13px}@media(max-width:1000px){main{grid-template-columns:1fr}header,main,.notice{margin:20px}}</style>
<header><div><div class="eyebrow">ALLBUY STUDIO / PREVIEW</div><h1>MOSS 布局与分辨率工作台</h1><p>使用插件真实编辑器 · 自适应节点与主题网格 · 本地示例，无模型采样</p></div><button id="theme">切换浅色</button></header>
<main><article class="preview-card"><h2>布局提示词 · MOSS</h2><p>在工作台编排元素，使用 MOSS 分辨率预设或外部尺寸。</p><div class="ports">输入：宽度 INT · 高度 INT<br>输出：提示词 · 宽度 · 高度 · 布局草稿</div><div id="mossMount"></div></article>
<article class="preview-card"><h2>A/B 图像对比</h2><p>现有分割线对比，拖动中线检查两张图片。</p><div class="ports">图片 A · 图片 B</div><div id="compareMount"><canvas id="compareCanvas" width="520" height="460"></canvas></div></article></main>
<p class="notice">预览中的保存仅作用于临时示例数据。实际插件内的布局会随工作流保留。</p>
<script type="module" src="/preview.js"></script></html>"""
BOOT = """
await import('/extensions/allbuy/moss_layout.js');await import('/extensions/allbuy/image_compare.js');
class Node {
 constructor(type,id){this.type=this.comfyClass=type;this.id=id;this.properties={};this.mode=0;this.graph=testApp.graph;this.size=type==='AllBuyABCompare'?[520,460]:[520,540];this.widgets=type==='AllBuyABCompare'?[{name:'auto_output',value:true}]:[{name:'layout_json',value:JSON.stringify(LAYOUT)}];this.outputs=type==='AllBuyABCompare'?[{name:'图片A'},{name:'图片B'}]:[{name:'提示词'},{name:'宽度'},{name:'高度'},{name:'布局草稿'}]}
 setSize(v){this.size=v}setDirtyCanvas(){}addOutput(name,type){this.outputs.push({name,type})}
 addInput(name,type){(this.inputs||=[]).push({name,type,link:null})}
 addDOMWidget(name,type,container,options){const wrap=document.createElement('div');wrap.className='dom-widget';wrap.style.position='relative';wrap.append(container);document.querySelector('#mossMount').append(wrap);const w={name,type,options,y:80};this.widgets.push(w);return w}
 addWidget(type,name,value,callback){const w={type,name,value,callback};this.widgets.push(w);if(type==='button'){const b=document.createElement('button');b.className='host-button';b.textContent=name;b.onclick=callback;document.querySelector('#compareMount').append(b)}return w}
 addCustomWidget(w){this.widgets.push(w);return w}
}
class MossNode extends Node{}class CompareNode extends Node{}
extensions['AllBuy.MossLayoutPrompt'].beforeRegisterNodeDef(MossNode,{name:'AllBuyMossLayoutPrompt'});
extensions['AllBuy.ABCompare'].beforeRegisterNodeDef(CompareNode,{name:'AllBuyABCompare'});
window.mossNode=new MossNode('AllBuyMossLayoutPrompt',1);mossNode.onNodeCreated();mossNode.onConfigure();
window.resolutionSource={id:90,type:'Resolution',outputs:[{name:'width'},{name:'height'}],widgets:[{name:'width',value:1536},{name:'height',value:1024}]};
testApp.graph.links={901:{origin_id:90,origin_slot:0},902:{origin_id:90,origin_slot:1}};testApp.graph.getNodeById=id=>id===90?resolutionSource:null;
const wire=document.createElement('div');wire.style.cssText='display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px;color:#91b9bd;font-size:13px';
wire.innerHTML='<label><input type="checkbox" aria-label="使用外部分辨率"> 外部宽高输入</label><input type="number" aria-label="外部宽度" value="1536" min="16" max="4096" step="16" style="width:85px"><span>×</span><input type="number" aria-label="外部高度" value="1024" min="16" max="4096" step="16" style="width:85px">';
document.querySelector('#mossMount').before(wire);
wire.addEventListener('input',()=>{resolutionSource.widgets[0].value=Number(wire.querySelector('[aria-label="外部宽度"]').value);resolutionSource.widgets[1].value=Number(wire.querySelector('[aria-label="外部高度"]').value);const on=wire.querySelector('[type=checkbox]').checked;mossNode.inputs.find(i=>i.name==='width').link=on?901:null;mossNode.inputs.find(i=>i.name==='height').link=on?902:null;mossNode.onConnectionsChange()});
window.compareNode=new CompareNode('AllBuyABCompare',2);compareNode.onNodeCreated();compareNode.onConfigure();
compareNode.onExecuted({a_images:[{filename:'a.png',type:'temp'}],b_images:[{filename:'b.png',type:'temp'}]});
const canvas=document.querySelector('#compareCanvas'),ctx=canvas.getContext('2d');
function draw(){compareNode._abWidget?.draw(ctx,compareNode,canvas.width,0);mossNode.onDrawBackground?.();requestAnimationFrame(draw)}draw();
function pos(e){const r=canvas.getBoundingClientRect();return[(e.clientX-r.left)*canvas.width/r.width,(e.clientY-r.top)*canvas.height/r.height]}
canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);compareNode.onMouseDown(e,pos(e))};canvas.onpointermove=e=>compareNode.onMouseMove(e,pos(e));canvas.onpointerup=e=>compareNode.onMouseUp(e,pos(e));
document.querySelector('#theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';document.body.toggleAttribute('data-light',light);document.querySelector('#theme').textContent=light?'切换深色':'切换浅色'};
window.previewReady=true;
"""
DRAFT = layout.blank_layout(720, 900)
DRAFT["summary"]["caption"] = "山间木屋旅行海报，宁静的山谷与温暖灯光"
DRAFT["items"] = [{"label": "text", "caption": "海报标题，留白排版", "text": "远山来信", "bbox": [70, 70, 430, 180]},
                  {"label": "object", "caption": "层叠的远山与暮色天空", "bbox": [65, 250, 655, 510]},
                  {"label": "object", "caption": "山间木屋，窗内透出灯光", "bbox": [235, 520, 490, 790]}]
# MOSS requires dimensions divisible by 16; fixtures keep the same aspect ratio.
DRAFT["height"] = 896


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, body, content_type="application/json", status=200):
        if not isinstance(body, bytes): body = body.encode("utf-8")
        self.send_response(status); self.send_header("Content-Type", content_type); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path); query = parse_qs(url.query); path = url.path
        if path == "/": return self.send(HTML, "text/html; charset=utf-8")
        if path == "/scripts/app.js": return self.send(APP, "text/javascript")
        if path == "/scripts/api.js": return self.send(API, "text/javascript")
        if path == "/preview.js": return self.send(BOOT.replace("LAYOUT", json.dumps(DRAFT, ensure_ascii=False)), "text/javascript")
        if path.startswith("/extensions/allbuy/"):
            file = (ROOT / "web" / path.removeprefix("/extensions/allbuy/")).resolve()
            if file.parent == (ROOT / "web").resolve() and file.is_file():
                return self.send(file.read_bytes(), "text/css" if file.suffix == ".css" else "text/javascript")
        if path == "/view" and query.get("filename", [""])[0] in IMAGES:
            out = io.BytesIO(); IMAGES[query["filename"][0]].save(out, "PNG"); return self.send(out.getvalue(), "image/png")
        if path.endswith("/cover/file"):
            file = assets.resolve(query.get("name", [""])[0])
            if file: return self.send(Path(file).read_bytes(), "image/png")
        self.send("Not found", "text/plain", 404)

    def do_POST(self):
        path = urlsplit(self.path).path
        size = int(self.headers.get("Content-Length", 0))
        if size > 32 * 1024 * 1024: return self.send('{"ok":false,"error":"文件过大"}', status=413)
        body = self.rfile.read(size)
        try:
            if path.endswith("/moss_layout/compile"):
                data = json.loads(body); result = layout.compile_layout(data["layout"], data.get("width", 1024), data.get("height", 1024), override_width=data.get("override_width"), override_height=data.get("override_height"))
                return self.send(json.dumps({"ok": True, **result}, ensure_ascii=False))
            if path.endswith("/media/upload"):
                message = BytesParser(policy=policy.default).parsebytes(("Content-Type: " + self.headers["Content-Type"] + "\r\n\r\n").encode() + body)
                part = next(part for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "file")
                blob = part.get_payload(decode=True); Image.open(io.BytesIO(blob)).verify()
                name = hashlib.sha256(blob).hexdigest() + ".png"; (Path(TEMP.name) / name).write_bytes(blob)
                return self.send(json.dumps({"ok": True, "name": name}))
            self.send("Not found", "text/plain", 404)
        except (ValueError, KeyError, TypeError, OSError, StopIteration) as error:
            self.send(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), status=400)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=8199); args = parser.parse_args()
    print(f"AllBuy preview: http://127.0.0.1:{args.port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
