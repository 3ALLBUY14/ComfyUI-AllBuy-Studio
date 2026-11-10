import { modelKey } from "./manager_data.js";
import { civitaiAuthPanel, civitaiImportOptions } from "./manager_civitai_batch.js";

export async function fetchCivitaiInfo(h, item, { el, button, input, field, request }) {
  const body = el("div", "abm-modal-fields abm-civitai-import"), saved = h.catalog.source_info?.[modelKey(item.name)];
  const tools = { el, button, input, field, request }, options = civitaiImportOptions(tools), checks = options.checks;
  const url = input("C 站版本链接（留空自动匹配）", saved?.url || ""), message = el("p", "abm-muted", "留空按本机文件 SHA256 匹配；首次计算可能较慢。只发送哈希，不上传模型。"), preview = el("section", "abm-civitai-preview");
  message.setAttribute("role", "status"); let info = null;
  const fetch = button("获取模型信息", async () => {
    body.dataset.busy = "true"; fetch.disabled = true; url.disabled = true; info = null; preview.replaceChildren(); message.textContent = "正在匹配并读取 C 站信息…";
    try {
      const result = await request("/lora_source/fetch", { model: item.name, url: url.value.trim() }); info = result.info;
      const metadata = el("dl", "abm-civitai-metadata");
      for (const [label, value] of [["底模", info.base_model], ["版本", info.version], ["匹配方式", info.matchedBy], ["内容评级", ({sfw: "SFW", nsfw: "NSFW", unknown: "未评级"}[info.rating])], ["激活提示词", info.trigger]]) metadata.append(el("dt", "abm-muted", label), el("dd", "", value || "未提供"));
      preview.append(el("h3", "", info.name || "未提供模型名称"), metadata);
      const advice = info.recommendation || {};
      preview.append(el("p", "abm-muted", "推荐权重：" + (advice.min !== undefined ? `${advice.min}～${advice.max} · 默认 ${advice.default}` : advice.notice || "未提供")));
      checks.get("recommendation").disabled = advice.min === undefined;
      if (advice.min === undefined) checks.get("recommendation").checked = false;
      const description = el("textarea", "abm-input"); description.setAttribute("aria-label", "作者说明"); description.value = info.description; description.readOnly = true; description.rows = 6;
      preview.append(field("作者说明", description)); message.textContent = "读取完成。勾选要导入的字段，点击保存后生效。";
    } catch (error) { info = null; message.textContent = error.message; }
    finally { delete body.dataset.busy; fetch.disabled = false; url.disabled = false; }
  });
  url.addEventListener("input", () => { info = null; preview.replaceChildren(); message.textContent = "链接已修改，请重新获取信息"; });
  const sourceRow = el("div", "abm-civitai-source-row"); sourceRow.append(url, fetch);
  const content = el("div", "abm-civitai-content"), settings = el("aside", "abm-civitai-settings");
  const model = el("p", "abm-civitai-model-name abm-muted", item.name); model.title = item.name;
  content.append(model, field("Civitai 来源", sourceRow), message, preview);
  settings.append(el("h3", "abm-civitai-settings-title", "导入与连接"), options.node, civitaiAuthPanel(tools));
  body.classList.add("abm-civitai-layout", "abm-civitai-single"); body.append(content, settings);
  const modal = h.modal("从 C 站拉取信息", body, async () => {
    if (!info || body.dataset.busy === "true") throw new Error("请先获取并检查模型信息");
    const { skip_existing, ...data } = options.data();
    h.catalog = await request("/lora_catalog/update", { action: "import_source", model: item.name, info, ...data });
    const draft = h.drafts.get(item.name); if (draft) draft.trigger = h.catalog.triggers?.[modelKey(item.name)] || "";
    h.changedLoras(); h.report("C 站信息已保存");
  });
  const dialog = body.closest("form"); dialog.classList.add("abm-civitai-dialog");
  dialog.querySelector(".abm-modal-footer").prepend(el("span", "abm-muted abm-modal-caption", "核对信息后保存；默认保留已手动设置的内容。"));
  await modal;
}
