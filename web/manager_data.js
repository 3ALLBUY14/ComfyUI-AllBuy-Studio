// Shared, DOM-free rules for the fullscreen manager and workflow adapters.
export const modelKey = name => String(name || "").replaceAll("\\", "/");
export const categoriesOf = group => Array.isArray(group.categories)
  ? group.categories.filter(Boolean) : group.category ? [group.category] : [];
export const locatorKey = locator => JSON.stringify([locator?.source, locator?.name, locator?.path]);
export const shortName = name => modelKey(name).split("/").pop().replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, "");

export function managerAppearance(preferences = {}) {
  const number = (value, fallback, min, max) => Number.isFinite(Number(value)) && value !== null && value !== ""
    ? Math.max(min, Math.min(max, Number(value))) : fallback;
  return { scale: number(preferences.scale, 100, 80, 140), fontSize: number(preferences.fontSize, 13, 11, 20) };
}
export function managerVisualPreferences(preferences = {}) {
  return { theme: preferences.theme === "light" ? "light" : "dark", launcherStyle: preferences.launcherStyle === "native" ? "native" : "glass" };
}

export function managerContentPreferences(value = {}) {
  return { mode: ["show", "hide"].includes(value?.mode) ? value.mode : "blur", includeUnknown: value?.includeUnknown === true };
}
export function modelContent(name, catalog = {}, previews = {}) {
  const key = modelKey(name), manual = catalog.content_ratings?.[key];
  if (["sfw", "nsfw"].includes(manual)) return { rating: manual, source: "手动设置" };
  const records = [previews[key]?.content, catalog.recommendations?.[key]?.content];
  return records.find(value => value?.rating === "nsfw") || records.find(value => value?.rating === "sfw") || { rating: "unknown", source: "未评级" };
}
export function contentRestricted(name, catalog, previews, preferences) {
  const rating = modelContent(name, catalog, previews).rating;
  return rating === "nsfw" || rating === "unknown" && preferences.includeUnknown;
}
export function modelInfo(name, catalog = {}, previews = {}) {
  const key = modelKey(name), manual = catalog.model_info?.[key];
  if (manual && typeof manual === "object") return { base_model: typeof manual.base_model === "string" ? manual.base_model : "", version: typeof manual.version === "string" ? manual.version : "", source: "手动设置" };
  const local = previews[key]?.model_info || {}, online = catalog.recommendations?.[key] || {};
  return { base_model: local.base_model || online.base_model || "", version: local.version || online.version || "", source: local.base_model || local.version ? "本地来源信息" : online.base_model || online.version ? "已保存来源" : "未填写" };
}
export function normalizeLoraFilters(value = {}) {
  const strings = key => Array.isArray(value?.[key]) ? [...new Set(value[key].filter(item => typeof item === "string" && item.length <= 200))].slice(0, 200) : [];
  return { bases: strings("bases"), includeTags: strings("includeTags"), excludeTags: strings("excludeTags"), tagMode: value?.tagMode === "all" ? "all" : "any", version: typeof value?.version === "string" ? value.version.slice(0, 200) : "" };
}
export function normalizeLoraFilterPresets(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.filter(row => row && typeof row.id === "string" && row.id.length <= 100 && typeof row.name === "string" && row.name.trim() && row.name.length <= 50 && !seen.has(row.id) && seen.add(row.id)).slice(0, 30).map(row => ({ id: row.id, name: row.name.trim(), advanced: normalizeLoraFilters(row.advanced), query: typeof row.query === "string" ? row.query.slice(0, 2000) : "", filter: typeof row.filter === "string" && row.filter.length <= 1000 ? row.filter : "", sort: ["manual", "name", "desc", "favorite", "updated"].includes(row.sort) ? row.sort : "manual" }));
}

