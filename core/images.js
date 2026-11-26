// Preview images for cards: og:image / twitter:image + site icon.
// Backfill fetches a page's HTML (extension only, needs the optional all-sites permission). No AI calls.
import { X, denied } from './util.js';
import { getCfg } from './kv.js';
import { S, tx, put, persist, push, live } from './store.js';

export const ORIGINS = { origins: ['http://*/*', 'https://*/*'] };
export const canFetch = async () => !!X?.permissions && X.permissions.contains(ORIGINS).catch(() => false);
export const ask = () => X.permissions.request(ORIGINS); // must be called from a click

/** Absolute http(s) URL or ''. */
export const abs = (u, base) => { try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 600) : ''; } catch { return ''; } };

export const attr = (tag, n) => tag.match(new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(v => v != null);
export const unent = s => s?.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"').trim();
const IMG = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'];

/** Pull {img, ico} out of raw HTML (regex: the background service worker has no DOMParser). */
export function parse(html, base) {
  const head = html.slice(0, 300000);
  const meta = {};
  for (const t of head.match(/<meta\b[^>]*>/gi) || []) {
    const k = (attr(t, 'property') || attr(t, 'name') || '').toLowerCase();
    if (IMG.includes(k) && !meta[k]) meta[k] = unent(attr(t, 'content'));
  }
  let ico = '', icoScore = 0;
  for (const t of head.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(t, 'rel') || '').toLowerCase(), href = unent(attr(t, 'href'));
    if (!href) continue;
    if (!meta.src && rel.split(/\s+/).includes('image_src')) meta.src = href;
    const sc = rel.includes('apple-touch-icon') ? 3 : /(^|\s)icon(\s|$)/.test(rel) ? (/svg/.test(attr(t, 'type') || href) ? 2 : 1) : 0;
    if (sc > icoScore) { icoScore = sc; ico = href; }
  }
  const img = [...IMG.map(k => meta[k]), meta.src].find(Boolean);
  return { img: img ? abs(img, base) : '', ico: abs(ico || '/favicon.ico', base) };
}

export async function fetchMeta(url) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ac.signal, headers: { Accept: 'text/html' } });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return { img: '', ico: abs('/favicon.ico', r.url || url) };
    // Read only the first ~300 KB: the <head> is what we need.
    const rd = r.body.getReader(), dec = new TextDecoder();
    let html = '';
    while (html.length < 300000) { const { done, value } = await rd.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html)) break; }
    rd.cancel().catch(() => {});
    return parse(html, r.url || url);
  } finally { clearTimeout(to); }
}

let running = null;
const failed = new Set();
/** Fill img/ico for bookmarks that were never checked (img === undefined). Returns how many got an image. */
export function backfill() {
  return running ??= (async () => {
    try {
      if (!await canFetch()) return 0;
      const c = await getCfg();
      const todo = await tx(() => live().filter(b => b.img === undefined && !failed.has(b.id) && !denied(b.url, c.deny)).map(b => b.id));
      let found = 0;
      const work = async () => {
        for (let id; (id = todo.shift());) {
          const url = S.bm[id]?.url;
          if (!url) continue;
          let m;
          // Network error/timeout: leave unchecked so a later run retries; skip it for the rest of this session.
          try { m = await fetchMeta(url); } catch { failed.add(id); continue; }
          await tx(async () => { const b = S.bm[id]; if (b && !b.del) { put({ ...b, img: m.img, ico: b.ico || m.ico, u: Date.now() }); await persist(); } });
          if (m.img) found++;
        }
      };
      await Promise.all([work(), work(), work(), work()]);
      await push().catch(() => {});
      return found;
    } finally { running = null; }
  })();
}
