import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../web/library_picker.js", import.meta.url), "utf8");
const moduleUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const picker = await import(moduleUrl);
const { libraryIdentity: key, rankLibraryItems: rank, updateLibraryPreference: update,
  readLibraryPreferences: read, LIBRARY_PICKER_STORAGE_KEY: storageKey } = picker;

assert.equal(key('user:shared'), key(JSON.stringify({ name: "shared", source: "user" })));
assert.notEqual(key('user:shared'), key('builtin:shared'));
assert.notEqual(key({ source: "custom", path: "a.json" }), key({ source: "custom", path: "b.json" }));
for (const value of [null, "__create__", "__rename__", "bad", "user:", {}, { source: "user" }]) assert.equal(key(value), null);

const libraries = Array.from({ length: 30 }, (_, i) => ({ value: "user:lib" + i, label: `Library ${i}`, group: "用户库" }));
libraries.push({ value: 'builtin:lib1', label: "Builtin", group: "内置库" });
libraries.push({ value: '__rename__', label: '重命名', group: '操作' });
libraries.push({ value: '__create__', label: '新建', group: '操作' });
const original = structuredClone(libraries);
const preferences = { favorites: [key('user:lib8'), key('user:removed')],
  recent: ['user:lib8', 'user:lib20', 'user:lib19', 'user:lib18', 'user:lib17', 'user:lib16', 'user:lib15'].map(key) };
const ranked = rank(libraries, preferences);
assert.deepEqual(ranked.libraries.slice(0, 6).map(item => item.value), ['user:lib8', 'user:lib20', 'user:lib19', 'user:lib18', 'user:lib17', 'user:lib16']);
assert.equal(ranked.libraries[0].group, '常用库');
assert.equal(ranked.libraries.filter(item => item.group === '最近使用').length, 5);
assert.equal(new Set(ranked.libraries.map(item => item.key)).size, 31);
assert.deepEqual(ranked.actions.map(item => item.value), ['__rename__', '__create__']);
assert.deepEqual(libraries, original, 'Ranking must not mutate the backend library list');
assert.deepEqual(rank(libraries, preferences, '  LIBRARY 20 ').libraries.map(item => item.value), ['user:lib20']);
assert.equal(rank(libraries, preferences, 'no match').libraries.length, 0);
assert.equal(rank(libraries, preferences, 'no match').actions.length, 2);
const renamed = libraries.map(item => item.value === 'user:lib8' ? { ...item, label: 'New name' } : item);
assert.equal(rank(renamed, preferences).libraries[0].label, 'New name', 'Stable locators preserve favorites after renaming');
const notices = [...libraries, { value: '__hidden_builtin__', label: '隐藏的内置同名库', disabled: true }];
assert.equal(rank(notices, preferences).notices.length, 1);
assert.equal(rank(notices, preferences).actions.length, 2, 'Hidden-library notices must not crowd management actions');
assert.equal(rank(notices, preferences, 'Library').notices.length, 0);

const storage = new Map();
globalThis.localStorage = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) };
globalThis.window = new EventTarget();
let notifications = 0;
window.addEventListener('allbuy-library-picker-changed', () => notifications++);
update(key('user:lib1'), 'favorite');
update(key('user:lib1'), 'recent');
update(key('user:lib2'), 'recent');
update(key('user:lib1'), 'recent');
assert.deepEqual(read(), { favorites: [key('user:lib1')], recent: [key('user:lib1'), key('user:lib2')] });
assert.equal(notifications, 4);
assert.ok(storage.has(storageKey));
update(key('user:lib1'), 'favorite');
assert.equal(read().favorites.length, 0);
for (let i = 0; i < 40; i++) update(key('user:lib' + i), 'recent');
assert.equal(read().recent.length, 20);
storage.set(storageKey, '{broken');
assert.doesNotThrow(() => read());
localStorage.setItem = () => { throw new Error('quota exceeded'); };
update(key('builtin:lib1'), 'favorite');
assert.ok(read().favorites.includes(key('builtin:lib1')), 'Unavailable storage must retain preferences in memory');
console.log('Library search, ordering, shared identity, deduplication and persistence checks passed');
