// AllBuy-文本框：大文本提示词编辑面板
//   DOM widget 面板：多行文本（同步「文本」widget，防抖写入+入队前冲刷）、
//   主题开关「去空行」、「替换表」折叠编辑（每行 旧=新）、「入库」/「从库插入」
//   快速对接提示词库（/libraries + /library + /library/save），@素材名 实时统计
//   提示（→ image1..10）。样式沿用 .vpl-* 统一体系。
import { app } from "../../scripts/app.js";
import { installBypassSync, installExecutionLock, applyFillPanel, installFillResize, installCornerHover } from "./panel_guard.js";
import { randomColor } from "./editor_dialog.js";

const NODE_NAME = "AllBuyTextBox";
const API = "/allbuy_promptlibrary";
const STACK_MIN_WIDTH = 460;
const STACK_MIN_TOTAL_H = 260;
const STACK_BOTTOM_GAP = 18;
const STACK_MAX_CHROME = 300;
const STACK_FALLBACK_CHROME = 96;

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name) || null;
}

function stopGraph(el) {
  el.classList.add("alora-control");
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("mousedown", (e) => e.stopPropagation());
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
}

function stackChromeH(node) {
  const y = node?._atbWidget && typeof node._atbWidget.y === "number" ? node._atbWidget.y : 0;
  if (y <= 0) return STACK_FALLBACK_CHROME;
  return Math.min(y, STACK_MAX_CHROME);
}

function recalcHeight(node) {
  if (!node || typeof node.setSize !== "function" || node._atbHeightPending) return;
  node._atbHeightPending = true;
  requestAnimationFrame(() => {
    node._atbHeightPending = false;
    const panel = node?._atbContainer;
    if (!panel?.isConnected) return;
    if (panel.getBoundingClientRect().height === 0) return; // 远缩放/离屏剔除：测量无意义，沿用缓存（bips/media 同款守卫）
    const chrome = stackChromeH(node);
    panel.style.height = ""; // 先回自然高度量内容下限（填充模式下也要量）
    const host = panel.parentElement || panel;
    const measured = Math.ceil(host.scrollHeight || host.offsetHeight || 0);
    const h = Math.max(STACK_MIN_TOTAL_H, measured + chrome + STACK_BOTTOM_GAP);
    node._atbCachedH = h;
    if ((node.size?.[1] || 0) > h + 1) {
      // 节点比内容高（用户拉高或工作流存了更大尺寸）：面板填满节点，不缩回去
      applyFillPanel(node, panel, chrome, STACK_BOTTOM_GAP);
      app.graph?.setDirtyCanvas?.(true, true);
      return;
    }
    if (node.size?.[1] === h) return;
    node.setSize([node.size?.[0] || STACK_MIN_WIDTH, h]);
    app.graph?.setDirtyCanvas?.(true, true);
  });
}

function apiGet(path) {
  // .catch 兜 fetch 网络层 reject（后端重启/断连抛 TypeError: Failed to fetch），
  // 归一成 ok:false 走"无数据"分支；调用方再以 loadFailed 区分网络错误给出提示
  return fetch(API + path)
    .then((r) => r.json().catch(() => ({ ok: false })))
    .catch(() => ({ ok: false, loadFailed: true }));
}
function apiPost(path, body) {
  return fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({ ok: false })));
}

function el(tag, cls, text) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function iconBtn(label, title, onClick, cls = "") {
  const b = el("button", "vpl-btn vpl-btn-sm " + cls, label);
  b.type = "button";
  b.title = title;
  stopGraph(b);
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onClick(e); });
  return b;
}

// ---------------------------------------------------------------------------
// 入库 / 从库插入 弹窗（overlay 复用 .vpl-overlay 主题）
// ---------------------------------------------------------------------------
// 跨弹窗记忆（模块级）：上次用的库 + 上次插入的组——重开弹窗直接回到上次位置，
// 不必每次从第一个库、列表顶部重新翻
let lastLibName = null;
let lastInsertGroup = null; // { lib, name }
// 库下拉预选上次值并跟踪选择（两个弹窗共用同一记忆）
function wireLibMemory(libSel, libs) {
  if (lastLibName && libs.some((L) => L.name === lastLibName)) libSel.value = lastLibName;
  libSel.addEventListener("change", () => { lastLibName = libSel.value; });
}

async function userLibraries() {
  // /libraries 返回 {source, name, display_name, count}——没有 locator 字段
  //（初版按 x.locator 过滤导致"识别不到已有库"），locator 由调用方按 source 组装
  const d = await apiGet("/libraries");
  const libs = (d && d.ok && Array.isArray(d.libraries)) ? d.libraries : [];
  return libs
    .filter((x) => x && x.source === "user" && x.name)
    .map((x) => ({ name: x.name, display: x.display_name || x.name, count: x.count || 0 }));
}

