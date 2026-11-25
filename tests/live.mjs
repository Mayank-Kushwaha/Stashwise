// Live API check with your real keys (dev.env.local.js). Run: node tests/live.mjs
// Uses ~3 Gemini calls. If a GitHub token is set it also creates, reads and deletes a temporary secret gist.
import { GEMINI_API_KEY as gem, GITHUB_TOKEN as gh } from '../dev.env.local.js';
const mem = {};
globalThis.chrome = { storage: { local: { get: async k => ({ [k]: mem[k] }), set: async o => Object.assign(mem, o) } } };
const { DEF } = await import('../core/kv.js');
const { embed, gen, SCHEMA, FIELDS, clean } = await import('../core/ai.js');
const G = await import('../core/gist.js');
const c = { ...DEF, gem };
const step = async (n, f) => { try { console.log('OK  ', n, '->', await f()); } catch (e) { console.log('FAIL', n, '->', e.status ?? '', e.message); process.exitCode = 1; } };

if (!gem) console.log('Paste GEMINI_API_KEY into dev.env.local.js first.');
else {
  await step('embedding (768 dims)', async () => (await embed(c, 'title: iLovePDF | text: free pdf tools')).length);
  await step('structured analysis', async () => JSON.stringify(clean(await gen(c,
    `Existing sections/topics:\n(none yet)\n\nPage:\nURL: https://www.ilovepdf.com\nTitle: iLovePDF | Online PDF tools\nText: Merge, split, compress and convert PDF files for free.\n\n${FIELDS}`, SCHEMA))));
}
if (gh) {
  await step('github gist create/read/patch/delete', async () => {
    const id = await G.create(gh);
    try {
      await G.patch(gh, id, { 'bm-test.json': { content: '[]' } });
      const r = await G.get(gh, id);
      return Object.keys(r.data.files).join(',');
    } finally { await G.remove(gh, id); }
  });
} else console.log('GITHUB_TOKEN empty: skipped gist check.');
