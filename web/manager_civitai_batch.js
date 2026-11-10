import { modelKey } from "./manager_data.js";
import { civitaiNetworkPanel } from "./manager_civitai_network.js";

export function civitaiImportOptions({ el, input }, batch = false) {
  const node = el("fieldset", "abm-civitai-options"), grid = el("div", "abm-civitai-options-grid"), checks = new Map();
  node.append(el("legend", "abm-label", batch ? "获取后自动保存的字段" : "选择导入字段"));
  const option = (label, checked = true) => {
    const row = el("label", "abm-civitai-check"), check = input(label, "", "checkbox"); check.checked = checked;
    row.append(check, el("span", "", label)); return { row, check };
  };
  for (const [key, label] of [["info", "底模与版本"], ["trigger", "激活提示词"], ["rating", "内容评级"], ["recommendation", "推荐权重与区间"]]) {
    const { row, check } = option(label, key !== "recommendation"); checks.set(key, check); grid.append(row);
  }
  const fill = option("保留已手动设置的字段"), skip = option("跳过已获取来源信息的模型");
  node.append(grid, fill.row); if (batch) node.append(skip.row);
  node.append(el("p", "abm-muted", "不采集 C 站标签，分类标签由你自行管理；推荐权重仅在来源有明确建议时导入。"));
  return { node, checks, data: () => ({ fields: [...checks].filter(([, c]) => c.checked && !c.disabled).map(([key]) => key), fill_empty: fill.check.checked, skip_existing: skip.check.checked }) };
}

export function civitaiAuthPanel({ el, input, button, request }) {
  const panel = el("details", "abm-civitai-auth"), summary = el("summary", "", "连接与 API 授权"), status = el("span", "abm-muted", "正在读取配置…");
  summary.append(status); panel.append(summary);
  const key = input("C 站 API Key", "", "password"), row = el("div", "abm-civitai-source-row"), message = el("p", "abm-muted");
  key.autocomplete = "new-password"; key.spellcheck = false; message.setAttribute("role", "status");
  const link = el("a", "", "前往 C 站创建 API Key"); link.href = "https://civitai.com/user/account"; link.target = "_blank"; link.rel = "noopener noreferrer";
  const show = button("显示", () => { const visible = key.type === "password"; key.type = visible ? "text" : "password"; show.textContent = visible ? "隐藏" : "显示"; show.setAttribute("aria-pressed", String(visible)); });
  show.setAttribute("aria-label", "显示或隐藏 API Key"); show.setAttribute("aria-pressed", "false");
  const apply = state => { status.textContent = state.configured ? `密钥已配置 · ${state.source}` : "未配置密钥 · 使用公开接口"; };
  const update = async action => {
    save.disabled = clear.disabled = true; message.textContent = action === "save" ? "正在验证授权…" : "正在清除本地密钥…";
    try { apply(await request("/civitai/auth", { action, ...(action === "save" ? { api_key: key.value.trim() } : {}) })); key.value = ""; message.textContent = action === "save" ? "验证通过，密钥已保存在 ComfyUI 用户目录" : "本地密钥已清除；环境变量需在启动配置中移除"; }
    catch (error) { message.textContent = error.message; }
    finally { save.disabled = clear.disabled = false; }
  };
  const save = button("验证并保存", () => update("save")), clear = button("清除本地密钥", () => update("clear")), actions = el("div", "abm-detail-actions");
  row.append(key, show); actions.append(save, clear, link);
  panel.append(civitaiNetworkPanel({ el, input, button, request }), el("h4", "", "API Key（可选）"), el("p", "abm-muted", "先测试连接。密钥验证通过后保存在 ComfyUI 用户目录，不会随模型信息导出。"), row, actions, message);
  request("/civitai/auth").then(apply).catch(() => { status.textContent = "无法读取授权配置"; });
  return panel;
}

