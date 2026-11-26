// Dashboard. Runs as the extension's full-tab page and as the mobile PWA (same code).
import { X, esc, host, tc, clip, normUrl } from '../core/util.js';
import { get, set, getCfg, saveCfg } from '../core/kv.js';
import { S, tx, live, put, persist, push, sync } from '../core/store.js';
import { index } from '../core/topics.js';
import { kw, rrf } from '../core/search.js';
import { saveUrl, edit, pin, remove, retry, ask, semantic, preview, applyMoves } from '../core/save.js';
import * as G from '../core/gist.js';
import { embed, gen } from '../core/ai.js';
import * as IM from '../core/images.js';
import * as W from '../core/watch.js';

const $ = s => document.querySelector(s);
// f = special sidebar filter: '' | pend (waiting for AI) | watch (watched) | iss (address issues)
const st = { sec: '', top: '', q: '', fused: null, f: '', lim: 120, view: 'lib', synced: '' };
const FILT = { pend: b => b.pend, watch: b => b.w, iss: b => b.w && (b.wv || b.wd) };
const FLBL = { pend: 'Waiting for AI', watch: 'Watched addresses', iss: 'Address issues' };
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
  if (st.f) l = l.filter(FILT[st.f]);
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
  const n = k => all.filter(FILT[k]).length, pins = all.filter(b => b.pin).length;
  const on = (s, p) => st.sec === s && st.top === p && !st.f ? ' on' : '';
  const it = (cls, attrs, label, n, icon = '') => `<button class="it${cls}" ${attrs}>${icon}<span>${esc(label)}</span><i>${n}</i></button>`;
  const fi = (k, cls, icon) => { const c = n(k); return c ? it(cls + (st.f === k ? ' on' : ''), `data-f="${k}"`, FLBL[k], c, ic(icon)) : ''; };
  let h = it(st.sec || st.f ? '' : ' on', 'data-s="" data-p=""', 'All sites', all.length, ic('grid'))
    + fi('pend', ' warn', 'clock') + fi('iss', ' bad', 'alert') + fi('watch', '', 'radar');
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
// Address-watch status chip on the banner; clicking it opens the watch details.
const WEEK = 7 * 864e5;
const wchip = b => {
  const c = b.wv ? ['rv', 'alert', 'New address found']
    : b.wd ? ['dn', 'alert', 'Unreachable']
      : b.wch && Date.now() - b.wch < WEEK ? ['up', 'check', 'Address updated']
        : b.w ? ['on', 'radar', 'Watching'] : null;
  return c ? `<button class="wc ${c[0]}" data-wd="${b.id}" title="Address watch details">${ic(c[1])}<span>${c[2]}</span></button>` : '';
};
const watchBtn = b => `<button class="ib" data-w="${b.id}" aria-pressed="${!!b.w}" title="${b.w ? 'Stop watching the address' : 'Watch the address: check every night if the site moved'}" aria-label="${b.w ? 'Stop watching address' : 'Watch address'}">${ic('radar')}</button>`;
const card = b => { const h = host(b.url); return `<article class="card${b.pin ? ' pinned' : ''}">
${wchip(b)}${banner(b, h)}
<div class="hd"><div class="av" style="--h:${hue(h)}">${esc((h[0] || '?').toUpperCase())}${b.ico ? pic(b.ico) : ''}</div><div class="hb">
<a class="t" href="${safe(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.t)}</a><div class="host">${esc(h)}</div></div>${b.pin ? `<span class="pinb" title="Pinned">${ic('pin')}</span>` : ''}</div>
${b.d ? `<p class="d">${esc(b.d)}</p>` : ''}
${b.tags?.length ? `<div class="tg">${b.tags.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
<div class="ft">${b.pend ? '<span class="chip">Waiting for AI</span>' : `<span class="cat">${esc(b.sec)} · ${esc(b.top)}</span>`}
<div class="ca">${watchBtn(b)}${pinBtn(b)}<button class="ib" data-e="${b.id}" title="Edit" aria-label="Edit">${ic('edit')}</button><button class="ib del" data-x="${b.id}" title="Delete" aria-label="Delete">${ic('trash')}</button></div></div></article>`; };

const empty = (icon, title, text) => `<div class="empty"><span class="badge">${ic(icon)}</span><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

function list() {
  const l = items(), show = l.slice(0, st.lim);
  $('#vt').textContent = st.q ? `Results for “${st.q}”` : st.f ? FLBL[st.f] : st.top || st.sec || 'All sites';
  const n = `${l.length} ${l.length === 1 ? 'site' : 'sites'}`;
  $('#vs').textContent = [st.top && !st.q ? `${st.sec} · ${n}` : n, !st.q && !st.sec && !st.f && st.pins ? `${st.pins} pinned` : '', st.synced && `Synced ${st.synced}`].filter(Boolean).join(' · ');
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
  f.url.value = b.url; f.t.value = b.t; f.d.value = b.d || ''; f.tags.value = (b.tags || []).join(', ');
  f.sec.value = b.sec; f.top.value = b.top;
  $('#dEdit').showModal();
}

/** Key status badge: ok = tested and working, no = missing, er = test failed. */
const badge = (id, s, text) => { const e = $(id); e.className = 'st ' + s; e.textContent = text; };
async function openSettings() {
  const c = await getCfg(), f = $('#fSet').elements;
  for (const k of ['gh', 'gem', 'gen', 'deny']) { f[k].value = c[k]; f[k].type = ['gh', 'gem'].includes(k) ? 'password' : 'text'; }
  badge('#sGh', c.gh ? (c.gist ? 'ok' : '') : 'no', c.gh ? (c.gist ? 'Connected' : 'Not tested') : 'Missing');
  badge('#sGem', c.gem ? '' : 'no', c.gem ? 'Not tested' : 'Missing');
  // Open the guide for whatever is missing, so first-time setup shows the steps straight away.
  const [dGh, dGem] = $('#fSet').querySelectorAll('.key details');
  dGh.open = !c.gh; dGem.open = !c.gem;
  $('#gistInfo').innerHTML = c.gist
    ? `Your bookmarks are stored in <a href="https://gist.github.com/${esc(c.gist)}" target="_blank" rel="noopener">this secret Gist</a>. Nothing to set up here.`
    : 'Add a GitHub token above and press Save. The Vault then creates a secret Gist named <i>AI Bookmark Vault data</i>, or finds the one you already have.';
  $('#info').textContent = `This device: ${S.dev} · ${live().length} sites · ${Object.keys(S.q).length} waiting for AI`;
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
  else if (t.dataset.act === 'getx') openGet();
  else if (t.dataset.act === 'img') enableImages();
  else if (t.dataset.act === 'imgX') { st.imgOk = null; list(); }
  else if (t.closest('#ex')) doAsk(t.textContent);
  else if (t.dataset.e) openEdit(t.dataset.e);
  else if (t.dataset.x) { if (confirm('Delete this bookmark?')) remove(t.dataset.x).then(() => { render(); toast('Deleted'); }); }
  else if (t.id === 'more') { st.lim += 120; list(); }
  else if (t.dataset.w) withPerm(() => toggleWatch(t.dataset.w));
  else if (t.dataset.wd) openWatch(t.dataset.wd);
  else if (t.dataset.wa) watchAct(t.dataset.wa, t.dataset.v);
  else if (t.closest('#tree')) {
    st.f = t.dataset.f || ''; st.sec = t.dataset.s || ''; st.top = t.dataset.p || '';
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
/* Get extension: download + install guide */
const GX = {
  chrome: { page: 'chrome://extensions', dev: '<b>Developer mode</b> (switch at the top right)' },
  brave: { page: 'brave://extensions', dev: '<b>Developer mode</b> (switch at the top right)' },
  edge: { page: 'edge://extensions', dev: '<b>Developer mode</b> (switch in the left panel; on narrow windows open the ☰ menu first)' },
};
const detect = () => navigator.brave ? 'brave' : /Edg\//.test(navigator.userAgent) ? 'edge' : /Firefox\//.test(navigator.userAgent) ? 'firefox' : 'chrome';
const copyBtn = t => `<button type="button" class="cp" data-copy="${esc(t)}" title="Copy">${ic('copy')}<code>${esc(t)}</code></button>`;
function gxRender(br) {
  document.querySelectorAll('#gxTabs button').forEach(b => b.classList.toggle('on', b.dataset.b === br));
  const keep = '<small>Keep this folder; the browser runs the extension from it. Don\'t delete or move it.</small>';
  const after = [
    'Pin it: click the puzzle-piece icon in the toolbar, then the pin next to <b>AI Bookmark Vault</b>.',
    'The Vault opens by itself. In <b>Settings</b>, paste the <b>same GitHub token</b> you use on your other devices, plus your Gemini key. Your bookmarks sync in.',
  ];
  const steps = br === 'firefox' ? [
    `Download the zip and extract it (right-click → <b>Extract All</b>).`,
    `Open ${copyBtn('about:debugging#/runtime/this-firefox')} in a new tab. Paste it into the address bar; pages can't open it for you.`,
    'Click <b>Load Temporary Add-on…</b> and select the <b>manifest.json</b> file inside the extracted folder.',
    ...after,
    '<small>Firefox removes temporary add-ons when it closes, so you repeat step 3 after each restart. Permanent installs in Firefox need the add-on to be signed by Mozilla.</small>',
  ] : [
    `Download the zip and extract it (right-click → <b>Extract All</b>). ${keep}`,
    `Open ${copyBtn(GX[br].page)} in a new tab. Paste it into the address bar; pages can't open it for you.`,
    `Turn on ${GX[br].dev}.`,
    'Click <b>Load unpacked</b> and select the extracted folder (the one that contains <code>manifest.json</code>).',
    ...after,
    '<small>An "Errors" button with a warning that <code>background.scripts</code> requires manifest version 2 is expected. That line is there for Firefox and is harmless.</small>',
  ];
  const note = steps.pop(); // last entry is a note, not a step
  $('#gxSteps').innerHTML = steps.map(s => `<li>${s}</li>`).join('');
  $('#gxNote').innerHTML = note;
}
function openGet() {
  const v = X?.runtime?.getManifest?.().version;
  $('#gxVer').textContent = v ? `You're running the extension, version ${v}. Download again to update.` : 'Always the latest version from GitHub';
  gxRender(detect());
  nav(false);
  $('#dGet').showModal();
}
$('#getx').onclick = openGet;
$('#gxTabs').addEventListener('click', e => { const b = e.target.closest('[data-b]'); if (b) gxRender(b.dataset.b); });
$('#gxSteps').addEventListener('click', e => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied. Paste it into the address bar.'), () => toast('Copy failed. Select the text and copy it.'));
});

/* Address watch */
// Checks need the all-sites permission (same one as previews). Must be requested inside the click, before any await.
function withPerm(f) {
  if (st.imgOk !== false) return f(); // granted, or the PWA (where the desktop extension does the checking)
  IM.ask().then(ok => {
    if (!ok) return toast('Permission is needed to check websites.');
    st.imgOk = true;
    f();
    runBackfill(false);
  }).catch(e => toast('Could not request permission: ' + e.message));
}
const RES = {
  ok: 'Reachable. The address has not changed.',
  moved: r => `Address updated to ${host(r.to)}`,
  review: r => `Possible new address: ${host(r.to)}. Review it on the card.`,
  fail: 'Not reachable right now. Nightly checks will keep trying.',
  unknown: 'Couldn\'t check: the site blocks automated visits. It will be tried again tonight.',
};
const say = r => { const m = RES[r?.st]; toast(typeof m === 'function' ? m(r) : m || 'Check finished'); };
async function checkNow(id) {
  if (!X?.permissions) return toast('Checks run in the desktop extension.');
  toast('Checking the address…');
  const r = await W.checkOne(id).catch(() => null);
  await tx(() => 0);
  render();
  if ($('#dWatch').open) openWatch(id);
  say(r);
}
async function toggleWatch(id) {
  const on = !S.bm[id]?.w;
  await W.setWatch(id, on);
  render();
  if (!on) return toast('Stopped watching this address');
  if (X?.permissions) checkNow(id);
  else toast('Watching. Your desktop extension checks it every night.');
}
const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(t).toLocaleDateString(); };
const LAST = { ok: 'reachable, address unchanged', moved: 'address updated', review: 'possible new address found', fail: 'not reachable', unknown: 'could not check (bot protection)' };
async function openWatch(id) {
  const b = S.bm[id];
  if (!b) return;
  const ws = await W.watchState(), last = ws.chk[id], fails = ws.f[id] || 0, ext = !!X?.permissions;
  const link = u => `<a href="${safe(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`;
  $('#dWatch').dataset.id = id;
  $('#wBody').innerHTML = `
    <p class="wt"><b>${esc(b.t)}</b><br>${link(b.url)}</p>
    <label class="sw"><input type="checkbox" data-wt ${b.w ? 'checked' : ''}><span>Watch this address every night</span></label>
    <p class="hint">${ext
      ? 'Checked once a night between 1 and 5 am (or when you next open the browser). One request, no cookies, no AI.'
      : 'Your desktop extension does the checking; changes show up here after a sync.'}</p>
    ${last ? `<p class="hint">Last check on this device: ${ago(last.at)}, ${LAST[last.st] || last.st}${last.why ? ` (${esc(last.why)})` : ''}.${fails ? ` Failed ${fails} night${fails > 1 ? 's' : ''} in a row.` : ''}</p>` : ''}
    ${b.wv ? `<div class="wbox rv"><b>New address found</b><p>${esc(b.wv.why)}:</p><p>${link(b.wv.to)}</p>
      <p class="hint">It wasn't switched automatically because the new site doesn't clearly match the saved one. Open it to check before you switch.</p>
      <div class="row"><button type="button" class="btn pri" data-wa="accept">Use new address</button><button type="button" class="btn ghost" data-wa="reject">Keep current</button></div></div>` : ''}
    ${b.wd ? `<div class="wbox dn"><b>Unreachable since ${new Date(b.wd).toLocaleDateString()}</b><p>The site hasn't answered for ${FAILS_TXT} nights and doesn't forward anywhere. If you know its new address, paste it in Edit.</p></div>` : ''}
    ${b.wch && Date.now() - b.wch < WEEK && b.hist?.[0] ? `<div class="wbox up"><b>Address updated ${ago(b.wch)}</b><p>Moved from ${esc(host(b.hist[0].u))} to ${esc(host(b.url))}.</p></div>` : ''}
    ${b.hist?.length ? `<p class="lbl">Previous addresses</p><div class="list">${b.hist.map(h => `<div class="hrow"><span>${esc(h.u)}<br><small>until ${new Date(h.at).toLocaleDateString()}</small></span><button type="button" class="btn ghost" data-wa="restore" data-v="${esc(h.u)}">Restore</button></div>`).join('')}</div>` : ''}`;
  $('#wChk').hidden = !ext;
  if (!$('#dWatch').open) $('#dWatch').showModal();
}
const FAILS_TXT = '3';
async function watchAct(a, v) {
  const id = $('#dWatch').dataset.id;
  if (a === 'accept') { await W.accept(id); toast('Address updated'); }
  else if (a === 'reject') { await W.reject(id); toast('Kept the current address. That new address won\'t be suggested again.'); }
  else if (a === 'restore') { await W.setUrl(id, v); toast('Previous address restored'); }
  await tx(() => 0);
  render();
  openWatch(id);
}
$('#wBody').addEventListener('change', e => {
  if (!e.target.matches('[data-wt]')) return;
  const id = $('#dWatch').dataset.id;
  if (e.target.checked && st.imgOk === false) { e.target.checked = false; return withPerm(() => toggleWatch(id).then(() => openWatch(id))); }
  toggleWatch(id).then(() => openWatch(id));
});
$('#wChk').onclick = () => withPerm(() => checkNow($('#dWatch').dataset.id));

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
  const f = $('#fEdit').elements, id = e.target.dataset.id;
  await edit(id, {
    t: clip(f.t.value, 120), d: clip(f.d.value, 260),
    tags: f.tags.value.split(',').map(x => clip(x, 24).toLowerCase()).filter(Boolean).slice(0, 8),
    sec: tc(clip(f.sec.value, 30)), top: tc(clip(f.top.value, 40)), pend: 0,
  });
  const url = normUrl(f.url.value);
  if (!url) toast('Address not changed: it is not a valid web address');
  else if (url !== S.bm[id]?.url) { await W.setUrl(id, url); toast('Address changed. The old one is kept under Address watch.'); }
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
// Show/hide a key field.
$('#fSet').addEventListener('click', e => {
  const b = e.target.closest('[data-eye]');
  if (b) { const i = $('#fSet').elements[b.dataset.eye]; i.type = i.type === 'password' ? 'text' : 'password'; }
});
$('#fSet').addEventListener('input', e => {
  if (e.target.name === 'gh') badge('#sGh', e.target.value.trim() ? '' : 'no', e.target.value.trim() ? 'Not tested' : 'Missing');
  if (e.target.name === 'gem') badge('#sGem', e.target.value.trim() ? '' : 'no', e.target.value.trim() ? 'Not tested' : 'Missing');
});
// Tests report in plain words what's wrong and how to fix it.
$('#tGh').onclick = async () => {
  const tok = form().gh.trim();
  if (!tok) return badge('#sGh', 'no', 'Missing'), toast('Paste a GitHub token first');
  badge('#sGh', '', 'Testing…');
  try {
    const sc = await G.ping(tok);
    if (sc && !sc.includes('gist')) return badge('#sGh', 'er', 'No gist scope'), toast('This token is missing the gist scope. Make a new one with "gist" ticked.');
    badge('#sGh', 'ok', 'Works');
    toast(sc?.some(s => s === 'repo' || s.startsWith('admin') || s.startsWith('delete'))
      ? `Works, but it also has: ${sc.filter(s => s !== 'gist').join(', ')}. Safer: make a token with only "gist".`
      : 'GitHub token works');
  } catch (e) {
    badge('#sGh', 'er', 'Failed');
    toast(e.status === 401 ? 'GitHub rejected this token. It may be mistyped, expired, or deleted.' : `GitHub test failed: ${e.message}`);
  }
};
$('#tGem').onclick = async () => {
  const c = { ...(await getCfg()), gem: form().gem.trim(), gen: form().gen.trim() };
  if (!c.gem) return badge('#sGem', 'no', 'Missing'), toast('Paste a Gemini key first');
  badge('#sGem', '', 'Testing…');
  try {
    await embed(c, 'ping');
    await gen(c, 'Return {"ok":true}', { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] });
    badge('#sGem', 'ok', 'Works');
    toast('Gemini key works (text + embeddings)');
  } catch (e) {
    badge('#sGem', 'er', 'Failed');
    toast({ 400: 'Gemini rejected the key. Check it was copied in full.', 401: 'Gemini rejected the key.', 403: 'This key is not allowed to use the Gemini API. Create a new key in AI Studio.', 429: 'Key works, but the free limit is used up for now. Try again later.', 503: 'Key is fine; Gemini is busy right now. Try again in a minute.' }[e.status] || `Gemini test failed: ${e.message}`);
  }
};

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
