// Background (Chrome service worker / Firefox event page). Handles icon click, shortcuts, menus, periodic sync.
import { X } from './core/util.js';
import { getCfg } from './core/kv.js';
import { extractPage } from './extractor.js';
import { savePage, saveUrl, retry } from './core/save.js';
import { sync } from './core/store.js';
import { backfill } from './core/images.js';

const mark = (tabId, text, color) => {
  if (tabId == null) return;
  X.action.setBadgeText({ tabId, text });
  X.action.setBadgeBackgroundColor({ tabId, color });
  if (text !== '…') setTimeout(() => X.action.setBadgeText({ tabId, text: '' }), 3000);
};
const RES = { ok: ['✓', '#16a34a'], dup: ['=', '#2563eb'], denied: ['✕', '#dc2626'], bad: ['✕', '#dc2626'] };

async function saveTab(tab) {
  if (!tab?.id) return;
  if (tab.incognito) return mark(tab.id, '✕', '#dc2626');
  mark(tab.id, '…', '#6366f1');
  try {
    const [{ result }] = await X.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    const r = await savePage(result, await getCfg());
    mark(tab.id, ...RES[r.st]);
  } catch { mark(tab.id, '!', '#dc2626'); }
}

const activeTab = async () => (await X.tabs.query({ active: true, currentWindow: true }))[0];

X.action.onClicked.addListener(saveTab);

X.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd === 'open-vault') return X.runtime.openOptionsPage();
  if (cmd === 'save-page') saveTab(tab || await activeTab());
});

X.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open') return X.runtime.openOptionsPage();
  if (info.menuItemId === 'page') return saveTab(tab);
  if (info.menuItemId === 'link') {
    const r = await saveUrl(info.linkUrl, await getCfg()).catch(() => ({ st: 'bad' }));
    mark(tab?.id, ...(RES[r.st] || RES.bad));
  }
});

X.runtime.onInstalled.addListener(async d => {
  await X.contextMenus.removeAll();
  X.contextMenus.create({ id: 'page', title: 'Save page to Vault', contexts: ['page'] });
  X.contextMenus.create({ id: 'link', title: 'Save link to Vault', contexts: ['link'] });
  X.contextMenus.create({ id: 'open', title: 'Open Vault', contexts: ['action'] });
  X.alarms.create('sync', { periodInMinutes: 5 });
  if (d.reason === 'install') X.runtime.openOptionsPage();
});

X.alarms.onAlarm.addListener(async a => {
  if (a.name !== 'sync') return;
  await sync().catch(() => {});
  await retry().catch(() => {});
  await backfill().catch(() => {}); // no-op unless the optional all-sites permission was granted
});
