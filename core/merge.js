/**
 * Merge records from every device's files. Newest `u` wins per id.
 * bms: bookmark records (live or tombstones {id,del:1,u}).
 * vfs: vector files {m:'model:dim', v:{id:[u,str]}}; files from another model are ignored.
 */
export function merge(bms, vfs, model) {
  const bm = {}, vec = {};
  for (const r of bms) if (!bm[r.id] || r.u > bm[r.id].u) bm[r.id] = r;
  for (const f of vfs) {
    if (f.m !== model) continue;
    for (const id in f.v) { const x = f.v[id]; if (!vec[id] || x[0] > vec[id][0]) vec[id] = x; }
  }
  for (const id in vec) if (!bm[id] || bm[id].del) delete vec[id];
  return { bm, vec };
}
