// Dashboard. Runs as the extension's full-tab page and as the mobile PWA (same code).
import { X, esc, host, tc, clip } from '../core/util.js';
import { get, set, getCfg, saveCfg } from '../core/kv.js';
import { S, tx, live, put, persist, push, sync } from '../core/store.js';
import { index } from '../core/topics.js';
import { kw, rrf } from '../core/search.js';
import { saveUrl, edit, remove, retry, ask, semantic, preview, applyMoves } from '../core/save.js';
import * as G from '../core/gist.js';
import { embed, gen } from '../core/ai.js';

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
  if (!st.q) return l.sort((a, b) => b.ts - a.ts);
  if (st.fused) { const m = new Map(l.map(b => [b.id, b])); return st.fused.map(i => m.get(i)).filter(Boolean); }
  return kw(l, st.q);
}

function side() {
  const all = live(), { t } = index(all), secs = {};
  for (const x of Object.values(t)) (secs[x.sec] ??= []).push(x);
  const pend = all.filter(b => b.pend).length;
  const on = (s, p) => st.sec === s && st.top === p && !st.pend ? ' on' : '';
  let h = `<button class="it${st.sec || st.pend ? '' : ' on'}" data-s="" data-p="">All sites <i>${all.length}</i></button>`;
  if (pend) h += `<button class="it${st.pend ? ' on' : ''}" data-pend="1">Waiting for AI <i>${pend}</i></button>`;
  for (const s of Object.keys(secs).sort((a, b) => a === 'Unsorted' ? 1 : b === 'Unsorted' ? -1 : a.localeCompare(b))) {
    const n = secs[s].reduce((a, x) => a + x.ids.length, 0);
    h += `<button class="it sec${on(s, '')}" data-s="${esc(s)}" data-p="">${esc(s)} <i>${n}</i></button>`;
    for (const x of secs[s].sort((a, b) => b.ids.length - a.ids.length))
      h += `<button class="it top${on(s, x.top)}" data-s="${esc(s)}" data-p="${esc(x.top)}">${esc(x.top)} <i>${x.ids.length}</i></button>`;
  }
  $('#side').innerHTML = h;
  $('#secs').innerHTML = Object.keys(secs).map(s => `<option value="${esc(s)}">`).join('');
  $('#tops').innerHTML = Object.values(t).map(x => `<option value="${esc(x.top)}">`).join('');
}

const card = b => `<article class="card"><div class="hd"><div class="av">${esc((host(b.url)[0] || '?').toUpperCase())}</div><div>
<a class="t" href="${safe(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.t)}</a><div class="host">${esc(host(b.url))}</div></div></div>
${b.d ? `<p class="d">${esc(b.d)}</p>` : ''}
<div class="tg">${(b.tags || []).map(x => `<span>${esc(x)}</span>`).join('')}</div>
<div class="ft"><span>${b.pend ? '<span class="chip w">waiting for AI</span>' : `${esc(b.sec)} / ${esc(b.top)}`}</span>
<span><button data-e="${b.id}">Edit</button><button data-x="${b.id}">Delete</button></span></div></article>`;

function list() {
  const l = items(), show = l.slice(0, st.lim);
  const where = st.pend ? 'Waiting for AI' : st.sec ? `${st.sec}${st.top ? ' / ' + st.top : ''}` : 'All sites';
  $('#bar').textContent = `${where} · ${l.length} ${l.length === 1 ? 'site' : 'sites'}${st.synced ? ' · synced ' + st.synced : ''}`;
  $('#lib').innerHTML = l.length
    ? `<div class="grid">${show.map(card).join('')}</div>${l.length > show.length ? '<p class="empty"><button id="more">Show more</button></p>' : ''}`
    : `<p class="empty">${st.q ? 'No match. Press Enter to search by meaning.' : 'Nothing saved yet. Click the toolbar icon on any page, or press Alt+Shift+S.'}</p>`;
}
const render = () => { side(); list(); };

/* ---------- actions ---------- */
async function doSync() {
  const c = await getCfg();
  if (!c.gh) return toast('Add a GitHub token in Settings to sync');
  await busy('Syncing', async () => {
    await sync();
    await retry();
    st.synced = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await tx(() => 0);
    render();
    toast('Synced');
  });
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
  out.innerHTML = '<p class="empty">Thinking…</p>';
  try {
    const r = await ask(c, q);
    const ids = r.ids.length ? r.ids : r.hits || [];
    out.innerHTML = `<div class="ans">${esc(r.a)}</div>${ids.length ? `<p class="hint">${r.ids.length ? 'Sources' : 'Closest saved sites'}</p>` : ''}<div class="grid">${ids.map(i => S.bm[i]).filter(Boolean).map(card).join('')}</div>`;
  } catch (e) { out.innerHTML = `<p class="empty">Could not answer: ${esc(e.message)}</p>`; }
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
  if (t.dataset.e) openEdit(t.dataset.e);
  else if (t.dataset.x) { if (confirm('Delete this bookmark?')) remove(t.dataset.x).then(() => { render(); toast('Deleted'); }); }
  else if (t.id === 'more') { st.lim += 120; list(); }
  else if (t.closest('#side')) {
    st.pend = !!t.dataset.pend; st.sec = t.dataset.s || ''; st.top = t.dataset.p || '';
    document.body.classList.remove('nav'); render();
  }
});
$('#nav').onclick = () => document.body.classList.toggle('nav');
$('#sf').onsubmit = e => { e.preventDefault(); search(true); };
$('#q').oninput = () => search(false);
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  st.view = b.dataset.v;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  $('#lib').hidden = $('#bar').hidden = st.view !== 'lib';
  $('#ask').hidden = st.view !== 'ask';
  if (st.view === 'ask') $('#aq').focus();
});
$('#af').onsubmit = e => { e.preventDefault(); const q = $('#aq').value.trim(); if (q) doAsk(q); };
$('#add').onclick = () => $('#dAdd').showModal();
$('#sy').onclick = doSync;
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
  if (e.key === 'Escape') document.body.classList.remove('nav');
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
