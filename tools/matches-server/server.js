// Jaguar X match server: the only thing that talks to API-Football. The app reads from here.
//
// - The API-Football key lives in .env on this server only (never in the app or a repo).
// - Requests to API-Football are planned so the daily limit is never passed (free plan = 100 a day).
// - Everything is kept on disk (data/), so a restart costs no requests.
// - Team / league names are turned into Arabic here (names.json, leagues.json).
// - Only our app can ask: every request carries a time + HMAC signature made with APP_SECRET.
//
// No npm packages: plain Node.js 20+ (built-in fetch, http, crypto, fs).
// Run:  node server.js            (the service)
//       node server.js --coverage (one request: which Iraqi competitions exist and what data they have)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- settings (.env) ----------
const DIR = __dirname;
function loadEnv() {
  const f = path.join(DIR, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();
const API_KEY = process.env.API_KEY || '';
const APP_SECRET = process.env.APP_SECRET || '';
const STATUS_KEY = process.env.STATUS_KEY || '';
const PORT = +(process.env.PORT || 8080);
const DAILY_LIMIT = +(process.env.DAILY_LIMIT || 100);          // the plan's requests per day
const LIVE_EVERY_MIN = +(process.env.LIVE_EVERY_MIN || 6);       // minutes between live updates (Pro: 1)
const API = process.env.API_BASE || 'https://v3.football.api-sports.io';
const TZ = 'Asia/Baghdad';
const DATA = path.join(DIR, 'data');
fs.mkdirSync(DATA, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- small disk store ----------
function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return def; }
}
function writeJson(name, v) {
  const f = path.join(DATA, name);
  fs.writeFileSync(f + '.tmp', JSON.stringify(v));
  fs.renameSync(f + '.tmp', f);
}

// ---------- names ----------
let leagues = [], leagueAr = {}, order = {}, byId = {}, byName = {};
function loadNames() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(DIR, 'leagues.json'), 'utf8')).leagues || [];
    leagues = l.filter(x => Number.isInteger(x.id));
    leagueAr = {}; order = {};
    leagues.forEach((x, i) => { leagueAr[x.id] = x.ar; order[x.id] = i; });
  } catch (e) { log('leagues.json:', e.message); }
  try {
    const n = JSON.parse(fs.readFileSync(path.join(DIR, 'names.json'), 'utf8'));
    byId = n.byId || {};
    byName = {};
    for (const [k, v] of Object.entries(n.byName || {})) byName[k.trim().toLowerCase()] = v;
  } catch (e) { log('names.json:', e.message); }
}
loadNames();
fs.watchFile(path.join(DIR, 'names.json'), loadNames);
fs.watchFile(path.join(DIR, 'leagues.json'), loadNames);

const missing = readJson('missing.json', {});
function teamAr(t) {
  if (!t) return '';
  const ar = byId[t.id] || byName[(t.name || '').toLowerCase()];
  if (ar) return ar;
  if (t.name && !missing[t.id]) { missing[t.id] = t.name; writeJson('missing.json', missing); }
  return t.name || '';
}

// ---------- the daily budget ----------
// API-Football's day starts at 00:00 UTC. We count ourselves and also trust the header it sends back.
let budget = readJson('budget.json', { day: '', used: 0, remaining: null, log: [] });
function today() { return new Date().toISOString().slice(0, 10); }
function rollDay() { if (budget.day !== today()) budget = { day: today(), used: 0, remaining: null, log: [] }; }
function left() {
  rollDay();
  const mine = DAILY_LIMIT - budget.used;
  return budget.remaining == null ? mine : Math.min(mine, budget.remaining);
}
// kind: 'live' may use the last requests; everything else stops 10 before the end.
function canSpend(kind) { return left() > (kind === 'live' ? 3 : 10); }

