export const workflowTabPath = file => String(file.path || "").replaceAll("\\", "/").replace(/^workflows\//, "");
export function openedWorkflowTabs(app, items) {
  const paths = new Set(items.map(item => item.path));
  return (app.extensionManager?.workflow?.openWorkflows || []).filter(file => paths.has(workflowTabPath(file)));
}

export async function saveAndCloseWorkflowTabs(app, items, { report = () => {}, loadGraph = (...args) => app.loadGraphData(...args) } = {}) {
  const store = app.extensionManager?.workflow, files = openedWorkflowTabs(app, items);
  if (!files.length) return 0;
  if (typeof store.saveWorkflow !== "function" || typeof store.closeWorkflow !== "function" || typeof app.loadGraphData !== "function") throw new Error("当前 ComfyUI 不支持快捷保存关闭，请更新前端或手动保存关闭页签");
  // Finish every save before closing any tab; a failed write must leave drafts open.
  for (const [index, file] of files.entries()) {
    if (file.isTemporary) throw new Error("请先为临时工作流另存文件，再移动");
    const path = file.path; report(`正在保存工作流 ${index + 1}/${files.length}…`);
    await file.changeTracker?.prepareForSave();
    if (await store.saveWorkflow(file) === false || file.isModified || file.path !== path) throw new Error("工作流未能保存到原位置，已停止关闭和移动");
  }
  const active = store.activeWorkflow;
  if (active && files.some(file => file.path === active.path)) {
    const closing = new Set(files.map(file => file.path));
    const next = store.openWorkflows.find(file => !closing.has(file.path));
    let data = { nodes: [], links: [], groups: [], config: {}, extra: {}, version: .4 };
    if (next) { if (!next.isLoaded) await next.load(); data = next.activeState; if (!data) throw new Error("其他工作流暂时无法载入，已保留当前页签"); }
    if (await loadGraph(JSON.parse(JSON.stringify(data)), true, true, next) === false) throw new Error("切换画布失败，已保留工作流页签");
  }
  let count = 0;
  for (const file of files) {
    if (file.isModified) throw new Error("工作流在保存后发生变化，已停止关闭，请重新保存");
    if (await store.closeWorkflow(file) === false || store.openWorkflows.some(open => open.path === file.path)) throw new Error(`已保存，已关闭 ${count} 个页签；其余页签未关闭，已停止移动`);
    count++;
  }
  return count;
}
