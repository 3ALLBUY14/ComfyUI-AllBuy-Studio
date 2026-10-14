// LoRA stack clearing, group quick-add, and shared saved-list management.
import { createLoRAMultiSelect } from "./lora_multi_select.js";
const API = "/allbuy_promptlibrary";
const UNDO_MS = 10000;

function el(tag, className = "", text = "") {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

function control(element) {
  element.classList.add("alora-control");
  for (const event of ["pointerdown", "mousedown", "touchstart", "keydown"]) {
    element.addEventListener(event, (e) => e.stopPropagation());
  }
  element.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  return element;
}

function button(text, title, action, className = "") {
  const result = control(el("button", "vpl-btn " + className, text));
  result.type = "button";
  result.title = title;
  result.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    action();
  });
  return result;
}

function field(placeholder) {
  const input = control(el("input", "vpl-input"));
  input.type = "text";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  return input;
}

async function presetsRequest(action) {
  const response = await fetch(API + (action ? "/lora_presets/update" : "/lora_presets"), action ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
  } : { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(response.status === 404 ? "请重启 ComfyUI，加载列表储存接口" : data.error || `HTTP ${response.status}`);
  }
  if (!Array.isArray(data.presets)) throw new Error("列表储存数据格式错误");
  if (action) window.dispatchEvent(new CustomEvent("allbuy-lora-data-changed", { detail: { origin: "node" } }));
  return data.presets;
}

