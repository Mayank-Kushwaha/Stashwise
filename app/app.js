// Dashboard. Runs as the extension's full-tab page and as the mobile PWA (same code).
import { X, esc, host, tc, clip } from '../core/util.js';
import { get, set, getCfg, saveCfg } from '../core/kv.js';
import { S, tx, live, put, persist, push, sync } from '../core/store.js';
import { index } from '../core/topics.js';
import { kw, rrf } from '../core/search.js';
import { saveUrl, edit, pin, remove, retry, ask, semantic, preview, applyMoves } from '../core/save.js';
import * as G from '../core/gist.js';
import { embed, gen } from '../core/ai.js';
import * as IM from '../core/images.js';

const $ = s => document.querySelector(s);
const st = { sec: '', top: '', q: '', fused: null, pend: false, lim: 120, view: 'lib', synced: '' };
let timer;

const toast = m => {
  const t = $('#toast');
  t.textContent = m;
  t.classList.add('on');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('on'), 3200);
};
const safe = u => /^https?:\/\//i.test(u) ? esc(u) : '#';
const busy = async (label, f) => { toast(label + '…'); try { const r = await f(); return r; } catch (e) { toast(`${label} failed: ${e.message}`); } };

/* ---------- render ---------- */
function items() {
  let l = live();
  if (st.pend) l = l.filter(b => b.pend);
  else if (st.sec) l = l.filter(b => b.sec === st.sec && (!st.top || b.top === st.top));
  // Pinned first (most recently pinned on top), then newest. Search results keep relevance order.
  if (!st.q) return l.sort((a, b) => (b.pin || 0) - (a.pin || 0) || b.ts - a.ts);
  if (st.fused) { const m = new Map(l.map(b => [b.id, b])); return st.fused.map(i => m.get(i)).filter(Boolean); }
  return kw(l, st.q);
}

const ic = n => `<svg><use href="#i-${n}"/></svg>`;
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

function side() {
  const all = live(), { t } = index(all), secs = {};
  for (const x of Object.values(t)) (secs[x.sec] ??= []).push(x);
  const pend = all.filter(b => b.pend).length, pins = all.filter(b => b.pin).length;
  const on = (s, p) => st.sec === s && st.top === p && !st.pend ? ' on' : '';
  const it = (cls, attrs, label, n, icon = '') => `<button class="it${cls}" ${attrs}>${icon}<span>${esc(label)}</span><i>${n}</i></button>`;
  let h = it(st.sec || st.pend ? '' : ' on', 'data-s="" data-p=""', 'All sites', all.length, ic('grid'));
  if (pend) h += it(' warn' + (st.pend ? ' on' : ''), 'data-pend="1"', 'Waiting for AI', pend, ic('clock'));
  for (const s of Object.keys(secs).sort((a, b) => a === 'Unsorted' ? 1 : b === 'Unsorted' ? -1 : a.localeCompare(b))) {
    const n = secs[s].reduce((a, x) => a + x.ids.length, 0);
    h += `<div class="grp">${it(' sec' + on(s, ''), `data-s="${esc(s)}" data-p=""`, s, n)}`;
    for (const x of secs[s].sort((a, b) => b.ids.length - a.ids.length))
      h += it(' top' + on(s, x.top), `data-s="${esc(s)}" data-p="${esc(x.top)}"`, x.top, x.ids.length);
    h += '</div>';
  }
  st.pins = pins;
  $('#tree').innerHTML = h;
  $('#secs').innerHTML = Object.keys(secs).map(s => `<option value="${esc(s)}">`).join('');
  $('#tops').innerHTML = Object.values(t).map(x => `<option value="${esc(x.top)}">`).join('');
}