function dialogShell(titleText, bodyBuild, onClose) {
  const overlay = el("div", "vpl-overlay");
  const dialog = el("div", "vpl-dialog atb-dialog");
  overlay.appendChild(dialog);
  const title = el("div", "vpl-dialog-title");
  const span = el("span", null, titleText);
  const closeBtn = iconBtn("✕", "关闭", () => close());
  title.append(span, closeBtn);
  dialog.appendChild(title);
  const body = el("div", "vpl-dialog-body");
  dialog.appendChild(body);
  const close = () => {
    onClose?.();
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  bodyBuild(body, close);
  return { overlay, close };
}

// 入库的分类/标签：已有建议可点选，也支持输入新值；切库时清空选择。
function libraryMetadataPicker(kind) {
  const root = el("div", "atb-metadata-picker");
  const row = el("div", "vpl-row vpl-row-tight atb-metadata-input");
  const input = el("input", "vpl-input");
  input.type = "text";
  input.placeholder = `输入${kind}后回车添加（可多选）`;
  const selected = new Set();
  let suggestions = [];
  const chips = el("div", "vpl-chip-list atb-metadata-selected");
  const choices = el("div", "vpl-chip-list atb-metadata-choices");
  const render = () => {
    chips.replaceChildren();
    for (const value of selected) {
      chips.appendChild(iconBtn(value + " ×", `移除${kind}：${value}`, () => {
        selected.delete(value);
        render();
      }, "vpl-chip vpl-chip-removable"));
    }
    choices.replaceChildren();
    for (const value of suggestions) {
      const button = iconBtn((selected.has(value) ? "✓ " : "") + value, `选择${kind}：${value}`, () => {
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
        render();
      }, "vpl-chip vpl-chip-click");
      button.setAttribute("aria-pressed", String(selected.has(value)));
      choices.appendChild(button);
    }
    if (!suggestions.length) choices.appendChild(el("span", "atb-field-label", `暂无已有${kind}，可自行添加`));
  };
  const commit = () => {
    input.value.split(/[,，]/).map((v) => v.trim()).filter(Boolean).forEach((v) => selected.add(v));
    input.value = "";
    render();
  };
  stopGraph(input);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === "，") { e.preventDefault(); commit(); }
  });
  row.append(input, iconBtn("添加", `添加${kind}`, commit));
  root.append(row, chips, choices);
  return {
    root,
    reset(values = []) {
      selected.clear();
      input.value = "";
      suggestions = [...new Set(values.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
      render();
    },
    values() { commit(); return [...selected]; },
  };
}

// 预览文件先留在本地，确认入库时再上传；取消弹窗释放本地预览。
function libraryPreviewPicker() {
  const root = el("div", "atb-preview-grid");
  const slots = {};
  for (const kind of ["image", "video"]) {
    const isVideo = kind === "video";
    const title = isVideo ? "视频预览" : "截图预览";
    const extensions = isVideo ? ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg"] : ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"];
    const slot = el("div", "atb-preview-slot");
    const head = el("div", "atb-preview-head");
    const frame = el("div", "atb-preview-frame");
    const hint = el("div", "atb-save-help", isVideo ? "选择或拖入视频" : "选择、拖入或 Ctrl+V 粘贴截图");
    const input = el("input");
    input.type = "file";
    input.accept = extensions.map((ext) => "." + ext).join(",");
    input.hidden = true;
    let file = null;
    let url = null;
    let uploaded = null;
    const release = () => {
      const video = frame.querySelector("video");
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
      frame.replaceChildren();
      if (url) URL.revokeObjectURL(url);
      url = null;
    };
    const setFile = (next) => {
      if (next) {
        const ext = (next.name || "").split(".").pop().toLowerCase();
        if (!extensions.includes(ext)) { hint.textContent = `请选择${isVideo ? "视频" : "图片"}文件`; return; }
        if (next.size > (isVideo ? 200 : 32) * 1024 * 1024) { hint.textContent = `${title}文件过大（上限 ${isVideo ? 200 : 32}MB）`; return; }
      }
      release();
      file = next;
      uploaded = null;
      remove.disabled = !file;
      if (file) {
        url = URL.createObjectURL(file);
        const media = el(isVideo ? "video" : "img");
        media.src = url;
        if (isVideo) { media.controls = true; media.muted = true; media.preload = "metadata"; }
        else media.alt = "截图预览";
        frame.appendChild(media);
      } else frame.appendChild(el("span", "atb-save-help", "未添加"));
      hint.textContent = file ? file.name : (isVideo ? "选择或拖入视频" : "选择、拖入或 Ctrl+V 粘贴截图");
    };
    const choose = iconBtn("选择", `选择${title}`, () => input.click());
    const remove = iconBtn("移除", `移除${title}`, () => setFile(null));
    head.append(el("span", "atb-field-label", title), choose, remove);
    slot.append(head, frame, hint, input);
    stopGraph(slot);
    input.addEventListener("change", () => { if (input.files?.[0]) setFile(input.files[0]); input.value = ""; });
    slot.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); slot.classList.add("dragover"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("dragover"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); slot.classList.remove("dragover");
      if (e.dataTransfer?.files?.[0]) setFile(e.dataTransfer.files[0]);
    });
    setFile(null);
    root.appendChild(slot);
    slots[kind] = {
      setFile, release,
      async upload(groupId) {
        if (!file) return null;
        if (uploaded) return uploaded;
        const fd = new FormData();
        fd.append("group_id", groupId);
        fd.append("file", file, file.name);
        const response = await fetch(API + "/cover/upload", { method: "POST", body: fd });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok || !(isVideo ? result.cover_video : result.cover)) {
          throw new Error(result.error || `${title}上传失败`);
        }
        uploaded = result;
        return result;
      },
    };
  }
  return {
    root,
    paste(e) {
      const item = [...(e.clipboardData?.items || [])].find((item) => item.type.startsWith("image/"));
      const file = item?.getAsFile() || [...(e.clipboardData?.files || [])].find((file) => file.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault(); e.stopPropagation();
      slots.image.setFile(file);
    },
    async upload(groupId) {
      const video = await slots.video.upload(groupId);
      const image = await slots.image.upload(groupId);
      return { cover: image?.cover || video?.cover || "", coverVideo: video?.cover_video || "" };
    },
    dispose() { Object.values(slots).forEach((slot) => slot.release()); },
  };
}

