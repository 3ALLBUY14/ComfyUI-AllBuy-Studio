import { contentRestricted, managerContentPreferences, modelInfo } from "./manager_data.js";

const key = name => String(name || "").replaceAll("\\", "/");
export const normalizeMissingPolicy = value => value === "skip" ? "skip" : "error";
export const rowActive = entry => entry.enabled !== false && !entry.group_off;
export function resolveName(name, available) {
  if (!name || name === "None") return { name, status: "empty" };
  if (available.includes(name)) return { name, status: "exact" };
  const normalized = key(name).toLocaleLowerCase();
  let matches = available.filter(value => key(value).toLocaleLowerCase() === normalized);
  if (!matches.length) matches = available.filter(value => key(value).split("/").pop().toLocaleLowerCase() === normalized.split("/").pop());
  return matches.length === 1 ? { name: matches[0], status: "moved" } : { name, status: matches.length ? "ambiguous" : "missing" };
}
export function masterToggle(entries, saved) {
  if (entries.some(rowActive)) return { entries: entries.map(entry => ({ ...entry, enabled: false })),
    saved: Object.fromEntries(entries.map(entry => [entry.id, { enabled: entry.enabled, group_off: !!entry.group_off }])) };
  return { entries: entries.map(entry => ({ ...entry, ...(saved?.[entry.id] || { enabled: true, group_off: false }) })), saved: null };
}
export function assignGroup(entries, ids, name) {
  const chosen = new Set(ids);
  if (!name) return entries.map(entry => chosen.has(entry.id) ? { ...entry, group: "", group_off: false } : entry);
  const selected = entries.filter(entry => chosen.has(entry.id));
  if (!selected.length) return entries;
  const at = entries.findIndex(entry => chosen.has(entry.id));
  const before = entries.slice(0, at).filter(entry => !chosen.has(entry.id));
  const after = entries.slice(at).filter(entry => !chosen.has(entry.id));
  const off = entries.some(entry => entry.group === name && entry.group_off);
  return [...before, ...selected.map(entry => ({ ...entry, group: name, group_off: off })), ...after];
}
export function contiguousGroups(entries) {
  const emitted = new Set();
  return entries.flatMap(entry => {
    if (!entry.group) return [entry];
    if (emitted.has(entry.group)) return [];
    emitted.add(entry.group);
    return entries.filter(member => member.group === entry.group);
  });
}
export function moveGroup(entries, name, direction) {
  const members = entries.filter(entry => entry.group === name), rest = entries.filter(entry => entry.group !== name);
  let index = entries.findIndex(entry => entry.group === name);
  if (!members.length) return entries;
  if (direction < 0) {
    if (!index) return entries;
    const previous = rest[index - 1]; index--;
    if (previous?.group) while (index > 0 && rest[index - 1].group === previous.group) index--;
  } else {
    if (index >= rest.length) return entries;
    const next = rest[index]; index++;
    if (next?.group) while (index < rest.length && rest[index].group === next.group) index++;
  }
  return [...rest.slice(0, index), ...members, ...rest.slice(index)];
}

export function modelChain(node) {
  const graph = node.graph, sources = [], entries = [], visited = new Set([node.id]);
  let current = node;
  while (true) {
    const links = current.outputs?.find(output => output.type === "MODEL")?.links || [];
    if (!links.length) break;
    if (links.length !== 1) throw new Error("模型链有分叉，保持原连线，不合并");
    const link = graph.getLink?.(links[0]) || graph.links?.get?.(links[0]) || graph.links?.[links[0]];
    if (!link) throw new Error("模型连线已改变，请刷新画布");
    const next = graph.getNodeById(link.target_id);
    if (!next || next.type !== "LoraLoaderModelOnly") break;
    if (visited.has(next.id)) throw new Error("检测到循环连线，不能合并");
    visited.add(next.id);
    if (next.inputs?.[link.target_slot]?.type !== "MODEL" || next.inputs.some(input => input.type !== "MODEL" && input.link != null)
      || next.outputs.some(output => output.type !== "MODEL" && output.links?.length)) throw new Error("加载器含有其他连线，不能安全合并");
    if (next.mode !== 4 && next.mode !== 2) {
      const read = name => next.widgets?.find(widget => widget.name === name)?.value;
      const name = read("lora_name"), weight = Number(read("strength_model"));
      if (typeof name !== "string" || !name || !Number.isFinite(weight)) throw new Error("加载器参数无效，保持原节点");
      entries.push({ name, weight, min: Math.min(-3, weight), max: Math.max(3, weight), enabled: true, trigger: "" });
      sources.push(next);
    }
    current = next;
  }
  if (!sources.length) throw new Error("后方没有可安全合并的原生「仅模型 LoRA 加载器」；含 CLIP 的加载器保持原样");
  return { sources, entries };
}