const pinBtn = b => `<button class="ib" data-pin="${b.id}" aria-pressed="${!!b.pin}" title="${b.pin ? 'Unpin' : 'Pin to top of its category'}" aria-label="${b.pin ? 'Unpin' : 'Pin'}">${ic('pin')}</button>`;
// Images load straight from each site; no referrer is sent. Broken or tiny images are removed (see load/error listeners).
const pic = (u, cls = '') => `<img${cls} src="${safe(u)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
const letter = h => esc((h[0] || '?').toUpperCase());
// Banner: the site's preview image, or a coloured placeholder with its icon (letter if the icon fails too).
const banner = (b, h) => b.img
  ? `<div class="pv" style="--h:${hue(h)}" data-l="${letter(h)}">${pic(b.img)}</div>`
  : `<div class="pv ph" style="--h:${hue(h)}">${b.ico ? pic(b.ico) : ''}<span>${letter(h)}</span></div>`;
const card = b => { const h = host(b.url); return `<article class="card${b.pin ? ' pinned' : ''}">
${banner(b, h)}
<div class="hd"><div class="av" style="--h:${hue(h)}">${esc((h[0] || '?').toUpperCase())}${b.ico ? pic(b.ico) : ''}</div><div class="hb">
<a class="t" href="${safe(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.t)}</a><div class="host">${esc(h)}</div></div>${b.pin ? `<span class="pinb" title="Pinned">${ic('pin')}</span>` : ''}</div>
${b.d ? `<p class="d">${esc(b.d)}</p>` : ''}
${b.tags?.length ? `<div class="tg">${b.tags.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
<div class="ft">${b.pend ? '<span class="chip">Waiting for AI</span>' : `<span class="cat">${esc(b.sec)} · ${esc(b.top)}</span>`}
<div class="ca">${pinBtn(b)}<button class="ib" data-e="${b.id}" title="Edit" aria-label="Edit">${ic('edit')}</button><button class="ib del" data-x="${b.id}" title="Delete" aria-label="Delete">${ic('trash')}</button></div></div></article>`; };

