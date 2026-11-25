// Offline tests (no network, no keys). Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

// ---- fake extension storage + fake GitHub/Gemini, installed before core modules load ----
const mem = {};
globalThis.chrome = { storage: { local: { get: async k => ({ [k]: mem[k] }), set: async o => Object.assign(mem, structuredClone(o)) } } };
const gist = { files: {}, calls: 0 };
let aiFail = 0;
const words = ['pdf', 'merge', 'compress', 'react', 'component', 'css', 'design', 'font', 'sql', 'database'];
const fakeVec = t => words.map(w => (t.toLowerCase().includes(w) ? 1 : 0) + 0.01);
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body ? JSON.parse(init.body) : null;
  const ok = j => ({ ok: true, status: 200, headers: { get: () => 'W/"1"' }, json: async () => j, text: async () => '' });
  if (u.includes('api.github.com')) {
    gist.calls++;
    if (init.method === 'POST') return ok({ id: 'g1' });
    if (init.method === 'PATCH') { for (const [n, f] of Object.entries(body.files)) gist.files[n] = { content: f.content }; return ok({}); }
    if (u.includes('?per_page')) return ok([{ id: 'g1', description: 'AI Bookmark Vault data', created_at: '2026-01-01' }]);
    return ok({ files: gist.files });
  }
  if (u.includes('embedContent')) return ok({ embedding: { values: fakeVec(body.content.parts[0].text) } });
  if (u.includes('/interactions')) {
    if (aiFail) { aiFail--; return { ok: false, status: 429, headers: { get: () => null } }; }
    const p = body.input, pdf = /pdf/i.test((p.split('Page:')[1] || p).split('Return JSON')[0]);
    const r = pdf ? { t: 'iLovePDF', d: 'Free PDF tools to merge and compress.', tags: ['pdf', 'tools'], sec: 'Productivity', top: 'PDF Tools', alt: 'Document Utilities', c: 0.9 }
      : { t: 'React Docs', d: 'Official React component docs.', tags: ['react'], sec: 'Development', top: 'Frontend', alt: 'UI Libraries', c: 0.9 };
    return ok({ steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(r) }] }] });
  }
  throw new Error('unexpected fetch ' + u);
};

const { normUrl, denied, idOf, parseJson } = await import('../core/util.js');
const { merge } = await import('../core/merge.js');
const { kw, rrf } = await import('../core/search.js');
const { enc, dec, dot, norm } = await import('../core/vec.js');
const { place, reorg, index, TH } = await import('../core/topics.js');
const { S, sync, live } = await import('../core/store.js');
const { savePage, retry, edit, pin, remove, ask } = await import('../core/save.js');
const { saveCfg, getCfg } = await import('../core/kv.js');

test('normUrl strips tracking, hash, www, trailing slash; rejects non-http', () => {
  assert.equal(normUrl('https://www.Example.com/a/?utm_source=x&b=2&a=1#frag'), 'https://example.com/a/?a=1&b=2'.replace('/a/?', '/a/?'));
  assert.equal(normUrl('https://example.com/'), 'https://example.com');
  assert.equal(normUrl('chrome://settings'), '');
  assert.equal(normUrl('javascript:alert(1)'), '');
});

test('denied blocks private, auth, banking and user words', () => {
  for (const u of ['http://localhost:3000', 'http://192.168.1.4', 'https://mail.google.com', 'https://mybank.com', 'https://login.site.com'])
    assert.ok(denied(u), u);
  assert.ok(!denied('https://ilovepdf.com'));
  assert.ok(denied('https://corp-wiki.example.com', 'corp-wiki'));
});

test('parseJson tolerates code fences', () => assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 }));

test('merge: newest wins, tombstone removes vector, other-model vectors ignored', () => {
  const m = merge(
    [{ id: 'a', u: 1, t: 'old' }, { id: 'a', u: 2, t: 'new' }, { id: 'b', u: 1 }, { id: 'b', del: 1, u: 2 }],
    [{ m: 'x:1', v: { a: [1, 's'], b: [1, 's'] } }, { m: 'y:1', v: { a: [9, 'z'] } }], 'x:1');
  assert.equal(m.bm.a.t, 'new');
  assert.ok(m.bm.b.del);
  assert.deepEqual(Object.keys(m.vec), ['a']);
});