async function api(pathAndQuery, kind) {
  if (!API_KEY) throw new Error('no API_KEY in .env');
  if (!canSpend(kind)) { log('budget: skipped', kind, pathAndQuery); return null; }
  rollDay();
  budget.used++;
  budget.log.push(new Date().toISOString().slice(11, 16) + ' ' + kind + ' ' + pathAndQuery);
  if (budget.log.length > 150) budget.log.shift();
  const r = await fetch(API + pathAndQuery, { headers: { 'x-apisports-key': API_KEY } });
  const rem = r.headers.get('x-ratelimit-requests-remaining');
  if (rem != null && !isNaN(+rem)) budget.remaining = +rem;
  writeJson('budget.json', budget);
  if (!r.ok) { log('api', r.status, pathAndQuery); return null; }
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) log('api errors', pathAndQuery, JSON.stringify(j.errors));
  return j;
}

// ---------- turning API-Football into our format ----------
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const DONE = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const OFF = new Set(['PST', 'CANC', 'ABD']);
const statusAr = { NS: '', TBD: 'الوكت مو محدد', HT: 'استراحة', FT: 'انتهت', AET: 'انتهت (أشواط إضافية)', PEN: 'انتهت (ترجيح)',
  PST: 'تأجلت', CANC: 'ألغيت', ABD: 'توقفت', SUSP: 'متوقفة', INT: 'متوقفة', BT: 'استراحة', P: 'ركلات ترجيح', ET: 'أشواط إضافية' };

function state(short) { return LIVE.has(short) ? 'in' : DONE.has(short) ? 'post' : OFF.has(short) ? 'off' : 'pre'; }

function side(t, goals) {
  return { id: t.id, name: teamAr(t), en: t.name || '', logo: t.logo || '', goals: goals == null ? null : goals };
}

function brief(f) {
  const s = f.fixture.status || {};
  return {
    id: f.fixture.id, league: f.league.id, leagueName: leagueAr[f.league.id] || f.league.name, leagueLogo: f.league.logo || '',
    season: f.league.season, round: f.league.round || '',
    start: (f.fixture.timestamp || 0) * 1000, state: state(s.short), short: s.short || '',
    status: statusAr[s.short] ?? '', minute: s.elapsed ?? null, extra: s.extra ?? null,
    home: side(f.teams.home, f.goals.home), away: side(f.teams.away, f.goals.away),
    venue: [f.fixture.venue?.name, f.fixture.venue?.city].filter(Boolean).join('، '),
    referee: (f.fixture.referee || '').replace(/,.*$/, ''),
  };
}

function full(f) {
  const b = brief(f);
  const homeId = f.teams.home.id;
  const sideOf = id => (id === homeId ? 'home' : 'away');
  b.events = (f.events || []).map(e => ({
    min: e.time?.elapsed ?? null, extra: e.time?.extra ?? null, side: sideOf(e.team?.id),
    type: e.type === 'Goal' ? 'goal' : e.type === 'Card' ? 'card' : e.type === 'subst' ? 'sub' : (e.type || '').toLowerCase(),
    detail: e.detail || '', player: e.player?.name || '', assist: e.assist?.name || '',
  }));
  b.lineups = {};
  for (const l of f.lineups || []) {
    b.lineups[sideOf(l.team?.id)] = {
      formation: l.formation || '', coach: l.coach?.name || '',
      start: (l.startXI || []).map(p => ({ n: p.player?.name || '', num: p.player?.number ?? '', pos: p.player?.pos || '' })),
      subs: (l.substitutes || []).map(p => ({ n: p.player?.name || '', num: p.player?.number ?? '', pos: p.player?.pos || '' })),
    };
  }
  b.stats = {};
  for (const s of f.statistics || []) {
    const o = {};
    for (const x of s.statistics || []) o[x.type] = x.value;
    b.stats[sideOf(s.team?.id)] = o;
  }
  return b;
}