const empty = (icon, title, text) => `<div class="empty"><span class="badge">${ic(icon)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

function list() {
  const l = items(), show = l.slice(0, st.lim);
  $('#vt').textContent = st.q ? `Results for “${st.q}”` : st.pend ? 'Waiting for AI' : st.top || st.sec || 'All sites';
  const n = `${l.length} ${l.length === 1 ? 'site' : 'sites'}`;
  $('#vs').textContent = [st.top && !st.q ? `${st.sec} · ${n}` : n, !st.q && !st.sec && !st.pend && st.pins ? `${st.pins} pinned` : '', st.synced && `Synced ${st.synced}`].filter(Boolean).join(' · ');
  const miss = st.imgOk === false && live().filter(b => b.img === undefined).length;
  $('#imgBar').hidden = !miss;
  if (miss) $('#imgN').textContent = `${miss} ${miss === 1 ? 'site has' : 'sites have'} no preview yet.`;
  $('#cards').innerHTML = l.length
    ? `<div class="grid">${show.map(card).join('')}</div>${l.length > show.length ? '<div class="more"><button id="more" class="btn">Show more</button></div>' : ''}`
    : st.q ? empty('search', 'No matches', 'Press Enter to also search by meaning.')
      : empty('book', 'Nothing saved yet', 'Click the toolbar icon on any page, press Alt+Shift+S, or use Add.');
}
const render = () => { side(); list(); };

/* ---------- actions ---------- */
/** Background syncs are silent (spinner only); a manual sync also confirms with a toast. */
let syncing = false;
async function doSync(manual) {
  const c = await getCfg();
  if (!c.gh) return manual && toast('Add a GitHub token in Settings to sync');
  if (syncing) return;
  syncing = true;
  $('#sy').classList.add('spin');
  try {
    await sync();
    await retry();
    st.synced = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await tx(() => 0);
    render();
    if (manual) toast('Synced');
  } catch (e) { toast(`Sync failed: ${e.message}`); }
  finally { syncing = false; $('#sy').classList.remove('spin'); }
  runBackfill(false); // fills previews for sites saved elsewhere (e.g. from the phone)
}

async function search(deep) {
  st.q = $('#q').value.trim();
  st.fused = null;
  st.lim = 120;
  if (deep && st.q) {
    const c = await getCfg();
    if (c.gem) await busy('Searching by meaning', async () => {
      const sem = (await semantic(c, st.q, 30)).map(x => x[0]);
      st.fused = rrf([kw(live(), st.q).map(b => b.id), sem]);
    });
  }
  list();
}

async function doAsk(q) {
  const c = await getCfg(), out = $('#ans');
  if (!c.gem) return toast('Add your Gemini key in Settings');
  $('#aq').value = q;
  $('#ex').hidden = true;
  out.innerHTML = '<div class="dots" aria-label="Thinking"><i></i><i></i><i></i></div>';
  try {
    const r = await ask(c, q);
    const ids = r.ids.length ? r.ids : r.hits || [];
    out.innerHTML = `<div class="ans">${esc(r.a)}</div>${ids.length ? `<p class="lbl">${r.ids.length ? 'Sources' : 'Closest saved sites'}</p>` : ''}<div class="grid">${ids.map(i => S.bm[i]).filter(Boolean).map(card).join('')}</div>`;
  } catch (e) { out.innerHTML = empty('spark', 'Could not answer', e.message); }
}

function openEdit(id) {
  const b = S.bm[id], f = $('#fEdit').elements;
  $('#dEdit').dataset.id = id;
  f.t.value = b.t; f.d.value = b.d || ''; f.tags.value = (b.tags || []).join(', ');
  f.sec.value = b.sec; f.top.value = b.top;
  $('#dEdit').showModal();
}

async function openSettings() {
  const c = await getCfg(), f = $('#fSet').elements;
  for (const k of ['gh', 'gem', 'gen', 'deny']) f[k].value = c[k];
  $('#info').textContent = `Device ${S.dev} · ${live().length} sites · ${Object.keys(S.q).length} waiting for AI · Gist ${c.gist || 'not created yet'}`;
  $('#dSet').showModal();
}

const form = () => Object.fromEntries(new FormData($('#fSet')));

/* ---------- events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.pin) {
    const id = t.dataset.pin, on = !S.bm[id]?.pin;
    pin(id, on).then(() => {
      render();
      document.querySelectorAll(`#ans [data-pin="${id}"]`).forEach(x => x.closest('.card').outerHTML = card(S.bm[id]));
      toast(on ? 'Pinned to the top of its category' : 'Unpinned');
    });
  }
  else if (t.dataset.act === 're') { nav(false); $('#re').click(); }
  else if (t.dataset.act === 'img') enableImages();
  else if (t.dataset.act === 'imgX') { st.imgOk = null; list(); }
  else if (t.closest('#ex')) doAsk(t.textContent);
  else if (t.dataset.e) openEdit(t.dataset.e);
  else if (t.dataset.x) { if (confirm('Delete this bookmark?')) remove(t.dataset.x).then(() => { render(); toast('Deleted'); }); }
  else if (t.id === 'more') { st.lim += 120; list(); }
  else if (t.closest('#tree')) {
    st.pend = !!t.dataset.pend; st.sec = t.dataset.s || ''; st.top = t.dataset.p || '';
    if (st.view !== 'lib') document.querySelector('[data-v=lib]').click();
    nav(false); render(); $('main').scrollTop = 0;
  }
});

/* Site previews */
// Permission request must come straight from the click (no await before it), or the browser refuses.
function enableImages() {
  IM.ask().then(async ok => {
    if (!ok) return toast('Permission declined. New saves still get previews.');
    st.imgOk = true;
    list();
    await runBackfill(true);
  }).catch(e => toast('Could not request permission: ' + e.message));
}
async function runBackfill(manual) {
  if (!st.imgOk) return;
  if (manual) toast('Fetching site previews…');
  const n = await IM.backfill().catch(() => 0);
  await tx(() => 0);
  render();
  if (manual) toast(n ? `Added ${n} preview ${n === 1 ? 'image' : 'images'}` : 'Done. No new preview images found.');
}
// A broken (or tracking-pixel-sized) preview turns its banner into the letter placeholder.
const toPh = pv => { pv.classList.add('ph'); pv.innerHTML = `<span>${esc(pv.dataset.l || '?')}</span>`; };
document.addEventListener('error', e => {
  const i = e.target;
  if (i.tagName !== 'IMG') return;
  const pv = i.closest('.pv');
  pv && !pv.classList.contains('ph') ? toPh(pv) : i.remove();
}, true);
document.addEventListener('load', e => {
  const i = e.target, pv = i.tagName === 'IMG' && i.closest('.pv:not(.ph)');
  if (pv && (i.naturalWidth < 80 || i.naturalHeight < 40)) toPh(pv);
}, true);