export async function fetchCivitaiBatch(h, tools) {
  const { el, button, input, field, select, request } = tools;
  const body = el("div", "abm-modal-fields abm-civitai-import abm-civitai-batch"), options = civitaiImportOptions(tools, true);
  const scopes = { selected: h.selected().map(i => i.name), filtered: h.filtered().map(i => i.name), all: h.items().filter(i => !h.contentHidden(i)).map(i => i.name) };
  const scope = select("获取范围", [["selected", `已勾选 · ${scopes.selected.length} 个`], ["filtered", `当前筛选结果 · ${scopes.filtered.length} 个`], ["all", `全部可见模型 · ${scopes.all.length} 个`]], scopes.selected.length ? "selected" : "filtered");
  const progress = el("progress", "abm-civitai-progress"), summary = el("p", ""), current = el("p", "abm-muted"), stats = el("div", "abm-civitai-stats"), results = el("div", "abm-civitai-results"), note = el("p", "abm-muted");
  progress.max = 1; progress.value = 0; progress.setAttribute("aria-label", "模型信息获取进度"); summary.setAttribute("role", "status");
  const fileProgress = el("progress", "abm-civitai-progress"), fileStatus = el("p", "abm-muted");
  fileProgress.setAttribute("aria-label", "当前模型文件读取进度"); fileProgress.hidden = fileStatus.hidden = true;
  const search = input("搜索任务中的模型或结果", "", "search"), filter = select("结果状态", [["all", "全部结果"], ["failed", "仅失败"], ["success", "仅成功"], ["skipped", "仅跳过"]], "all", () => renderResults());
  let job = null, timer, loading = true, pollError = "", initialized = false, lastResults = "", lastQuery = "", footerCaption = null;
  const active = () => ["running", "stopping"].includes(job?.status);
  function renderResults() {
    const query = search.value.trim().toLowerCase();
    const rows = (job?.results || []).filter(row => !h.contentHidden({id: row.name, name: row.name}) && (filter.value === "all" || row.status === filter.value) && `${row.name} ${row.reason}`.toLowerCase().includes(query));
    const displayed = rows.slice(-200).reverse(), queryKey = JSON.stringify([query, filter.value]);
    const signature = JSON.stringify([displayed, rows.length, rows.length ? "" : job?.status, rows.length ? "" : job?.error]);
    if (signature === lastResults && queryKey === lastQuery) return;
    const scroll = results.scrollTop, top = results.getBoundingClientRect().top;
    const anchor = scroll > 0 && queryKey === lastQuery ? [...results.children].find(node => node.dataset.model && node.getBoundingClientRect().bottom > top) : null;
    const anchorName = anchor?.dataset.model, anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    results.replaceChildren();
    for (const row of displayed) {
      const node = el("div", "abm-civitai-result"), text = el("div"), status = el("span", `abm-civitai-result-status is-${row.status}`, {success: "成功", failed: "失败", skipped: "跳过"}[row.status]);
      node.dataset.model = row.name;
      const name = el("strong", "", row.name), reason = el("p", "abm-muted", row.reason);
      name.title = row.name; reason.title = row.reason;
      text.append(name, reason); node.append(status, text); results.append(node);
    }
    if (!rows.length) {
      const empty = el("div", "abm-civitai-empty");
      const title = !job ? "还没有获取任务" : active() ? "正在处理模型" : job.error ? "连接检测未通过" : job.status === "cancelled" ? "任务已停止" : "没有匹配的结果";
      const detail = !job ? "选择获取范围与导入字段后，点击开始获取。" : active() ? "文件读取和网络进度会显示在上方，结果完成后逐项列出。" : job.error ? "展开连接与授权设置，测试连接后可重新开始。" : job.status === "cancelled" && !job.results.length ? "尚未保存新信息，可重新开始处理剩余模型。" : "调整搜索或结果状态，查看其他记录。";
      empty.append(el("strong", "", title), el("p", "abm-muted", detail)); results.append(empty);
    }
    note.textContent = rows.length > 200 ? `匹配 ${rows.length} 项，显示最近 200 项；可搜索具体模型。` : `显示 ${rows.length} 项结果。`;
    results.scrollTop = queryKey === lastQuery ? scroll : 0;
    const replacement = anchorName && [...results.children].find(node => node.dataset.model === anchorName);
    if (replacement) results.scrollTop += replacement.getBoundingClientRect().top - results.getBoundingClientRect().top - anchorOffset;
    lastResults = signature; lastQuery = queryKey;
  }
  function draw() {
    const running = active(); scope.disabled = loading || running;
    options.node.querySelectorAll("input").forEach(c => { c.disabled = loading || running; });
    start.disabled = loading || running; stop.disabled = loading || !running || job.status === "stopping"; retry.disabled = loading || running || !job?.failed;
    start.title = running ? "当前任务结束或停止后即可开始新任务" : "按所选范围批量获取模型信息";
    stop.textContent = job?.status === "stopping" ? "正在停止…" : "停止任务";
    stats.replaceChildren();
    for (const [key, label] of [["success", "成功"], ["failed", "失败"], ["skipped", "跳过"]]) { const cell = el("div", "is-" + key); cell.classList.toggle("has-value", !!job?.[key]); cell.append(el("strong", "", String(job?.[key] || 0)), el("span", "abm-muted", label)); stats.append(cell); }
    progress.max = job?.total || 1; progress.value = job?.processed || 0;
    summary.textContent = job ? `${job.phase} · ${job.processed}/${job.total} · ${Math.round(job.processed / job.total * 100)}%` : loading ? "正在读取上次任务…" : "选择范围和字段后，点击开始获取";
    const seconds = Math.max(0, Math.ceil((job?.retry_at || 0) - Date.now() / 1000));
    current.textContent = pollError || job?.error || (job?.current ? `${h.contentHidden({id: job.current, name: job.current}) ? "当前模型已按内容设置隐藏" : job.current}${seconds ? ` · ${seconds} 秒后重试` : ""}` : job?.status === "cancelled" ? `还有 ${job.total - job.processed} 项未处理` : job?.status === "complete" ? "获取已结束，成功项已保存；失败项可单独重试。" : "按所选字段逐项保存，默认保留已手动设置的内容。");
    if (footerCaption) footerCaption.textContent = running ? "关闭窗口后任务继续，可重新打开查看进度。" : "任务记录保留至 ComfyUI 重启，已保存的信息持续保留。";
    current.classList.toggle("abm-error", !!(pollError || job?.error));
    current.title = current.textContent;
    fileProgress.hidden = fileStatus.hidden = !(running && job?.bytes_total > 0);
    if (!fileProgress.hidden) {
      fileProgress.max = job.bytes_total; fileProgress.value = job.bytes_done;
      const size = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
      fileStatus.textContent = `当前文件：${size(job.bytes_done)} / ${size(job.bytes_total)} · ${Math.round(job.bytes_done / job.bytes_total * 100)}%`;
    }
    renderResults();
  }
  async function poll() {
    try { job = (await request("/lora_source/batch/state")).job; pollError = ""; }
    catch (error) { pollError = error.message + "；可重新打开窗口查看任务"; }
    if (!initialized) { settings.open = wide() || !job; initialized = true; }
    loading = false; draw();
    if (body.isConnected && (active() || pollError)) timer = setTimeout(poll, 1000);
  }
  async function begin(failedOnly = false) {
    const data = options.data();
    clearTimeout(timer); loading = true; draw();
    try {
      const models = failedOnly ? job.results.filter(row => row.status === "failed" && !h.contentHidden({id: row.name, name: row.name})).map(row => row.name) : scopes[scope.value];
      job = (await request("/lora_source/batch/start", { models, ...data, ...(failedOnly ? {skip_existing: false} : {}) })).job;
      pollError = ""; if (!wide()) settings.open = false;
    } catch (error) { pollError = error.message; }
    finally { loading = false; draw(); if (body.isConnected && active()) timer = setTimeout(poll, 600); }
  }
  const start = button("开始获取", () => begin(), "abm-primary"), retry = button("重试失败项", () => begin(true)), stop = button("停止任务", async () => {
    stop.disabled = true;
    try { job = (await request("/lora_source/batch/cancel", {id: job.id})).job; draw(); }
    catch (error) { pollError = error.message; draw(); }
  });
  const toolbar = el("div", "abm-civitai-source-row"), state = el("section", "abm-civitai-task-state"), resultBar = el("div", "abm-civitai-source-row");
  toolbar.append(scope, start); state.append(summary, progress, stats, current, fileStatus, fileProgress);
  const actions = el("div", "abm-detail-actions"); actions.append(stop, retry); resultBar.append(search, filter); search.addEventListener("input", renderResults);
  const settings = el("details", "abm-civitai-settings"); settings.open = true;
  settings.append(el("summary", "", "字段与连接设置"), options.node, civitaiAuthPanel(tools));
  const content = el("div", "abm-civitai-content abm-civitai-job-pane"), resultHeading = el("div", "abm-civitai-result-heading");
  resultHeading.append(el("h3", "", "获取记录"), note);
  content.append(field("获取范围", toolbar), state, actions, resultHeading, resultBar, results);
  body.classList.add("abm-civitai-layout"); body.append(content, settings);
  const wide = () => window.matchMedia("(min-width: 901px)").matches;
  draw();
  const modal = h.modal("C 站批量获取与进度", body, async () => {}, "关闭");
  const dialog = body.closest("form"); dialog.classList.add("abm-civitai-dialog");
  const footer = dialog.querySelector(".abm-modal-footer"); footer.firstElementChild.style.display = "none";
  footerCaption = el("span", "abm-muted abm-modal-caption", "任务记录保留至 ComfyUI 重启，已保存的信息持续保留。"); footer.prepend(footerCaption);
  poll();
  try { await modal; }
  finally {
    clearTimeout(timer);
    try {
      h.catalog = await request("/lora_catalog");
      for (const [name, draft] of h.drafts) { const trigger = h.catalog.triggers?.[modelKey(name)]; if (trigger !== undefined) draft.trigger = trigger; }
      h.changedLoras();
    } catch (error) { h.report(error.message, true); }
  }
}