// ---------- what we keep ----------
// days[date] = { at, matches: [brief] }   details[id] = { at, match: full }
let days = readJson('days.json', {});
let details = readJson('details.json', {});
let standings = readJson('standings.json', {});
let h2h = readJson('h2h.json', {});
function save() { writeJson('days.json', days); writeJson('details.json', details); }

function baghdadDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function baghdadHour() {
  return +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date());
}

// One request = every match in the world that day; we keep our leagues.
async function fetchDay(date) {
  const j = await api(`/fixtures?date=${date}&timezone=${encodeURIComponent(TZ)}`, 'day');
  if (!j) return false;
  const ours = (j.response || []).filter(f => f.league && order[f.league.id] != null).map(brief)
    .sort((a, b) => (order[a.league] - order[b.league]) || (a.start - b.start));
  days[date] = { at: Date.now(), matches: ours };
  // Old days are not needed after a week.
  for (const k of Object.keys(days)) if (k < baghdadDate(-7)) delete days[k];
  save();
  log('day', date, ours.length, 'matches');
  return true;
}

// Up to 20 matches in one request, with events, line-ups and statistics.
async function fetchFull(ids, kind) {
  ids = [...new Set(ids)];
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const j = await api(`/fixtures?ids=${part.join('-')}&timezone=${encodeURIComponent(TZ)}`, kind);
    if (!j) return;
    for (const f of j.response || []) {
      const m = full(f);
      details[m.id] = { at: Date.now(), match: m };
      // The day list follows the new score / minute too.
      for (const d of Object.values(days)) {
        const k = d.matches.findIndex(x => x.id === m.id);
        if (k >= 0) { const { events, lineups, stats, ...b } = m; d.matches[k] = b; }
      }
    }
  }
  for (const k of Object.keys(details)) if (Date.now() - details[k].at > 8 * 86400000) delete details[k];
  save();
}

async function fetchStandings(league, season) {
  const j = await api(`/standings?league=${league}&season=${season}`, 'standings');
  if (!j) return;
  const groups = j.response?.[0]?.league?.standings || [];
  standings[league] = {
    at: Date.now(), season,
    groups: groups.map(g => g.map(r => ({
      rank: r.rank, team: side(r.team, null), points: r.points, diff: r.goalsDiff, form: r.form || '',
      played: r.all?.played, win: r.all?.win, draw: r.all?.draw, lose: r.all?.lose,
      gf: r.all?.goals?.for, ga: r.all?.goals?.against, group: r.group || '', note: r.description || '',
    }))),
  };
  writeJson('standings.json', standings);
}

async function fetchH2h(a, b) {
  const key = [a, b].sort().join('-');
  const j = await api(`/fixtures/headtohead?h2h=${a}-${b}&last=5&timezone=${encodeURIComponent(TZ)}`, 'h2h');
  if (!j) return null;
  h2h[key] = { at: Date.now(), list: (j.response || []).map(brief) };
  writeJson('h2h.json', h2h);
  return h2h[key];
}

// ---------- the plan: runs every minute ----------
let lastLive = 0;
const flags = readJson('flags.json', { lineup60: {}, lineup20: {}, stats: {}, standingsDay: {} });
function saveFlags() { writeJson('flags.json', flags); }

