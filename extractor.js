// Injected into the page via scripting.executeScript({func}). Must stay self-contained (no outer references).
export function extractPage() {
  const meta = n => document.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content?.trim() || '';
  const abs = u => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href.slice(0, 600) : ''; } catch { return ''; } };
  let url = location.href;
  try {
    const c = document.querySelector('link[rel=canonical]')?.href;
    if (c && new URL(c).hostname === location.hostname) url = c;
  } catch { /* keep location.href */ }
  const root = document.querySelector('main,article,[role=main]') || document.body;
  const img = ['og:image:secure_url', 'og:image:url', 'og:image', 'twitter:image', 'twitter:image:src'].map(meta).find(Boolean)
    || document.querySelector('link[rel=image_src]')?.href || '';
  const ico = document.querySelector('link[rel~="apple-touch-icon"]')?.href || document.querySelector('link[rel~="icon"]')?.href || '/favicon.ico';
  return {
    url,
    title: document.title.trim(),
    desc: meta('description') || meta('og:description'),
    site: meta('og:site_name'),
    img: abs(img),
    ico: abs(ico),
    h: [...document.querySelectorAll('h1,h2')].slice(0, 12).map(h => h.innerText.trim()).filter(Boolean),
    text: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 4000),
  };
}
