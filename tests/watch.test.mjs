// Address-watch tests: fake network, no keys. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = {};
globalThis.chrome = {
  storage: { local: { get: async k => ({ [k]: mem[k] }), set: async o => Object.assign(mem, structuredClone(o)) } },
  permissions: { contains: async () => true }, // the all-sites permission is granted; no tabs API, so no tab fallback
};
// net[url] = { status, final, html, cf } | 'down' (DNS/connection failure)
const net = {};
const page = (title, extra = '') => `<html><head><title>${title}</title>${extra}</head><body>${'Real page content. '.repeat(20)}</body></html>`;
globalThis.fetch = async url => {
  const r = net[String(url)];
  if (!r || r === 'down') throw new TypeError('fetch failed');
  const h = { 'content-type': 'text/html; charset=utf-8', ...(r.cf ? { 'cf-mitigated': r.cf } : {}) };
  return { status: r.status ?? 200, url: r.final ?? String(url), headers: { get: k => h[k.toLowerCase()] ?? null }, text: async () => r.html ?? '' };
};

const { S, tx, put, persist, live } = await import('../core/store.js');
const W = await import('../core/watch.js');
const { savePage } = await import('../core/save.js');

const add = (id, url, t) => tx(async () => { put({ id, url, t, d: '', tags: [], sec: 'S', top: 'T', ts: 1, u: 1, w: 1, img: 'https://old/og.png', ico: 'x' }); await persist(); });
const check = (id, counted = false) => W.checkOne(id, counted);

test('brand() reduces a host to the site name', () => {
  assert.equal(W.brand('vegamovies.xyz'), 'vegamovies');
  assert.equal(W.brand('www.youtube.com'), 'youtube');
  assert.equal(W.brand('tabworthy.pages.dev'), 'tabworthy');
  assert.equal(W.brand('mayank-kushwaha.in'), 'mayankkushwaha');
  assert.equal(W.brand('example.co.uk'), 'example');
});

test('domain move with a matching site is applied automatically', async () => {
  await add('a', 'https://vegamovies.xyz', 'Vegamovies | Download Latest Bollywood Movies');
  net['https://vegamovies.xyz'] = { final: 'https://vegamovies.nz/', html: page('Vegamovies - Download Movies') };
  const r = await check('a');
  assert.equal(r.st, 'moved');
  const b = S.bm.a;
  assert.equal(b.url, 'https://vegamovies.nz');
  assert.equal(b.hist[0].u, 'https://vegamovies.xyz');
  assert.ok(b.wch > 0, 'marked as updated');
  assert.equal(b.img, undefined, 'preview re-fetched for the new address');
  // saving either address again is recognised as the same bookmark
  assert.equal((await savePage({ url: 'https://vegamovies.xyz/', title: 'x' }, { deny: '' })).st, 'dup');
  assert.equal((await savePage({ url: 'https://www.vegamovies.nz', title: 'x' }, { deny: '' })).st, 'dup');
});

test('redirect to an unrelated site goes to review, not applied', async () => {
  await add('b', 'https://rogmovies.beauty', 'Rogmovies 2026 - Download Free HD Movies');
  net['https://rogmovies.beauty'] = { final: 'https://totally-other.com/landing', html: page('Win a prize now') };
  const r = await check('b');
  assert.equal(r.st, 'review');
  assert.equal(S.bm.b.url, 'https://rogmovies.beauty');
  assert.equal(S.bm.b.wv.to, 'https://totally-other.com/landing');
  // rejecting it stops the same suggestion coming back
  await W.reject('b');
  assert.equal(S.bm.b.wv, undefined);
  assert.deepEqual(S.bm.b.wno, ['totally-other.com']);
  assert.equal((await check('b')).st, 'ok');
  assert.equal(S.bm.b.wv, undefined);
});

test('same brand in the host but an unrelated page title goes to review', async () => {
  await add('b2', 'https://animesite.to', 'AnimeSite - Watch Anime Free');
  net['https://animesite.to'] = { final: 'https://animesite-deals.com/', html: page('Cheap phone cases and chargers') };
  assert.equal((await check('b2')).st, 'review');
  await W.accept('b2');
  assert.equal(S.bm.b2.url, 'https://animesite-deals.com', 'accept switches the address');
  await W.setUrl('b2', S.bm.b2.hist[0].u);
  assert.equal(S.bm.b2.url, 'https://animesite.to', 'restore brings the old address back');
});

