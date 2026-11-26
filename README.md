# AI Bookmark Vault

One-click save for Chrome, Edge, Brave and Firefox. Gemini (free tier) writes the title, description, tags and topic. Sites are grouped into Sections and Topics automatically. Search, "Ask AI" over your saved sites, sync through a private GitHub Gist, and a mobile PWA that reads the same data. No npm dependencies.

## Setup
1. **GitHub token:** github.com/settings/tokens, classic token, tick only `gist`. Paste into Settings.
2. **Gemini key:** aistudio.google.com, create a free API key. Paste into Settings.
3. **Chrome/Edge/Brave:** `chrome://extensions` → Developer mode → Load unpacked → select this folder.
   **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → select `manifest.json`. Allow site access in the add-on's permissions if asked.
4. Settings opens on first run. Click **Test GitHub** and **Test Gemini**, then **Save**.

Second device: install the same way, paste the same GitHub token. The Gist is found automatically.

**Install from the zip:** the dashboard's **Get extension** button (next to Add) links to `ai-bookmark-vault.zip` on GitHub Pages, with step-by-step instructions for Chrome, Brave, Edge and Firefox. The Pages workflow rebuilds the zip on every push from the committed runtime files only (`manifest.json`, `background.js`, `extractor.js`, `README.md`, `app/`, `core/`, `icons/`).

## Use
- Click the toolbar icon, press **Alt+Shift+S**, or right-click a page or link → *Save to Vault*. Badge: ✓ saved, = already saved, ✕ blocked/invalid, ! error.
- **Alt+Shift+V** or right-click the icon → *Open Vault* (full tab, resizable).
- Search box: instant keyword search. Press Enter to add search by meaning.
- **Ask AI** tab: answers only from your saved sites and links the sources.
- **⌨** (top right, or press `?`): list of shortcuts. On the dashboard: `/` search, `A` Ask AI, `N` save a URL, `Esc` close.
- **Previews:** cards show the site's preview image (`og:image`), or its icon on a coloured placeholder. New saves get it from the open tab. For older sites and sites saved from the phone, click **Enable** on the dashboard notice (or Settings → *Fetch previews*). The browser asks once for permission to read pages, and the extension then reads each saved page's HTML. No AI is used. Images load straight from each site with no referrer sent.
- **Pin** a card to keep it at the top of its category.
- **Watch address** (radar icon on a card): for sites that keep moving to new domains. Once a night (random time 1-5 am, or when you next open the browser) the desktop extension requests the page with no cookies and no AI:
  - Server redirect, refresh tag, script redirect or canonical link to a new domain whose name and title match the saved site: the address is updated automatically and the old one is kept (up to 5) so you can restore it.
  - New address that doesn't clearly match (e.g. twitter.com → x.com): shown as **New address found** for you to accept or reject. Rejected addresses aren't suggested again.
  - Parking or for-sale pages are never followed.
  - Bot-protection pages count as "couldn't check"; for those and script-only pages the extension briefly opens the site in a muted background tab.
  - After 3 failed nights in a row the card shows **Unreachable**. Paste the new address in Edit if you know it.
  - Uses the same optional all-sites permission as previews. The phone app shows the results after a sync but doesn't run checks.
- **⇄** Re-organize: merges near-duplicate topics and moves clear outliers. Local, uses no AI tokens. Preview, apply, undo.

## Mobile
Chrome on Android has no extensions. Open **https://mayank-kushwaha.github.io/Ai-Chrome-Extensions/app/** on the phone, then *Add to Home screen* (iPhone: Safari → Share → Add to Home Screen). It is deployed by `.github/workflows/vault-pages.yml` on every push that changes `app/`, `core/` or `icons/`; only those folders are published. Enter the same two keys. Use **＋ Add** or Android's Share menu to save a URL (Gemini reads the page).

## Tests
- `npm test`: offline unit and pipeline tests (fake GitHub and Gemini).
- Put keys in `dev.env.local.js` (git-ignored), then `npm run live` checks the real APIs.

## Privacy
Page text (title, description, headings, about 2,200 characters) is sent to Gemini. On the free tier Google may use it to improve its products. Localhost, private IPs, mail, login pages, banking and password managers are never sent, plus any words you add to the never-send list. Incognito tabs are not saved. Keys are stored unencrypted in this browser's extension storage. Secret gists are unlisted, not private: anyone with the URL can read them.