async function tick() {
  rollDay();
  const d0 = baghdadDate(0), d1 = baghdadDate(1);
  const h = baghdadHour();
  // 1) The day lists: today + tomorrow at start, then again at 06:00 and 15:00 Baghdad.
  for (const d of [d0, d1]) {
    const have = days[d];
    const slot = h >= 15 ? 15 : h >= 6 ? 6 : 0;
    const want = !have || have.slotDay !== d0 || (have.slot ?? -1) < slot;
    if (want && await fetchDay(d)) { days[d].slot = slot; days[d].slotDay = d0; save(); }
  }
  const now = Date.now();
  const all = [...new Map(Object.values(days).flatMap(d => d.matches).map(m => [m.id, m])).values()];
  // 2) Live: matches started and not finished (from what we know), every LIVE_EVERY_MIN minutes.
  const live = all.filter(m => m.state === 'in' || (m.state === 'pre' && m.start <= now && now - m.start < 3 * 3600000));
  if (live.length && now - lastLive >= LIVE_EVERY_MIN * 60000 - 5000) {
    lastLive = now;
    await fetchFull(live.map(m => m.id), 'live');
  }
  // 3) Line-ups: about an hour before, and again about 20 minutes before (they are often out by then).
  const soon60 = all.filter(m => m.state === 'pre' && m.start - now < 62 * 60000 && m.start - now > 25 * 60000 && !flags.lineup60[m.id]);
  if (soon60.length) { await fetchFull(soon60.map(m => m.id), 'lineup'); soon60.forEach(m => (flags.lineup60[m.id] = 1)); saveFlags(); }
  const soon20 = all.filter(m => m.state === 'pre' && m.start - now < 22 * 60000 && m.start > now && !flags.lineup20[m.id]);
  if (soon20.length) { await fetchFull(soon20.map(m => m.id), 'lineup'); soon20.forEach(m => (flags.lineup20[m.id] = 1)); saveFlags(); }
  // 4) Statistics once after the end (the live update that saw the end already has most; this one is final).
  const ended = all.filter(m => m.state === 'post' && !flags.stats[m.id] && now - m.start < 12 * 3600000 && now - m.start > 2 * 3600000);
  if (ended.length) { await fetchFull(ended.map(m => m.id), 'stats'); ended.forEach(m => (flags.stats[m.id] = 1)); saveFlags(); }
  // 5) Standings: once a day for leagues that played, after their last match of the day ended.
  const byLeague = {};
  for (const m of days[d0]?.matches || []) (byLeague[m.league] ??= []).push(m);
  for (const [lg, ms] of Object.entries(byLeague)) {
    const key = lg + '@' + d0;
    if (flags.standingsDay[key]) continue;
    if (ms.every(m => m.state === 'post' || m.state === 'off') || !standings[lg]) {
      await fetchStandings(lg, ms[0].season);
      flags.standingsDay[key] = 1; saveFlags();
    }
  }
  // Old flags go after a few days.
  if (Object.keys(flags.stats).length > 3000) { flags.lineup60 = {}; flags.lineup20 = {}; flags.stats = {}; saveFlags(); }
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try { await tick(); } catch (e) { log('tick:', e.message); } finally { running = false; }
}

