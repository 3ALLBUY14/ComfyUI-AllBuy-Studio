import { createManagerSelect } from "./manager_controls.js";

export function civitaiNetworkPanel({ el, input, button, request }) {
  const panel = el("section", "abm-civitai-network"), row = el("div", "abm-civitai-source-row"), actions = el("div", "abm-detail-actions"), message = el("p", "abm-muted", "正在读取连接设置…");
  const mode = createManagerSelect("C 站连接方式", [["auto", "自动 · 优先系统代理"], ["direct", "直连"], ["custom", "自定义 HTTP 代理"]], "auto", () => { address.disabled = mode.value !== "custom"; });
  const address = input("HTTP 代理地址", ""); address.placeholder = "http://127.0.0.1:7890"; address.disabled = true; mode.disabled = true;
  message.setAttribute("role", "status");
  const apply = value => { mode.value = value.mode || "auto"; address.value = value.proxy || ""; address.disabled = mode.value !== "custom"; message.textContent = "当前连接：" + value.route; };
  const update = async test => {
    save.disabled = check.disabled = true; mode.disabled = address.disabled = true;
    message.classList.remove("abm-error"); message.textContent = test ? "正在从 ComfyUI 后端测试 C 站连接，无需 API Key…" : "正在保存连接设置…";
    try {
      apply(await request("/civitai/network", {mode: mode.value, proxy: address.value.trim()}));
      if (test) { const result = await request("/civitai/network/test", {}); message.textContent = `连接正常 · ${result.route} · ${result.elapsed_ms} ms。可以继续验证 API Key 或开始获取。`; }
    } catch (error) { message.textContent = error.message; message.classList.add("abm-error"); }
    finally {
      save.disabled = check.disabled = false; mode.disabled = false; address.disabled = mode.value !== "custom";
      if (message.isConnected) message.scrollIntoView({block: "nearest", behavior: "smooth"});
    }
  };
  const save = button("保存连接设置", () => update(false)), check = button("测试连接", () => update(true));
  row.append(mode, address); actions.append(save, check);
  panel.append(el("h4", "", "C 站连接"), el("p", "abm-muted", "仅影响 C 站请求，不修改 ComfyUI 全局代理。保存或测试后生效；请使用 HTTP / 混合端口。"), row, message, actions);
  request("/civitai/network").then(apply).catch(error => { message.textContent = error.message; }).finally(() => { mode.disabled = false; });
  return panel;
}
