// Gemini REST client (Interactions API for text, embedContent for vectors).
// Docs: aistudio.google.com/docs/interactions, /docs/structured-output, /docs/embeddings
import { sleep, clip, tc, parseJson } from './util.js';
import { norm } from './vec.js';

const B = 'https://generativelanguage.googleapis.com/v1beta/';
const REV = '2026-05-20';

async function post(c, path, body) {
  if (!c.gem) throw Object.assign(new Error('No Gemini key'), { status: 401 });
  for (let i = 0; ; i++) {
    const r = await fetch(B + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.gem, ...(path === 'interactions' ? { 'Api-Revision': REV } : {}) },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();
    if ((r.status === 429 && i < 2) || (r.status >= 500 && i < 1)) { await sleep(1500 * 2 ** i); continue; }
    throw Object.assign(new Error('Gemini ' + r.status), { status: r.status });
  }
}

const text = j => j.output_text ??
  (j.steps || []).filter(s => s.type === 'model_output').flatMap(s => s.content || []).map(x => x.text || '').join('');

// Fallback chain: user's model(s) first, then known-good free models. 503 = overloaded, 404 = model retired.
const FALLBACK = ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-flash-lite-latest'];
const models = c => [...new Set([...String(c.gen || '').split(','), ...FALLBACK].map(s => s.trim()).filter(Boolean))];

// store:false = do not keep the interaction on Google's servers.
async function run(c, input, extra) {
  let err;
  for (const model of models(c)) {
    try { return await post(c, 'interactions', { model, input, store: false, generation_config: { temperature: 0.2 }, ...extra }); }
    catch (e) { err = e; if (![503, 404].includes(e.status)) throw e; }
  }
  throw err;
}

export const gen = async (c, input, schema) =>
  parseJson(text(await run(c, input, { response_format: { type: 'text', mime_type: 'application/json', schema } })));

/** Gemini fetches the page itself (used where we can't scrape: PWA, link right-click). */
export const genUrl = async (c, input) => parseJson(text(await run(c, input, { tools: [{ type: 'url_context' }] })));

export async function embed(c, t) {
  const j = await post(c, `models/${c.emb}:embedContent`, { content: { parts: [{ text: t }] }, output_dimensionality: c.dim });
  const v = j.embedding?.values ?? j.embeddings?.[0]?.values;
  if (!v?.length) throw new Error('Bad embedding response');
  return norm(v);
}
export const docText = a => `title: ${a.t} | text: ${a.d} ${a.tags.join(' ')}`;
export const queryText = (q, qa) => `task: ${qa ? 'question answering' : 'search result'} | query: ${q}`;

const S = { type: 'string' };
export const SCHEMA = {
  type: 'object',
  properties: { t: S, d: S, tags: { type: 'array', items: S }, sec: S, top: S, alt: S, c: { type: 'number' } },
  required: ['t', 'd', 'tags', 'sec', 'top', 'alt', 'c'],
};
export const ASK = { type: 'object', properties: { a: S, n: { type: 'array', items: { type: 'integer' } } }, required: ['a', 'n'] };

export const FIELDS = 'Return JSON: t=clean page title (max 70 chars, no site-name suffix), d=factual 1-2 sentence description of what the site offers (max 200 chars), tags=3-6 lowercase keywords, sec=broad section name (1-3 words), top=specific topic inside the section (1-3 words, e.g. "PDF Tools"), alt=the topic name you would create if no existing topic fits, c=0-1 confidence in top. Reuse an existing section/topic only if the page clearly belongs there; otherwise propose a new one. Use only facts from the page.';

/** Validate and normalize model output. */
export function clean(r) {
  const s = (x, n) => clip(x, n);
  const a = {
    t: s(r.t, 90), d: s(r.d, 260),
    tags: (Array.isArray(r.tags) ? r.tags : []).slice(0, 6).map(x => s(x, 24).toLowerCase()).filter(Boolean),
    sec: tc(s(r.sec, 30)), top: tc(s(r.top, 40)), alt: tc(s(r.alt, 40)),
  };
  if (!a.sec || !a.top) { a.sec = 'Unsorted'; a.top = 'Inbox'; }
  return a;
}