test('vector int8 round trip keeps cosine within 1%', () => {
  const v = norm(Array.from({ length: 768 }, (_, i) => Math.sin(i * 1.7) + Math.cos(i * 0.3)));
  const r = dec([0, enc(v)], 'rt');
  assert.ok(dot(v, r) > 0.99);
  assert.ok(enc(v).length < 1100);
});

test('keyword search: all terms must match, title outranks description', () => {
  const b = [{ id: 1, t: 'PDF tools', d: '', tags: [], sec: '', top: '', url: '' }, { id: 2, t: 'Other', d: 'has pdf tools', tags: [], sec: '', top: '', url: '' }];
  assert.deepEqual(kw(b, 'pdf tools').map(x => x.id), [1, 2]);
  assert.equal(kw(b, 'pdf zzz').length, 0);
  assert.deepEqual(rrf([['a', 'b'], ['b', 'c']]), ['b', 'a', 'c']);
});

test('place: wrong-topic guard and near-duplicate reuse', () => {
  const mk = (id, sec, top, text) => ({ b: { id, sec, top }, v: [Date.now(), enc(norm(fakeVec(text)))] });
  const rows = [mk('1', 'Dev', 'Frontend', 'react component'), mk('2', 'Dev', 'Frontend', 'css design react'), mk('3', 'Prod', 'PDF Tools', 'pdf merge'), mk('4', 'Prod', 'PDF Tools', 'pdf compress')];
  const vec = Object.fromEntries(rows.map(r => [r.b.id, r.v]));
  const idx = index(rows.map(r => r.b));
  // AI wrongly says Frontend for a database site: guard must refuse and use the alternative new topic
  const bad = place({ sec: 'Dev', top: 'Frontend', alt: 'Databases' }, norm(fakeVec('sql database')), idx, vec, TH);
  assert.equal(bad.top, 'Databases');
  // Same wrong pick for a PDF site: guard refuses, and the alternative is folded into the existing PDF topic
  const fold = place({ sec: 'Dev', top: 'Frontend', alt: 'Document Utilities' }, norm(fakeVec('pdf merge compress')), idx, vec, TH);
  assert.deepEqual(fold, { sec: 'Prod', top: 'PDF Tools' });
  // AI proposes a new topic name for something identical to PDF Tools: reuse existing
  const dup = place({ sec: 'Docs', top: 'PDF Editors', alt: 'x' }, norm(fakeVec('pdf merge')), idx, vec, TH);
  assert.deepEqual(dup, { sec: 'Prod', top: 'PDF Tools' });
  // Correct pick passes through, casing canonicalized
  const ok = place({ sec: 'dev', top: 'frontend', alt: 'x' }, norm(fakeVec('react component')), idx, vec, TH);
  assert.deepEqual(ok, { sec: 'Dev', top: 'Frontend' });
});

test('reorg merges duplicate topics and moves outliers', () => {
  const rows = [];
  const add = (id, top, text) => rows.push({ b: { id, sec: 'S', top }, v: [1, enc(norm(fakeVec(text)))] });
  add('1', 'PDF Tools', 'pdf merge'); add('2', 'PDF Tools', 'pdf compress'); add('3', 'PDF Tools', 'pdf merge compress');
  add('4', 'PDF Editors', 'pdf merge');
  add('5', 'Frontend', 'react component'); add('6', 'Frontend', 'css design'); add('7', 'Frontend', 'react css'); add('8', 'Frontend', 'pdf merge compress'); // 8 is an outlier
  const vec = Object.fromEntries(rows.map(r => [r.b.id, r.v]));
  const mv = Object.fromEntries(reorg(rows.map(r => r.b), vec, TH).map(m => [m.id, m.top]));
  assert.equal(mv['4'], 'PDF Tools');
  assert.equal(mv['8'], 'PDF Tools');
  assert.equal(mv['5'], undefined);
});

