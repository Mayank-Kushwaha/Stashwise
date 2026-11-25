// Topic grouping: placement guard and local (zero-token) re-organize.
import { dec, dot, norm } from './vec.js';

export const key = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const TH = { fit: 0.5, merge: 0.8, move: 0.1 }; // starting values; tune with real data
const INBOX = 'unsorted|inbox';

/** {t: {"sec|top": {sec,top,ids}}, s: {secKey: displayName}} */
export function index(bms) {
  const t = {}, s = {};
  for (const b of bms) {
    if (b.del) continue;
    const sk = key(b.sec);
    s[sk] ??= b.sec;
    (t[sk + '|' + key(b.top)] ??= { sec: b.sec, top: b.top, ids: [] }).ids.push(b.id);
  }
  return { t, s };
}

/** Unit centroid per topic, from members that have vectors. */
export function cents(topics, vec) {
  const out = {};
  for (const k in topics) {
    let c = null, n = 0;
    for (const id of topics[k].ids) {
      if (!vec[id]) continue;
      const f = dec(vec[id], id);
      c ??= new Float32Array(f.length);
      for (let i = 0; i < f.length; i++) c[i] += f[i];
      n++;
    }
    if (n) out[k] = { c: norm(c), n };
  }
  return out;
}

/**
 * Decide the final {sec, top}. a: cleaned AI answer {sec,top,alt}; v: unit vector of the page.
 * 1) AI picked an existing topic but the page is far from its centroid -> use the AI's alternative new topic.
 * 2) New topic that is nearly identical to an existing one -> reuse the existing one.
 */
export function place(a, v, idx, vec, th = TH) {
  const cs = cents(idx.t, vec);
  const canon = (sec, top) => {
    const sk = key(sec), k = sk + '|' + key(top);
    return { sec: idx.s[sk] || sec, top: idx.t[k]?.top || top, k };
  };
  let p = canon(a.sec, a.top);
  const e = cs[p.k];
  if (e && e.n >= 2 && dot(v, e.c) < th.fit) {
    p = key(a.alt) && key(a.alt) !== key(a.top) ? canon(a.sec, a.alt) : canon('Unsorted', 'Inbox');
  }
  if (!idx.t[p.k] && p.k !== INBOX) {
    let bk = null, bs = th.merge;
    for (const k in cs) if (k !== INBOX) { const s = dot(v, cs[k].c); if (s >= bs) { bs = s; bk = k; } }
    if (bk) return { sec: idx.t[bk].sec, top: idx.t[bk].top };
  }
  return { sec: p.sec, top: p.top };
}

/** Proposed moves [{id,sec,top}] to merge near-duplicate topics and move clear outliers. */
export function reorg(bms, vec, th = TH) {
  const idx = index(bms), cs = cents(idx.t, vec);
  const ks = Object.keys(cs).filter(k => k !== INBOX).sort((a, b) => idx.t[b].ids.length - idx.t[a].ids.length);
  const to = {}, mv = {};
  for (let i = 0; i < ks.length; i++) {
    if (to[ks[i]]) continue;
    for (let j = i + 1; j < ks.length; j++) {
      if (!to[ks[j]] && dot(cs[ks[i]].c, cs[ks[j]].c) >= th.merge) to[ks[j]] = ks[i];
    }
  }
  for (const k in to) for (const id of idx.t[k].ids) mv[id] = to[k];
  for (const k of ks) {
    if (to[k] || idx.t[k].ids.length < 3) continue;
    for (const id of idx.t[k].ids) {
      if (!vec[id]) continue;
      const f = dec(vec[id], id), own = dot(f, cs[k].c);
      let bk = null, bs = -1;
      for (const o of ks) if (o !== k && !to[o]) { const s = dot(f, cs[o].c); if (s > bs) { bs = s; bk = o; } }
      if (bk && bs >= th.fit && bs > own + th.move) mv[id] = bk;
    }
  }
  return Object.entries(mv).map(([id, k]) => ({ id, sec: idx.t[k].sec, top: idx.t[k].top }));
}
