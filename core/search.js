// Local keyword search (offline, no tokens) and rank fusion.
const FIELDS = [['t', 3], ['tags', 2], ['top', 1.5], ['sec', 1.5], ['d', 1], ['url', 0.5]];

/** All terms must match somewhere (substring). Score = sum of best field weight per term. */
export function kw(bms, q) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const b of bms) {
    const f = FIELDS.map(([k, w]) => [(Array.isArray(b[k]) ? b[k].join(' ') : b[k] || '').toLowerCase(), w]);
    let s = 0;
    for (const t of terms) {
      let m = 0;
      for (const [txt, w] of f) if (w > m && txt.includes(t)) m = w;
      if (!m) { s = 0; break; }
      s += m;
    }
    if (s) out.push([b, s]);
  }
  return out.sort((a, b) => b[1] - a[1]).map(x => x[0]);
}

/** Reciprocal rank fusion of several id lists. */
export function rrf(lists, k = 60) {
  const sc = {};
  for (const l of lists) l.forEach((id, i) => sc[id] = (sc[id] || 0) + 1 / (k + i + 1));
  return Object.keys(sc).sort((a, b) => sc[b] - sc[a]);
}
