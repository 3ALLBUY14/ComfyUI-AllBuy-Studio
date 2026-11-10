export async function editLoRATags(h, names, { el, button, input, request }) {
  h.catalog = await request("/lora_catalog");
  const body = el("div", "abm-modal-fields abm-model-tag-editor"), toolbar = el("div", "abm-tag-edit-toolbar");
  const search = input("搜索 LoRA 标签", "", "search"), list = el("div", "abm-tag-choice-grid"), summary = el("p", "abm-muted");
  const message = el("p", "abm-error"), newName = input("新标签名称（可用逗号分隔）"), createRow = el("div", "abm-tag-create");
  summary.setAttribute("role", "status"); message.setAttribute("role", "alert");
  let selectedOnly = false;
  const rows = h.catalog.tags.map(tag => ({ tag, count: names.filter(name => h.catalog.models[name.replaceAll("\\", "/")]?.includes(tag)).length, changed: false, fresh: false }));
  const visible = row => row.tag.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()) && (!selectedOnly || row.check.checked || row.check.indeterminate);
  const update = () => {
    for (const row of rows) {
      row.node.classList.toggle("is-selected", row.check.checked); row.node.classList.toggle("is-mixed", row.check.indeterminate);
      row.status.textContent = row.fresh ? "待新建并添加" : row.changed ? row.check.checked ? `保存后全部关联 · 原 ${row.count}/${names.length}` : `保存后全部移除 · 原 ${row.count}/${names.length}` : `${row.count === names.length ? "全部关联" : row.count ? "部分关联" : "未关联"} · ${row.count}/${names.length} 个模型`;
    }
    summary.textContent = `${names.length} 个模型 · ${rows.filter(row => row.check.checked).length} 个共同标签 · ${rows.filter(row => row.check.indeterminate).length} 个部分标签 · ${rows.filter(row => row.changed).length} 项待修改`;
  };
  const prepare = row => {
    row.check = input(row.tag, "", "checkbox"); row.check.checked = row.count === names.length; row.check.indeterminate = row.count > 0 && row.count < names.length;
    row.node = el("label", "abm-tag-choice");
    const text = el("span", "abm-tag-choice-text"); row.status = el("span", "abm-muted"); text.append(el("strong", "", row.tag), row.status);
    row.node.append(row.check, text);
    row.check.addEventListener("change", () => { row.changed = true; update(); if (selectedOnly) draw(); });
  };
  const draw = () => {
    list.replaceChildren(); rows.filter(visible).forEach(row => list.appendChild(row.node));
    if (!list.childElementCount) list.appendChild(el("p", "abm-muted", "没有匹配标签，可在下方新建")); update();
  };
  rows.forEach(prepare);
  const only = button("仅看已关联", () => { selectedOnly = !selectedOnly; only.setAttribute("aria-pressed", String(selectedOnly)); draw(); }); only.setAttribute("aria-pressed", "false");
  const batch = checked => { rows.filter(visible).forEach(row => { row.check.checked = checked; row.check.indeterminate = false; row.changed = true; }); draw(); };
  toolbar.append(only, button("选中搜索结果", () => batch(true)), button("取消搜索结果", () => batch(false)), button("重置修改", () => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].fresh) rows.splice(i, 1);
    rows.forEach(row => { row.check.checked = row.count === names.length; row.check.indeterminate = row.count > 0 && row.count < names.length; row.changed = false; }); draw();
  }));
  const create = button("新建并选中", () => {
    const values = [...new Set(newName.value.split(/[,，;；]/).map(value => value.trim()).filter(Boolean))];
    if (!values.length || values.some(value => value.length > 64 || /[\x00-\x1f]/.test(value))) { message.textContent = "请输入 1～64 字的标签名称"; return; }
    for (const tag of values) {
      let row = rows.find(row => row.tag.toLocaleLowerCase() === tag.toLocaleLowerCase());
      if (!row) { row = { tag, count: 0, fresh: true }; prepare(row); rows.push(row); }
      row.changed = true; row.check.checked = true; row.check.indeterminate = false;
    }
    newName.value = ""; search.value = ""; message.textContent = ""; draw();
  });
  newName.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); create.click(); } });
  search.addEventListener("input", draw); createRow.append(newName, create);
  body.append(summary, search, toolbar, list, createRow, message, el("p", "abm-muted", "部分关联的标签保持原样；勾选为全部添加，取消为全部移除。保存后生效。")); draw();
  await h.modal(`编辑 ${names.length} 个 LoRA 的标签`, body, async () => {
    const changed = rows.filter(row => row.changed);
    if (changed.length) await h.catalogAction({ action: "patch_tags", models: names, create: changed.filter(row => row.fresh && row.check.checked).map(row => row.tag), add: changed.filter(row => row.check.checked).map(row => row.tag), remove: changed.filter(row => !row.fresh && !row.check.checked).map(row => row.tag) });
  });
}