function saveToLibrary(text, onDone) {
  const previews = libraryPreviewPicker();
  const groupId = "atb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  dialogShell("入库到提示词库", async (body, close) => {
    body.classList.add("atb-save-body");
    body.parentElement.classList.add("atb-save-dialog");
    body.addEventListener("paste", (e) => previews.paste(e));
    const hint = el("div", "atb-save-intro", "当前文本将作为新提示词组入库，可选择分类与标签");
    const libSel = el("select", "vpl-input atb-select");
    libSel.appendChild(el("option", null, "加载用户库…")).value = "";
    const nameInput = el("input", "vpl-input");
    nameInput.type = "text";
    nameInput.placeholder = "新提示词组名称";
    const categories = libraryMetadataPicker("分类");
    const tags = libraryMetadataPicker("标签");
    let color = randomColor();
    const colorRow = el("div", "vpl-row vpl-row-tight atb-save-color");
    const colorSwatch = el("span", "vpl-color-item");
    const colorLabel = el("span", "atb-field-label");
    const showColor = () => {
      colorSwatch.style.background = color;
      colorLabel.textContent = color;
    };
    showColor();
    colorRow.append(colorSwatch, colorLabel, iconBtn("随机换色", "重新生成随机配色", () => { color = randomColor(); showColor(); }));
    const loadHint = el("div", "atb-save-help");
    let loadSeq = 0;
    let loadedLib = null;
    stopGraph(libSel); stopGraph(nameInput);
    const field = (title, control, help) => {
      const wrap = el("div", "atb-save-field");
      const label = el("label", "atb-field-label", title);
      const input = control.matches("input, select") ? control : control.querySelector("input");
      if (input) {
        input.id = "atb-field-" + Math.random().toString(36).slice(2);
        label.htmlFor = input.id;
      }
      wrap.append(label, control);
      if (help) wrap.appendChild(help);
      return wrap;
    };
    const foot = el("div", "vpl-dialog-footer");
    const okBtn = iconBtn("入库", "保存到所选库", async () => {
      const lib = libSel.value;
      const gname = nameInput.value.trim();
      if (!lib || !gname) { okBtn.textContent = "✗ 需选库并填组名"; setTimeout(() => { okBtn.textContent = "入库"; }, 1200); return; }
      if (loadedLib !== lib) return;
      const selectedCategories = categories.values();
      const selectedTags = tags.values();
      okBtn.disabled = true;
      libSel.disabled = true;
      body.inert = true;
      try {
        const loc = { source: "user", name: lib };
        const d = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
        // 读取失败时不能用空库兜底再保存，否则会覆盖已有卡片。
        if (!d?.ok || !d.library || !Array.isArray(d.library.groups)) throw new Error(d?.error || "读取库失败，请重试");
        let data = d.library;
        if (data.groups.some((g) => (g.name || "").trim() === gname)) {
          okBtn.disabled = false;
          libSel.disabled = false;
          okBtn.textContent = "✗ 同名组已存在";
          setTimeout(() => { okBtn.textContent = "入库"; }, 1500);
          return;
        }
        okBtn.textContent = "正在入库…";
        const media = await previews.upload(groupId);
        if (media.cover || media.coverVideo) {
          // 视频上传可能耗时较长，完成后重读库，保留上传期间新增的卡片。
          const latest = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
          if (!latest?.ok || !latest.library || !Array.isArray(latest.library.groups)) throw new Error(latest?.error || "读取库失败，请重试");
          data = latest.library;
          if (data.groups.some((g) => (g.name || "").trim() === gname)) throw new Error("同名组已存在");
        }
        data.groups.push({
          id: groupId,
          name: gname, categories: selectedCategories, positive: text, negative: "", note: "",
          color, weight: 1, prefix: "", suffix: "", tags: selectedTags, ...media,
        });
        const meta = data.meta || (data.meta = {});
        for (const [key, values] of [["categories", selectedCategories], ["tags", selectedTags]]) {
          meta[key] = [...new Set([...(Array.isArray(meta[key]) ? meta[key] : []), ...values])];
        }
        const saved = await apiPost("/library/save", { locator: loc, data });
        if (!saved || saved.ok !== true) throw new Error((saved && saved.error) || "保存失败");
        // 保存落盘后立即通知当前画布的同库面板，避免继续显示或回写旧副本。
        window.dispatchEvent(new CustomEvent("allbuy-promptlibrary-saved", { detail: { locator: loc } }));
        lastLibName = lib; // 入库成功也更新记忆：下次直接定位到这个库
        okBtn.textContent = "✓ 已入库";
        setTimeout(() => { close(); onDone && onDone(); }, 500);
      } catch (err) {
        okBtn.disabled = false;
        libSel.disabled = false;
        okBtn.textContent = "✗ " + (err.message || "失败");
        setTimeout(() => { okBtn.textContent = "入库"; }, 1800);
      } finally {
        body.inert = false;
      }
    }, "vpl-btn-primary");
    okBtn.disabled = true;
    foot.appendChild(okBtn);
    const basics = el("div", "atb-save-basics");
    basics.append(field("用户库", libSel, loadHint), field("提示词组名称", nameInput));
    body.append(hint, basics,
      field("分类（可多选）", categories.root), field("标签（可多选）", tags.root),
      field("自动随机配色", colorRow), field("预览素材（可选）", previews.root,
        el("div", "atb-save-help", "只添加视频时自动使用首帧作为截图；也可单独指定截图。")));
    body.after(foot);
    const loadMetadata = async () => {
      const seq = ++loadSeq;
      const lib = libSel.value;
      loadedLib = null;
      okBtn.disabled = true;
      categories.reset();
      tags.reset();
      categories.root.inert = tags.root.inert = true;
      loadHint.textContent = "正在读取分类和标签…";
      const loc = { source: "user", name: lib };
      const d = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
      if (seq !== loadSeq || !body.isConnected) return;
      if (!d?.ok || !d.library || !Array.isArray(d.library.groups)) {
        loadHint.replaceChildren(el("span", null, "读取库失败，请重试 "), iconBtn("重试", "重新读取分类和标签", loadMetadata));
        return;
      }
      const data = d.library;
      const meta = data.meta || {};
      const list = (v) => Array.isArray(v) ? v : [];
      categories.reset([...list(meta.categories), ...data.groups.flatMap((g) =>
        Array.isArray(g.categories) && g.categories.length ? g.categories : (g.category ? [g.category] : []))]);
      tags.reset([...list(meta.tags), ...data.groups.flatMap((g) => list(g.tags))]);
      categories.root.inert = tags.root.inert = false;
      loadHint.textContent = "";
      loadedLib = lib;
      okBtn.disabled = false;
    };
    libSel.addEventListener("change", loadMetadata);
    const libs = await userLibraries();
    libSel.innerHTML = "";
    if (!libs.length) {
      if ((await apiGet("/version")).loadFailed) {
        libSel.appendChild(el("option", null, "⚠ 无法连接后端")).value = "";
        // v3.124：容器是 body（此前误引用 insertFromLibrary 作用域的 list → ReferenceError，提示永不渲染）
        body.appendChild(el("div", "vpl-empty", "连接后端失败：请检查 ComfyUI 是否在运行，关掉此弹窗稍后重试"));
        return;
      }
      libSel.appendChild(el("option", null, "（无用户库）")).value = "";
      libSel.disabled = true;
      return;
    }
    for (const L of libs) {
      const opt = el("option", null, `${L.display}${L.count ? `（${L.count} 组）` : ""}`);
      opt.value = L.name;
      libSel.appendChild(opt);
    }
    wireLibMemory(libSel, libs);
    await loadMetadata();
    nameInput.focus();
  }, () => previews.dispose());
}

