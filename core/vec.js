// Vector helpers. Vectors are stored as "scale:base64(int8)" (~1 KB for 768 dims).
export function norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

export function enc(v) {
  let m = 0;
  for (const x of v) m = Math.max(m, Math.abs(x));
  const sc = m / 127 || 1;
  let s = '';
  for (const x of v) s += String.fromCharCode(Math.round(x / sc) & 255);
  return sc.toPrecision(6) + ':' + btoa(s);
}

const memo = new Map();
/** Decode a stored vector entry [updatedAt, "scale:b64"] to a unit Float32Array (memoized by id). */
export function dec(entry, id) {
  const str = entry[1];
  const hit = memo.get(id);
  if (hit?.str === str) return hit.f;
  const [sc, b] = str.split(':');
  const bin = atob(b);
  const f = new Float32Array(bin.length);
  for (let i = 0; i < f.length; i++) f[i] = ((bin.charCodeAt(i) << 24) >> 24) * sc;
  const n = norm(f);
  memo.set(id, { str, f: n });
  return n;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) s += a[i] * b[i];
  return s;
}

/** Top-k ids by cosine similarity. vec: {id:[u,str]}, ok(id) filters candidates. */
export function nearest(q, vec, k = 8, ok = () => true) {
  const out = [];
  for (const id in vec) if (ok(id)) out.push([id, dot(q, dec(vec[id], id))]);
  return out.sort((a, b) => b[1] - a[1]).slice(0, k);
}
