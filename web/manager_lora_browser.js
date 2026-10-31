import { modelKey, modelInfo, normalizeLoraFilters, normalizeLoraFilterPresets } from "./manager_data.js";

export async function editModelInfo(h, item, { el, input, field, request }) {
  const info = modelInfo(item.name, h.catalog, h.previews), body = el("div", "abm-modal-fields");
  const base = input("底模名称", info.base_model), version = input("模型版本", info.version), auto = input("恢复自动读取", "", "checkbox");
  base.maxLength = version.maxLength = 200;
  body.append(field("底模", base), field("版本", version), field("恢复自动读取（清除手动填写）", auto), el("p", "abm-muted", "来源：" + info.source + "。未填写的信息不会按文件夹名猜测；可从推荐设置读取 C 站版本信息。"));
  await h.modal("底模与版本 · " + item.name.split(/[\\/]/).pop(), body, async () => {
    const result = await request("/lora_catalog/update", { action: "set_model_info", model: item.name, info: auto.checked ? null : { base_model: base.value.trim(), version: version.value.trim() } });
    h.catalog.model_info = result.model_info || {}; h.changedLoras(); h.report("底模与版本信息已保存");
  });
}

export async function editLoraFilters(h, { el, button, input, field, select, uid, savePreferences }) {
  const body = el("div", "abm-modal-fields abm-lora-filter-editor"), presetsRow = el("div", "abm-filter-preset-row");
  const presets = normalizeLoraFilterPresets(h.loraFilterPresets), name = input("筛选预设名称"), message = el("p", "abm-muted");
  const query = input("搜索模型、底模、版本", h.search.value, "search"), version = input("版本关键词", h.loraFilters.version, "search");
  const sorting = select("预设排序", [["manual", "原始顺序"], ["name", "名称 A → Z"], ["desc", "名称 Z → A"], ["favorite", "收藏优先"], ["updated", "最近更新"]], h.sort);
  const logic = select("包含标签的匹配方式", [["any", "包含任一标签"], ["all", "包含全部标签"]], h.loraFilters.tagMode);
  const bases = el("div", "abm-base-choices"), tags = el("div", "abm-filter-tag-list"), baseChecks = new Map();
  let draft = normalizeLoraFilters(h.loraFilters), scope = h.filter, chosen = "", presetSelect;
  message.setAttribute("role", "status");
  const scopeLabel = filter => filter.startsWith("group:") ? h.groups.find(group => group.id === filter.slice(6))?.name || "原分组已不存在" : filter.startsWith("folder:") ? filter.slice(7) : filter.startsWith("tag:") ? "标签：" + filter.slice(4) : ({ "": "全部模型", favorite: "我的收藏", untagged: "未分类", "content:nsfw": "NSFW 模型", "content:sfw": "SFW 模型", "content:unknown": "未评级模型" })[filter] || "全部模型";
  const range = el("p", "abm-muted");
  const collect = () => ({ advanced: normalizeLoraFilters({ ...draft, bases: [...baseChecks].filter(([, check]) => check.checked).map(([base]) => base), version: version.value.trim(), tagMode: logic.value }), query: query.value, filter: scope, sort: sorting.value });
  const draw = () => {
    range.textContent = "分类范围：" + scopeLabel(scope); bases.replaceChildren(); baseChecks.clear(); tags.replaceChildren();
    const values = new Set([...draft.bases, ...h.items().filter(item => !h.contentHidden(item)).map(item => modelInfo(item.name, h.catalog, h.previews).base_model)]);
    for (const base of [...values].sort((a, b) => a.localeCompare(b))) {
      const check = input("筛选底模 " + (base || "未填写"), "", "checkbox"); check.checked = draft.bases.includes(base); baseChecks.set(base, check); bases.appendChild(field(base || "未填写底模", check));
    }
    for (const tag of [...new Set([...h.catalog.tags, ...draft.includeTags, ...draft.excludeTags])].sort()) {
      const row = el("div", "abm-filter-tag-row"), include = button("包含", () => toggle("includeTags", "excludeTags")), exclude = button("排除", () => toggle("excludeTags", "includeTags"));
      include.setAttribute("aria-label", "包含标签 " + tag); exclude.setAttribute("aria-label", "排除标签 " + tag);
      const state = () => { include.setAttribute("aria-pressed", String(draft.includeTags.includes(tag))); exclude.setAttribute("aria-pressed", String(draft.excludeTags.includes(tag))); };
      const toggle = (key, opposite) => { draft[key] = draft[key].includes(tag) ? draft[key].filter(value => value !== tag) : [...draft[key], tag]; draft[opposite] = draft[opposite].filter(value => value !== tag); state(); };
      row.append(el("span", "abm-filter-tag-name", tag), include, exclude); state(); tags.appendChild(row);
    }
    if (!tags.childElementCount) tags.appendChild(el("p", "abm-muted", "暂无标签，可先通过管理标签创建"));
  };
  const drawPresets = () => {
    presetSelect = select("筛选预设", [["", "选择已保存预设"], ...presets.map(row => [row.id, row.name])], chosen, id => {
      chosen = id; const preset = presets.find(row => row.id === id); if (!preset) return;
      draft = normalizeLoraFilters(preset.advanced); query.value = preset.query; version.value = draft.version; sorting.value = preset.sort; logic.value = draft.tagMode; scope = preset.filter; name.value = preset.name; draw();
    }); presetsRow.replaceChildren(presetSelect);
  };
  const perform = action => {
    const title = name.value.trim(), found = presets.find(row => row.id === chosen);
    if (action !== "delete" && (!title || title.length > 50)) { message.textContent = "请填写 1～50 字的预设名称"; return; }
    if (action !== "delete" && presets.some(row => row.name === title && (action === "create" || row.id !== chosen))) { message.textContent = "已有同名预设，请选择后覆盖或改用其他名称"; return; }
    if (action === "create") { if (presets.length >= 30) { message.textContent = "最多保存 30 个筛选预设"; return; } chosen = uid(); presets.push({ id: chosen, name: title, ...collect() }); }
    else if (!found) { message.textContent = "请先选择预设"; return; }
    else if (action === "delete") { presets.splice(presets.indexOf(found), 1); chosen = ""; name.value = ""; }
    else if (action === "rename") found.name = title;
    else Object.assign(found, collect(), { name: title });
    message.textContent = "预设修改待保存，点击应用后生效"; drawPresets();
  };
  drawPresets();
  const presetActions = el("div", "abm-filter-preset-actions");
  presetActions.append(name, button("新建预设", () => perform("create")), button("覆盖", () => perform("overwrite")), button("重命名", () => perform("rename")), button("删除", () => perform("delete")));
  const fields = el("div", "abm-filter-fields"); fields.append(field("搜索", query), field("版本关键词", version), field("排序", sorting), field("包含标签的匹配方式", logic));
  body.append(presetsRow, presetActions, message, range, fields, el("div", "abm-section-label", "底模（不勾选表示不限）"), bases, el("div", "abm-section-label", "标签 · 排除优先"), tags,
    button("清除本次筛选条件", () => { draft = normalizeLoraFilters(); scope = ""; query.value = version.value = ""; logic.value = "any"; draw(); }), el("p", "abm-muted", "预设与筛选修改均在点击应用后保存到当前浏览器；内容显示模式保持当前设置。")); draw();
  await h.modal("高级筛选与预设", body, async () => {
    const data = collect(); h.loraFilters = data.advanced; h.loraFilterPresets = normalizeLoraFilterPresets(presets); h.search.value = data.query; h.filter = data.filter; h.sort = data.sort; h.sortSelect.value = h.sort; h.limit = 80;
    h.selection.clear(); h.list.scrollTop = 0;
    savePreferences({ loraFilters: h.loraFilters, loraFilterPresets: h.loraFilterPresets }); h.report("高级筛选已应用");
  }, "应用");
}

