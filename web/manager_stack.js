import { validatePresetEntries, appendUniqueEntries, shortName, modelKey } from "./manager_data.js";
import { closeManagerPopup, showManagerContext } from "./manager_controls.js";

const SETTING_KEYS = ["模型类型", "ckpt_name", "unet_name", "gguf_name", "clip_name", "clip_type", "vae_name",
  "weight_dtype", "gguf_dequant_dtype", "gguf_patch_dtype", "gguf_patch_on_device"];
const entryId = () => "stack-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

export class ManagerStackEditor {
  constructor(host, controls) {
    this.host = host; Object.assign(this, controls);
    this.target = String(this.nodes().find(node => this.app.canvas?.selected_nodes?.[node.id])?.id || this.nodes()[0]?.id || "new");
    this.draft = this.empty(); this.dirty = false; this.initialized = false; this.loading = false; this.epoch = 0;
  }
  graph() { return this.app.canvas?.graph || this.app.graph; }
  nodes() { return (this.graph()?._nodes || []).filter(node => node.type === "AllBuyLoRAStack"); }
  empty() {
    const initial = (key, fallback = "None") => {
      const input = this.host.modelInfo?.input;
      const values = input?.required?.[key]?.[0] || input?.optional?.[key]?.[0];
      return Array.isArray(values) && values.length ? values[0] : fallback;
    };
    return { title: "AllBuy-LoRA 堆栈", entries: [], settings: { "模型类型": "UNET", ckpt_name: initial("ckpt_name"), unet_name: initial("unet_name"), gguf_name: initial("gguf_name"), clip_name: initial("clip_name"), clip_type: initial("clip_type", "stable_diffusion"), vae_name: initial("vae_name") } };
  }
  allowDiscard() { return !this.dirty || confirm("堆栈有未应用的修改，确定放弃？"); }
  changed() {
    this.dirty = true; this.host.report("堆栈草稿已修改，点击「应用到节点」保存到当前工作流");
    if (this.host.tab === "stacks") { this.host.subtitle.textContent = `${this.draft.entries.length} 条 LoRA · 未应用的草稿`; this.renderActions(); }
  }
  async loadTarget(target, force = false) {
    if (!force && !this.allowDiscard()) return;
    closeManagerPopup();
    const epoch = ++this.epoch;
    this.target = String(target); this.loading = true;
    this.loadError = false;
    if (this.host.tab === "stacks") { this.render(); this.renderSidebar(); this.renderActions(); }
    try {
      if (this.target === "new") { this.draft = this.empty(); this.baseline = null; }
      else {
        const graph = this.graph(), node = graph?.getNodeById(this.target);
        if (!node) throw new Error("堆栈节点已删除，请选择其他节点或新建");
        for (let i = 0; !node._allbuyManagerStack && i < 120; i++) await new Promise(resolve => setTimeout(resolve, 25));
        if (epoch !== this.epoch || !this.host.root.isConnected) return;
        if (!node._allbuyManagerStack || node.graph !== graph) throw new Error("堆栈尚未就绪，请刷新 ComfyUI");
        this.draft = node._allbuyManagerStack.snapshot();
        this.baseline = JSON.stringify(this.draft);
      }
      if (epoch !== this.epoch) return;
      this.draft.entries = this.draft.entries.map(entry => ({ ...entry, id: entry.id || entryId() }));
      this.dirty = false; this.initialized = true;
      this.host.report(this.target === "new" ? "编辑新堆栈草稿，应用时创建节点" : "已载入当前工作流中的堆栈");
    } catch (err) { this.initialized = false; this.loadError = true; this.host.report(err.message, true); }
    finally {
      if (epoch === this.epoch) { this.loading = false; if (this.host.tab === "stacks" && this.host.root.isConnected) this.host.render(); }
    }
  }
  renderSidebar() {
    const { el, button } = this;
    const sidebar = this.host.sidebar; sidebar.replaceChildren();
    sidebar.append(el("div", "abm-section-label", "工作流堆栈"));
    const create = button("＋ 新建 LoRA 堆栈", () => this.loadTarget("new"), "abm-sidebar-add");
    create.disabled = this.loading || this.host.busy; sidebar.appendChild(create);
    for (const node of this.nodes()) {
      const row = button("", () => this.loadTarget(String(node.id)), "abm-nav-item");
      row.append(el("span", "abm-nav-label", `${node.title || "LoRA 堆栈"} #${node.id}`), el("span", "abm-count", String(node._stackEntries?.length || 0)));
      row.classList.toggle("is-active", this.target === String(node.id)); row.disabled = this.loading || this.host.busy;
      sidebar.appendChild(row);
    }
    sidebar.append(el("p", "abm-stack-help", "这里编辑当前工作流的节点。修改先保留为草稿，应用后仍需保存工作流。"));
  }
  renderActions() {
    const { host, button } = this;
    host.actions.replaceChildren();
    const reload = button("↻ 重新载入", () => this.loadTarget(this.target));
    reload.disabled = this.loading || host.busy;
    const save = host.action(this.target === "new" ? "创建堆栈节点" : "应用到节点", () => this.save(), this.initialized && !this.loading && !this.loadError, true);
    const preset = host.action("保存为组合", () => host.editPreset(null, structuredClone(this.draft.entries)), !!this.draft.entries.length && host.ready.presets && !this.loading);
    host.actions.append(reload, host.action("管理标签", () => host.manageTags(), host.ready.catalog), preset, save);
  }
  options(key, current) {
    const definitions = this.host.modelInfo?.input;
    const available = definitions?.required?.[key]?.[0] || definitions?.optional?.[key]?.[0];
    return [...new Set([...(Array.isArray(available) ? available : key === "clip_type" ? ["stable_diffusion"] : ["None"]), ...(current ? [current] : [])])];
  }
  render() {
    const { host, el, button, input, select, field } = this;
    host.masonryObserver?.disconnect();
    closeManagerPopup(); host.stopMedia(host.list); host.list.replaceChildren(); host.detail.replaceChildren(); host.batch.replaceChildren();
    host.heading.textContent = "LoRA 堆栈";
    host.subtitle.textContent = `${this.draft.entries.length} 条 LoRA · ${this.dirty ? "未应用的草稿" : this.target === "new" ? "新堆栈" : "当前工作流节点 #" + this.target}`;
    host.batch.append(el("span", "abm-muted", this.dirty ? "修改尚未写入节点" : "可直接管理模型、权重、范围和激活提示词"));
    if (!this.initialized && !this.loading && !this.loadError && !host.loading) {
      this.loading = true; queueMicrotask(() => this.loadTarget(this.target, true));
    }
    const editor = el("div", "abm-stack-editor");
    if (this.loading || host.loading) editor.append(el("p", "abm-muted", "正在载入堆栈…"));
    const settings = el("div", "abm-stack-settings");
    const title = input("堆栈节点名称", this.draft.title);
    title.addEventListener("input", () => { this.draft.title = title.value; this.changed(); });
    const type = select("底模类型", [["UNET", "UNET"], ["Checkpoint", "Checkpoint"], ["GGUF", "GGUF"]], this.draft.settings["模型类型"] || "UNET", value => {
      this.draft.settings["模型类型"] = value; this.changed(); this.render();
    });
    const modelKeyName = this.draft.settings["模型类型"] === "Checkpoint" ? "ckpt_name" : this.draft.settings["模型类型"] === "GGUF" ? "gguf_name" : "unet_name";
    const model = select("底模文件", this.options(modelKeyName, this.draft.settings[modelKeyName]).map(name => [name, name === "None" ? "未选择底模" : name]), this.draft.settings[modelKeyName] || "None", value => { this.draft.settings[modelKeyName] = value; this.changed(); });
    settings.append(field("节点名称", title), field("底模类型", type), field("底模文件", model));
    for (const [key, label] of [["clip_name", "CLIP 模型"], ["clip_type", "CLIP 类型"], ["vae_name", "VAE 模型"]]) {
      const control = select(label, this.options(key, this.draft.settings[key]).map(name => [name, name === "None" ? "默认 / 底模自带" : name]), this.draft.settings[key] || (key === "clip_type" ? "stable_diffusion" : "None"), value => { this.draft.settings[key] = value; this.changed(); });
      settings.appendChild(field(label, control));
    }
    editor.appendChild(settings);
    const toolbar = el("div", "abm-stack-toolbar");
    const picker = select("添加 LoRA", [["", "选择 LoRA 模型…"], ...host.models.map(name => [name, name])], "", value => {
      if (!value) return;
      this.draft.entries.push({ id: entryId(), name: value, weight: 1, min: -3, max: 3, enabled: true, trigger: "" });
      this.changed(); this.render();
    });
    const clear = button("清空列表", () => { if (!this.draft.entries.length || !confirm("清空草稿的全部 LoRA？应用后才会修改节点。")) return; this.draft.entries = []; this.changed(); this.render(); });
    toolbar.append(picker, host.action("批量编辑标签", () => host.editModelTags([...new Set(this.draft.entries.map(entry => entry.name))]), host.ready.catalog && !!this.draft.entries.length), clear); editor.appendChild(toolbar);
    const rows = el("div", "abm-stack-rows");
    const query = host.search.value.trim().toLocaleLowerCase();
    this.draft.entries.forEach((entry, index) => {
      const modelTags = host.catalog.models?.[modelKey(entry.name)] || [];
      if (query && ![entry.name, entry.trigger, ...modelTags].join(" ").toLocaleLowerCase().includes(query)) return;
      const row = el("div", "abm-stack-row");
      row.dataset.id = entry.id;
      const heading = el("div", "abm-stack-row-heading");
      const enabled = input("启用第 " + (index + 1) + " 条 LoRA", "", "checkbox"); enabled.checked = entry.enabled !== false;
      enabled.addEventListener("change", () => { entry.enabled = enabled.checked; this.changed(); });
      const move = offset => {
        if (!this.draft.entries[index + offset]) return;
        [this.draft.entries[index], this.draft.entries[index + offset]] = [this.draft.entries[index + offset], this.draft.entries[index]];
        this.changed(); this.render();
      };
      const remove = () => { this.draft.entries.splice(index, 1); this.changed(); this.render(); };
      const up = button("↑", () => move(-1)); up.disabled = index === 0; up.setAttribute("aria-label", "上移 LoRA");
      const down = button("↓", () => move(1)); down.disabled = index === this.draft.entries.length - 1; down.setAttribute("aria-label", "下移 LoRA");
      heading.append(enabled, el("strong", "", `${index + 1}. ${shortName(entry.name)}`), up, down, button("移除", remove));
      const fields = el("div", "abm-stack-row-fields");
      const name = select("第 " + (index + 1) + " 条 LoRA 模型", [...new Set([...host.models, entry.name])].map(name => [name, name]), entry.name, value => { entry.name = value; this.changed(); this.render(); });
      fields.appendChild(field("LoRA 模型", name));
      for (const [key, label] of [["weight", "权重"], ["min", "最小值"], ["max", "最大值"]]) {
        const number = input(label, entry[key] ?? (key === "min" ? -3 : key === "max" ? 3 : 1), "number"); number.step = "0.05";
        number.addEventListener("input", () => { entry[key] = number.value; this.changed(); }); fields.appendChild(field(label, number));
      }
      const trigger = input("激活提示词", entry.trigger || "");
      trigger.addEventListener("input", () => { entry.trigger = trigger.value; this.changed(); });
      row.append(heading, fields, field("激活提示词", trigger));
      const tags = el("div", "abm-stack-tags abm-chips");
      for (const tag of modelTags) tags.appendChild(el("span", "abm-chip", tag));
      if (!modelTags.length) tags.appendChild(el("span", "abm-chip abm-subtle", "未分类"));
      tags.appendChild(host.action("编辑标签", () => host.editModelTags([entry.name]), host.ready.catalog));
      row.appendChild(tags);
      row.addEventListener("contextmenu", event => {
        event.preventDefault(); event.stopPropagation();
        if (host.busy || this.loading) return;
        showManagerContext(row, [
          { label: entry.enabled !== false ? "停用此 LoRA" : "启用此 LoRA", action: () => { entry.enabled = entry.enabled === false; this.changed(); this.render(); } },
          { label: "复制此条", action: () => { this.draft.entries.splice(index + 1, 0, { ...entry, id: entryId() }); this.changed(); this.render(); } },
          { label: "编辑模型标签", disabled: !host.ready.catalog, action: () => host.run(() => host.editModelTags([entry.name])) },
          { label: "上移", disabled: index === 0, action: () => move(-1) },
          { label: "下移", disabled: index === this.draft.entries.length - 1, action: () => move(1) },
          { label: "移除", danger: true, action: remove },
        ], event.clientX, event.clientY);
      });
      rows.appendChild(row);
    });
    if (!rows.childElementCount) rows.append(el("p", "abm-muted", this.draft.entries.length ? "没有匹配的 LoRA" : "选择上方模型，将 LoRA 加入堆栈。"));
    editor.appendChild(rows); host.list.appendChild(editor);
    if (this.loading || host.busy || host.loading || !this.initialized) editor.querySelectorAll("input,button").forEach(node => { node.disabled = true; });
  }
  append(entries) {
    this.draft.entries = appendUniqueEntries(this.draft.entries, entries.map(entry => ({ ...entry, id: entryId() })));
    this.initialized = true; this.changed();
  }
  async save() {
    const graph = this.graph();
    if (!graph) throw new Error("当前没有可用工作流");
    const entries = this.draft.entries.length ? validatePresetEntries(this.draft.entries, this.host.models) : [];
    let node = this.target === "new" ? null : graph.getNodeById(this.target), created = false;
    if (this.target !== "new" && !node) throw new Error("目标堆栈已删除，请重新选择");
    if (node?._stackContainer?.closest(".vpl-node")?.classList.contains("vpl-locked")) throw new Error("堆栈正在执行，请完成后再应用");
    if (node && this.baseline !== JSON.stringify(node._allbuyManagerStack?.snapshot()) && !confirm("堆栈已被节点面板修改过，确定用当前草稿覆盖？")) return;
    if (!node) {
      node = globalThis.LiteGraph?.createNode("AllBuyLoRAStack");
      if (!node) throw new Error("LoRA 节点尚未注册，请刷新 ComfyUI");
      node.pos = this.app.canvas?.convertEventToCanvasOffset?.({ clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 }) || [100, 100];
      graph.add(node); created = true;
    }
    try {
      for (let i = 0; !node._allbuyManagerStack && i < 120; i++) await new Promise(resolve => setTimeout(resolve, 25));
      if (!node._allbuyManagerStack || node.graph !== graph) throw new Error("堆栈面板尚未就绪，请刷新后重试");
      const settings = Object.fromEntries(SETTING_KEYS.filter(key => key in this.draft.settings).map(key => [key, this.draft.settings[key]]));
      node._allbuyManagerStack.replace({ entries, settings, title: this.draft.title });
      this.target = String(node.id); this.draft = node._allbuyManagerStack.snapshot();
      this.baseline = JSON.stringify(this.draft); this.dirty = false;
      graph.change?.(); node.setDirtyCanvas?.(true, true);
      this.host.targetValue = String(node.id);
      this.host.report(`已${created ? "创建" : "更新"}堆栈「${node.title}」#${node.id}，请保存工作流`);
    } catch (err) { if (created && node.graph === graph) graph.remove(node); throw err; }
  }
  destroy() { ++this.epoch; }
}