// ---------- the app's door ----------
function signed(req, url) {
  if (!APP_SECRET) return false;
  const t = req.headers['x-jx-time'] || '';
  const sig = req.headers['x-jx-sig'] || '';
  if (!/^\d{10,13}$/.test(t) || Math.abs(Date.now() - +t) > 5 * 60000) return false;
  const want = crypto.createHmac('sha256', APP_SECRET).update(t + url.pathname + url.search).digest('hex');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

// 60 requests a minute per address is plenty for one viewer.
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { at: now, n: 0 };
  if (now - h.at > 60000) { h.at = now; h.n = 0; }
  h.n++; hits.set(ip, h);
  if (hits.size > 50000) hits.clear();
  return h.n > 60;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    // For Maytham: how many requests today, what was asked, names still in English.
    if (url.pathname === '/status' || url.pathname === '/missing') {
      if (!STATUS_KEY || url.searchParams.get('key') !== STATUS_KEY) return send(res, 403, { error: 'key' });
      if (url.pathname === '/missing') return send(res, 200, missing);
      rollDay();
      return send(res, 200, { day: budget.day, used: budget.used, left: left(), limit: DAILY_LIMIT, liveEveryMin: LIVE_EVERY_MIN,
        days: Object.fromEntries(Object.entries(days).map(([k, v]) => [k, v.matches.length])), requests: budget.log });
    }
    if (tooMany(ip)) return send(res, 429, { error: 'slow down' });
    if (!signed(req, url)) return send(res, 403, { error: 'app only' });

    if (url.pathname === '/v1/day') {
      const d = url.searchParams.get('d') || baghdadDate(0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: 'd' });
      let day = days[d];
      // Another day than today / tomorrow: fetched once when someone asks, then kept.
      if (!day && canSpend('day')) { await fetchDay(d); day = days[d]; }
      if (!day) return send(res, 503, { error: 'not ready', limit: left() <= 10 });
      return send(res, 200, { date: d, at: day.at, leagues: leagues.map(l => ({ id: l.id, name: l.ar })), matches: day.matches });
    }
    if (url.pathname === '/v1/match') {
      const id = +url.searchParams.get('id');
      if (!id) return send(res, 400, { error: 'id' });
      let d = details[id];
      const known = Object.values(days).flatMap(x => x.matches).find(m => m.id === id);
      // Nothing kept yet (e.g. a match days away): one request, kept 6 hours.
      if ((!d || (Date.now() - d.at > 6 * 3600000 && known?.state !== 'post')) && canSpend('detail')) { await fetchFull([id], 'detail'); d = details[id]; }
      const m = d?.match || known;
      if (!m) return send(res, 404, { error: 'none' });
      // Head to head: only on demand, kept a week.
      const key = [m.home.id, m.away.id].sort().join('-');
      let hh = h2h[key];
      if ((!hh || Date.now() - hh.at > 7 * 86400000) && canSpend('h2h')) hh = await fetchH2h(m.home.id, m.away.id);
      return send(res, 200, { at: d?.at || 0, match: m, h2h: (hh?.list || []).filter(x => x.id !== id) });
    }
    if (url.pathname === '/v1/standings') {
      const lg = +url.searchParams.get('league');
      const s = standings[lg];
      if (!s) return send(res, 404, { error: 'none' });
      return send(res, 200, { league: lg, name: leagueAr[lg] || '', ...s });
    }
    send(res, 404, { error: 'path' });
  } catch (e) {
    log('req', url.pathname, e.message);
    send(res, 500, { error: 'server' });
  }
});

// ---------- coverage check ----------
async function coverage() {
  if (!API_KEY) { console.log('API_KEY is missing in .env'); process.exit(1); }
  const r = await fetch(API + '/leagues?country=Iraq', { headers: { 'x-apisports-key': API_KEY } });
  const j = await r.json();
  if (j.errors && Object.keys(j.errors).length) console.log('errors:', JSON.stringify(j.errors));
  for (const x of j.response || []) {
    console.log(`\n${x.league.id}  ${x.league.name} (${x.league.type})`);
    for (const s of (x.seasons || []).slice(-3)) {
      const c = s.coverage || {}, f = c.fixtures || {};
      console.log(`  season ${s.year} ${s.start}..${s.end}${s.current ? ' CURRENT' : ''}: events=${f.events} lineups=${f.lineups} ` +
        `match-stats=${f.statistics_fixtures} standings=${c.standings} top-scorers=${c.top_scorers}`);
    }
  }
  console.log('\nrequests left today:', r.headers.get('x-ratelimit-requests-remaining'));
  // The free plan may not open the current season: one small test.
  const t = await fetch(API + '/status', { headers: { 'x-apisports-key': API_KEY } });
  const st = await t.json();
  console.log('plan:', JSON.stringify(st.response?.subscription || st.errors));
}

if (process.argv.includes('--coverage')) {
  coverage().then(() => process.exit(0), e => { console.log(e.message); process.exit(1); });
} else {
  if (!API_KEY || !APP_SECRET || !STATUS_KEY) log('WARNING: API_KEY / APP_SECRET / STATUS_KEY missing in .env');
  server.listen(PORT, '127.0.0.1', () => log('listening on', PORT, '| limit', DAILY_LIMIT, '| live every', LIVE_EVERY_MIN, 'min'));
  loop();
  setInterval(loop, 60000);
}
