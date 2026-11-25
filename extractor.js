// Injected into the page via scripting.executeScript({func}). Must stay self-contained (no outer references).
export function extractPage() {
  const meta = n => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content?.trim() || '';
  let url = location.href;
  try {
    const c = document.querySelector('link[rel=canonical]')?.href;
    if (c && new URL(c).hostname === location.hostname) url = c;
  } catch { /* keep location.href */ }
  const root = document.querySelector('main,article,[role=main]') || document.body;
  return {
    url,
    title: document.title.trim(),
    desc: meta('description') || meta('og:description'),
    site: meta('og:site_name'),
    h: [...document.querySelectorAll('h1,h2')].slice(0, 12).map(h => h.innerText.trim()).filter(Boolean),
    text: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 4000),
  };
}
