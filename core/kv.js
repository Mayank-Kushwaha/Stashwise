// Key-value storage: extension storage.local, or IndexedDB on the web (PWA).
const ext = (globalThis.browser ?? globalThis.chrome)?.storage?.local;
let db;
const open = () => db ??= new Promise((res, rej) => {
  const r = indexedDB.open('vault', 1); // name kept from the old project name so existing phone-app data stays readable
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idb = async (mode, f) => {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const r = f(t.objectStore('kv'));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
};
export const get = async k => ext ? (await ext.get(k))[k] : idb('readonly', s => s.get(k));
export const set = async o => ext ? ext.set(o) : idb('readwrite', s => { for (const k in o) s.put(o[k], k); });

export const DEF = {
  gh: '', gem: '', gist: '', deny: '',
  gen: 'gemini-3.5-flash-lite', emb: 'gemini-embedding-2', dim: 768,
  fit: 0.5, merge: 0.8,
};
export const getCfg = async () => ({ ...DEF, ...(await get('cfg')) });
export const saveCfg = async p => { const c = { ...(await getCfg()), ...p }; await set({ cfg: c }); return c; };
