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

export function filterManagerItems(items, { tab, query = "", filter = "", sort = "name", catalog = {}, groups = [] }) {
  const needle = query.trim().toLocaleLowerCase();
  const favorites = new Set((groups.find(group => group.name === "我的收藏")?.loras || []).map(modelKey));
  const tagsOf = item => tab === "prompts" ? item.tags || [] : catalog.models?.[modelKey(item.name)] || [];
  const favorite = item => tab === "prompts" ? !!item.star : favorites.has(modelKey(item.name));
  const result = items.filter(item => {
    const tags = tagsOf(item);
    const haystack = [item.name, item.positive, item.negative, item.note, ...tags,
      ...categoriesOf(item), ...(item.entries || []).map(entry => entry.name)].join(" ").toLocaleLowerCase();
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
