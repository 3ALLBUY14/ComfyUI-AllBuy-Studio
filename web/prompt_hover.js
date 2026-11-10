export function promptInfoFields(group) {
  const labels = values => Array.isArray(values) ? values.filter(value => typeof value === "string" && value.trim()).join(" / ") : "";
  const categories = labels(group.categories) || group.category;
  const tags = labels(group.tags);
  const fields = [["备注", group.note], ["分类", categories], ["标签", tags],
    ["正向提示词", group.positive], ["负向提示词", group.negative], ["前缀", group.prefix], ["后缀", group.suffix]];
  if (["number", "string"].includes(typeof group.weight) && String(group.weight).trim() && Number.isFinite(Number(group.weight)) && Number(group.weight) !== 1) {
    fields.push(["权重", String(group.weight)]);
  }
  return fields.filter(([, value]) => typeof value === "string" && value.trim());
}

let nextId = 0;
export function createPromptHover() {
  const make = (tag, cls = "", text = "") => {
    const element = document.createElement(tag); element.className = cls; element.textContent = text; return element;
  };
  let card, anchor, showTimer, hideTimer, destroyed = false;
  const inside = event => event.target?.nodeType && card?.contains(event.target);
  const hide = () => {
    clearTimeout(showTimer); clearTimeout(hideTimer);
    if (anchor && card) {
      const ids = (anchor.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== card.id);
      if (ids.length) anchor.setAttribute("aria-describedby", ids.join(" ")); else anchor.removeAttribute("aria-describedby");
    }
    card?.remove(); card = null; anchor = null;
  };
  const position = () => {
    if (!card || !anchor?.isConnected) { hide(); return; }
    const target = anchor.getBoundingClientRect(), bounds = card.getBoundingClientRect();
    const left = target.right + bounds.width + 8 <= innerWidth - 8 ? target.right + 8 : target.left - bounds.width - 8;
    card.style.left = Math.max(8, Math.min(left, innerWidth - bounds.width - 8)) + "px";
    card.style.top = Math.max(8, Math.min(target.top, innerHeight - bounds.height - 8)) + "px";
  };
  const leave = () => { clearTimeout(showTimer); clearTimeout(hideTimer); hideTimer = setTimeout(hide, 120); };
  function show(element, getGroup) {
    if (destroyed || !element.isConnected) return;
    const group = getGroup();
    if (!group) return;
    anchor = element;
    card = make("aside", "vpl-prompt-info");
    const current = card;
    card.id = "allbuy-prompt-hover-" + (++nextId);
    card.dataset.theme = element.closest("[data-theme]")?.dataset.theme || document.documentElement.dataset.theme || "dark";
    card.setAttribute("role", "tooltip");
    element.setAttribute("aria-describedby", [element.getAttribute("aria-describedby"), card.id].filter(Boolean).join(" "));
    card.append(make("strong", "vpl-prompt-info-title", group.name || "提示词组"));
    const cover = group.cover || group.coverVideo;
    if (cover) {
      const image = make("img"); image.alt = "提示词组封面"; image.draggable = false;
      image.src = "/allbuy_promptlibrary/cover/file?name=" + encodeURIComponent(cover) + "&w=640";
      image.addEventListener("load", () => { if (card === current) position(); });
      image.addEventListener("error", () => { image.remove(); if (card === current) position(); });
      card.append(image);
    }
    for (const [label, value] of promptInfoFields(group)) {
      const field = make("div", "vpl-prompt-info-field"); field.dataset.field = label;
      field.append(make("b", "", label), make("div", "vpl-prompt-info-text", value)); card.append(field);
    }
    card.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    card.addEventListener("mouseleave", leave);
    document.body.append(card); position();
  }
  function bind(element, getGroup) {
    const enter = () => { hide(); if (!destroyed) showTimer = setTimeout(() => show(element, getGroup), 350); };
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("focusin", enter);
    element.addEventListener("focusout", leave);
    element.addEventListener("click", hide);
    element.addEventListener("dragstart", hide);
    element.addEventListener("contextmenu", hide);
  }
  const onScroll = event => { if (!inside(event)) hide(); };
  const onKey = event => { if (event.key === "Escape") hide(); };
  const onPointer = event => { if (!inside(event)) hide(); };
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", hide);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  return { bind, hide, destroy() {
    destroyed = true; hide();
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", hide);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
  } };
}