/* Mobile drawer: menu button opens; close button, backdrop tap, Esc, or picking a section closes. */
function nav(open) {
  document.body.classList.toggle('nav', open);
  $('#scrim').hidden = !open;
  $('#nav').setAttribute('aria-expanded', open);
  if (open) $('#navX').focus();
}
$('#nav').onclick = () => nav(!document.body.classList.contains('nav'));
$('#navX').onclick = () => { nav(false); $('#nav').focus(); };
$('#scrim').onclick = () => nav(false);
matchMedia('(min-width: 821px)').addEventListener('change', e => e.matches && nav(false));

$('#sf').onsubmit = e => { e.preventDefault(); $('#q').blur(); search(true); };
$('#q').oninput = () => search(false);
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  st.view = b.dataset.v;
  document.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
  $('#lib').hidden = st.view !== 'lib';
  $('#ask').hidden = st.view !== 'ask';
  document.body.classList.toggle('asking', st.view === 'ask');
  if (st.view === 'ask' && matchMedia('(hover:hover)').matches) $('#aq').focus();
});
$('#af').onsubmit = e => { e.preventDefault(); const q = $('#aq').value.trim(); if (q) doAsk(q); };
$('#add').onclick = () => $('#dAdd').showModal();
$('#sy').onclick = () => doSync(true);
$('#se').onclick = openSettings;

