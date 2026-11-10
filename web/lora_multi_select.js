// Shared multi-selection controls for active stacks and saved-list drafts.
function control(element) {
  element.classList.add("alora-control");
  for (const event of ["pointerdown", "mousedown", "touchstart", "keydown"]) {
    element.addEventListener(event, (e) => e.stopPropagation());
  }
  element.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  return element;
}

function button(text, title, callback) {
  const element = control(document.createElement("button"));
  element.type = "button";
  element.className += " vpl-btn";
  element.textContent = text;
  element.title = title;
  element.addEventListener("click", (e) => { e.stopPropagation(); callback(); });
  return element;
}

export function createLoRAMultiSelect(options) {
  const { getEntries, getHost, onChange, onDelete, onFavorites, onFavoritesChanged } = options;
  const visible = () => options.getVisibleEntries?.() || getEntries();
  const selectedIds = new Set();
  let active = false;
  let busy = false;
  let disposed = false;
  let anchor = null;
  let selectionKey = "";
  let generation = 0;
  const selected = () => getEntries().filter((entry) => selectedIds.has(entry.id));
  const bar = document.createElement("div");
  bar.className = "alora-bulk-bar";
  bar.hidden = true;
  const selectAll = control(document.createElement("input"));
  selectAll.type = "checkbox";
  selectAll.classList.add("vpl-checkbox");
  selectAll.setAttribute("aria-label", "全选当前显示的 LoRA");
  const allLabel = document.createElement("label");
  allLabel.className = "vpl-check-row";
  control(allLabel);
  allLabel.append(selectAll, document.createTextNode("全选"));
  const count = document.createElement("span");
  count.className = "alora-bulk-count";
  const weight = control(document.createElement("input"));
  weight.type = "number";
  weight.step = "0.01";
  weight.classList.add("vpl-input", "alora-bulk-weight");
  weight.placeholder = "设置权重";
  weight.setAttribute("aria-label", "批量权重");
  const status = document.createElement("span");
  status.className = "alora-bulk-status";
  status.setAttribute("role", "status");
  const report = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle("error", error);
  };
  const bounds = (entries) => entries.reduce((range, entry) => ({
    min: Math.max(range.min, Number(entry.min)), max: Math.min(range.max, Number(entry.max)),
  }), { min: -Infinity, max: Infinity });
  const applyWeight = button("修改权重", "将所选 LoRA 统一设置为此权重", () => {
    const entries = selected();
    if (!entries.length) return;
    const value = Math.round(Number(weight.value) * 100) / 100;
    if (!weight.value.trim() || !Number.isFinite(value)) { report("请填写有效的权重数字", true); return; }
    if (entries.some((entry) => ["min", "max"].some((key) => String(entry[key]).trim() === ""
      || !Number.isFinite(Number(entry[key]))) || Number(entry.max) <= Number(entry.min))) {
      report("请先修正所选 LoRA 的权重范围", true);
      return;
    }
    const range = bounds(entries);
    if (range.max < range.min) { report("所选 LoRA 的权重范围不重叠，请分开修改", true); return; }
    if (value < range.min || value > range.max) {
      report(`权重需满足所选条目的范围：${range.min} 至 ${range.max}`, true);
      return;
    }
    onChange(getEntries().map((entry) => selectedIds.has(entry.id) ? { ...entry, weight: value } : entry));
    weight.value = value.toFixed(2);
    report(`已修改 ${entries.length} 条权重`);
    sync();
  });
  weight.addEventListener("input", () => report(""));
  weight.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyWeight.click(); } });
  const favorite = async (remove) => {
    const names = [...new Set(selected().map((entry) => (entry.name || "").trim()).filter((name) => name && name !== "None"))];
    if (!names.length || busy) return;
    const revision = generation;
    busy = true;
    report("正在保存收藏…");
    sync();
    try {
      await onFavorites(names, remove);
      if (disposed || revision !== generation) return;
      onFavoritesChanged?.();
      report(`已${remove ? "取消收藏" : "收藏"} ${names.length} 个 LoRA`);
    } catch (err) {
      if (!disposed && revision === generation) report(`收藏保存失败：${err.message}`, true);
    } finally {
      busy = false;
      if (!disposed) sync();
    }
  };
  const addFavorites = button("收藏", "将所选模型加入「我的收藏」", () => favorite(false));
  const removeFavorites = button("取消收藏", "将所选模型从「我的收藏」移除", () => favorite(true));
  const editTags = options.onTags ? button("标签", "批量设置所选 LoRA 的分类标签", () => {
    options.onTags([...new Set(selected().map((entry) => (entry.name || "").trim()).filter((name) => name && name !== "None"))]);
  }) : null;
  const remove = button("删除选中", "删除所有选中的 LoRA 条目", () => {
    const entries = selected();
    if (!entries.length) return;
    if (onDelete) onDelete(entries);
    else onChange(getEntries().filter((entry) => !selectedIds.has(entry.id)));
    report(`已删除 ${entries.length} 条 LoRA`);
    sync();
  });
  remove.classList.add("alora-clear");
  const clear = button("清除选择", "取消所有已选条目", () => { selectedIds.clear(); anchor = null; report(""); sync(); });
  const toggleBtn = button("多选", "进入或退出 LoRA 多选模式", () => {
    active = !active;
    if (!active) { selectedIds.clear(); anchor = null; report(""); }
    sync();
  });
  selectAll.addEventListener("change", () => {
    for (const entry of visible()) {
      if (selectAll.checked) selectedIds.add(entry.id);
      else selectedIds.delete(entry.id);
    }
    anchor = null;
    report("");
    sync();
  });
  bar.append(allLabel, count, weight, applyWeight, addFavorites, removeFavorites, remove, clear, status);
  if (editTags) bar.insertBefore(editTags, remove);

  const sync = () => {
    if (disposed) return;
    const entries = getEntries();
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of selectedIds) if (!ids.has(id)) selectedIds.delete(id);
    if (!ids.has(anchor)) anchor = null;
    const chosen = selected();
    const displayed = visible();
    const selectedVisible = displayed.filter((entry) => selectedIds.has(entry.id)).length;
    const hidden = chosen.length - selectedVisible;
    count.textContent = `已选 ${chosen.length} 条` + (hidden ? `（含 ${hidden} 条筛选外）` : "");
    selectAll.checked = displayed.length > 0 && selectedVisible === displayed.length;
    selectAll.indeterminate = selectedVisible > 0 && selectedVisible < displayed.length;
    const locked = busy || !!options.isBusy?.();
    selectAll.disabled = locked || !displayed.length;
    for (const element of [weight, applyWeight, remove, clear]) element.disabled = locked || !chosen.length;
    const hasModels = chosen.some((entry) => entry.name?.trim() && entry.name.trim() !== "None");
    addFavorites.disabled = removeFavorites.disabled = locked || !hasModels;
    if (editTags) editTags.disabled = locked || !hasModels;
    toggleBtn.disabled = locked;
    toggleBtn.textContent = active ? "退出多选" : "多选";
    toggleBtn.setAttribute("aria-pressed", String(active));
    bar.hidden = !active;
    const key = chosen.map((entry) => entry.id).sort().join("|");
    if (key !== selectionKey) {
      selectionKey = key;
      weight.value = chosen.length && chosen.every((entry) => Number(entry.weight) === Number(chosen[0].weight))
        ? Number(chosen[0].weight).toFixed(2) : "";
    }
    const host = getHost();
    host?.classList.toggle("alora-select-mode", active);
    for (const checkbox of host?.querySelectorAll(".alora-row-select") || []) {
      checkbox.hidden = !active;
      checkbox.disabled = locked;
      checkbox.checked = selectedIds.has(checkbox.dataset.selectionId);
      checkbox.closest(".alora-row, .alora-preset-editor-entry")?.classList.toggle("alora-selected", checkbox.checked);
    }
    options.onLayoutChange?.();
  };
  const checkbox = (entry) => {
    const input = control(document.createElement("input"));
    input.type = "checkbox";
    input.classList.add("vpl-checkbox", "alora-row-select");
    input.dataset.selectionId = entry.id;
    input.setAttribute("aria-label", "选择 LoRA：" + entry.name);
    input.title = "勾选 LoRA；Shift 点击可连续选择";
    input.hidden = !active;
    input.addEventListener("click", (e) => {
      e.stopPropagation();
      const displayed = visible();
      const from = displayed.findIndex((item) => item.id === anchor);
      const to = displayed.findIndex((item) => item.id === entry.id);
      const targets = e.shiftKey && from >= 0 && to >= 0
        ? displayed.slice(Math.min(from, to), Math.max(from, to) + 1) : [entry];
      for (const target of targets) {
        if (input.checked) selectedIds.add(target.id);
        else selectedIds.delete(target.id);
      }
      anchor = entry.id;
      report("");
      sync();
    });
    return input;
  };
  const reset = () => {
    generation++;
    selectedIds.clear();
    active = false;
    anchor = null;
    selectionKey = "";
    report("");
    sync();
  };
  return { bar, toggleBtn, checkbox, sync, reset, dispose() { reset(); disposed = true; } };
}
