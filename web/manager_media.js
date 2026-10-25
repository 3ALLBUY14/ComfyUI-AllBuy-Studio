const API = "/allbuy_promptlibrary";
const dimensions = new Map();
function element(tag, className = "", text = "") {
  const node = document.createElement(tag); node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(text, action) {
  const node = element("button", "abm-button", text); node.type = "button";
  node.addEventListener("click", event => { event.stopPropagation(); action(); });
  return node;
}
export function previewFileKind(file) {
  if (/\.(mp4|webm|mov|mkv|avi|m4v|mpg|mpeg)$/i.test(file.name)) return "video";
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file.name)) return "image";
  return null;
}
export function attachMediaDrop(box, onDrop) {
  if (!onDrop) return;
  let depth = 0, busy = false;
  const reset = () => { depth = 0; box.classList.remove("abm-drop-active"); };
  box.classList.add("abm-drop-zone");
  box.addEventListener("dragenter", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); depth++; box.classList.add("abm-drop-active");
  });
  box.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = busy ? "none" : "copy";
  });
  box.addEventListener("dragleave", event => { event.stopPropagation(); if (--depth <= 0) reset(); });
  box.addEventListener("drop", async event => {
    event.preventDefault(); event.stopPropagation(); reset();
    if (busy) return;
    const file = event.dataTransfer?.files?.[0]; if (!file) return;
    busy = true; box.classList.add("abm-drop-busy");
    try { await onDrop(file); } catch (error) { box.title = error.message || "预览替换失败"; }
    finally { busy = false; box.classList.remove("abm-drop-busy"); }
  });
}
export function promptMedia(group) {
  const record = {};
  if (group.cover) record.image = { url: API + "/cover/file?name=" + encodeURIComponent(group.cover), filename: group.cover };
  if (group.coverVideo) record.video = { url: API + "/cover/video?name=" + encodeURIComponent(group.coverVideo), poster: API + "/cover/file?name=" + encodeURIComponent(group.coverVideo), filename: group.coverVideo };
  return record;
}

