import { workflowTags } from "./workflow_library.js";

export async function manageWorkflowTags(w) {
  const { host: h, el, input, button } = w, body = el("div", "abm-modal-fields abm-workflow-tag-manager");
  const name = input("新标签名称"), search = input("搜索工作流标签", "", "search"), list = el("div", "abm-tag-manager-list"), message = el("div", "abm-muted");
  const createRow = el("div", "abm-tag-create"); message.setAttribute("role", "status");
  let busy = false, pasting = false;
  const perform = async (action, tag, replacement) => {
    if (busy || pasting) return;
    busy = true; body.dataset.busy = "true";
    const form = body.closest("form"); form?.querySelectorAll("input,button").forEach(node => { node.disabled = true; });
    try {
      await w.library.tagAction(action, tag, replacement);
      for (const [path, draft] of w.drafts) {
        const values = draft.tags.split(/[,，;；]/).map(value => value.trim()).filter(Boolean);
        if (action !== "create" && values.includes(tag)) draft.tags = [...new Set(values.flatMap(value => value === tag ? action === "rename" ? [replacement.trim()] : [] : [value]))].join(", ");
      }
      if (h.filter === "tag:" + tag && action !== "create") h.filter = action === "rename" ? "tag:" + replacement.trim() : "";
      name.value = ""; message.textContent = "已保存"; message.classList.remove("abm-error"); draw();
    } catch (error) { message.textContent = error.message; message.classList.add("abm-error"); }
    finally { busy = false; body.dataset.busy = "false"; form?.querySelectorAll("input,button").forEach(node => { node.disabled = false; }); }
  };
  const paste = button("", async () => {
    if (busy || pasting) return;
    pasting = true; paste.disabled = true; paste.setAttribute("aria-busy", "true");
    try {
      const text = await navigator.clipboard.readText(); if (!body.isConnected) return;
      if (text) { name.setRangeText(text, name.selectionStart ?? name.value.length, name.selectionEnd ?? name.value.length, "end"); name.dispatchEvent(new Event("input", { bubbles: true })); message.textContent = "已粘贴"; }
      else message.textContent = "剪贴板中没有文字";
      message.classList.remove("abm-error"); name.focus();
    } catch {
      if (body.isConnected) { message.textContent = "无法读取剪贴板，请在输入框中按 Ctrl+V 粘贴。"; message.classList.add("abm-error"); name.focus(); }
    } finally { pasting = false; paste.disabled = false; paste.removeAttribute("aria-busy"); }
  }, "abm-icon-button abm-tag-paste");
  paste.title = "粘贴标签名称"; paste.setAttribute("aria-label", "粘贴标签名称");
  paste.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="6" y="2" width="8" height="4" rx="1"/><path d="M6 4H4v14h12V4h-2M7 10h6M7 13h6"/></svg>';
  const nameBox = el("div", "abm-tag-name-input"); nameBox.append(name, paste);
  const create = button("＋ 新建标签", () => perform("create", name.value.trim())); createRow.append(nameBox, create);
  const draw = () => {
    list.replaceChildren();
    for (const tag of workflowTags(w.library.metadata).filter(tag => tag.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))) {
      const row = el("div", "abm-tag-manager-row"), count = w.items.filter(item => w.meta(item).tags?.includes(tag)).length;
      const actions = el("div", "abm-workflow-tag-actions");
      actions.append(el("span", "abm-muted", `${count} 个工作流`),
        button("重命名", () => { const value = prompt("标签的新名称：", tag); if (value?.trim() && value.trim() !== tag) perform("rename", tag, value.trim()); }),
        button("删除", () => { if (confirm(`删除标签「${tag}」并解除关联？工作流文件会保留。`)) perform("delete", tag); }));
      row.append(el("span", "abm-tag-name", tag), actions);
      list.appendChild(row);
    }
    if (!list.childElementCount) list.appendChild(el("p", "abm-muted", "没有匹配的标签"));
  };
  search.addEventListener("input", draw);
  name.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); create.click(); } });
  body.append(createRow, search, message, list); draw(); await h.modal("管理工作流标签", body, async () => {}, "完成");
}

export async function editWorkflowTags(w, items) {
  const { host: h, el, input, field } = w, body = el("div", "abm-modal-fields"), rows = [];
  for (const tag of workflowTags(w.library.metadata)) {
    const check = input(tag, "", "checkbox"), count = items.filter(item => w.meta(item).tags?.includes(tag)).length;
    check.checked = count === items.length; check.indeterminate = count > 0 && count < items.length;
    const row = { tag, check, changed: false }; check.addEventListener("change", () => { row.changed = true; }); rows.push(row);
    body.appendChild(field(tag + (check.indeterminate ? "（部分工作流）" : ""), check));
  }
  if (!rows.length) body.appendChild(el("p", "abm-muted", "暂无标签，可填写新标签，或通过「管理标签」创建。"));
  const extra = input("新增标签（逗号分隔）"); body.appendChild(field("新增标签", extra));
  await h.modal(`编辑 ${items.length} 个工作流的标签`, body, async () => {
    const add = [...rows.filter(row => row.changed && row.check.checked).map(row => row.tag), ...extra.value.split(/[,，;；]/).map(value => value.trim()).filter(Boolean)];
    await w.library.patchTags(items.map(item => item.path), add, rows.filter(row => row.changed && !row.check.checked).map(row => row.tag));
    for (const item of items) { const draft = w.drafts.get(item.path); if (draft) draft.tags = (w.meta(item).tags || []).join(", "); }
    h.report("工作流标签已更新");
  });
}
