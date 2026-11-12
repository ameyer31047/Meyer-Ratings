// Nightly refresh: opens the site in headless Chromium in "nightly" mode, which pulls ESPN and runs the
// basketball and football sims, then saves the browser's saved data to data.json for the site to load instantly.
const { chromium } = require('playwright'), http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), PORT = 8765, LIMIT = 25 * 60e3;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript' };
const server = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise(r => server.listen(PORT, r));
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const browser = await chromium.launch(), page = await (await browser.newContext({ userAgent: UA })).newPage(), start = Date.now();
  // ESPN API calls go through Node instead of the browser: no CORS, a normal Chrome user agent, at most 4 at a time, and retries with backoff
  const stats = {}; let active = 0; const waitq = [], slot = () => active < 4 ? (active++, Promise.resolve()) : new Promise(r => waitq.push(r)), free = () => { const n = waitq.shift(); n ? n() : active--; };
  const BASE = process.env.ESPN_TEST_BASE;
  if (!process.env.MOCK) await page.route(/^https:\/\/(site\.api|sports\.core\.api)\.espn\.com\//, async route => {
    const url = route.request().url(), u = BASE ? url.replace(/^https:\/\/[^/]+/, BASE) : url; let last = 'none';
    await slot();
    try { for (let a = 0; a < 6; a++) { if (a) await new Promise(r => setTimeout(r, 2000 * 2 ** (a - 1)));
        try { const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'application/json,*/*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.espn.com/' } }); last = String(r.status);
          if (r.ok) { const body = Buffer.from(await r.arrayBuffer()); stats.ok = (stats.ok || 0) + 1; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body }); }
          if (r.status === 404) break; } catch (e) { last = e.code || e.message; } }
      stats[last] = (stats[last] || 0) + 1; if (stats[last] <= 2) console.log('ESPN gave up', last, url.split('?')[0]);
      return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '' });
    } finally { free(); } });
  page.on('pageerror', e => console.log('page error:', e.message));
  const bad = {}; page.on('response', r => { if (r.status() >= 400 && /espn/.test(r.url())) { const k = r.status() + ' ' + r.url().split('?')[0]; if ((bad[k] = (bad[k] || 0) + 1) <= 2) console.log('ESPN', k); } });
  page.on('requestfailed', r => { if (/espn/.test(r.url())) { const k = 'fail ' + r.url().split('?')[0]; if ((bad[k] = (bad[k] || 0) + 1) <= 2) console.log('ESPN', k, (r.failure() || {}).errorText); } });
  let fbTries = 0;
  if (process.env.MOCK) await require(path.resolve(process.env.MOCK))(page);
  await page.goto(`http://localhost:${PORT}/index.html?nightly#fb`);
  let st = {};
  while (Date.now() - start < LIMIT) {
    await page.waitForTimeout(5000);
    st = await page.evaluate(() => { const j = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, r = j('cbb26_run'), f = j('cfb26_agg');
      return { cbb: r && r.meta ? Date.parse(r.meta.at) : 0, cfb: f && f.agg ? Date.parse(f.agg.at) : 0, cbbS: document.getElementById('status').textContent, cfbS: document.getElementById('fb-status').textContent, cbbP: document.getElementById('paste-msg').textContent.slice(0, 200) }; });
    if (process.env.VERBOSE) console.log(Math.round((Date.now() - start) / 1000) + 's', JSON.stringify(st));
    if (st.cbb > start && st.cfb > start) break;
    // football pull failed (ESPN throttling while basketball pulls): wait until basketball is done, then retry, up to 3 times
    if (!(st.cfb > start) && /failed/i.test(st.cfbS) && st.cbb > start && fbTries < 3) { fbTries++; console.log('football retry ' + fbTries + ': ' + st.cfbS); await page.waitForTimeout(30000 * fbTries); await page.evaluate(() => document.getElementById('fb-refresh').click()); }
  }
  console.log('status', JSON.stringify(st));
  console.log('ESPN requests', JSON.stringify(stats));
  const partial = !(st.cbb > start && st.cfb > start);
  if (partial) console.error('Warning: ' + (st.cbb > start ? '' : 'basketball ') + (st.cfb > start ? '' : 'football ') + 'did not finish');
  if (!(st.cbb > start) && !(st.cfb > start)) { await browser.close(); server.close(); process.exit(1); }
  const ls = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf('__snap') !== 0) o[k] = localStorage.getItem(k); } return o; });
  const out = JSON.stringify({ v: 1, at: Date.now(), ls });
  fs.writeFileSync(path.join(ROOT, 'data.json'), out);
  console.log(`data.json: ${Object.keys(ls).length} items, ${(out.length / 1048576).toFixed(2)} MB`);
  await browser.close(); server.close();
  if (partial) console.log('Saved what finished; the rest keeps its previous data.');
})().catch(e => { console.error(e); process.exit(1); });
