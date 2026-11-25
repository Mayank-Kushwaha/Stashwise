// GitHub Gist REST client (docs.github.com/en/rest/gists). Needs a token with the `gist` scope.
const B = 'https://api.github.com/gists';
export const DESC = 'AI Bookmark Vault data';

async function call(tok, path, init = {}, etag) {
  const r = await fetch(B + path, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + tok,
      Accept: 'application/vnd.github+json',
      ...(etag ? { 'If-None-Match': etag } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 304) return { notModified: true };
  if (!r.ok) throw Object.assign(new Error('GitHub ' + r.status), { status: r.status });
  return { data: r.status === 204 ? null : await r.json(), etag: r.headers.get('etag') };
}

export const get = (tok, id, etag) => call(tok, '/' + id, {}, etag);
export const patch = (tok, id, files) => call(tok, '/' + id, { method: 'PATCH', body: JSON.stringify({ files }) });
export const remove = (tok, id) => call(tok, '/' + id, { method: 'DELETE' });
export const raw = async url => { const r = await fetch(url); if (!r.ok) throw new Error('Raw ' + r.status); return r.text(); };

export const create = async tok => (await call(tok, '', {
  method: 'POST',
  body: JSON.stringify({ description: DESC, public: false, files: { 'README.md': { content: 'Data for AI Bookmark Vault. Edit through the app.' } } }),
})).data.id;

/** Oldest gist of ours (so two devices converge on the same one). */
export async function find(tok) {
  const hits = [];
  for (let p = 1; p <= 5; p++) {
    const { data } = await call(tok, `?per_page=100&page=${p}`);
    hits.push(...data.filter(g => g.description === DESC));
    if (data.length < 100) break;
  }
  return hits.sort((a, b) => a.created_at < b.created_at ? -1 : 1)[0]?.id ?? null;
}

export const ping = tok => call(tok, '?per_page=1');