export function installStackTools(node, hooks) {
  const { defaultEntry, normStackEntry, writeStack, renderStack, recalcStackHeight, loadGroups, saveGroups } = hooks;
  let undo = null;
  let undoTimer = null;
  const undoBar = el("div", "alora-undo-bar");
  undoBar.hidden = true;
  const undoText = el("span");
  const undoBtn = button("撤销", "恢复刚刚清空的列表，保留此后新添加的 LoRA", () => {
    if (!undo || Date.now() >= undo.expiresAt) { dismissUndo(); return; }
    const previous = undo.entries;
    const ids = new Set(previous.map((entry) => entry.id));
    const current = new Map((node._stackEntries || []).map((entry) => [entry.id, entry]));
    const restored = previous.filter((entry) => current.has(entry.id) || undo.deletedIds.has(entry.id))
      .map((entry) => current.get(entry.id) || entry);
    const added = (node._stackEntries || []).filter((entry) => !ids.has(entry.id));
    dismissUndo();
    setEntries([...restored, ...added]);
  });
  undoBar.append(undoText, undoBtn);

  const setEntries = (entries) => {
    node._aloraPickerClose?.();
    node._stackDragCleanup?.();
    node._stackEntries = entries;
    node._aloraCatalog?.revealEntries();
    node._stackFilter = "";
    if (node._stackFilterInput) node._stackFilterInput.value = "";
    writeStack(node);
    renderStack(node);
  };
  const dismissUndo = () => {
    clearTimeout(undoTimer);
    undoTimer = null;
    undo = null;
    undoBar.hidden = true;
    recalcStackHeight(node);
  };
  const tickUndo = () => {
    if (!undo) return;
    const remaining = undo.expiresAt - Date.now();
    if (remaining <= 0) { dismissUndo(); return; }
    undoText.textContent = `${undo.action} ${undo.deletedIds.size} 条 LoRA`;
    undoBtn.textContent = `撤销 (${Math.ceil(remaining / 1000)}s)`;
    undoTimer = setTimeout(tickUndo, Math.min(250, remaining));
  };
  const deleteEntries = (entries, action = "已删除") => {
    if (!entries.length) return;
    dismissUndo();
    const deletedIds = new Set(entries.map((entry) => entry.id));
    undo = { entries: structuredClone(node._stackEntries), deletedIds, action, expiresAt: Date.now() + UNDO_MS };
    setEntries(node._stackEntries.filter((entry) => !deletedIds.has(entry.id)));
    undoBar.hidden = false;
    tickUndo();
    recalcStackHeight(node);
  };
  const clearBtn = button("清空", "清空 LoRA 列表，10 秒内可撤销", () => {
    deleteEntries(node._stackEntries || [], "已清空");
  }, "alora-clear");
  const saveFavorites = async (names, remove) => {
    const data = await loadGroups({ strict: true });
    const groups = structuredClone(data.groups || []);
    let fav = groups.find((group) => group.name === "我的收藏");
    if (!fav) { fav = { id: "_fav", name: "我的收藏", loras: [] }; groups.unshift(fav); }
    const chosen = new Set(names);
    fav.loras = remove ? fav.loras.filter((name) => !chosen.has(name)) : [...new Set([...fav.loras, ...names])];
    await saveGroups(groups);
  };
  const favoritesChanged = () => {
    node._aloraPickerClose?.();
    renderStack(node);
    node._aloraGroupManagerRefresh?.();
  };
  const multi = createLoRAMultiSelect({
    getEntries: () => node._stackEntries || [],
    getHost: () => node._stackList,
    getVisibleEntries: () => (node._stackEntries || []).filter((entry) => node._aloraCatalog
      ? node._aloraCatalog.matches(entry) : !node._stackFilter || (entry.name || "").toLowerCase().includes(node._stackFilter)),
    onChange: (entries) => {
      node._aloraPickerClose?.();
      node._stackEntries = entries;
      writeStack(node);
      renderStack(node);
    },
    onDelete: deleteEntries,
    onFavorites: saveFavorites,
    onFavoritesChanged: favoritesChanged,
    onTags: (names) => node._aloraCatalog?.editTags(names),
    onLayoutChange: () => recalcStackHeight(node),
  });
  node._aloraMultiSelect = multi;

  const openGroupPicker = async (anchor) => {
    const same = node._aloraPickerAnchor === anchor && node._aloraPickerMode === "group";
    node._aloraPickerClose?.();
    if (same) return;
    const pop = el("div", "alora-pop alora-group-picker");
    const search = field("搜索 LoRA 分组…");
    const list = el("div", "alora-pop-list");
    pop.append(search, list);
    document.body.appendChild(pop);
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(420, window.innerWidth - 16);
      pop.style.width = width + "px";
      pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
      const height = pop.offsetHeight;
      pop.style.top = Math.max(8, rect.bottom + height + 8 <= window.innerHeight
        ? rect.bottom + 4 : rect.top - height - 4) + "px";
    };
    const close = () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", position);
      pop.remove();
      if (node._aloraPickerClose === close) {
        node._aloraPickerClose = null;
        node._aloraPickerAnchor = null;
        node._aloraPickerMode = null;
      }
    };
    const onOutside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    node._aloraPickerClose = close;
    node._aloraPickerAnchor = anchor;
    node._aloraPickerMode = "group";
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", position);
    list.appendChild(el("div", "alora-pop-empty", "正在加载分组…"));
    position();
    search.focus();
    const data = await loadGroups();
    if (!pop.isConnected) return;
    const render = () => {
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const available = new Set(node._loraOptions || []);
      const existing = new Set((node._stackEntries || []).map((entry) => entry.name));
      const groups = (data.groups || []).filter((group) => group.name.toLowerCase().includes(query));
      for (const group of groups) {
        const names = [...new Set(group.loras || [])].filter((name) => available.has(name) && !existing.has(name));
        const choice = button(group.name, "将本组可用且尚未添加的 LoRA 加入列表", () => {
          setEntries([...(node._stackEntries || []), ...names.map((name) => ({ ...defaultEntry(), name }))]);
          close();
        }, "alora-group-choice");
        choice.appendChild(el("span", "alora-group-count", `${names.length} 可添加 / ${(group.loras || []).length} 条`));
        choice.disabled = !names.length;
        list.appendChild(choice);
      }
      if (!groups.length) list.appendChild(el("div", "alora-pop-empty", "暂无匹配分组，可在 LoRA 分组管理中创建"));
      position();
    };
    search.addEventListener("input", render);
    render();
  };

  const openPresets = async () => {
    node._aloraPickerClose?.();
    node._aloraPresetClose?.();
    const overlay = el("div", "vpl-overlay alora-presets-overlay");
    const dialog = el("div", "vpl-dialog alora-presets-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "LoRA 列表储存");
    dialog.setAttribute("aria-modal", "true");
    const close = () => {
      editingMulti?.dispose();
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      if (node._aloraPresetClose === close) {
        node._aloraPresetClose = null;
        node._aloraPresetSync = null;
        node._aloraPresetTagsSync = null;
      }
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (editing && !busy) cancelEdit();
      else if (!editing) close();
    };
    node._aloraPresetClose = close;
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    const title = el("div", "vpl-dialog-title");
    const titleLabel = el("span", "", "LoRA 列表储存");
    title.append(titleLabel, button("✕", "关闭", close));
    const body = el("div", "vpl-dialog-body alora-presets-body");
    const message = el("div", "alora-presets-message");
    message.setAttribute("role", "status");
    const nameInput = field("列表名称");
    nameInput.maxLength = 100;
    const saveRow = el("div", "alora-presets-save");
    const search = field("搜索已保存列表…");
    const list = el("div", "vpl-list alora-presets-list");
    const editor = el("div", "alora-preset-editor");
    editor.hidden = true;
    let presets = [];
    let busy = false;
    let ready = false;
    let editing = null;
    let editingMulti = null;
    node._aloraPresetTagsSync = () => {
      for (const box of editor.querySelectorAll(".alora-editor-model-tags")) {
        box.replaceChildren(node._aloraCatalog?.rowTags(box.dataset.modelName) || "");
      }
    };
    const report = (text, error = false) => {
      message.textContent = text;
      message.classList.toggle("error", error);
    };
    editor.addEventListener("input", () => {
      if (message.classList.contains("error")) report("");
    });
    const snapshot = () => (node._stackEntries || []).map(({ _editingRange, id, ...entry }) => entry);
    const sync = () => {
      saveBtn.disabled = busy || !ready || !!editing || !node._stackEntries?.length;
      for (const btn of list.querySelectorAll("button")) {
        btn.disabled = busy || (btn.dataset.needsStack === "true" && !node._stackEntries?.length);
      }
      for (const input of editor.querySelectorAll("input, textarea, select, button")) {
        input.disabled = busy || input.dataset.unavailable === "true"
          || (input.dataset.saveEdit === "true" && !editing?.entries.length);
      }
      editingMulti?.sync();
    };
    node._aloraPresetSync = sync;
    const mutate = async (action, success, onSuccess) => {
      if (busy) return false;
      busy = true;
      sync();
      try {
        const fresh = await presetsRequest(action);
        if (!overlay.isConnected) return false;
        presets = fresh;
        onSuccess?.();
        report(success);
        render();
        return true;
      } catch (err) {
        if (overlay.isConnected) report(err.message, true);
        return false;
      } finally {
        busy = false;
        if (overlay.isConnected) sync();
      }
    };
    const saveBtn = button("保存当前列表", "保存顺序、权重、启用状态、范围和触发词", async () => {
      if (await mutate({ action: "save", name: nameInput.value, entries: snapshot(),
        view: node._aloraCatalog?.snapshotSort() }, "当前列表已保存")) nameInput.value = "";
    }, "vpl-btn-primary");
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveBtn.click(); } });
    saveRow.append(nameInput, saveBtn);
    const apply = (preset, append) => {
      const entries = preset.entries.map(normStackEntry).filter(Boolean);
      if (!append) node._aloraCatalog?.restoreSort(preset.view || { sort: "manual" });
      setEntries(append ? [...(node._stackEntries || []), ...entries] : entries);
      close();
    };
    const updateView = () => {
      dialog.classList.toggle("alora-presets-editing", !!editing);
      saveRow.hidden = search.hidden = list.hidden = refreshBtn.hidden = !!editing;
      editor.hidden = !editing;
      titleLabel.textContent = editing ? `编辑列表 · ${editing.name}` : "LoRA 列表储存";
    };
    const cancelEdit = () => {
      editingMulti?.dispose();
      editingMulti = null;
      editing = null;
      editor.replaceChildren();
      updateView();
      report("");
      render();
    };
    const validateDraft = () => {
      if (!editing.entries.length) throw new Error("列表至少需要一条 LoRA");
      return editing.entries.map((entry, index) => {
        const name = entry.name.trim();
        if (!name) throw new Error(`第 ${index + 1} 条请选择 LoRA 模型`);
        for (const key of ["weight", "min", "max"]) {
          if (String(entry[key]).trim() === "" || !Number.isFinite(Number(entry[key]))) {
            throw new Error(`第 ${index + 1} 条的权重和范围必须是有效数字`);
          }
        }
        const weight = Math.round(Number(entry.weight) * 100) / 100;
        const min = Number(entry.min), max = Number(entry.max);
        if (max <= min) throw new Error(`第 ${index + 1} 条的最大值必须大于最小值`);
        if (weight < min || weight > max) throw new Error(`第 ${index + 1} 条的权重必须在 ${min} 至 ${max} 之间`);
        return { name, weight, min, max, enabled: entry.enabled !== false, trigger: entry.trigger.trim() };
      });
    };
    const renderEditor = () => {
      report("");
      editor.replaceChildren();
      const models = el("datalist");
      models.id = "alora-preset-models-" + Math.random().toString(36).slice(2);
      for (const name of new Set(node._loraOptions || [])) {
        const option = el("option");
        option.value = name;
        models.appendChild(option);
      }
      editor.appendChild(models);
      const rows = el("div", "alora-preset-editor-rows");
      const labelled = (text, input) => {
        const label = el("label", "alora-preset-editor-field");
        input.setAttribute("aria-label", text);
        label.append(el("span", "alora-preset-editor-label", text), input);
        return label;
      };
      editing.entries.forEach((entry, index) => {
        const row = el("div", "alora-preset-editor-entry");
        const heading = el("div", "alora-preset-heading");
        if (editingMulti) heading.appendChild(editingMulti.checkbox(entry));
        const enabled = control(el("input", "vpl-checkbox"));
        enabled.type = "checkbox";
        enabled.checked = entry.enabled !== false;
        enabled.setAttribute("aria-label", "启用 LoRA");
        enabled.addEventListener("change", () => { entry.enabled = enabled.checked; });
        const toggle = el("label", "vpl-check-row");
        toggle.append(enabled, document.createTextNode("启用"));
        const shift = (offset) => {
          const other = index + offset;
          [editing.entries[index], editing.entries[other]] = [editing.entries[other], editing.entries[index]];
          editing.view = { sort: "manual" };
          renderEditor();
        };
        const up = button("↑", "向上移动", () => shift(-1));
        const down = button("↓", "向下移动", () => shift(1));
        up.dataset.unavailable = String(index === 0);
        down.dataset.unavailable = String(index === editing.entries.length - 1);
        const remove = button("移除", "从此保存列表移除 LoRA", () => {
          editing.entries.splice(index, 1);
          renderEditor();
        }, "alora-clear");
        heading.append(el("span", "alora-preset-name", `LoRA ${index + 1}`), toggle, up, down, remove);
        const model = field("搜索或输入 LoRA 模型路径");
        model.value = entry.name;
        model.setAttribute("list", models.id);
        const missing = el("div", "alora-preset-missing");
        const tagBox = el("div", "alora-editor-model-tags");
        const updateTags = () => {
          tagBox.dataset.modelName = entry.name;
          tagBox.replaceChildren(node._aloraCatalog?.rowTags(entry.name) || "");
        };
        updateTags();
        const checkModel = () => {
          missing.textContent = entry.name.trim() && entry.name !== "None" && !(node._loraOptions || []).includes(entry.name.trim())
            ? "未找到此 LoRA 文件，请检查名称或安装对应模型" : "";
        };
        model.addEventListener("input", () => { entry.name = model.value; checkModel(); updateTags(); });
        checkModel();
        const parameters = el("div", "alora-preset-editor-parameters");
        for (const [key, text] of [["weight", "权重"], ["min", "最小值"], ["max", "最大值"]]) {
          const input = field(text);
          input.type = "number";
          input.step = "0.01";
          input.value = String(entry[key]);
          input.addEventListener("input", () => { entry[key] = input.value; });
          parameters.appendChild(labelled(text, input));
        }
        const trigger = control(el("textarea", "vpl-textarea alora-preset-editor-trigger"));
        trigger.value = entry.trigger || "";
        trigger.placeholder = "填写此 LoRA 的激活提示词 / 触发词";
        trigger.addEventListener("input", () => { entry.trigger = trigger.value; });
        row.append(heading, labelled("LoRA 模型", model), tagBox, missing, parameters, labelled("激活提示词", trigger));
        rows.appendChild(row);
      });
      if (!editing.entries.length) rows.appendChild(el("div", "vpl-empty", "列表为空，请添加 LoRA 后保存"));
      const actions = el("div", "alora-preset-actions");
      if (node._aloraCatalog) actions.appendChild(node._aloraCatalog.sortControl(editing.view?.sort, (sort) => {
        editing.view = { sort };
        editing.entries = node._aloraCatalog.sortedEntries(editing.entries, sort);
        renderEditor();
      }));
      if (editingMulti) actions.appendChild(editingMulti.toggleBtn);
      const add = button("＋ 添加 LoRA", "在此保存列表中新增一条 LoRA", () => {
        editing.entries.push({ ...defaultEntry(), name: "" });
        renderEditor();
        editor.querySelector(".alora-preset-editor-entry:last-child input[list]")?.focus();
      });
      const saveEdit = button("保存修改", "保存回原列表", () => {
        try {
          const entries = node._aloraCatalog?.sortedEntries(validateDraft(), editing.view?.sort || "manual") || validateDraft();
          mutate({ action: "overwrite", id: editing.id, entries, view: editing.view || { sort: "manual" } }, "列表修改已保存", () => {
            editingMulti?.dispose();
            editingMulti = null;
            editing = null;
            editor.replaceChildren();
            updateView();
          });
        } catch (err) { report(err.message, true); }
      }, "vpl-btn-primary");
      saveEdit.dataset.saveEdit = "true";
      actions.append(add, saveEdit, button("取消", "取消编辑，保留原保存列表", cancelEdit));
      if (editingMulti) editor.appendChild(editingMulti.bar);
      editor.append(rows, actions);
      sync();
    };
    const render = () => {
      list.replaceChildren();
      const query = search.value.trim().toLowerCase();
      const matches = presets.filter((preset) => preset.name.toLowerCase().includes(query));
      for (const preset of matches) {
        const row = el("div", "alora-preset-row");
        const heading = el("div", "alora-preset-heading");
        const label = el("span", "alora-preset-name", preset.name);
        label.title = preset.name;
        heading.append(label, el("span", "alora-preset-count", `${preset.entries.length} 条`));
        const summary = el("div", "alora-preset-summary", preset.entries
          .map((entry) => `${entry.name.split(/[\\/]/).pop()} (${Number(entry.weight).toFixed(2)})`).join(" · "));
        summary.title = summary.textContent;
        const actions = el("div", "alora-preset-actions");
        const use = button("使用", "替换当前 LoRA 列表", () => apply(preset, false), "vpl-btn-primary");
        const append = button("追加", "将已保存列表追加到当前列表末尾", () => apply(preset, true));
        const edit = button("编辑", "修改已保存列表中的 LoRA 模型、参数和激活提示词", () => {
          editing = { id: preset.id, name: preset.name,
            view: preset.view || { sort: "manual" },
            entries: preset.entries.map((entry) => ({ ...entry, id: defaultEntry().id })) };
          editingMulti = createLoRAMultiSelect({
            getEntries: () => editing?.entries || [],
            getHost: () => editor.querySelector(".alora-preset-editor-rows"),
            onChange: (entries) => { editing.entries = entries; renderEditor(); },
            onFavorites: saveFavorites,
            onFavoritesChanged: favoritesChanged,
            onTags: (names) => node._aloraCatalog?.editTags(names),
            isBusy: () => busy,
          });
          report("");
          updateView();
          renderEditor();
          editor.querySelector("input[list]")?.focus();
        });
        const overwrite = button("覆盖", "用当前 LoRA 列表覆盖此保存项", () => {
          if (window.confirm(`用当前列表覆盖「${preset.name}」？`)) mutate({ action: "overwrite", id: preset.id, entries: snapshot(),
            view: node._aloraCatalog?.snapshotSort() }, "已覆盖保存项");
        });
        overwrite.dataset.needsStack = "true";
        const rename = button("重命名", "修改保存项名称", () => {
          const input = field("新的列表名称");
          input.value = preset.name;
          input.maxLength = 100;
          let submitted = false;
          const commit = async () => {
            if (submitted) return;
            submitted = true;
            if (input.value.trim() === preset.name) { render(); sync(); return; }
            const succeeded = await mutate({ action: "rename", id: preset.id, name: input.value }, "已重命名");
            if (!succeeded) submitted = false;
          };
          input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
          input.addEventListener("blur", commit);
          label.replaceWith(input);
          input.focus();
          input.select();
        });
        const remove = button("删除", "删除此保存项", () => {
          if (window.confirm(`删除已保存的列表「${preset.name}」？`)) mutate({ action: "delete", id: preset.id }, "已删除保存项");
        }, "alora-clear");
        actions.append(use, append, edit, overwrite, rename, remove);
        row.append(heading, summary);
        const missing = preset.entries.filter((entry) => entry.name !== "None" && !(node._loraOptions || []).includes(entry.name));
        if (missing.length) row.appendChild(el("div", "alora-preset-missing", `${missing.length} 个 LoRA 文件未找到，使用前请安装或替换`));
        row.appendChild(actions);
        list.appendChild(row);
      }
      if (!matches.length) list.appendChild(el("div", "vpl-empty", query ? "没有匹配的列表" : "还没有保存的列表"));
      sync();
    };
    search.addEventListener("input", render);
    const refreshBtn = button("刷新", "重新读取已保存的列表", async () => {
      if (busy) return;
      busy = true;
      ready = false;
      sync();
      try {
        const fresh = await presetsRequest();
        if (!overlay.isConnected) return;
        presets = fresh;
        ready = true;
        report("");
        render();
      } catch (err) {
        if (overlay.isConnected) report(err.message, true);
      } finally {
        busy = false;
        if (overlay.isConnected) sync();
      }
    });
    const footer = el("div", "vpl-dialog-footer");
    footer.append(refreshBtn, button("关闭", "关闭列表储存", close));
    body.append(saveRow, search, message, list, editor);
    dialog.append(title, body, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    sync();
    refreshBtn.click();
    nameInput.focus();
  };

  const presetsBtn = button("列表储存", "保存、管理和使用 LoRA 列表", openPresets, "alora-presets-btn");
  node._aloraToolsSync = () => {
    clearBtn.disabled = !node._stackEntries?.length;
    node._aloraPresetSync?.();
    multi.sync();
  };
  node._aloraToolsReset = () => {
    multi.reset();
    dismissUndo();
    node._aloraPickerClose?.();
    node._aloraPresetClose?.();
  };
  node._aloraToolsSync();
  return { clearBtn, presetsBtn, undoBar, openGroupPicker, multi };
}