export function filterManagerItems(items, { tab, query = "", filter = "", sort = "name", catalog = {}, groups = [], previews = {}, content = {}, advanced = {} }) {
  const needle = query.trim().toLocaleLowerCase();
  const favorites = new Set((groups.find(group => group.name === "我的收藏")?.loras || []).map(modelKey));
  const tagsOf = item => tab === "prompts" ? item.tags || [] : catalog.models?.[modelKey(item.name)] || [];
  const favorite = item => tab === "prompts" ? !!item.star : favorites.has(modelKey(item.name));
  const filters = normalizeLoraFilters(advanced);
  const result = items.filter(item => {
    if (tab === "loras") {
      if (content.mode === "hide" && contentRestricted(item.name, catalog, previews, content)) return false;
      if (filter.startsWith("content:") && modelContent(item.name, catalog, previews).rating !== filter.slice(8)) return false;
      const info = modelInfo(item.name, catalog, previews), labels = tagsOf(item);
      if (filters.bases.length && !filters.bases.includes(info.base_model || "")) return false;
      if (filters.version && !info.version.toLocaleLowerCase().includes(filters.version.toLocaleLowerCase())) return false;
      if (filters.excludeTags.some(tag => labels.includes(tag))) return false;
      if (filters.includeTags.length && !(filters.tagMode === "all" ? filters.includeTags.every(tag => labels.includes(tag)) : filters.includeTags.some(tag => labels.includes(tag)))) return false;
    }
    const info = tab === "loras" ? modelInfo(item.name, catalog, previews) : {};
    const tags = tagsOf(item);
    const haystack = [item.name, item.positive, item.negative, item.note, ...tags,
      ...categoriesOf(item), info.base_model, info.version, ...(item.entries || []).map(entry => entry.name)].join(" ").toLocaleLowerCase();
    if (needle && !haystack.includes(needle)) return false;
    if (filter === "favorite") return favorite(item);
    if (filter.startsWith("category:")) return categoriesOf(item).includes(filter.slice(9));
    if (filter.startsWith("tag:")) return tags.includes(filter.slice(4));
    if (filter === "untagged") return !tags.length;
    if (filter.startsWith("group:")) {
      const members = new Set((groups.find(group => group.id === filter.slice(6))?.loras || []).map(modelKey));
      return members.has(modelKey(item.name));
    }
    if (filter.startsWith("folder:")) return modelKey(item.name).startsWith(filter.slice(7) + "/");
    return true;
  });
  if (sort === "manual") return result;
  return result.sort((a, b) => {
    if (sort === "favorite" && favorite(a) !== favorite(b)) return Number(favorite(b)) - Number(favorite(a));
    if (sort === "updated") return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN", { numeric: true, sensitivity: "base" }) * (sort === "desc" ? -1 : 1);
  });
}

export function validatePresetEntries(entries, available) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("请至少添加一条 LoRA");
  const installed = available ? new Set(available.map(modelKey)) : null;
  return entries.map((entry, index) => {
    const name = String(entry.name || "").trim();
    if (!name || name === "None") throw new Error(`第 ${index + 1} 条请选择 LoRA`);
    if (installed && !installed.has(modelKey(name))) throw new Error(`LoRA 文件不存在：${name}`);
    const values = [entry.weight ?? 1, entry.min ?? -3, entry.max ?? 3];
    if (values.some(value => String(value).trim() === "" || !Number.isFinite(Number(value)))) throw new Error(`第 ${index + 1} 条的权重和范围必须是有效数字`);
    const [weight, min, max] = values.map(Number);
    if (max <= min || weight < min || weight > max) throw new Error(`第 ${index + 1} 条权重必须在有效范围内`);
    return { name, weight, min, max, enabled: entry.enabled !== false, trigger: String(entry.trigger || "").trim() };
  });
}

export function appendUniqueEntries(current, additions) {
  const existing = new Set(current.map(entry => modelKey(entry.name)));
  return [...current, ...additions.filter(entry => {
    const key = modelKey(entry.name);
    if (existing.has(key)) return false;
    existing.add(key);
    return true;
  })];
}

export function promptApplication(state, locator, groups, ids, append) {
  const available = new Set(groups.map(group => group.id));
  const sameLibrary = locatorKey(state.locator) === locatorKey(locator);
  const chosen = [...new Set([...(append && sameLibrary ? state.selectedIds : []), ...ids])].filter(id => available.has(id));
  const order = [...new Set([...(sameLibrary ? state.unselectedIds : []), ...groups.map(group => group.id)])].filter(id => available.has(id));
  return { selectedIds: order.filter(id => chosen.includes(id)), unselectedIds: order };
}