test('parked / for-sale domains are never followed', async () => {
  await add('c', 'https://coolsite.xyz', 'Coolsite tools');
  net['https://coolsite.xyz'] = { final: 'https://sedo.com/search/details/?domain=coolsite.xyz', html: page('coolsite.xyz is for sale') };
  assert.equal((await check('c')).st, 'fail');
  net['https://coolsite.xyz'] = { final: 'https://coolsite.xyz', html: page('coolsite.xyz - This domain may be for sale!') };
  assert.equal((await check('c')).st, 'ok', 'same host: parked title alone does not move it');
  assert.equal(S.bm.c.url, 'https://coolsite.xyz');
});

test('same-site redirects (https, www, paths) are ignored', async () => {
  await add('d', 'http://site.dev/old', 'Site Dev');
  net['http://site.dev/old'] = { final: 'https://www.site.dev/new/path', html: page('Site Dev') };
  assert.equal((await check('d')).st, 'ok');
  assert.equal(S.bm.d.url, 'http://site.dev/old');
});

test('page refresh tag and script redirects to the same site name are followed; ad scripts are ignored', async () => {
  await add('e', 'https://moviebox.lol', 'MovieBox - Stream Movies');
  net['https://moviebox.lol'] = { html: page('Moved', '<meta http-equiv="refresh" content="0; url=https://moviebox.cam/">') };
  net['https://moviebox.cam/'] = { html: page('MovieBox Official') };
  assert.equal((await check('e')).st, 'moved');
  assert.equal(S.bm.e.url, 'https://moviebox.cam');

  await add('f', 'https://toonhub.io', 'ToonHub cartoons');
  net['https://toonhub.io'] = { html: page('Redirecting', '<script>window.location.href = "https://toonhub.net/home";</script>') };
  net['https://toonhub.net/home'] = { html: page('ToonHub') };
  assert.equal((await check('f')).st, 'moved');
  assert.equal(S.bm.f.url, 'https://toonhub.net/home');

  await add('g', 'https://newsy.app', 'Newsy daily');
  net['https://newsy.app'] = { html: page('Newsy', '<script>if(x) location.href = "https://ads.tracker.com/click";</script>') };
  assert.equal((await check('g')).st, 'ok', 'script target without the site name is treated as an ad');
});

test('bot protection is "unknown", never counted as down', async () => {
  await add('h', 'https://guarded.site', 'Guarded');
  net['https://guarded.site'] = { status: 403, cf: 'challenge', html: '<title>Just a moment...</title>' };
  for (let i = 0; i < 4; i++) assert.equal((await check('h', true)).st, 'unknown');
  assert.ok(!S.bm.h.wd);
});

test('three failed nightly checks mark it unreachable; manual checks do not count; recovery clears it', async () => {
  await add('i', 'https://gone.example', 'Gone');
  net['https://gone.example'] = 'down';
  await check('i'); await check('i'); await check('i');
  assert.ok(!S.bm.i.wd, 'manual checks are not counted');
  await check('i', true); await check('i', true);
  assert.ok(!S.bm.i.wd);
  await check('i', true);
  assert.ok(S.bm.i.wd > 0, 'unreachable after 3 nights');
  net['https://gone.example'] = { html: page('Gone is back') };
  assert.equal((await check('i', true)).st, 'ok');
  assert.equal(S.bm.i.wd, 0);
});

test('nextNight picks 1-5 am, never the slot that just ran', () => {
  const at = (h, m = 0) => { const d = new Date(2026, 5, 10, h, m); return d.getTime(); };
  const n1 = new Date(W.nextNight(at(10), 0.5));
  assert.deepEqual([n1.getDate(), n1.getHours()], [11, 3]);
  const n2 = new Date(W.nextNight(at(0, 30), 0.5));
  assert.deepEqual([n2.getDate(), n2.getHours()], [10, 3]);
  const n3 = new Date(W.nextNight(at(1, 30) + 6 * 3600e3, 0.9)); // after a run at 1:30 the next is tomorrow
  assert.equal(n3.getDate(), 11);
});

test('nightly: first call only schedules; forced run checks watched cards only', async () => {
  await tx(async () => { put({ id: 'z', url: 'https://unwatched.example', t: 'U', ts: 1, u: 1 }); await persist(); });
  delete mem.watch;
  assert.equal(await W.nightly(), 0);
  assert.ok(mem.watch.next > Date.now());
  for (const id of Object.keys(S.bm)) if (S.bm[id].w) net[S.bm[id].url] ??= { html: page(S.bm[id].t) };
  let hit = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async u => { if (String(u).includes('unwatched')) hit++; return real(u); };
  await W.nightly(true);
  globalThis.fetch = real;
  assert.equal(hit, 0, 'unwatched bookmark was not requested');
  assert.ok(Object.keys(mem.watch.chk).length >= live().filter(b => b.w).length);
});

test('turning watch off clears its status', async () => {
  await W.setWatch('i', false);
  assert.equal(S.bm.i.w, 0);
  assert.equal(S.bm.i.wd, 0);
});
