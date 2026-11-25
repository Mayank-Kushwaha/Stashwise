// Shared helpers. No dependencies.
export const X = globalThis.browser ?? globalThis.chrome;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const tc = s => s.replace(/(^|\s)\p{L}/gu, m => m.toUpperCase());
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

const TRACK = /^(utm_|fbclid$|gclid$|mc_[ce]id$|igshid$|ref$|ref_src$)/i;
/** Canonical form of a URL used for dedupe. Returns '' for non-http(s). */
export function normUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return '';
    x.hash = '';
    x.hostname = x.hostname.replace(/^www\./, '');
    for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    return x.href.replace(/\/$/, '');
  } catch { return ''; }
}

export const idOf = async u =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(u))).slice(0, 9)]
    .map(b => b.toString(16).padStart(2, '0')).join('');

// Never send these pages to a third-party AI: local/private hosts, mail, auth, banking, password managers.
const DENY = /^(localhost|.+\.(local|internal|lan))$|^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)|^(mail|accounts|login|signin|auth|secure)\.|(bank|paypal|1password|lastpass|bitwarden)/i;
export function denied(url, extra = '') {
  const h = host(url);
  return !h || DENY.test(h) ||
    extra.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(s => h.includes(s));
}

/** Pull the first JSON object out of model text (tolerates code fences). */
export function parseJson(t) {
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('No JSON in response');
  return JSON.parse(t.slice(a, b + 1));
}