// Keep decoded dimensions across renders, and prefer a video's own poster to the hidden image.
export function mediaThumbnail(record, onOpen, { compact = true, onDrop, muted = true, onMuted } = {}) {
  const box = element("div", "abm-media");
  const kind = record.video ? "video" : "image";
  const url = record.video?.poster || record.image?.url;
  const image = element("img"); image.alt = ""; image.loading = "lazy"; image.draggable = false;
  const remember = () => {
    if (image.naturalWidth) {
      const ratio = image.naturalWidth / image.naturalHeight;
      dimensions.set(url, ratio); box.style.setProperty("--abm-media-ratio", ratio);
    }
  };
  box.style.setProperty("--abm-media-ratio", dimensions.get(url) || 1);
  image.addEventListener("load", remember);
  image.addEventListener("error", () => { image.hidden = true; box.classList.add("abm-media-failed"); });
  if (url) image.src = kind === "image" && !/^(data:|blob:)/.test(url) ? url + (url.includes("?") ? "&" : "?") + "w=480" : url;
  else image.hidden = true;
  box.append(element("span", "abm-media-fallback", record.video ? "视频预览" : "图片无法读取"), image);
  box.title = "双击放大 · 拖入图片或视频替换";
  box.tabIndex = 0; box.setAttribute("role", "button"); box.setAttribute("aria-label", "放大预览");
  box.addEventListener("dblclick", event => { event.stopPropagation(); if (!event.target.closest("button")) onOpen(kind); });
  box.addEventListener("keydown", event => {
    if (event.target === box && ["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); onOpen(kind); }
  });
  attachMediaDrop(box, onDrop);
  if (record.video) {
    const play = button("▶ 视频", () => onOpen("video")); play.classList.add("abm-media-play"); box.appendChild(play);
    if (compact) {
      let video = null, quiet = muted;
      const ensure = () => {
        if (!video) {
          video = element("video", "abm-card-video"); video.muted = quiet; video.loop = true; video.playsInline = true;
          video.preload = "none"; video.src = record.video.url;
          video.addEventListener("playing", () => box.classList.add("abm-video-playing")); box.appendChild(video);
        }
        return video;
      };
      const sound = button("", () => {
        quiet = !quiet; ensure().muted = quiet; onMuted?.(quiet); updateSound(); video.play().catch(() => {});
      });
      sound.classList.add("abm-media-sound");
      const updateSound = () => { sound.textContent = quiet ? "静音" : "有声"; sound.title = quiet ? "开启声音" : "静音"; sound.setAttribute("aria-label", sound.title); sound.setAttribute("aria-pressed", String(!quiet)); };
      updateSound(); box.appendChild(sound);
      box.addEventListener("pointerenter", () => ensure().play().catch(() => {}));
      box.addEventListener("pointerleave", () => { video?.pause(); box.classList.remove("abm-video-playing"); });
    }
  }
  return box;
}

export function openMediaLightbox(parent, record, title, initialKind, onClose, { onDrop } = {}) {
  const overlay = element("div", "abm-lightbox");
  overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", title + "预览");
  const header = element("div", "abm-lightbox-header"), stage = element("div", "abm-lightbox-stage"), kindLabel = element("span", "abm-muted");
  const frame = element("div", "abm-media-transform"), status = element("div", "abm-muted");
  const footer = element("div", "abm-lightbox-footer"), percent = element("output", "abm-zoom-value");
  let current, closed = false, zoom = 1, x = 0, y = 0, fitScale = 1, drag = null, dragged = false, replacing = false;
  const paint = () => { frame.style.transform = `translate(${x}px,${y}px) scale(${zoom})`; percent.textContent = Math.round(zoom * fitScale * 100) + "%"; };
  const fit = (reset = true) => {
    const width = current?.naturalWidth || current?.videoWidth || 640, height = current?.naturalHeight || current?.videoHeight || 480;
    fitScale = Math.min(stage.clientWidth / width, stage.clientHeight / height, 1);
    frame.style.width = width * fitScale + "px"; frame.style.height = height * fitScale + "px";
    if (reset) { zoom = 1; x = y = 0; } paint();
  };
  const changeZoom = (value, px = 0, py = 0) => {
    const next = Math.max(.1, Math.min(Math.max(16, 1 / fitScale), value));
    x = px - (px - x) * next / zoom; y = py - (py - y) * next / zoom; zoom = next; paint();
  };
  const cleanup = () => { if (current?.tagName === "VIDEO") { current.pause(); current.removeAttribute("src"); current.load(); } };
  const close = () => {
    if (closed || replacing) return;
    closed = true; cleanup(); observer.disconnect(); document.removeEventListener("keydown", onKey, true);
    overlay.remove(); onClose();
  };
  const show = () => {
    cleanup(); frame.replaceChildren(); status.textContent = "拖动平移 · 滚轮缩放 · 拖入素材替换";
    const video = !!record.video;
    kindLabel.textContent = video ? "视频" : "图片";
    current = element(video ? "video" : "img", "abm-lightbox-media"); current.draggable = false;
    current.addEventListener(video ? "loadedmetadata" : "load", () => fit());
    current.addEventListener("error", () => { status.textContent = "无法读取预览，视频建议使用 MP4 / WebM。"; });
    if (video) {
      current.controls = true; current.playsInline = true; current.preload = "metadata";
      if (record.video.poster) current.poster = record.video.poster;
      current.src = record.video.url; current.play().catch(() => { status.textContent = "点击播放按钮播放视频"; });
    } else { current.src = record.image.url; current.alt = title; }
    current.addEventListener("dblclick", event => {
      if (video && event.clientY > current.getBoundingClientRect().bottom - 48 * zoom) return;
      event.preventDefault(); fit();
    });
    frame.appendChild(current); fit();
  };
  const closeButton = button("关闭 ×", close);
  header.append(element("strong", "", title), kindLabel, closeButton);
  footer.append(status, button("−", () => changeZoom(zoom / 1.25)), percent, button("＋", () => changeZoom(zoom * 1.25)), button("适应窗口", () => fit()), button("原始尺寸", () => { x = y = 0; changeZoom(1 / fitScale); }));
  footer.querySelectorAll("button")[0].setAttribute("aria-label", "缩小预览"); footer.querySelectorAll("button")[1].setAttribute("aria-label", "放大预览");
  stage.appendChild(frame); overlay.append(header, stage, footer); parent.appendChild(overlay);
  stage.addEventListener("wheel", event => {
    event.preventDefault(); event.stopPropagation(); const r = stage.getBoundingClientRect();
    changeZoom(zoom * Math.exp(-event.deltaY * .002), event.clientX - r.left - r.width / 2, event.clientY - r.top - r.height / 2);
  }, { passive: false });
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || replacing) return;
    // Leave the native video's bottom control strip available for playback and seeking.
    if (event.target === current && current.tagName === "VIDEO" && event.clientY > current.getBoundingClientRect().bottom - 48 * zoom) return;
    drag = { id: event.pointerId, px: event.clientX, py: event.clientY, x, y }; dragged = false;
  });
  stage.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.px, dy = event.clientY - drag.py;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true; stage.setPointerCapture(event.pointerId); stage.classList.add("is-panning");
    x = drag.x + dx; y = drag.y + dy; paint(); event.preventDefault();
  });
  const endDrag = event => { if (drag?.id === event.pointerId) { if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); drag = null; stage.classList.remove("is-panning"); } };
  stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag);
  overlay.addEventListener("click", event => {
    if (dragged) { dragged = false; return; }
    if ([overlay, stage, header, footer].includes(event.target)) close();
  });
  attachMediaDrop(overlay, onDrop && (async file => {
    replacing = true; status.textContent = "正在替换预览…";
    try { const updated = await onDrop(file); if (updated && !closed) { record = updated; show(); } else { status.textContent = "替换未完成，请查看底栏提示"; } }
    catch (error) { status.textContent = error.message; }
    finally { replacing = false; }
  }));
  const onKey = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === "Tab") {
      const controls = [...overlay.querySelectorAll("button,video")].filter(node => !node.disabled);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  };
  const observer = new ResizeObserver(() => fit(false)); observer.observe(stage);
  document.addEventListener("keydown", onKey, true); show(); closeButton.focus(); return close;
}
