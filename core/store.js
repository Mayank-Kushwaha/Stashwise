// Local state + Gist sync. Each device writes only its own files (bm-<dev>.json, vec-<dev>.json),
// so devices never overwrite each other; readers merge all files (newest record wins).
import { get, set, getCfg, saveCfg } from './kv.js';
import * as G from './gist.js';
import { merge } from './merge.js';

export const S = { bm: {}, vec: {}, q: {}, mine: { bm: {}, vec: {}, dirty: null }, etag: null, ver: null, dev: null };
export const live = () => Object.values(S.bm).filter(b => !b.del);
const model = c => `${c.emb}:${c.dim}`;

/** Reload from storage only if another context (background/dashboard) changed it. */
export async function refresh() {
  const v = await get('ver');
  if (S.dev && v === S.ver) return;
  S.dev ??= (await get('dev')) || await (async () => { const d = crypto.randomUUID().slice(0, 8); await set({ dev: d }); return d; })();
  const c = await get('cache');
  if (c) Object.assign(S, c);
  S.ver = v;
}

export async function persist() {
  S.ver = crypto.randomUUID();
  await set({ cache: { bm: S.bm, vec: S.vec, q: S.q, mine: S.mine, etag: S.etag }, ver: S.ver });
}

// Serialize mutations within one context.
let lock = Promise.resolve();
export const tx = f => {
  const r = lock.then(refresh).then(f);
  lock = r.catch(() => {});
  return r;
};

/** Write a record (and optional vector [u,str]) locally and mark for upload. Call inside tx, then persist(). */
export function put(rec, v) {
  S.bm[rec.id] = S.mine.bm[rec.id] = rec;
  if (rec.del) { delete S.vec[rec.id]; delete S.mine.vec[rec.id]; }
  else if (v) S.vec[rec.id] = S.mine.vec[rec.id] = v;
  S.mine.dirty = { bm: 1, vec: (S.mine.dirty?.vec || v) ? 1 : 0 };
}

async function ensureGist(c) {
  if (c.gist) return c.gist;
  let id = await G.find(c.gh);
  if (!id) {
    id = await G.create(c.gh);
    const first = await G.find(c.gh); // two devices may race on first run: keep the oldest
    if (first && first !== id) { await G.remove(c.gh, id).catch(() => {}); id = first; }
  }
  await saveCfg({ gist: id });
  c.gist = id;
  return id;
}

export async function push() {
  return tx(async () => {
    const c = await getCfg(), d = S.mine.dirty;
    if (!c.gh || !d) return false;
    const id = await ensureGist(c), files = {};
    if (d.bm) files[`bm-${S.dev}.json`] = { content: JSON.stringify(Object.values(S.mine.bm)) };
    if (d.vec) files[`vec-${S.dev}.json`] = { content: JSON.stringify({ m: model(c), v: S.mine.vec }) };
    await G.patch(c.gh, id, files);
    S.mine.dirty = null;
    await persist();
    return true;
  });
}

/** Pull all device files, merge, then upload anything still pending. Returns {changed}. */
export async function sync() {
  const out = await tx(async () => {
    const c = await getCfg();
    if (!c.gh) return { off: true };
    const id = await ensureGist(c);
    const r = await G.get(c.gh, id, S.etag);
    if (r.notModified) return { changed: false };
    const bms = [], vfs = [];
    for (const [n, f] of Object.entries(r.data.files)) {
      if (!/^(bm|vec)-[\w-]+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(f.truncated ? await G.raw(f.raw_url) : f.content);
        n.startsWith('bm') ? bms.push(...j) : vfs.push(j);
      } catch { /* skip a corrupt file */ }
    }
    const m = merge([...bms, ...Object.values(S.mine.bm)], [...vfs, { m: model(c), v: S.mine.vec }], model(c));
    S.bm = m.bm; S.vec = m.vec; S.etag = r.etag;
    await persist();
    return { changed: true };
  });
  if (!out.off) await push();
  return out;
}