test('pipeline: save -> AI file -> sync to gist; second device record merges; rate limit queues and retries', async () => {
  await saveCfg({ gh: 'tok', gem: 'key', dim: 768 });
  const page = (url, title, text) => ({ url, title, desc: '', h: [], text, img: 'https://cdn.example/og.png', ico: '' });

  const r1 = await savePage(page('https://www.ilovepdf.com/?utm_source=x', 'iLovePDF', 'merge pdf compress pdf'), await getCfg());
  assert.equal(r1.st, 'ok');
  let b = live()[0];
  assert.equal(b.top, 'PDF Tools');
  assert.equal(b.img, 'https://cdn.example/og.png', 'preview image kept through AI filing');
  assert.equal(b.pend, 0);
  assert.ok(S.vec[b.id]);
  assert.equal((await savePage(page('https://ilovepdf.com', 'x', 'pdf'), await getCfg())).st, 'dup');
  assert.equal((await savePage(page('http://localhost:3000', 'x', ''), await getCfg())).st, 'denied');
  assert.ok(gist.files[`bm-${S.dev}.json`] && gist.files[`vec-${S.dev}.json`], 'own files uploaded');

  // rate limit: saved locally, queued, then filed on retry
  aiFail = 3;
  const r2 = await savePage(page('https://react.dev', 'React', 'react component'), await getCfg());
  assert.equal(r2.st, 'ok');
  assert.equal(S.bm[r2.id].pend, 1);
  assert.equal(await retry(), 1);
  assert.equal(S.bm[r2.id].top, 'Frontend');

  // another device wrote a bookmark into its own file
  gist.files['bm-other.json'] = { content: JSON.stringify([{ id: 'zz', url: 'https://site.dev', t: 'Site', d: '', tags: [], sec: 'Dev', top: 'Frontend', ts: 1, u: Date.now() + 5 }]) };
  S.etag = null;
  await sync();
  assert.ok(S.bm.zz);

  // edit and delete propagate as newer records
  await edit('zz', { t: 'Renamed' });
  assert.equal(JSON.parse(gist.files[`bm-${S.dev}.json`].content).find(x => x.id === 'zz').t, 'Renamed');
  // pin syncs as a newer record and does not cancel queued AI work
  S.q.zz = { d: 'x', n: 0 };
  await pin('zz', true);
  assert.ok(S.bm.zz.pin > 0 && S.q.zz, 'pinned, still queued');
  assert.ok(JSON.parse(gist.files[`bm-${S.dev}.json`].content).find(x => x.id === 'zz').pin > 0);
  await pin('zz', false);
  assert.equal(S.bm.zz.pin, 0);
  delete S.q.zz;

  await remove(r2.id);
  assert.ok(!live().some(x => x.id === r2.id));

  // Ask AI only links sites it was given
  const a = await ask(await getCfg(), 'which site has pdf tools?');
  assert.ok(a.hits.includes(b.id));
});

test('preview parse: og:image priority, relative URLs, entities, icon choice', async () => {
  const { parse } = await import('../core/images.js');
  const html = `<head><meta name="twitter:image" content="https://cdn.x.com/t.png">
    <meta content='/img/og.png?a=1&amp;b=2' property="og:image"><link rel="icon" href="/f.ico"><link rel="apple-touch-icon" href="/apple.png"></head>`;
  assert.deepEqual(parse(html, 'https://site.com/page'), { img: 'https://site.com/img/og.png?a=1&b=2', ico: 'https://site.com/apple.png' });
  assert.deepEqual(parse('<html><body>none</body></html>', 'https://a.com/x'), { img: '', ico: 'https://a.com/favicon.ico' });
  assert.equal(parse('<meta property="og:image" content="javascript:alert(1)">', 'https://a.com').img, '');
});

test('idOf is stable per URL', async () => assert.equal(await idOf('https://a.com'), await idOf('https://a.com')));
