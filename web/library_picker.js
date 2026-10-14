// Library navigation preferences belong to this browser, not to prompt-library files.
export const LIBRARY_PICKER_STORAGE_KEY = "allbuy-promptlibrary.library-picker.v1";
const CHANGE_EVENT = "allbuy-library-picker-changed";
let fallbackPreferences = { favorites: [], recent: [] };
let storageUnavailable = false;

export function libraryIdentity(value) {
  let locator = value;
  if (typeof value === "string") {
    try { locator = JSON.parse(value); }
    catch {
      const match = /^(user|builtin):(.+)$/.exec(value);
      locator = match ? { source: match[1], name: match[2] } : null;
    }
  }
  if (!locator || !["user", "builtin", "inline", "custom"].includes(locator.source)) return null;
  if (locator.source === "custom") {
    return typeof locator.path === "string" && locator.path
      ? JSON.stringify([locator.source, "", locator.path]) : null;
  }
  return typeof locator.name === "string" && locator.name
    ? JSON.stringify([locator.source, locator.name, ""]) : null;
}

function normalizePreferences(raw) {
  const keys = (value, limit) => Array.isArray(value)
    ? [...new Set(value.filter(key => typeof key === "string" && key.length <= 1024))].slice(0, limit) : [];
  return { favorites: keys(raw?.favorites, 200), recent: keys(raw?.recent, 20) };
}

export function readLibraryPreferences() {
  if (storageUnavailable) return normalizePreferences(fallbackPreferences);
  try {
    const raw = localStorage.getItem(LIBRARY_PICKER_STORAGE_KEY);
    return normalizePreferences(raw ? JSON.parse(raw) : {});
  } catch { storageUnavailable = true; }
  return normalizePreferences(fallbackPreferences);
}

