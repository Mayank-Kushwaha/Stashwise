// Address watch: once a night, check watched bookmarks and follow them when a site moves to a new domain.
// Extension only (needs the optional all-sites permission). No AI calls.
//
// Synced fields on a bookmark: w=1 watched, hist=[{u,at}] previous addresses, wv={to,why,at} change waiting
// for review, wd=time marked unreachable, wch=time of last automatic update, wno=[hosts] rejected changes.
// Device-local state (kv 'watch'): next run time, consecutive failure counts, last result per bookmark.
import { X, host, normUrl, sleep } from './util.js';
import { get as kvGet, set as kvSet } from './kv.js';
import { S, tx, put, persist, push, live } from './store.js';
import { canFetch, abs, attr, unent } from './images.js';

const FAILS = 3; // nightly failures in a row before a card shows "Unreachable"
const CHAL = /challenge-platform|cf-chl-|Just a moment\.\.\.|Attention Required! \| Cloudflare|checking your browser|ddos-guard/i;
const PARKH = /(^|\.)(sedo|sedoparking|parkingcrew|bodis|dan|afternic|hugedomains|undeveloped|parklogic|domainmarket|above|squadhelp)\.(com|net|io)$|^parkingpage\.namecheap\.com$/i;
const PARKT = /domain (name )?(is )?for sale|buy this domain|this domain (may be|is) for sale|parked (free|domain)|domain parking|is parked/i;
const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'pages', 'github', 'gitlab', 'vercel', 'netlify', 'web', 'firebaseapp', 'herokuapp', 'blogspot', 'wordpress', 'onrender', 'workers', 'glitch']);
const STOP = new Set(['download', 'free', 'online', 'latest', 'home', 'official', 'page', 'site', 'website', 'with', 'your', 'from', 'best', 'and', 'the', 'for']);
const az = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Site name from a host: "vegamovies.xyz" -> "vegamovies", "tabworthy.pages.dev" -> "tabworthy". */
export function brand(h) {
  const l = String(h || '').toLowerCase().replace(/^(www|m)\./, '').split('.');
  if (l.length > 1) l.pop();
  while (l.length > 1 && SLD.has(l[l.length - 1])) l.pop();
  return az(l.pop());
}
const words = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !STOP.has(w)));
const overlap = (a, b) => { const x = words(a); let n = 0; for (const w of words(b)) if (x.has(w)) n++; return n; };
const hasBrand = (b, to) => { const br = brand(host(b.url)); return br.length >= 4 && az(host(to)).includes(br); };

/**
 * Does the new address look like the same site? Its host must contain the old site name, and its page title
 * (when readable) must name the site too or share 2+ real words with the saved title.
 */
export function sameSite(b, to, page) {
  const br = brand(host(b.url));
  if (!hasBrand(b, to)) return false;
  if (!page?.title) return true; // bot protection hid the page; the host match is the evidence
  return az(page.title + ' ' + (page.site || '')).includes(br) || overlap(b.t, page.title) >= 2;
}