export async function editLoRARecommendation(h, item, { el, button, input, field, select, request, modelKey }) {
  const model = modelKey(item.name), saved = h.catalog.recommendations?.[model], value = h.catalog.recommended_weights?.[model] ?? 1;
  const body = el("div", "abm-modal-fields abm-recommendation-editor"), row = el("div", "abm-recommendation-numbers");
  const low = input("推荐下限", saved?.min ?? value, "number"), high = input("推荐上限", saved?.max ?? value, "number"), normal = input("默认推荐权重", saved?.default ?? value, "number");
  for (const control of [low, high, normal]) { control.step = "any"; control.min = "-3"; control.max = "3"; control.required = true; }
  const url = input("来源版本链接（留空按文件匹配）", saved?.url || ""), message = el("p", "abm-muted"), evidence = el("pre", "abm-recommendation-evidence");
  let record = { ...saved };
  evidence.textContent = saved?.evidence || "读取来源后，这里显示作者说明；不会自动覆盖当前设置。";
  message.setAttribute("role", "status");
  const draw = () => { low.closest("label").hidden = high.closest("label").hidden = type.value !== "range"; row.classList.toggle("is-single", type.value !== "range"); };
  const type = select("推荐类型", [["single", "单一权重"], ["range", "推荐区间"]], saved && saved.min !== saved.max ? "range" : "single", draw);
  const fetch = button("从 C 站获取", async () => {
    body.dataset.busy = "true"; fetch.disabled = true; message.classList.remove("abm-error"); message.textContent = "正在匹配模型和读取来源说明，首次文件哈希计算可能需要一些时间…";
    try {
      const result = await request("/lora_recommendation/fetch", { model, url: url.value.trim() });
      record = result.recommendation; url.value = record.url;
      evidence.textContent = record.evidence || "来源未提供权重说明";
      message.textContent = `${record.source} · ${record.version} · ${record.matchedBy}` + (record.notice ? " · " + record.notice : " · 已填入候选值，请核对后保存");
      if (Number.isFinite(record.min)) { low.value = record.min; high.value = record.max; normal.value = record.default; type.value = record.min === record.max ? "single" : "range"; draw(); }
    } catch (error) { message.textContent = error.message; message.classList.add("abm-error"); }
    finally { body.dataset.busy = "false"; fetch.disabled = false; }
  });
  const source = el("div", "abm-recommendation-source"); source.append(url, fetch);
  row.append(field("下限", low), field("上限", high), field("默认应用值", normal));
  body.append(field("推荐类型", type), row, el("p", "abm-muted", "区间为推荐参考；默认值须在区间内。本次应用可独立调整。"), field("来源（目前支持 Civitai 版本链接）", source), message, evidence);
  draw();
  await h.modal("推荐权重与来源 · " + item.name.split(/[\\/]/).pop(), body, async () => {
    if (body.dataset.busy === "true") throw new Error("请等待来源读取完成后再保存");
    const min = type.value === "range" ? low.valueAsNumber : normal.valueAsNumber, max = type.value === "range" ? high.valueAsNumber : normal.valueAsNumber, weight = normal.valueAsNumber;
    if (![min, max, weight].every(Number.isFinite) || min < -3 || max > 3 || min > weight || weight > max) throw new Error("请填写 -3～3 的有效区间，默认值须在区间内");
    const sameSource = url.value.trim() === (record.url || ""), modified = record.source && (min !== record.min || max !== record.max || weight !== record.default);
    const recommendation = { min, max, default: weight, url: url.value.trim(), source: !sameSource ? "手动" : modified ? "手动调整" : record.source || "手动", evidence: sameSource ? record.evidence || "" : "", version: sameSource ? record.version || "" : "", matchedBy: sameSource ? record.matchedBy || "" : "" };
    if (sameSource && record.content) recommendation.content = record.content;
    if (sameSource && record.base_model) recommendation.base_model = record.base_model;
    const data = await request("/lora_catalog/update", { action: "set_recommendation", model, recommendation });
    h.catalog.recommendations = data.recommendations; h.catalog.recommended_weights = data.recommended_weights;
    h.report("推荐区间与来源已保存");
  });
}