export function updateLibraryPreference(key, action) {
  if (!key || !["favorite", "recent"].includes(action)) return;
  const preferences = readLibraryPreferences();
  if (action === "favorite") {
    preferences.favorites = preferences.favorites.includes(key)
      ? preferences.favorites.filter(item => item !== key) : [...preferences.favorites, key];
  } else {
    preferences.recent = [key, ...preferences.recent.filter(item => item !== key)].slice(0, 20);
  }
  fallbackPreferences = normalizePreferences(preferences);
  try {
    localStorage.setItem(LIBRARY_PICKER_STORAGE_KEY, JSON.stringify(fallbackPreferences));
    storageUnavailable = false;
  } catch { storageUnavailable = true; }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function rankLibraryItems(items, preferences, query = "") {
  const actions = [], notices = [], available = new Map();
  for (const item of items) {
    const key = libraryIdentity(item.value);
    if (!key && item.value === "__hidden_builtin__") notices.push(item);
    else if (!key) actions.push(item);
    else if (!available.has(key)) available.set(key, { ...item, key });
  }
  const ordered = [], used = new Set();
  const add = (key, group) => {
    if (used.has(key) || !available.has(key)) return;
    used.add(key);
    ordered.push({ ...available.get(key), ...(group ? { group } : {}) });
  };
  for (const key of preferences.favorites || []) add(key, "常用库");
  let recentCount = 0;
  for (const key of preferences.recent || []) {
    if (!used.has(key) && available.has(key) && recentCount < 5) {
      add(key, "最近使用");
      recentCount++;
    }
  }
  for (const key of available.keys()) add(key);
  const needle = query.trim().toLocaleLowerCase();
  return { libraries: ordered.filter(item => !needle || String(item.label).toLocaleLowerCase().includes(needle)), actions,
    notices: needle ? [] : notices };
}

export function installLibraryPicker(dropdown) {
  const { panel, trigger } = dropdown;
  panel.classList.add("vpl-library-picker");
  const searchHead = document.createElement("div");
  searchHead.className = "vpl-lib-search";
  const input = document.createElement("input");
  input.type = "search";
  input.className = "vpl-input";
  input.placeholder = "搜索提示词库…";
  input.setAttribute("aria-label", "搜索提示词库");
  input.autocomplete = "off";
  searchHead.appendChild(input);
  let items = [], options = null, destroyed = false;
  let selectedValue = dropdown.value, selectedLabel = "";
  const setItems = dropdown.setItems.bind(dropdown);
  const setValue = dropdown.setValueSilent.bind(dropdown);

  function render() {
    if (destroyed) return;
    const focused = document.activeElement === input;
    const selection = [input.selectionStart, input.selectionEnd];
    const scrollTop = options?.scrollTop || 0;
    const preferences = readLibraryPreferences();
    const ranked = rankLibraryItems(items, preferences, input.value);
    setItems([...ranked.libraries, ...ranked.notices]);
    options = document.createElement("div");
    options.className = "vpl-lib-options";
    options.setAttribute("role", "group");
    options.setAttribute("aria-label", "提示词库");
    while (panel.firstChild) options.appendChild(panel.firstChild);
    for (const row of options.querySelectorAll(".vpl-dd-item")) {
      const key = libraryIdentity(row.getAttribute("data-value"));
      if (!key) continue;
      const favorite = preferences.favorites.includes(key);
      row.classList.toggle("vpl-dd-item-active", key === libraryIdentity(dropdown.value));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "vpl-icon-btn vpl-lib-favorite";
      button.classList.toggle("vpl-lib-favorite-on", favorite);
      button.textContent = favorite ? "★" : "☆";
      button.title = favorite ? "取消常用" : "设为常用";
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(favorite));
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        updateLibraryPreference(key, "favorite");
      });
      row.tabIndex = 0;
      row.appendChild(button);
    }
    if (!ranked.libraries.length) {
      const empty = document.createElement("div");
      empty.className = "vpl-lib-empty";
      empty.textContent = input.value.trim() ? "没有匹配的提示词库" : "暂无提示词库";
      options.appendChild(empty);
    }
    // Render management actions separately so searching/scrolling never hides them.
    setItems(ranked.actions);
    const actions = document.createElement("div");
    actions.className = "vpl-lib-actions";
    while (panel.firstChild) actions.appendChild(panel.firstChild);
    panel.append(searchHead, options);
    if (ranked.actions.length) panel.appendChild(actions);
    options.scrollTop = scrollTop;
    if (focused) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(...selection);
    }
  }

  dropdown.setItems = next => { items = next; render(); };
  dropdown.setValueSilent = value => {
    setValue(value);
    const key = libraryIdentity(value);
    panel.querySelectorAll(".vpl-dd-item").forEach(row => {
      const rowValue = row.getAttribute("data-value");
      row.classList.toggle("vpl-dd-item-active", key ? libraryIdentity(rowValue) === key : rowValue === value);
    });
  };
  dropdown.addEventListener("change", value => {
    const key = libraryIdentity(value);
    if (key) updateLibraryPreference(key, "recent");
    else if (selectedLabel) {
      dropdown.setLabel(selectedLabel);
      dropdown.setValueSilent(selectedValue);
    }
  });
  function onOpen() {
    if (trigger.getAttribute("aria-expanded") !== "true") return;
    selectedValue = dropdown.value;
    selectedLabel = trigger.querySelector(".vpl-dd-label")?.textContent || "";
    input.value = "";
    render();
    options.scrollTop = 0;
    requestAnimationFrame(() => {
      if (!destroyed && trigger.getAttribute("aria-expanded") === "true") input.focus({ preventScroll: true });
    });
  }
  const open = dropdown.open.bind(dropdown);
  dropdown.open = () => { open(); onOpen(); };
  trigger.addEventListener("click", onOpen);
  input.addEventListener("input", () => { render(); options.scrollTop = 0; });
  input.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); dropdown.close(); trigger.focus(); }
    if (event.key === "Enter" || event.key === "ArrowDown") {
      event.preventDefault();
      const row = options.querySelector(".vpl-dd-item:not(.vpl-dd-item-disabled)");
      if (event.key === "Enter") row?.click(); else row?.focus();
    }
  });
  panel.addEventListener("keydown", event => {
    if (event.target === input) return;
    const row = event.target.closest(".vpl-dd-item");
    if (!row || event.target !== row) return;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); row.click(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const rows = [...panel.querySelectorAll(".vpl-dd-item:not(.vpl-dd-item-disabled)")];
      const index = rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1);
      if (index < 0) input.focus(); else rows[Math.min(index, rows.length - 1)]?.focus();
    }
  });
  const onStorage = event => {
    if (event.key === LIBRARY_PICKER_STORAGE_KEY || event.key === null) {
      storageUnavailable = false;
      fallbackPreferences = { favorites: [], recent: [] };
      render();
    }
  };
  window.addEventListener(CHANGE_EVENT, render);
  window.addEventListener("storage", onStorage);
  dropdown.destroy = () => {
    destroyed = true;
    dropdown.close();
    trigger.removeEventListener("click", onOpen);
    window.removeEventListener(CHANGE_EVENT, render);
    window.removeEventListener("storage", onStorage);
  };
  return dropdown;
}
