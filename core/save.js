// Save pipeline: scrape -> store locally -> one Gemini call (title/desc/topic) -> one embedding -> sync.
import { clip, host, normUrl, idOf, denied } from './util.js';
import { getCfg } from './kv.js';
import { S, tx, put, persist, push, live } from './store.js';
import { gen, genUrl, embed, docText, queryText, clean, SCHEMA, ASK, FIELDS } from './ai.js';
import { enc, nearest } from './vec.js';
import { index, place, reorg, TH } from './topics.js';

const th = c => ({ ...TH, fit: c.fit, merge: c.merge });

/** Existing taxonomy as compact text (largest 40 topics) to keep prompts small. */
function taxonomy() {
  const by = {};
  Object.values(index(live()).t).filter(x => x.sec !== 'Unsorted').sort((a, b) => b.ids.length - a.ids.length).slice(0, 40)
    .forEach(x => (by[x.sec] ??= []).push(x.top));
  return Object.entries(by).map(([s, t]) => `${s}: ${t.join(', ')}`).join('\n') || '(none yet)';
}

const digest = p => [
  `Title: ${clip(p.title, 150)}`,
  p.site && `Site: ${clip(p.site, 60)}`,
  `Description: ${clip(p.desc, 300)}`,
  p.h?.length && `Headings: ${p.h.slice(0, 10).map(h => clip(h, 80)).join(' | ')}`,
  `Text: ${clip(p.text, 2200)}`,
].filter(Boolean).join('\n');

// media: {img, ico} from the open tab. img '' = checked, none found; undefined = not checked (backfill will look).
async function add(url, title, desc, q, c, media = {}) {
  const id = await idOf(url);
  const dup = await tx(async () => {
    if (S.bm[id] && !S.bm[id].del) return true;
    // Same site saved before under its current or a previous address (address watch can change b.url).
    if (live().some(b => b.url === url || b.hist?.some(h => h.u === url))) return true;
    const now = Date.now();
    put({ id, url, t: clip(title, 120) || host(url), d: clip(desc, 260), tags: [], sec: 'Unsorted', top: 'Inbox', ts: now, u: now, pend: 1, ...media });
    S.q[id] = { d: q, n: 0 };
    await persist();
    return false;
  });
  if (dup) return { st: 'dup', id };
  await enrich(id, c).catch(() => {});
  await push().catch(() => {});
  return { st: 'ok', id };
}

/** p = result of extractPage() from the open tab. */
export async function savePage(p, c) {
  const url = normUrl(p.url);
  if (!url) return { st: 'bad' };
  if (denied(url, c.deny)) return { st: 'denied' };
  return add(url, p.title, p.desc, digest(p), c, { img: p.img || '', ico: p.ico || '' });
}

/** Save by URL only; Gemini reads the page. Used for the PWA and link right-click. */
export async function saveUrl(raw, c) {
  const url = normUrl(raw);
  if (!url) return { st: 'bad' };
  if (denied(url, c.deny)) return { st: 'denied' };
  return add(url, '', '', '@' + url, c);
}

/** Run AI analysis for one queued bookmark. Returns true if filed. */
export async function enrich(id, c) {
  if (!c.gem) return false;
  const j = await tx(() => ({ rec: S.bm[id], q: S.q[id], tax: taxonomy() }));
  if (!j.rec || j.rec.del || !j.q) { await tx(async () => { delete S.q[id]; await persist(); }); return false; }
  let a, v;
  try {
    const by = j.q.d.startsWith('@');
    a = clean(by
      ? await genUrl(c, `Existing sections/topics:\n${j.tax}\n\nFetch ${j.q.d.slice(1)} and describe it.\n${FIELDS}\nReply with the JSON object only.`)
      : await gen(c, `Existing sections/topics:\n${j.tax}\n\nPage:\nURL: ${j.rec.url}\n${j.q.d}\n\n${FIELDS}`, SCHEMA));
    v = await embed(c, docText({ ...a, t: a.t || j.rec.t }));
  } catch (e) {
    if (![429, 401, 403].includes(e.status)) await tx(async () => { // give up after 3 non-rate-limit failures
      const q = S.q[id];
      if (q && ++q.n >= 3) { delete S.q[id]; put({ ...S.bm[id], pend: 0, u: Date.now() }); }
      await persist();
    });
    throw e;
  }
  return tx(async () => {
    const cur = S.bm[id];
    if (!cur || cur.del) { delete S.q[id]; await persist(); return false; }
    const { sec, top } = place(a, v, index(live().filter(b => b.id !== id)), S.vec, th(c));
    const now = Date.now();
    put({ ...cur, t: a.t || cur.t, d: a.d || cur.d, tags: a.tags, sec, top, u: now, pend: 0 }, [now, enc(v)]);
    delete S.q[id];
    await persist();
    return true;
  });
}