let previews;
async function previewRecords() {
  previews ||= fetch("/allbuy_promptlibrary/lora_previews").then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).models || {};
  }).catch(error => { previews = null; throw error; });
  return previews;
}
export function installStackAdvanced(node, hooks) {
  node.properties ||= {};
  const make = (tag, cls = "", text = "") => { const el = document.createElement(tag); el.className = cls; el.textContent = text; return el; };
  const button = (text, action) => {
    const el = make("button", "vpl-btn alora-control", text); el.type = "button";
    el.addEventListener("click", event => { event.stopPropagation(); action(); }); return el;
  };
  const bar = make("div", "alora-advanced-toolbar alora-control");
  const onData = () => { previews = null; };
  window.addEventListener("allbuy-lora-data-changed", onData);
  for (const type of ["pointerdown", "mousedown", "keydown"]) bar.addEventListener(type, event => event.stopPropagation());
  const message = make("span", "alora-advanced-message"); message.setAttribute("role", "status");
  const commit = entries => { node._aloraScroll?.prepare(); node._stackEntries = entries; hooks.writeStack(node); hooks.renderStack(node); node.graph?.change?.(); };
  const report = text => { message.textContent = text; };
  const master = button("停用全部", () => {
    const result = masterToggle(node._stackEntries || [], node.properties.allbuyLoraMaster);
    node.properties.allbuyLoraMaster = result.saved; commit(result.entries);
  });
  master.title = "暂时停用整栈，再次点击恢复之前每条 LoRA 的启停状态";
  const group = button("选中分组", () => {
    const ids = [...node._stackList.querySelectorAll(".alora-row-select:checked")].map(box => box.dataset.selectionId);
    if (!ids.length) { report("请先点击「多选」并勾选要分组的 LoRA"); return; }
    const name = window.prompt("分组名称（填已有名称可加入该组；留空解除分组）", "");
    if (name === null) return;
    node._aloraCatalog?.setManualOrder(); commit(assignGroup(node._stackEntries, ids, name.trim().slice(0, 64))); report("分组已保存");
  });
  const repair = button("检查 / 找回文件", async () => {
    repair.disabled = true;
    try {
      previews = null;
      let fixed = 0, missing = 0;
      const paths = [];
      for (const entry of node._stackEntries) {
        const found = resolveName(entry.name, node._loraOptions || []);
        if (found.status === "moved") { fixed++; paths.push([entry.name, found.name]); }
        if (["missing", "ambiguous"].includes(found.status)) missing++;
      }
      if (paths.length) {
        await node._aloraCatalog.copyPaths(paths);
        const groups = (await hooks.loadGroups({ strict: true })).groups;
        const replacements = new Map(paths.map(([old, value]) => [key(old), value]));
        const updated = groups.map(group => ({ ...group, loras: [...new Set(group.loras.map(name => replacements.get(key(name)) || name))] }));
        if (JSON.stringify(groups) !== JSON.stringify(updated)) await hooks.saveGroups(updated);
      }
      const renamed = new Map(paths.map(([old, name]) => [key(old), name]));
      commit(node._stackEntries.map(entry => renamed.has(key(entry.name)) ? { ...entry, name: renamed.get(key(entry.name)) } : entry));
      report(`已找回 ${fixed} 条，待处理 ${missing} 条（同名不唯一时不会自动替换）`);
    } catch (error) { report("文件检查失败：" + error.message); }
    finally { repair.disabled = false; }
  });
  const policy = make("select", "vpl-input alora-catalog-select alora-control"); policy.setAttribute("aria-label", "缺失 LoRA 处理");
  for (const [value, text] of [["error", "缺失时停止"], ["skip", "缺失时跳过"]]) { const option = make("option", "", text); option.value = value; policy.append(option); }
  policy.addEventListener("change", () => {
    const widget = node.widgets.find(widget => widget.name === "on_missing");
    if (widget) { widget.value = policy.value; node.graph?.change?.(); }
    hooks.updateFooter(node);
  });
  const absorb = button("合并后方 LoRA 链", () => {
    try {
      const plan = modelChain(node);
      if (!window.confirm(`将后方 ${plan.sources.length} 个仅模型加载器追加到本堆栈并旁路原节点？顺序和重复项会保留。`)) return;
      const previous = node._stackEntries, modes = plan.sources.map(source => source.mode);
      node.graph?.beforeChange?.();
      try {
        node._aloraCatalog?.setManualOrder();
        commit([...previous, ...plan.entries.map(entry => ({ ...hooks.defaultEntry(), ...entry }))]);
        plan.sources.forEach(source => { source.mode = 4; });
      } catch (error) {
        plan.sources.forEach((source, index) => { source.mode = modes[index]; }); commit(previous); throw error;
      } finally { node.graph?.afterChange?.(); }
      report(`已合并 ${plan.sources.length} 个加载器，原节点保留并旁路，可用画布撤销恢复`);
    } catch (error) { report(error.message); }
  });
  bar.append(master, group, repair, policy, absorb, message);
  let hover, timer;
  const hide = () => { clearTimeout(timer); hover?.remove(); hover = null; };
  const hoverOn = (element, getName) => {
    element.addEventListener("mouseenter", () => {
      hide();
      timer = setTimeout(async () => {
        if (!element.isConnected) return;
        const card = make("div", "alora-info-card"); hover = card;
        card.setAttribute("role", "tooltip"); card.append(make("strong", "", getName()), make("p", "", "正在读取模型信息…"));
        document.body.append(card);
        const rect = element.getBoundingClientRect();
        card.style.left = Math.max(8, Math.min(rect.right + 8, window.innerWidth - 300)) + "px";
        card.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - 380)) + "px";
        try {
          const records = await previewRecords(), name = key(resolveName(getName(), node._loraOptions || []).name), record = records[name] || {}, catalog = node._aloraCatalog?.records || {};
          if (hover !== card || !element.isConnected) { card.remove(); return; }
          card.replaceChildren(make("strong", "", getName()));
          let preference;
          try { preference = JSON.parse(localStorage.getItem("allbuy-manager.v1") || "{}").contentPreferences; } catch (_) {}
          preference = managerContentPreferences(preference);
          const restricted = contentRestricted(name, catalog, records, preference);
          const image = record.image?.url || record.video?.poster;
          if (image && !(restricted && preference.mode === "hide")) {
            const img = make("img"); img.src = image; img.alt = "LoRA 预览";
            if (restricted && preference.mode === "blur") img.style.filter = "blur(18px)";
            card.append(img);
          }
          const info = modelInfo(name, catalog, records), recommendation = catalog.recommendations?.[name];
          card.append(make("p", "", `底模：${info.base_model || "未填写"} · 版本：${info.version || "未填写"}`));
          if (recommendation) card.append(make("p", "", `推荐区间：${recommendation.min ?? "不限"} ～ ${recommendation.max ?? "不限"}`));
          card.append(make("p", "", `激活词：${catalog.triggers?.[name] || "未填写"}`));
        } catch (error) { if (hover === card) card.append(make("p", "", "读取失败：" + error.message)); }
      }, 350);
    });
    element.addEventListener("mouseleave", hide);
  };
  const paintWeights = () => {
    const entries = node._stackEntries || [], scale = Math.max(1, ...entries.filter(rowActive).map(entry => Math.abs(entry.weight)));
    for (const row of node._stackList?.querySelectorAll(".alora-row") || []) {
      const entry = entries.find(entry => entry.id === row.dataset.id), button = row.querySelector(".alora-name-btn");
      if (!entry || !button) continue;
      const value = Math.max(-1, Math.min(1, entry.weight / scale)), start = 50 + Math.min(0, value) * 50, end = 50 + Math.max(0, value) * 50;
      const color = value < 0 ? "#e681813b" : "#7389ed45";
      button.style.backgroundImage = `linear-gradient(to right, transparent ${start}%, ${color} ${start}%, ${color} ${end}%, transparent ${end}%)`;
    }
  };
  const decorateGroups = () => {
    const list = node._stackList; if (!list) return;
    hide(); list.querySelectorAll(".alora-stack-group").forEach(el => el.remove());
    const folded = new Set(node.properties.allbuyLoraFolded || []);
    let previous = "";
    for (const entry of node._stackEntries || []) {
      const row = [...list.children].find(row => row.dataset.id === entry.id); if (!row) continue;
      const name = entry.group || "";
      if (name && name !== previous) {
        const header = make("div", "alora-stack-group alora-control"); header.dataset.group = name;
        const members = node._stackEntries.filter(entry => entry.group === name);
        const fold = button((folded.has(name) ? "▸ " : "▾ ") + name, () => {
          if (folded.has(name)) folded.delete(name); else folded.add(name);
          node.properties.allbuyLoraFolded = [...folded]; commit(node._stackEntries);
        });
        fold.setAttribute("aria-expanded", String(!folded.has(name)));
        const toggle = button(members.some(entry => entry.group_off) ? "启用组" : "停用组", () => {
          const off = !members.some(entry => entry.group_off);
          commit(node._stackEntries.map(entry => entry.group === name ? { ...entry, group_off: off } : entry));
        });
        header.append(fold, make("span", "", `${members.filter(rowActive).length}/${members.length}`), toggle);
        const changeOrder = direction => { node._aloraCatalog?.setManualOrder(); commit(moveGroup(node._stackEntries, name, direction)); };
        header.append(button("↑", () => changeOrder(-1)), button("↓", () => changeOrder(1)), button("改名", () => {
          const value = window.prompt("新的分组名称", name);
          if (!value?.trim()) return;
          const renamed = value.trim().slice(0, 64);
          if (renamed !== name && node._stackEntries.some(entry => entry.group === renamed)) { report("分组名称已存在，请用「选中分组」合并"); return; }
          if (folded.has(name)) { folded.delete(name); folded.add(renamed); node.properties.allbuyLoraFolded = [...folded]; }
          commit(node._stackEntries.map(entry => entry.group === name ? { ...entry, group: renamed } : entry));
        }), button("解组", () => commit(assignGroup(node._stackEntries, members.map(entry => entry.id), ""))));
        header.style.display = members.some(entry => !node._aloraCatalog || node._aloraCatalog.matches(entry)) ? "" : "none";
        header.addEventListener("pointerdown", event => event.stopPropagation());
        header.addEventListener("mousedown", event => event.stopPropagation());
        header.addEventListener("keydown", event => event.stopPropagation());
        list.insertBefore(header, row);
      }
      previous = name;
      row.classList.toggle("alora-group-off", !!entry.group_off);
      if (name && folded.has(name)) { row.style.display = "none"; if (row.nextElementSibling?.classList.contains("alora-range-row")) row.nextElementSibling.style.display = "none"; }
      const nameButton = row.querySelector(".alora-name-btn");
      if (nameButton && !nameButton.dataset.hoverInfo) { nameButton.dataset.hoverInfo = "true"; hoverOn(nameButton, () => entry.name); }
      const found = resolveName(entry.name, node._loraOptions || []);
      row.classList.toggle("alora-file-missing", ["missing", "ambiguous"].includes(found.status));
      row.classList.toggle("alora-file-moved", found.status === "moved");
      if (found.status !== "exact" && found.status !== "empty") nameButton.title = found.status === "moved" ? `文件已移动，将使用：${found.name}；点击「检查 / 找回文件」更新记录` : `文件${found.status === "ambiguous" ? "同名不唯一" : "缺失"}：${entry.name}`;
    }
    master.textContent = (node._stackEntries || []).some(rowActive) ? "停用全部" : node.properties.allbuyLoraMaster ? "恢复原启用" : "启用全部";
    const widget = node.widgets?.find(widget => widget.name === "on_missing");
    if (widget) widget.value = normalizeMissingPolicy(widget.value);
    policy.value = normalizeMissingPolicy(widget?.value); policy.disabled = !widget;
    paintWeights();
  };
  const controller = { bar, decorateGroups, hoverOn, paintWeights, hide,
    contributesTrigger(entry) {
      const type = node.widgets?.find(widget => widget.name === "模型类型")?.value || node._modelType;
      const modelKey = type === "Checkpoint" ? "ckpt_name" : type === "GGUF" ? "gguf_name" : "unet_name";
      if (type === "None" || node.widgets?.find(widget => widget.name === modelKey)?.value === "None") return true;
      return policy.value !== "skip" || !["missing", "ambiguous"].includes(resolveName(entry.name, node._loraOptions || []).status);
    },
    destroy() { hide(); window.removeEventListener("allbuy-lora-data-changed", onData); } };
  node._aloraAdvanced = controller;
  return controller;
}