/** Signals in a page's HTML: title, site name, refresh/script redirect targets, canonical address. */
export function inspect(html, base) {
  const h = String(html || '').slice(0, 100000);
  let refresh = '', site = '', ogurl = '';
  for (const t of h.match(/<meta\b[^>]*>/gi) || []) {
    const he = (attr(t, 'http-equiv') || '').toLowerCase(), k = (attr(t, 'property') || attr(t, 'name') || '').toLowerCase(), c = unent(attr(t, 'content')) || '';
    if (he === 'refresh') { const m = c.match(/url\s*=\s*['"]?([^'";\s]+)/i); if (m) refresh = abs(m[1], base); }
    else if (k === 'og:site_name') site = c;
    else if (k === 'og:url') ogurl = abs(c, base);
  }
  const cl = h.match(/<link\b[^>]*\brel\s*=\s*["']?canonical\b[^>]*>/i)?.[0];
  const js = h.match(/(?:location(?:\.href)?\s*=|location\.(?:replace|assign)\()\s*["'](https?:\/\/[^"'\s]+)["']/i)?.[1];
  const text = h.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    title: unent(h.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    site, refresh,
    canonical: (cl && abs(unent(attr(cl, 'href')) || '', base)) || ogurl,
    js: js ? abs(js, base) : '',
    thin: h.length < 3000 && text.length < 200 && /<script/i.test(h), // probably redirects by script
    chal: CHAL.test(h.slice(0, 30000)),
  };
}

/** One request, no cookies, redirects followed; reads at most ~100 KB. */
async function fetchPage(url) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(url, { credentials: 'omit', redirect: 'follow', cache: 'no-store', signal: ac.signal, headers: { Accept: 'text/html,*/*;q=0.8' } });
    let html = '';
    if (/html|text/i.test(r.headers.get('content-type') || '')) {
      if (r.body?.getReader) {
        const rd = r.body.getReader(), dec = new TextDecoder();
        while (html.length < 100000) { const { done, value } = await rd.read(); if (done) break; html += dec.decode(value, { stream: true }); }
        rd.cancel().catch(() => {});
      } else html = (await r.text()).slice(0, 100000);
    }
    return { status: r.status, final: r.url || url, html, cf: r.headers.get('cf-mitigated') };
  } finally { clearTimeout(to); }
}

/** Turn a candidate new address into a result. */
function decide(b, raw, page, status, why) {
  const to = normUrl(raw);
  if (!to) return { st: 'fail', why: 'The old address now leads to an error page' };
  if (PARKH.test(host(to)) || PARKT.test(page?.title || '')) return { st: 'fail', why: 'The old address now shows a domain-parking or for-sale page' };
  if (b.wno?.includes(host(to))) return { st: 'ok', why: 'Forwards to an address you rejected' };
  if (status >= 400 && ![401, 403, 429, 503].includes(status)) return { st: 'review', to, why: `${why}, but that page answered with error ${status}` };
  return { st: sameSite(b, to, page) ? 'moved' : 'review', to, why };
}

/** Quick check with plain requests. st: ok | moved | review | fail | unclear. */
export async function probe(b) {
  let r;
  try { r = await fetchPage(b.url); } catch { return { st: 'fail', why: 'No response: the site is down or the address no longer exists' }; }
  const p = inspect(r.html, r.final);
  const bot = r.cf === 'challenge' || [401, 403, 429].includes(r.status) || p.chal;
  if (host(r.final) !== host(b.url)) return decide(b, r.final, bot ? null : p, r.status, 'The old address redirects here');
  if (bot) return { st: 'unclear', why: 'The site blocks automated checks' };
  if (r.status >= 400) return { st: 'fail', why: `The site answered with error ${r.status}` };
  const hops = [[p.refresh, 'The page forwards here'], [p.js && hasBrand(b, p.js) && p.js, 'A script on the page forwards here']]; // script targets without the site name are usually ads
  for (const [to, why] of hops) {
    if (!to || host(to) === host(b.url)) continue;
    try { const d = await fetchPage(to); const q = inspect(d.html, d.final); return decide(b, d.final, q.chal ? null : q, d.status, why); }
    catch { return { st: 'review', to: normUrl(to), why: `${why}, but it could not be opened` }; }
  }
  if (p.canonical && host(p.canonical) !== host(b.url) && hasBrand(b, p.canonical)) return decide(b, p.canonical, p, 200, 'The page names this as its main address');
  if (p.thin) return { st: 'unclear', why: 'The page loads by script' };
  return { st: 'ok' };
}

/* ---- background-tab fallback for script redirects and bot checks ---- */
// Injected into the checked tab; must stay self-contained.
export function pageInfo() {
  const m = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || '';
  return {
    title: document.title, site: m('og:site_name'),
    chal: /just a moment|attention required|checking your browser|ddos-guard/i.test(document.title) || !!document.querySelector('#challenge-form,#cf-challenge-running,[name="cf-turnstile-response"]'),
  };
}
function settle(id, ms) {
  return new Promise(res => {
    let to;
    const on = (tid, ch) => { if (tid === id && ch.status === 'complete') done(); };
    const done = () => { clearTimeout(to); X.tabs.onUpdated.removeListener(on); res(); };
    to = setTimeout(done, ms);
    X.tabs.onUpdated.addListener(on);
    X.tabs.get(id).then(t => t.status === 'complete' && done(), done);
  });
}
async function openTab(url) {
  if (!X?.tabs?.create || !X.scripting) return null;
  let id;
  try {
    ({ id } = await X.tabs.create({ url, active: false }));
    X.tabs.update(id, { muted: true }).catch(() => {});
    await settle(id, 20000);
    await sleep(4000); // give script redirects time to run
    await settle(id, 10000);
    const t = await X.tabs.get(id);
    let info = null;
    try { [{ result: info }] = await X.scripting.executeScript({ target: { tabId: id }, func: pageInfo }); } catch { /* error page */ }
    return { final: t.url || '', title: info?.title || '', site: info?.site || '', chal: !!info?.chal };
  } catch { return null; }
  finally { if (id != null) X.tabs.remove(id).catch(() => {}); }
}
let tabQ = Promise.resolve(); // one tab at a time
const viaTab = url => { const r = tabQ.then(() => openTab(url)); tabQ = r.catch(() => {}); return r; };

async function deep(b, why) {
  const t = await viaTab(b.url);
  if (!t) return { st: 'unknown', why };
  if (t.chal) return { st: 'unknown', why: 'The site blocks automated checks' };
  if (host(t.final) !== host(b.url)) return decide(b, t.final, t.title ? t : null, 200, 'The old address forwards here in a browser');
  return { st: 'ok' };
}

/* ---- state ---- */
let wq = Promise.resolve();
const updW = f => { const r = wq.then(async () => { const w = { f: {}, chk: {}, next: 0, ...(await kvGet('watch')) }; const out = f(w); await kvSet({ watch: w }); return out; }); wq = r.catch(() => {}); return r; };
export const watchState = async () => ({ f: {}, chk: {}, next: 0, ...(await kvGet('watch')) });

/** Bookmark with its address replaced; the old one goes to the history. */
export function relocate(b, to, now, auto) {
  const { wv, ...rest } = b;
  return {
    ...rest, url: to, wd: 0, wch: auto ? now : 0, img: undefined, ico: '', // preview is looked up again for the new address
    hist: [{ u: b.url, at: now }, ...(b.hist || []).filter(h => h.u !== to && h.u !== b.url)].slice(0, 5),
  };
}

async function apply(id, r, counted) {
  const now = Date.now();
  const f = await updW(w => {
    let n = w.f[id] || 0;
    if (r.st === 'fail') n += counted ? 1 : 0; else if (r.st !== 'unknown') n = 0;
    if (n) w.f[id] = n; else delete w.f[id];
    w.chk[id] = { at: now, st: r.st, why: r.why || '', to: r.to || '' };
    return n;
  });
  return tx(async () => {
    const b = S.bm[id];
    if (!b || b.del) return false;
    let nb = null;
    if (r.st === 'moved') {
      const clash = live().some(x => x.id !== id && x.url === r.to);
      nb = clash ? { ...b, wd: 0, wv: { to: r.to, why: `${r.why}. That address is also saved as another bookmark`, at: now } } : relocate(b, r.to, now, true);
    } else if (r.st === 'review') { if (b.wv?.to !== r.to || b.wd) nb = { ...b, wd: 0, wv: { to: r.to, why: r.why, at: now } }; }
    else if (r.st === 'ok') { if (b.wd) nb = { ...b, wd: 0 }; }
    else if (r.st === 'fail' && f >= FAILS && !b.wd) nb = { ...b, wd: now };
    if (!nb) return false;
    put({ ...nb, u: now });
    await persist();
    return true;
  });
}

/** Check one bookmark now. counted=true for the nightly run (only those count toward "Unreachable"). */
export async function checkOne(id, counted = false) {
  const b = await tx(() => S.bm[id]);
  if (!b || b.del) return null;
  let r = await probe(b);
  if (r.st === 'unclear') r = await deep(b, r.why);
  await apply(id, r, counted);
  if (!counted) await push().catch(() => {});
  return r;
}

/** Random time between 1 and 5 am after `from`. */
export function nextNight(from = Date.now(), rnd = Math.random()) {
  const d = new Date(from);
  d.setHours(1, 0, 0, 0);
  let t = d.getTime() + rnd * 4 * 3600e3;
  if (t <= from) { d.setDate(d.getDate() + 1); t = d.getTime() + rnd * 4 * 3600e3; }
  return t;
}

let running = null;
/** Called every few minutes by the background; runs the check once the scheduled night time has passed. */
export function nightly(force = false) {
  return running ??= (async () => {
    try {
      if (!await canFetch()) return 0;
      const now = Date.now();
      const due = await updW(w => {
        if (!w.next) { w.next = nextNight(now); return false; }
        if (!force && now < w.next) return false;
        w.next = nextNight(now + 6 * 3600e3); // set before running, so a crash can't cause a loop
        return true;
      });
      if (!due) return 0;
      const ids = await tx(() => live().filter(b => b.w).map(b => b.id));
      let changed = 0;
      const work = async () => {
        for (let id; (id = ids.shift());) {
          try { const r = await checkOne(id, true); if (r?.st === 'moved' || r?.st === 'review') changed++; } catch { /* next */ }
        }
      };
      await Promise.all([work(), work(), work()]);
      await push().catch(() => {});
      return changed;
    } finally { running = null; }
  })();
}

/* ---- user actions ---- */
const change = f => tx(async () => {
  const nb = f();
  if (!nb) return false;
  put({ ...nb, u: Date.now() });
  await persist();
  return true;
}).then(async ok => { if (ok) await push().catch(() => {}); return ok; });

export const setWatch = (id, on) => change(() => {
  const b = S.bm[id];
  if (!b || b.del) return null;
  const { wv, ...rest } = b;
  return on ? { ...b, w: 1 } : { ...rest, w: 0, wd: 0 };
});
export const accept = id => change(() => { const b = S.bm[id]; return b?.wv ? relocate(b, b.wv.to, Date.now(), true) : null; });
export const reject = id => change(() => {
  const b = S.bm[id];
  if (!b?.wv) return null;
  const { wv, ...rest } = b;
  return { ...rest, wno: [...new Set([host(wv.to), ...(b.wno || [])])].slice(0, 10) };
});
/** Manual address change (edit dialog, restoring an old address). */
export const setUrl = (id, raw) => change(() => {
  const b = S.bm[id], to = normUrl(raw);
  return b && !b.del && to && to !== b.url ? relocate(b, to, Date.now(), false) : null;
});
