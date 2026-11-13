// Nightly refresh: opens the site in headless Chromium in "nightly" mode, which pulls ESPN and runs the
// basketball and football sims, then saves the browser's saved data to data.json for the site to load instantly.
const { chromium } = require('playwright'), http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), PORT = 8765, LIMIT = 25 * 60e3;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript' };
const server = http.createServer((req, res) => { const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });

// EA SPORTS College Football 27 ratings (reference data for the Stats page and injury values; never used by the model).
// Tries EA's ratings JSON feed first, then the public ratings pages. Returns [[name, team, pos, ovr], ...].
async function eaRatings(UA) {
  const out = new Map(), add = (nm, tm, pos, ovr) => { nm = String(nm || '').trim(); tm = String(tm || '').trim(); ovr = +ovr; if (!nm || !tm || !(ovr >= 40 && ovr <= 99)) return; out.set(nm + '|' + tm, [nm, tm, String(pos || ''), ovr]); };
  const pick = o => { if (!o || typeof o !== 'object') return; const ovr = o.overallRating ?? o.ovr ?? o.overall ?? (o.ratings && (o.ratings.ovr || o.ratings.overall));
    const nm = o.firstName && o.lastName ? o.firstName + ' ' + o.lastName : o.fullName || o.playerName || o.name, tm = o.team && typeof o.team === 'object' ? o.team.label || o.team.name || o.team.title || o.team.shortName : o.teamName || o.team || o.school,
      pos = o.position && typeof o.position === 'object' ? o.position.shortLabel || o.position.abbreviation || o.position.id || o.position.label : o.positionShort || o.pos || o.position;
    if (ovr != null && nm && tm) add(nm, tm, pos, ovr); for (const k in o) if (o[k] && typeof o[k] === 'object') pick(o[k]); };
  const H = { 'user-agent': UA, accept: 'application/json,text/html;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.ea.com/' };
  for (const base of ['https://drop-api.ea.com/rating/college-football', 'https://drop-api.ea.com/rating/ea-sports-college-football']) {
    for (let off = 0; off < 15000; off += 100) { let j; try { const r = await fetch(`${base}?locale=en&limit=100&offset=${off}`, { headers: H }); if (!r.ok) { console.log('EA feed', base, r.status); break; } j = await r.json(); } catch (e) { console.log('EA feed error', e.message); break; }
      const n0 = out.size; pick(j); if (out.size === n0) break; }
    if (out.size > 1000) break; }
  if (out.size < 1000) for (let pg = 1; pg <= 150; pg++) { let html; try { const r = await fetch(`https://www.ea.com/games/ea-sports-college-football/ratings?page=${pg}`, { headers: H }); if (!r.ok) { console.log('EA page', pg, r.status); break; } html = await r.text(); } catch (e) { console.log('EA page error', e.message); break; }
    const n0 = out.size, nd = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html); if (nd) { try { pick(JSON.parse(nd[1])); } catch (e) {} }
    if (out.size === n0) { const txt = html.replace(/\\"/g, '"'); const re = /"overallRating":(\d+)/g; let m; while ((m = re.exec(txt))) { const w = txt.slice(Math.max(0, m.index - 1500), m.index + 1500), g = k => (new RegExp('"' + k + '":"([^"]+)"').exec(w) || [])[1]; add(g('firstName') && g('lastName') ? g('firstName') + ' ' + g('lastName') : g('fullName'), (/"team":\{[^}]*?"label":"([^"]+)"/.exec(w) || [])[1] || g('teamName'), (/"position":\{[^}]*?"shortLabel":"([^"]+)"/.exec(w) || [])[1], m[1]); } }
    if (out.size === n0) break; }
  return [...out.values()];
}
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
  // NCAA 27 ratings: refresh weekly (kept from the previous data.json otherwise)
  try { const prev = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cfb26_ncaa') || 'null'); } catch (e) { return null; } });
    if (process.env.NCAA_FORCE || !prev || !prev.at || Date.now() - prev.at > 6 * 864e5) { const p = await eaRatings(UA); console.log('NCAA 27 ratings:', p.length, 'players', p.slice(0, 3).map(x => x.join(' ')).join(' | '));
      if (p.length > 500) await page.evaluate(v => localStorage.setItem('cfb26_ncaa', v), JSON.stringify({ at: Date.now(), src: 'EA SPORTS College Football 27', p })); }
    else console.log('NCAA 27 ratings: kept from', new Date(prev.at).toISOString().slice(0, 10)); } catch (e) { console.log('NCAA 27 ratings failed:', e.message); }
  // Past seasons for player ratings (CollegeFootballData, needs the CFBD_KEY repository secret): refresh monthly, kept from the previous data.json otherwise
  if (process.env.CFBD_KEY) try { const prev = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cfb26_career') || 'null'); } catch (e) { return null; } });
    if (process.env.CFBD_FORCE || !prev || !prev.at || Date.now() - prev.at > 30 * 864e5) {
      const get = async p => { const r = await fetch('https://api.collegefootballdata.com' + p, { headers: { Authorization: 'Bearer ' + process.env.CFBD_KEY, accept: 'application/json' } }); if (!r.ok) throw new Error('CFBD ' + r.status + ' ' + p); return r.json(); };
      const MAP = { passing: { COMPLETIONS: 9, ATT: 8, YDS: 0, TD: 11, INT: 10 }, rushing: { CAR: 12, YDS: 1, TD: 14 }, receiving: { REC: 13, YDS: 2, TD: 15 }, defensive: { TOT: 4, SACKS: 5, TFL: 6 }, interceptions: { INT: 7 } };
      const keep = new Set(await page.evaluate(() => { try { return Object.keys((JSON.parse(localStorage.getItem('cfb26_pbox_v5') || '{}').n) || {}); } catch (e) { return []; } }));
      const season = new Date().getMonth() < 1 ? new Date().getFullYear() - 1 : new Date().getFullYear(), out = { v: 1, at: Date.now(), yrs: {}, cls: {} };
      for (const y of [season - 1, season - 2, season - 3]) { const m = {}; for (const cat in MAP) for (const r of await get(`/stats/player/season?year=${y}&category=${cat}`) || []) { const q = MAP[cat][String(r.statType).toUpperCase()]; if (q == null) continue; const id = String(r.playerId); (m[id] || (m[id] = new Array(16).fill(0)))[q] += +r.stat || 0; }
        const yo = {}; for (const id in m) { const a = m[id]; a[3] = a[14] + a[15]; if (a[8] >= 20 || a[12] >= 10 || a[13] >= 5 || a[4] >= 10 || a[5] + a[7] >= 2) yo[id] = a.map(x => Math.round(x * 10) / 10); } out.yrs[y] = yo; }
      try { for (const p of await get(`/roster?year=${season}`) || []) if (p.year && keep.has(String(p.id))) out.cls[p.id] = p.year; } catch (e) { console.log('CFBD roster failed:', e.message); }
      await page.evaluate(v => localStorage.setItem('cfb26_career', v), JSON.stringify(out)); console.log('Career stats:', Object.values(out.yrs).map(o => Object.keys(o).length).join(' / '), 'player-seasons,', Object.keys(out.cls).length, 'class years'); }
    else console.log('Career stats: kept from', new Date(prev.at).toISOString().slice(0, 10)); } catch (e) { console.log('Career stats failed:', e.message); }
  else console.log('Career stats: no CFBD_KEY secret, skipped');
  // Football EPA per play this season (CollegeFootballData): refresh daily
  if (process.env.CFBD_KEY) try { const season = new Date().getMonth() < 1 ? new Date().getFullYear() - 1 : new Date().getFullYear(), get = async p => { const r = await fetch('https://api.collegefootballdata.com' + p, { headers: { Authorization: 'Bearer ' + process.env.CFBD_KEY, accept: 'application/json' } }); if (!r.ok) throw new Error('CFBD ' + r.status + ' ' + p); return r.json(); };
    let rows = []; try { rows = await get(`/ppa/players/season?year=${season}`); } catch (e) { for (const c of ['ACC', 'Big 12', 'Big Ten', 'SEC', 'Pac-12', 'American Athletic', 'Conference USA', 'Mid-American', 'Mountain West', 'Sun Belt', 'FBS Independents']) { try { rows.push(...await get(`/ppa/players/season?year=${season}&conference=${encodeURIComponent(c)}`)); } catch (x) {} } }
    const p = {}; for (const r of rows || []) { const a = r.averagePPA || {}, t = r.totalPPA || {}; if (a.all == null) continue; p[String(r.id)] = [a.all, a.pass, a.rush, a.all ? Math.round(t.all / a.all) : 0].map(x => x == null ? null : Math.round(x * 1000) / 1000); }
    if (Object.keys(p).length > 200) { await page.evaluate(v => localStorage.setItem('cfb26_epa', v), JSON.stringify({ at: Date.now(), p })); console.log('Football EPA:', Object.keys(p).length, 'players'); } else console.log('Football EPA: only', Object.keys(p).length, 'players, kept the old file'); } catch (e) { console.log('Football EPA failed:', e.message); }
  // Basketball prior seasons (CollegeBasketballData, same CFBD_KEY secret): refresh monthly
  if (process.env.CFBD_KEY) try { const prev = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('cbb26_career') || 'null'); } catch (e) { return null; } });
    if (process.env.CFBD_FORCE || !prev || !prev.at || Date.now() - prev.at > 30 * 864e5) {
      const get = async p => { const r = await fetch('https://api.collegebasketballdata.com' + p, { headers: { Authorization: 'Bearer ' + process.env.CFBD_KEY, accept: 'application/json' } }); if (!r.ok) throw new Error('CBBD ' + r.status + ' ' + p); return r.json(); };
      const out = { v: 1, at: Date.now(), yrs: {} }, v_ = x => +(x && typeof x === 'object' ? x.total ?? x.made ?? 0 : x) || 0, r1 = x => typeof x === 'number' ? Math.round(x * 10) / 10 : x;
      for (const y of [2026, 2025]) { const o = {}; for (const r of await get(`/stats/player/season?season=${y}`) || []) { const gp = +r.games || 0, mn = +r.minutes || 0; if (gp < 3 || mn < 30) continue; const fg = r.fieldGoals || {}, tp = r.threePointFieldGoals || {}, ft = r.freeThrows || {}, rb = r.rebounds || {};
          const id = r.athleteSourceId != null ? String(r.athleteSourceId) : 'x' + (r.athleteId ?? r.id); o[id] = [gp, mn, +r.points || 0, +fg.made || 0, +fg.attempted || 0, +tp.made || 0, +tp.attempted || 0, +ft.made || 0, +ft.attempted || 0, v_(rb.offensive), v_(rb.defensive), +r.assists || 0, +r.steals || 0, +r.blocks || 0, v_(r.turnovers), r.name || [r.firstName, r.lastName].filter(Boolean).join(' '), r.team || ''].map(r1); }
        out.yrs[y] = o; }
      await page.evaluate(v => localStorage.setItem('cbb26_career', v), JSON.stringify(out)); console.log('Basketball prior seasons:', Object.values(out.yrs).map(o => Object.keys(o).length).join(' / '), 'players'); }
    else console.log('Basketball prior seasons: kept from', new Date(prev.at).toISOString().slice(0, 10)); } catch (e) { console.log('Basketball prior seasons failed:', e.message); }
  const ls = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.indexOf('__snap') !== 0 && k !== 'cfbd_key' && k !== 'cfb26_cfbdc') o[k] = localStorage.getItem(k); } return o; });
  const out = JSON.stringify({ v: 1, at: Date.now(), ls });
  fs.writeFileSync(path.join(ROOT, 'data.json'), out);
  console.log(`data.json: ${Object.keys(ls).length} items, ${(out.length / 1048576).toFixed(2)} MB`);
  await browser.close(); server.close();
  if (partial) console.log('Saved what finished; the rest keeps its previous data.');
})().catch(e => { console.error(e); process.exit(1); });