function insertFromLibrary(onInsert) {
  dialogShell("从提示词库插入", async (body) => {
    const libSel = el("select", "vpl-input atb-select");
    stopGraph(libSel);
    const list = el("div", "vpl-list atb-lib-list");
    const hint = el("div", "vpl-empty atb-hint", "选择库后点击组即可插入到光标处");
    body.append(hint, libSel, list);
    const libs = await userLibraries();
    libSel.innerHTML = "";
    if (!libs.length) {
      if ((await apiGet("/version")).loadFailed) {
        libSel.appendChild(el("option", null, "⚠ 无法连接后端")).value = "";
        list.appendChild(el("div", "vpl-empty", "连接后端失败：请检查 ComfyUI 是否在运行，关掉此弹窗稍后重试"));
        return;
      }
      libSel.appendChild(el("option", null, "（无用户库）")).value = "";
      list.appendChild(el("div", "vpl-empty", "还没有用户库，先在提示词库面板创建"));
      return;
    }
    for (const L of libs) {
      const opt = el("option", null, `${L.display}${L.count ? `（${L.count} 组）` : ""}`);
      opt.value = L.name;
      libSel.appendChild(opt);
    }
    wireLibMemory(libSel, libs); // 预选上次用的库（首次 load 即加载它的组）
    // 切库竞态守卫（batch_image_selector 同款）：连续切换时慢的旧响应后到，丢弃之，
    // 防旧库列表覆盖新库、点行插入过期内容
    let loadSeq = 0;
    const load = async () => {
      const seq = ++loadSeq;
      list.replaceChildren();
      list.appendChild(el("div", "vpl-empty", "加载中…"));
      const loc = { source: "user", name: libSel.value };
      const d = await apiGet("/library?locator=" + encodeURIComponent(JSON.stringify(loc)));
      if (seq !== loadSeq) return;
      list.replaceChildren();
      const groups = (d && d.ok && d.library && Array.isArray(d.library.groups)) ? d.library.groups : [];
      if (!groups.length) { list.appendChild(el("div", "vpl-empty", "该库没有提示词组")); return; }
      for (const g of groups) {
        const row = el("div", "vpl-item atb-lib-item");
        stopGraph(row);
        const gname = g.name || "未命名";
        const name = el("span", "vpl-item-name", gname);
        name.title = g.name || "";
        const preview = el("span", "vpl-item-cat atb-lib-prev",
          (g.positive || "").replace(/\s+/g, " ").slice(0, 40) || "（空）");
        row.append(name, preview);
        row.addEventListener("click", () => {
          lastLibName = libSel.value;
          lastInsertGroup = { lib: libSel.value, name: gname }; // 记住本次插入的组
          onInsert((g.positive || "").trim());
          // 插入后不关弹窗：可连续插入多组；按 Esc/✕ 关闭
        });
        list.appendChild(row);
      }
      // 上次插入的组就在当前库：高亮并滚到它——重开即回到上次位置
      if (lastInsertGroup && lastInsertGroup.lib === libSel.value) {
        const prev = [...list.querySelectorAll(".atb-lib-item")]
          .find((r) => r.querySelector(".vpl-item-name")?.textContent === lastInsertGroup.name);
        if (prev) {
          prev.classList.add("vpl-item-selected");
          prev.scrollIntoView({ block: "center" });
        }
      }
    };
    libSel.addEventListener("change", load);
    await load();
  });
}