$('#dEdit').onclose = async e => {
  if (e.target.returnValue !== 'ok') return;
  const f = $('#fEdit').elements;
  await edit(e.target.dataset.id, {
    t: clip(f.t.value, 120), d: clip(f.d.value, 260),
    tags: f.tags.value.split(',').map(x => clip(x, 24).toLowerCase()).filter(Boolean).slice(0, 8),
    sec: tc(clip(f.sec.value, 30)), top: tc(clip(f.top.value, 40)), pend: 0,
  });
  render();
};
$('#dAdd').onclose = async e => {
  if (e.target.returnValue !== 'ok') return;
  const u = $('#fAdd').elements.u.value;
  $('#fAdd').reset();
  const r = await busy('Saving', async () => saveUrl(u, await getCfg()));
  if (r) { toast({ ok: 'Saved', dup: 'Already saved', denied: 'Blocked: private or never-send site', bad: 'Not a valid web address' }[r.st]); render(); }
};
$('#dSet').onclose = async e => {
  if (e.target.returnValue !== 'ok') return;
  const f = form(), old = await getCfg();
  await saveCfg({ gh: f.gh.trim(), gem: f.gem.trim(), gen: f.gen.trim() || old.gen, deny: f.deny.trim(), ...(f.gh.trim() !== old.gh ? { gist: '' } : {}) });
  if (f.gh.trim() !== old.gh) await tx(async () => { S.etag = null; await persist(); });
  toast('Settings saved');
  doSync();
};
$('#tGh').onclick = () => busy('Testing GitHub', async () => { await G.ping(form().gh.trim()); toast('GitHub token works'); });
$('#tGem').onclick = () => busy('Testing Gemini', async () => {
  const c = { ...(await getCfg()), gem: form().gem.trim(), gen: form().gen.trim() };
  await embed(c, 'ping');
  await gen(c, 'Return {"ok":true}', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
  toast('Gemini key works (text + embeddings)');
});

$('#exp').onclick = async () => {
  await tx(() => 0);
  const blob = new Blob([JSON.stringify({ v: 1, bm: Object.values(S.bm), vec: S.vec })], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `vault-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#imp').onchange = e => busy('Importing', async () => {
  const j = JSON.parse(await e.target.files[0].text());
  if (!Array.isArray(j.bm)) throw new Error('Not a vault export');
  await tx(async () => {
    const now = Date.now();
    for (const b of j.bm) if (b?.id && /^https?:\/\//.test(b.url || '') && !S.bm[b.id]) put({ ...b, u: now }, j.vec?.[b.id] && [now, j.vec[b.id][1]]);
    await persist();
  });
  await push().catch(() => {});
  render();
  toast('Imported');
});

/* Keyboard shortcuts */
const keys = s => s ? s.split('+').map(k => `<kbd>${esc(k)}</kbd>`).join(' + ') : '<span class="hint">not set</span>';
const rows = r => `<table class="kb">${r.map(([d, k]) => `<tr><td>${esc(d)}</td><td>${k}</td></tr>`).join('')}</table>`;
async function openKeys() {
  let h = '';
  if (X?.commands?.getAll) { // real bindings: the user may have changed them or the browser may have dropped a conflicting one
    const cmds = await X.commands.getAll();
    const g = n => cmds.find(c => c.name === n)?.shortcut;
    h += `<h3>Anywhere in the browser</h3>${rows([
      ['Save the current page', keys(g('save-page'))],
      ['Open the Vault', keys(g('open-vault'))],
      ['Save page or link', 'Right-click → Save to Vault'],
      ['Save the current page', 'Click the toolbar icon'],
    ])}<p class="hint">To change these, open <code>${/firefox/i.test(navigator.userAgent) ? 'about:addons → ⚙ → Manage Extension Shortcuts' : 'chrome://extensions/shortcuts'}</code>.</p>`;
  }
  h += `<h3>On this page</h3>${rows([
    ['Focus search', keys('/')],
    ['Search by meaning', keys('Enter') + ' in search'],
    ['Ask AI', keys('A')],
    ['Save a URL', keys('N')],
    ['Show shortcuts', keys('?')],
    ['Close a dialog or the menu', keys('Esc')],
  ])}`;
  $('#kbBody').innerHTML = h;
  $('#dKb').showModal();
}
$('#kb').onclick = openKeys;
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('nav')) return nav(false);
  if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || e.target.closest?.('input,textarea')) return;
  const go = { '/': () => { document.querySelector('[data-v=lib]').click(); $('#q').focus(); }, '?': openKeys,
    a: () => document.querySelector('[data-v=ask]').click(), n: () => $('#dAdd').showModal() }[e.key.toLowerCase()];
  if (go) { e.preventDefault(); go(); }
});

/* Re-organize */
let moves = [];
$('#re').onclick = async () => {
  $('#reBody').textContent = 'Looking for near-duplicate topics and misplaced sites…';
  $('#reGo').hidden = true;
  $('#reUndo').hidden = !(await get('undo'))?.length;
  $('#dRe').showModal();
  moves = await preview(await getCfg());
  $('#reBody').innerHTML = moves.length
    ? moves.map(m => `<div><b>${esc(clip(m.t, 60))}</b><br>${esc(m.from)} → ${esc(m.sec)} / ${esc(m.top)}</div>`).join('')
    : 'Everything is already well organized.';
  $('#reGo').hidden = !moves.length;
};
$('#reGo').onclick = async () => {
  await set({ undo: await applyMoves(moves) });
  $('#dRe').close(); render(); toast(`Moved ${moves.length} sites. Undo is available.`);
};
$('#reUndo').onclick = async () => {
  await applyMoves(await get('undo'));
  await set({ undo: [] });
  $('#dRe').close(); render(); toast('Undone');
};

/* ---------- start ---------- */
(async () => {
  await tx(() => 0);
  st.imgOk = X?.permissions ? await IM.canFetch() : null; // null = PWA (cannot read other sites)
  if (st.imgOk === null) $('#tImg').hidden = true;
  render();
  X?.storage?.onChanged?.addListener(ch => { if (ch.ver) tx(() => 0).then(render); });
  if (!X?.runtime?.id && location.protocol === 'https:' && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const c = await getCfg();
  const sh = new URLSearchParams(location.search);
  const shared = (sh.get('url') || sh.get('text') || '').match(/https?:\/\/\S+/)?.[0];
  if (shared) { history.replaceState(null, '', location.pathname); $('#fAdd').elements.u.value = shared; $('#dAdd').showModal(); }
  else if (!c.gh || !c.gem) openSettings();
  doSync();
  setInterval(() => document.visibilityState === 'visible' && doSync(), 5 * 60e3);
  let last = Date.now();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - last > 60e3) { last = Date.now(); doSync(); } });
})();