export async function showLoraDuplicates(h, { el, button, field, select, request, copy, savePreferences }) {
  const body = el("div", "abm-modal-fields abm-duplicate-browser"), message = el("p", "abm-muted", "按大小分组后计算完整 SHA256；模型文件保持原样。"), progress = el("progress"), results = el("div", "abm-duplicate-results"), controls = el("div", "abm-filter-preset-actions");
  message.setAttribute("role", "status"); progress.max = 1; progress.value = 0; progress.setAttribute("aria-label", "查重进度");
  const scope = select("查重范围", [["all", "所有可见模型"], ["current", "当前筛选结果"]], "all");
  let timer, closed = false, pending = false, target;
  const error = failure => { message.textContent = failure.message; message.classList.add("abm-error"); };
  const draw = job => {
    const running = job.status === "running"; start.disabled = running; cancel.disabled = !running; scope.disabled = running;
    progress.max = job.total || 1; progress.value = job.processed || 0;
    message.textContent = `${({ running: "检测中", complete: "检测完成", cancelled: "已取消", error: "检测失败" })[job.status] || job.status} · ${job.phase || ""} · ${job.processed}/${job.total} 个候选文件 · 范围 ${job.scope} 项`;
    if (job.error) message.textContent += " · " + job.error;
    results.replaceChildren(); let count = 0;
    for (const group of job.groups || []) {
      const available = new Map(h.models.map(name => [modelKey(name), name]));
      const names = group.models.map(name => available.get(modelKey(name))).filter(name => name && !h.contentHidden({ name })); if (names.length < 2) continue; count++;
      const box = el("section", "abm-duplicate-group"); box.append(el("strong", "", `${names.length} 份相同内容 · ${(group.size / 1024 / 1024).toFixed(2)} MB / 份`), el("p", "abm-model-path", group.sha256));
      for (const name of names) {
        const row = el("div", "abm-duplicate-row"); row.append(el("span", "", name), button("复制路径", () => copy(name).catch(error)), button("定位模型", () => { target = name; body.closest("form").requestSubmit(); })); box.appendChild(row);
      }
      results.appendChild(box);
    }
    if (job.status === "complete" && !count) results.appendChild(el("p", "abm-muted", "未发现相同内容的可见模型"));
    if (job.skipped?.length) results.appendChild(el("p", "abm-muted", `跳过 ${job.skipped.filter(row => h.models.some(name => modelKey(name) === modelKey(row.name)) && !h.contentHidden({ name: row.name })).length} 个不可读或已变化文件，可刷新后重新检测`));
    if (!running) clearTimeout(timer);
  };
  const poll = async () => {
    if (closed || pending || !h.duplicateJob) return;
    pending = true;
    try { const data = await request("/lora_duplicates/state?id=" + encodeURIComponent(h.duplicateJob)); if (closed) return; draw(data.job); if (data.job.status === "running") timer = setTimeout(poll, 800); }
    catch (failure) { if (!closed) { error(failure); start.disabled = false; cancel.disabled = true; scope.disabled = false; } }
    finally { pending = false; }
  };
  const start = button("开始 / 重新检测", async () => {
    start.disabled = true; message.classList.remove("abm-error");
    const items = scope.value === "current" ? h.filtered() : h.items().filter(item => !h.contentHidden(item));
    try {
      const data = await request("/lora_duplicates/start", { models: items.map(item => item.name) });
      h.duplicateJob = data.job.id; savePreferences({ duplicateJob: h.duplicateJob }); if (closed) { if (h.root.isConnected && !h.busy && h.tab === "loras") h.renderActions(); return; }
      draw(data.job); if (data.job.status === "running") timer = setTimeout(poll, 800);
    } catch (failure) { if (!closed) { error(failure); start.disabled = false; } }
  });
  const cancel = button("取消检测", async () => {
    if (!h.duplicateJob) return;
    cancel.disabled = true;
    try { await request("/lora_duplicates/cancel", { id: h.duplicateJob }); if (!closed) { message.textContent = "正在取消检测…"; clearTimeout(timer); timer = setTimeout(poll, 300); } }
    catch (failure) { if (!closed) error(failure); }
  }); cancel.disabled = true;
  controls.append(start, cancel); body.append(field("检测范围", scope), controls, progress, message, results, el("p", "abm-muted", "可关闭窗口继续检测，稍后通过“查看查重结果”返回。定位仅查看模型，不会应用到工作流。"));
  const done = h.modal("模型重复检测", body, async () => { if (target) { h.loraFilters = normalizeLoraFilters(); h.filter = ""; h.search.value = target; h.focused = target; h.limit = 80; h.list.scrollTop = 0; savePreferences({ loraFilters: h.loraFilters }); } }, "完成");
  if (h.duplicateJob) poll();
  try { await done; } finally { closed = true; clearTimeout(timer); }
}