// ---------------------------------------------------------------------------
// 节点挂载
// ---------------------------------------------------------------------------
function hideNativeWidget(w) {
  if (!w) return;
  w.options = w.options || {};
  w.options.hidden = true;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  w.draw = () => {};
}

function attach(node) {
  if (node._atbContainer) return;
  const wText = findWidget(node, "文本");
  const wRep = findWidget(node, "替换表");
  const wDrop = findWidget(node, "去空行");
  hideNativeWidget(wText);
  hideNativeWidget(wRep);
  hideNativeWidget(wDrop);

  const container = document.createElement("div");
  container.className = "vpl-node atb-node";
  container.style.cssText = "pointer-events:none;";
  installBypassSync(node, container);
  installExecutionLock(node, container);
  requestAnimationFrame(() => {
    container.querySelector(".vpl-exec-bar")?.classList.add("alora-control");
  });

  const panel = el("div", "atb-panel");
  node._atbContainer = panel;

  // ---- 顶栏 ----
  // 去空行主题开关（须先于 tbar.append 声明，TDZ）
  const dropSwitch = el("div", "atb-switch" + ((wDrop ? wDrop.value !== false : true) ? " on" : ""));
  dropSwitch.title = "输出前删除空行";
  dropSwitch.append(el("span", "atb-track"), el("span", "atb-switch-label", "去空行"));
  stopGraph(dropSwitch);
  dropSwitch.addEventListener("click", () => {
    const on = !dropSwitch.classList.contains("on");
    dropSwitch.classList.toggle("on", on);
    if (wDrop) wDrop.value = on;
    updateBadge();
    node.setDirtyCanvas?.(true, true);
  });

  const tbar = el("div", "atb-tbar");
  const copyBtn = iconBtn("复制", "复制全部文本到剪贴板", async () => {
    const t = area.value;
    if (!t.trim()) return;
    try {
      await navigator.clipboard.writeText(t);
      copyBtn.textContent = "✓ 已复制";
    } catch (_) {
      area.select();
      const ok = document.execCommand?.("copy"); // 失败返回 false 不抛错，别报假成功
      copyBtn.textContent = ok ? "✓" : "⚠";
    }
    setTimeout(() => { copyBtn.textContent = "复制"; }, 1200);
  });
  const pasteBtn = iconBtn("粘贴", "读剪贴板【替换全部内容】（无权限时聚焦手动 Ctrl+V）", async () => {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch (_) {}
    if (text && text.trim()) {
      area.value = text; // 用户要求：粘贴=清空原内容后覆盖（不再插入光标处）
      flush();
      pasteBtn.textContent = "✓";
    } else {
      area.focus();
      pasteBtn.textContent = "⚠";
    }
    setTimeout(() => { pasteBtn.textContent = "粘贴"; }, 1200);
  });
  const libBtn = iconBtn("入库", "把当前文本存为新提示词组（用户库）", () => {
    const t = area.value.trim();
    if (!t) return;
    saveToLibrary(t, () => {
      libBtn.textContent = "✓ 已入库";
      setTimeout(() => { libBtn.textContent = "入库"; }, 1200);
    });
  }, "vpl-btn-primary");
  const insBtn = iconBtn("插入", "从提示词库选择组插入文本", () => {
    insertFromLibrary((text) => {
      insertAtCursor(area, text);
      scheduleSave();
      insBtn.textContent = "✓ 已插入";
      setTimeout(() => { insBtn.textContent = "插入"; }, 1200);
    });
  });
  const repBtn = iconBtn("替换", "展开/收起替换表（每行 旧=新）", () => {
    repWrap.style.display = repWrap.style.display === "none" ? "" : "none";
    recalcHeight(node);
  });
  tbar.append(copyBtn, pasteBtn, libBtn, insBtn, repBtn, dropSwitch);
  panel.appendChild(tbar);

  // ---- 文本区 ----
  const area = el("textarea", "vpl-input atb-area");
  area.value = (wText && wText.value) || "";
  area.placeholder = "输入提示词，每行一段；@素材名 按出现顺序标记为 image1..10（与素材库无匹配关系）";
  stopGraph(area);
  panel.appendChild(area);

  // ---- 状态徽标行 ----
  const badge = el("div", "atb-badge");
  panel.appendChild(badge);

  // ---- 替换表折叠区 ----
  const repWrap = el("div", "atb-repwrap");
  repWrap.style.display = "none";
  const repLabel = el("div", "atb-field-label", "替换表（每行一条：旧=新，按顺序应用）");
  const repArea = el("textarea", "vpl-input atb-area atb-reparea");
  repArea.value = (wRep && wRep.value) || "";
  repArea.placeholder = "示例：\n杰作=masterpiece\n人物=girl";
  stopGraph(repArea);
  repWrap.append(repLabel, repArea);
  panel.appendChild(repWrap);

  container.appendChild(panel);

  // ---- 同步（防抖写入 widget，入队/关页前冲刷） ----
  let timer = 0;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (wText) wText.value = area.value;
    if (wRep) wRep.value = repArea.value;
    histPush(area.value); // 编辑历史：防抖合并后的快照（程序化恢复由 _histLock 挡住）
    node.setDirtyCanvas?.(true, true);
  };
  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 200);
    updateBadge();
  };
  area.addEventListener("input", scheduleSave);
  repArea.addEventListener("input", scheduleSave);

  const insertAtCursor = (ta, text) => {
    if (!text) return;
    // 未聚焦时不信选区：复制按钮降级路径的 area.select() 全选会残留，被当"选区替换"
    // 执行就成了清空原内容（用户报的粘贴清空）；未聚焦一律追加到末尾
    const focused = document.activeElement === ta;
    const s = focused ? (ta.selectionStart ?? ta.value.length) : ta.value.length;
    const e = focused ? (ta.selectionEnd ?? s) : ta.value.length;
    const pre = ta.value.slice(0, s);
    const post = ta.value.slice(e);
    const glue = pre && !pre.endsWith("\n") && !pre.endsWith(" ") ? "\n" : "";
    ta.value = pre + glue + text + post;
    const pos = (pre + glue + text).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
  };

  // ---- 编辑历史（v3.122）：快照栈 + 撤销/重做/历史，右下角悬停浮出 ----
  // 快照在 flush 防抖（200ms）落盘时合并入栈（连续打字一条记录）；程序化恢复不入栈。
  const hist = [area.value || ""];
  let hi = 0;
  let _histLock = false;
  function histPush(v) {
    if (_histLock) return;
    if (hist[hi] === v) return;
    hist.splice(hi + 1);       // 截断撤销后的未来分支
    hist.push(v);
    if (hist.length > 40) hist.shift();
    hi = hist.length - 1;
    refreshHistBtns();
  }
  function histApply(idx) {
    if (idx < 0 || idx >= hist.length) return;
    hi = idx;
    _histLock = true;
    area.value = hist[hi];
    flush();
    updateBadge();
    _histLock = false;
    refreshHistBtns();
  }
  function refreshHistBtns() {
    if (!cornerBtns) return;
    cornerBtns.undo.disabled = hi <= 0;
    cornerBtns.redo.disabled = hi >= hist.length - 1;
    cornerBtns.histBtn.disabled = hist.length <= 1;
  }

  // 右下角悬停浮出条：光标靠近面板右下角（170×46 热区）才显示，平时隐藏且不挡点击
  const corner = el("div", "vpl-corner-actions");
  const cornerBtns = {};
  cornerBtns.undo = iconBtn("↩", "撤销（回到上一条历史）", () => histApply(hi - 1));
  cornerBtns.redo = iconBtn("↪", "重做（恢复被撤销的编辑）", () => histApply(hi + 1));
  cornerBtns.histBtn = iconBtn("🕘", "历史记录：查看并恢复到任一快照", (e) => {
    e.stopPropagation();
    openHistPop(e.currentTarget);
  });
  corner.append(cornerBtns.undo, cornerBtns.redo, cornerBtns.histBtn);

  function openHistPop(anchor) {
    closeHistPop();
    const pop = el("div", "vpl-corner-pop");
    pop.append(el("div", "vpl-corner-pop-title", "编辑历史（最近 20 条，点击恢复）"));
    // v3.124：快照数<20 时 hist.length-20+k 为负 → histApply 的 idx<0 早退、行号显示 # -14；
    // 起点钳到 0（对齐 slice(-20) 的真实起点），恢复/●标记/行号随之全部正确
    const histStart = Math.max(0, hist.length - 20);
    const items = hist.slice(-20).map((v, k) => ({ v, idx: histStart + k })).reverse();
    if (items.length <= 1) pop.append(el("div", "vpl-empty", "还没有历史记录"));
    for (const it of items) {
      const row = el("div", "vpl-corner-pop-item" + (it.idx === hi ? " cur" : ""));
      const preview = (it.v.split("\n").find((l) => l.trim()) || "（空）").slice(0, 40);
      row.append(el("span", "vpl-corner-pop-idx", (it.idx === hi ? "● " : "") + " #" + (it.idx + 1)), el("span", "vpl-corner-pop-txt", preview));
      row.addEventListener("click", (e) => { e.stopPropagation(); histApply(it.idx); closeHistPop(); });
      pop.appendChild(row);
    }
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    pop.style.bottom = Math.max(8, window.innerHeight - r.top + 6) + "px";
    _histPop = pop;
    setTimeout(() => {
      document.addEventListener("mousedown", _histPopClose, true);
    }, 0);
  }
  let _histPop = null;
  function _histPopClose(e) { if (_histPop && !_histPop.contains(e.target)) closeHistPop(); }
  function closeHistPop() {
    if (_histPop) { _histPop.remove(); _histPop = null; document.removeEventListener("mousedown", _histPopClose, true); }
  }

  panel.appendChild(corner); // 右下角悬停浮出（历史/撤销/重做）
  const uninstallCorner = installCornerHover(panel, corner);

  // 状态徽标：行数/去空行/@素材
  function updateBadge() {
    const drop = wDrop ? wDrop.value !== false : true;
    const lines = area.value.split("\n");
    const nonBlank = lines.filter((l) => l.trim()).length;
    const ats = [];
    for (const m of area.value.matchAll(/@([^\s@，。,.：:；;！!？?（）()【】\[\]、]+)/g)) {
      if (m[1] && !ats.includes(m[1])) ats.push(m[1]);
    }
    const atText = ats.length
      ? ` · @素材 ${ats.length}${ats.length > 10 ? "（前 10 个生效）" : ""}`
      : "";
    badge.textContent = `${nonBlank} 行${drop ? "（去空行）" : ""}${atText}`;
  }
  updateBadge();
  node._atbFlush = flush; // 入队/关页冲刷用（直接写穿，不走防抖）
  node._atbBadgeRefresh = updateBadge;

  // 入队前冲刷：graphToPrompt 会 await widget.serializeValue——在这里写穿防抖
  // 窗口，序列化拿到的必是最新文本。（此前监听的 app "queue" 事件在前端任何
  // 版本都不存在，监听从未挂上=死代码，200ms 窗口内的编辑曾静默丢失）
  for (const w of [wText, wRep]) {
    if (w && !w._atbSerialFlush) {
      w._atbSerialFlush = true;
      w.serializeValue = async () => { flush(); return w.value; };
    }
  }

  // ---- DOM widget 与高度管理（兄弟节点同款配方） ----
  const domWidget = node.addDOMWidget("textbox_ui", "ATB_UI", container, {
    getValue() { return ""; },
    setValue() {},
    resize: false,
    hideOnZoom: false, // 画布远缩放（low_quality）不隐藏面板（LoRA 堆栈同款，默认 true 会在缩小时整层消失）
  });
  node._atbWidget = domWidget;
  domWidget.computeSize = () => [0, -4];
  // 前端的 DOM widget 外壳仍可能比面板高，空白部分必须穿透到画布。
  const markWrapper = () => container.closest(".dom-widget")?.classList.add("atb-fit-widget");
  markWrapper();
  requestAnimationFrame(markWrapper);

  [60, 250, 600].forEach((t) => setTimeout(() => recalcHeight(node), t));
  const ro = new ResizeObserver(() => recalcHeight(node));
  ro.observe(container);
  // 用户拖拽节点大小（setSize 每次移动都会回调 onResize）与工作流载入的大尺寸
  // 都走这里：拉高→面板跟满；拖矮→钳到内容下限（共享助手 panel_guard.installFillResize）
  installFillResize(node, {
    el: () => node._atbContainer,
    chrome: () => stackChromeH(node),
    floor: () => node._atbCachedH || 0,
    minWidth: STACK_MIN_WIDTH,
    margin: STACK_BOTTOM_GAP,
    onSettled: () => recalcHeight(node),
  });
  const _origOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    _origOnRemoved?.apply(this, arguments);
    ro.disconnect();
    uninstallCorner();
    closeHistPop();
  };
  node._atbRecalc = () => recalcHeight(node);
}