/** Retry everything still queued (rate-limited or offline earlier). */
export async function retry() {
  const c = await getCfg();
  if (!c.gem) return 0;
  let n = 0;
  for (const id of await tx(() => Object.keys(S.q))) {
    try { if (await enrich(id, c)) n++; } catch (e) { if ([429, 401, 403].includes(e.status)) break; }
  }
  if (n) await push().catch(() => {});
  return n;
}

/** Edit fields of a bookmark (title, description, tags, section, topic). */
export const edit = (id, p) => tx(async () => {
  const cur = S.bm[id];
  if (!cur) return;
  put({ ...cur, ...p, u: Date.now() });
  delete S.q[id]; // a manual edit wins over any queued AI analysis
  await persist();
}).then(() => push().catch(() => {}));

/** Pin/unpin. pin = time pinned (0 = not pinned). Unlike edit(), keeps any queued AI analysis. */
export const pin = (id, on) => tx(async () => {
  const cur = S.bm[id];
  if (!cur || cur.del) return;
  put({ ...cur, pin: on ? Date.now() : 0, u: Date.now() });
  await persist();
}).then(() => push().catch(() => {}));

export const remove = id => tx(async () => {
  put({ id, del: 1, u: Date.now() });
  delete S.q[id];
  await persist();
}).then(() => push().catch(() => {}));

/** Semantic search: ids of the closest bookmarks to a free-text query. */
export async function semantic(c, q, k = 8, qa = false) {
  const v = await embed(c, queryText(q, qa));
  return tx(() => nearest(v, S.vec, k, id => S.bm[id] && !S.bm[id].del));
}

/** Ask AI: answer only from the closest saved sites. Returns {a, ids}. */
export async function ask(c, q) {
  const hits = await semantic(c, q, 8, true);
  if (!hits.length) return { a: 'No saved sites with AI vectors yet.', ids: [] };
  const rows = hits.map(([id], i) => { const b = S.bm[id]; return `${i + 1}. ${b.t} - ${b.d} (${host(b.url)})`; });
  const r = await gen(c,
    `Saved sites:\n${rows.join('\n')}\n\nQuestion: ${q}\nAnswer in 1-3 sentences using ONLY the saved sites above. Name the site(s). If none fit, say none of the saved sites match. n=numbers of the sites you used.`,
    ASK);
  const ids = [...new Set((r.n || []).map(n => hits[n - 1]?.[0]).filter(Boolean))];
  return { a: clip(r.a, 600), ids, hits: hits.map(h => h[0]) };
}

/** Local (no AI) re-organize. preview(c) lists moves; applyMoves(moves) performs them and returns the undo list (same shape, pass it back to undo). */
export const preview = c => tx(() => reorg(live(), S.vec, th(c))
  .filter(m => { const b = S.bm[m.id]; return b.sec !== m.sec || b.top !== m.top; })
  .map(m => ({ ...m, from: `${S.bm[m.id].sec} / ${S.bm[m.id].top}`, t: S.bm[m.id].t })));

export const applyMoves = moves => tx(async () => {
  const undo = [];
  const now = Date.now();
  for (const m of moves) {
    const b = S.bm[m.id];
    if (!b || b.del) continue;
    undo.push({ id: m.id, sec: b.sec, top: b.top });
    put({ ...b, sec: m.sec, top: m.top, u: now });
  }
  await persist();
  return undo;
}).then(async u => { await push().catch(() => {}); return u; });
