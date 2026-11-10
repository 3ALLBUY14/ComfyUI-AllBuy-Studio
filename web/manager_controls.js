// Searchable selects and context menus share one theme-aware, viewport-sized popup.
let active = null;
let sequence = 0;
export const hasManagerPopup = () => !!active;
export function closeManagerPopup() { active?.(); }
function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
export function mountPopup(anchor, popup, { x, y, focusBack = anchor, matchAnchor = true } = {}) {
  closeManagerPopup();
  const root = anchor.closest(".abm-overlay") || document.body;
  const theme = anchor.closest(".abm-overlay, .abm-launcher")?.dataset.theme;
  if (theme) popup.dataset.theme = theme;
  root.appendChild(popup);
  const rect = anchor.getBoundingClientRect();
  const bounds = root === document.body ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : root.getBoundingClientRect();
  const scale = rect.width / Math.max(1, anchor.offsetWidth);
  popup.style.fontSize = `${parseFloat(getComputedStyle(anchor).fontSize) * scale}px`;
  if (matchAnchor) popup.style.width = `${Math.min(bounds.width - 16, Math.max(230, rect.width))}px`;
  else {
    popup.style.width = "max-content";
    popup.style.minWidth = `${Math.min(bounds.width - 16, 180 * scale)}px`;
    popup.style.maxWidth = `${Math.min(bounds.width - 16, 300 * scale)}px`;
  }
  const left = Math.max(8, Math.min((x ?? rect.left) - bounds.left, bounds.width - popup.offsetWidth - 8));
  const desiredTop = (y ?? rect.bottom + 5) - bounds.top, aboveBottom = (y ?? rect.top - 5) - bounds.top;
  const below = Math.max(0, bounds.height - desiredTop - 8), above = Math.max(0, aboveBottom - 8);
  const upwards = popup.offsetHeight > below && above > below;
  popup.style.maxHeight = `${Math.min(parseFloat(getComputedStyle(popup).maxHeight) || 380, upwards ? above : below)}px`;
  const top = Math.max(8, Math.min(upwards ? aboveBottom - popup.offsetHeight : desiredTop, bounds.height - popup.offsetHeight - 8));
  popup.style.left = left + "px";
  popup.style.top = top + "px";
  const close = (restore = false) => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("resize", resized);
    document.removeEventListener("scroll", scrolled, true);
    observer.disconnect(); popup.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (active === close) active = null;
    if (restore && focusBack.isConnected) focusBack.focus({ preventScroll: true });
  };
  const outside = event => { if (!popup.contains(event.target) && !anchor.contains(event.target)) close(); };
  const key = event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    if (event.key === "Tab") close(true);
  };
  const resized = () => close();
  const scrolled = event => { if (!popup.contains(event.target)) close(); };
  const observer = new MutationObserver(() => { if (!anchor.isConnected) close(); });
  observer.observe(root, { childList: true, subtree: true });
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  document.addEventListener("scroll", scrolled, true);
  window.addEventListener("resize", resized);
  for (const name of ["pointerdown", "mousedown", "keydown", "wheel", "contextmenu"]) popup.addEventListener(name, event => event.stopPropagation());
  active = close;
  return close;
}

export function createManagerSelect(label, options, value, onChange) {
  const wrapper = element("div", "abm-select");
  const trigger = element("button", "abm-input abm-select-trigger");
  trigger.type = "button";
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-label", label);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const caption = element("span", "abm-select-caption");
  const chevron = element("span", "abm-select-chevron", "⌄");
  trigger.append(caption, chevron);
  wrapper.appendChild(trigger);
  const choices = options.map(([key, text]) => [String(key), String(text)]);
  let selected = "";
  Object.defineProperties(wrapper, {
    value: { get: () => selected, set: value => {
      const option = choices.find(([key]) => key === String(value));
      selected = option ? option[0] : "";
      caption.textContent = option?.[1] || label;
      trigger.title = option?.[1] || label;
    } },
    disabled: { get: () => trigger.disabled, set: value => { trigger.disabled = !!value; wrapper.classList.toggle("is-disabled", !!value); } },
  });
  wrapper.value = value;
  const open = () => {
    if (trigger.disabled) return;
    if (trigger.getAttribute("aria-expanded") === "true") { closeManagerPopup(); return; }
    const popup = element("div", "abm-popup abm-select-popup");
    const search = element("input", "abm-input abm-popup-search");
    search.type = "search"; search.placeholder = "搜索" + label + "…";
    search.setAttribute("aria-label", "搜索" + label);
    const list = element("div", "abm-select-options");
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label);
    list.id = "abm-select-options-" + ++sequence;
    trigger.setAttribute("aria-controls", list.id);
    popup.append(search, list);
    let close;
    const draw = () => {
      list.replaceChildren();
      const needle = search.value.trim().toLocaleLowerCase();
      for (const [key, text] of choices.filter(([, text]) => text.toLocaleLowerCase().includes(needle))) {
        const option = element("button", "abm-select-option", text);
        option.type = "button";
        option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(key === selected));
        option.addEventListener("click", () => { wrapper.value = key; close(true); onChange?.(key); });
        list.appendChild(option);
      }
      if (!list.childElementCount) list.appendChild(element("div", "abm-popup-empty", "没有匹配项"));
    };
    draw();
    close = mountPopup(trigger, popup);
    trigger.setAttribute("aria-expanded", "true");
    search.addEventListener("input", draw);
    popup.addEventListener("keydown", event => {
      const rows = [...list.querySelectorAll("button")];
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const index = rows.indexOf(document.activeElement);
        rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
      if (event.key === "Enter" && event.target === search) { event.preventDefault(); rows[0]?.click(); }
    });
    search.focus();
  };
  trigger.addEventListener("click", open);
  trigger.addEventListener("keydown", event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); open(); } });
  return wrapper;
}

export function showManagerContext(anchor, entries, x, y) {
  const popup = element("div", "abm-popup abm-context-menu");
  popup.setAttribute("role", "menu");
  let close;
  for (const entry of entries) {
    if (entry.separator) { popup.appendChild(element("div", "abm-menu-separator")); continue; }
    const item = element("button", "abm-context-item" + (entry.danger ? " abm-error" : ""), entry.label);
    if (entry.description) item.appendChild(element("span", "abm-context-description", entry.description));
    item.type = "button"; item.disabled = !!entry.disabled;
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => { close(); entry.action(); });
    popup.appendChild(item);
  }
  close = mountPopup(anchor, popup, { x, y, matchAnchor: false });
  popup.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const rows = [...popup.querySelectorAll("button:not(:disabled)")];
    const index = rows.indexOf(document.activeElement);
    rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  });
  popup.querySelector("button:not(:disabled)")?.focus();
}