// 关页前冲刷防抖（入队冲刷已改为 serializeValue 写穿，见 attach 内注释）
window.addEventListener("beforeunload", () => {
  for (const n of app?.graph?._nodes || []) {
    if (n?.type === NODE_NAME && typeof n?._atbFlush === "function") n._atbFlush();
  }
});

app.registerExtension({
  name: "AllBuy.TextBox",
  async setup() {
    setTimeout(() => {
      for (const node of app?.graph?._nodes || []) {
        if (node?.type === NODE_NAME || node?.comfyClass === NODE_NAME) attach(node);
      }
    }, 500);
  },
  async nodeCreated(node) {
    if (node?.type !== NODE_NAME && node?.comfyClass !== NODE_NAME) return;
    attach(node);
  },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      if (onConfigure) onConfigure.apply(this, arguments);
      setTimeout(() => {
        if (!this._atbContainer) attach(this);
        // 工作流恢复：widget 值回填面板
        const panel = this._atbContainer;
        if (panel) {
          const area = panel.querySelector(".atb-area");
          const rep = panel.querySelector(".atb-reparea");
          const wt = findWidget(this, "文本");
          const wr = findWidget(this, "替换表");
          if (area && wt && area.value !== (wt.value || "")) area.value = wt.value || "";
          if (rep && wr && rep.value !== (wr.value || "")) rep.value = wr.value || "";
          this._atbBadgeRefresh?.();
        }
      }, 0);
    };
  },
});

console.info("[AllBuy Studio] 文本框前端已加载 v3.105");
