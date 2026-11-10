const pending = new Map();
const modelKey = (name) => String(name || "").trim().replaceAll("\\", "/");

export async function seedLoRATriggers(nodes) {
  const entries = new Map();
  for (const node of nodes || []) {
    if (node.type !== "AllBuyLoRAStack" && node.comfyClass !== "AllBuyLoRAStack") continue;
    let stack = node._stackEntries;
    if (!Array.isArray(stack)) {
      try { stack = JSON.parse(node.widgets?.find(widget => widget.name === "stack_json")?.value || "[]"); }
      catch (_) { continue; }
    }
    if (!Array.isArray(stack)) continue;
    for (const entry of stack) {
      const name = modelKey(entry?.name);
      if (name && name !== "None" && typeof entry.trigger === "string" && entry.trigger.trim() && !entries.has(name)) {
        entries.set(name, { name, trigger: entry.trigger });
      }
    }
  }
  if (!entries.size) return;
  const response = await fetch("/allbuy_promptlibrary/lora_catalog/update", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "seed_triggers", entries: [...entries.values()] }),
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
}

export function saveLoRATrigger(model, trigger) {
  model = modelKey(model);
  if (!model || model === "None") return Promise.resolve();
  // Serialize writes for a model so a slow earlier request cannot overwrite later edits.
  const write = (pending.get(model) || Promise.resolve()).catch(() => {}).then(async () => {
    const response = await fetch("/allbuy_promptlibrary/lora_catalog/update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_trigger", model, trigger }),
    });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
    window.dispatchEvent(new CustomEvent("allbuy-lora-trigger-saved", { detail: { model, trigger: trigger.trim() } }));
  });
  pending.set(model, write);
  const cleanup = () => { if (pending.get(model) === write) pending.delete(model); };
  write.then(cleanup, cleanup);
  return write;
}

export function bindLoRATrigger(input, getModel) {
  let timer;
  let draft;
  let revision = 0;
  const flush = () => {
    clearTimeout(timer);
    if (!draft) return;
    const { model, trigger, version } = draft;
    draft = null;
    input.title = "激活提示词正在保存到 LoRA 模型管理…";
    saveLoRATrigger(model, trigger).then(() => {
      if (revision !== version) return;
      input.title = "激活提示词已保存到 LoRA 模型管理";
      input.removeAttribute("aria-invalid");
      input.style.borderColor = "";
    }).catch((error) => {
      if (revision !== version) return;
      input.title = "激活提示词保存失败，重新编辑可重试：" + error.message;
      input.setAttribute("aria-invalid", "true");
      input.style.borderColor = "var(--vpl-danger, #ef7777)";
    });
  };
  input.addEventListener("input", () => {
    draft = { model: getModel(), trigger: input.value, version: ++revision };
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  });
  input.addEventListener("change", flush);
  input.addEventListener("blur", flush);
}
