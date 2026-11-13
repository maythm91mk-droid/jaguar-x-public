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
const ar = require('./arabic');
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://api.jaguarxiq.com').replace(/\/$/, '');
let teamLogo = {}, teamLogoId = {};
let leagues = [], leagueAr = {}, leagueLogo = {}, order = {}, byId = {}, byName = {}, byKey = {}, people = {};
function loadNames() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(DIR, 'leagues.json'), 'utf8')).leagues || [];
    leagues = l.filter(x => Number.isInteger(x.id));
    leagueAr = {}; order = {}; leagueLogo = {};
    // «logo» in leagues.json replaces the data source's picture (his ask: the Iraq Stars League showed the old one).
    leagues.forEach((x, i) => { leagueAr[x.id] = x.ar; order[x.id] = i; if (x.logo) leagueLogo[x.id] = PUBLIC_URL + '/logo/league/' + x.id + '.png?v=' + crypto.createHash('sha1').update(x.logo).digest('hex').slice(0, 8); });
  } catch (e) { log('leagues.json:', e.message); }
  try {
    const n = JSON.parse(fs.readFileSync(path.join(DIR, 'names.json'), 'utf8'));
    // «logos»: English team name → a better picture (his ask: Iraqi clubs on white squares or with none).
    teamLogo = {}; for (const [k, v] of Object.entries(n.logos || {})) if (!k.startsWith('_')) teamLogo[ar.key(k)] = v;
    byId = n.byId || {};
    byName = {};
    for (const [k, v] of Object.entries(n.byName || {})) byName[k.trim().toLowerCase()] = v;
    // The same names by a loose key (no FC / SC, no accents, «Al-» = «Al »): the API writes one team several ways.
    byKey = {};
    for (const [k, v] of Object.entries(n.byName || {})) { const kk = ar.key(k); if (kk && !byKey[kk]) byKey[kk] = v; }
    // Players / coaches / referees written by hand: "English name" → Arabic.
    people = {};
    for (const [k, v] of Object.entries(n.people || {})) people[ar.plain(k).trim().toLowerCase()] = v;
  } catch (e) { log('names.json:', e.message); }
}
loadNames();
fs.watchFile(path.join(DIR, 'names.json'), loadNames);
fs.watchFile(path.join(DIR, 'leagues.json'), loadNames);

const missing = readJson('missing.json', {});
/** Levenshtein distance, stopping once it passes [max]. */
function dist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const nearCache = new Map();
/** names.json's Arabic for a team: by id, exact name, loose key, then a near spelling («Al Taawon» = «Al Taawoun»). */
function handName(t) {
  const en = t.name || '';
  const hit = byId[t.id] || byName[en.toLowerCase()];
  if (hit) return hit;
  const k = ar.key(en);
  if (!k) return null;
  if (byKey[k]) return byKey[k];
  if (nearCache.has(k)) return nearCache.get(k);
  let found = null;
  if (k.length >= 6) {
    const max = k.length >= 10 ? 2 : 1;
    let best = max + 1, n = 0;
    for (const [kk, v] of Object.entries(byKey)) {
      const d = dist(k, kk, max);
      if (d < best) { best = d; found = v; n = 1; } else if (d === best && v !== found) n++;
    }
    if (n !== 1) found = null;   // two names as near: neither is trusted
  }
  nearCache.set(k, found);
  return found;
}
/** A team in Arabic: by hand (names.json), else written by how it sounds (never machine-translated). */
function teamAr(t) {
  if (!t) return '';
  const hand = handName(t);
  if (hand) return hand;
  // «Scotland U21» / «Iraq U-23» / «England Women»: the country by hand + an Arabic tag («سكوتلاند أو» before).
  const age = /^(.+?)\s+(?:U-?|Under[- ]?)(\d{2})$/i.exec(t.name || '');
  const wom = /^(.+?)\s+(?:Women|W)$/i.exec(t.name || '');
  if (age) return teamAr({ name: age[1] }) + ' تحت ' + age[2];
  if (wom) return teamAr({ name: wom[1] }) + ' سيدات';
  if (t.name && !missing[t.id]) { missing[t.id] = t.name; writeJson('missing.json', missing); }
  return ar.team(t.name || '');
}
/** A player: the name people know (his ask: «هالاند», not the full name). [full]: coaches / referees. */
function personAr(en, full = false) {
  if (!en) return '';
  return people[ar.plain(en).trim().toLowerCase()] || ar.person(en, full);
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
// Asked for by a viewer (not by the planned loop): a day nobody looked at yet, a match we know nothing about.
// Each has its own small daily allowance, so someone who pulled the app's secret out can't spend the whole plan.
const ASKED_MAX = { day: 15, match: 30 };
let asked = { day: '', day_n: 0, match_n: 0 };
function mayAsk(kind) {
  if (asked.day !== today()) asked = { day: today(), day_n: 0, match_n: 0 };
  if (asked[kind + '_n'] >= ASKED_MAX[kind]) { log('asked: daily allowance used', kind); return false; }
  asked[kind + '_n']++;
  return true;
}
/** A date the calendar can sensibly ask for: up to 60 days back or ahead of today (Baghdad). */
function nearDate(d) {
  const t = Date.parse(d + 'T00:00:00Z'), now = Date.parse(baghdadDate(0) + 'T00:00:00Z');
  return !isNaN(t) && Math.abs(t - now) <= 60 * 86400000;
}
/** Only the leagues in leagues.json (the app's leagues page shows only those). */
function ourLeague(id) { return order[id] != null; }

// kind: live may use the last requests; the day lists stop 10 before the end.
// What viewers open by hand (a match page, head to head) stops early, so the live scores never run out.
function canSpend(kind) { return left() > (kind === 'live' ? 3 : kind === 'detail' || kind === 'h2h' ? 40 : 10); }

// A kind the plan refuses (e.g. free plan + current season) is not asked again that day.
const planBlocked = {};
// When the source fails (down, refuses, sends an error) nothing is kept from that answer, the request is not
// counted against our own daily number (the source's own counter, sent back with every answer, still is), and
// we wait before asking again: 1 minute, then 2, 4 ... up to 15. One good answer clears the wait.
let failN = 0, failUntil = 0;
function failed(why, pathAndQuery) {
  failN++;
  const wait = Math.min(15, 2 ** (failN - 1));
  failUntil = Date.now() + wait * 60000;
  log('api failed:', why, pathAndQuery, '- waiting', wait, 'min');
}
async function api(pathAndQuery, kind) {
  if (!API_KEY) throw new Error('no API_KEY in .env');
  const today = new Date().toISOString().slice(0, 10);
  if (planBlocked[kind] === today) return null;
  if (Date.now() < failUntil) return null;
  if (!canSpend(kind)) { log('budget: skipped', kind, pathAndQuery); return null; }
  rollDay();
  budget.used++;
  const day = budget.day;
  const refund = () => { if (budget.day === day && budget.used > 0) budget.used--; writeJson('budget.json', budget); };
  budget.log.push(new Date().toISOString().slice(11, 16) + ' ' + kind + ' ' + pathAndQuery);
  if (budget.log.length > 150) budget.log.shift();
  let r;
  try { r = await fetch(API + pathAndQuery, { headers: { 'x-apisports-key': API_KEY }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { refund(); failed(e.message, pathAndQuery); return null; }
  const rem = r.headers.get('x-ratelimit-requests-remaining');
  if (rem != null && !isNaN(+rem)) budget.remaining = +rem;
  writeJson('budget.json', budget);
  if (!r.ok) { refund(); failed('http ' + r.status, pathAndQuery); return null; }
  let j;
  try { j = await r.json(); } catch (e) { refund(); failed('bad answer', pathAndQuery); return null; }
  if (j.errors && Object.keys(j.errors).length) {
    // An error answer has an empty "response": keeping it would show a day with no matches.
    if (j.errors.plan) { planBlocked[kind] = today; log('plan refuses', kind, pathAndQuery, '- not asked again today'); return null; }
    refund(); failed(JSON.stringify(j.errors).slice(0, 200), pathAndQuery);
    return null;
  }
  failN = 0; failUntil = 0;
  return j;
}

// ---------- turning API-Football into our format ----------
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
const DONE = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const OFF = new Set(['PST', 'CANC', 'ABD']);
const statusAr = { NS: '', TBD: 'الوكت مو محدد', HT: 'استراحة بين الشوطين', FT: 'انتهت', AET: 'انتهت (أشواط إضافية)', PEN: 'انتهت (ترجيح)',
  PST: 'تأجلت', CANC: 'ألغيت', ABD: 'توقفت', SUSP: 'متوقفة', INT: 'متوقفة', BT: 'استراحة قبل الأشواط الإضافية', P: 'ركلات ترجيح', ET: 'أشواط إضافية' };

function state(short) { return LIVE.has(short) ? 'in' : DONE.has(short) ? 'post' : OFF.has(short) ? 'off' : 'pre'; }

function side(t, goals) {
  return { id: t.id, name: teamAr(t), en: t.name || '', logo: t.logo || '', goals: goals == null ? null : goals };
}

function brief(f) {
  const s = f.fixture.status || {};
  return {
    id: f.fixture.id, league: f.league.id, leagueName: leagueAr[f.league.id] || f.league.name, leagueLogo: leagueLogo[f.league.id] || f.league.logo || '',
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
      // grid "row:col" (row 1 = goalkeeper) places each starter on the drawn pitch; id gives the player's photo.
      start: (l.startXI || []).map(p => ({ id: p.player?.id || 0, n: p.player?.name || '', num: p.player?.number ?? '', pos: p.player?.pos || '', grid: p.player?.grid || '' })),
      subs: (l.substitutes || []).map(p => ({ id: p.player?.id || 0, n: p.player?.name || '', num: p.player?.number ?? '', pos: p.player?.pos || '' })),
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
const seen = {};
async function fetchDay(date) {
  const j = await api(`/fixtures?date=${date}&timezone=${encodeURIComponent(TZ)}`, 'day');
  if (!j) return false;
  // The English name of each of our leagues as the API calls it (on /status), to check the ids in leagues.json.
  for (const f of j.response || []) if (f.league && order[f.league.id] != null) seen[f.league.id] = f.league.name + ' / ' + (f.league.country || '');
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
    if (!j) return false;
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
  return true;
}

// The season a league is playing now: from a match we keep, else asked once a week.
const seasons = readJson('seasons.json', {});
const leagueGames = {}, scorers = {};
async function currentSeason(lg) {
  for (const d of Object.values(days)) { const m = d.matches.find(x => x.league === lg); if (m?.season) return m.season; }
  const k = seasons[lg];
  if (k && Date.now() - k.at < 7 * 86400000) return k.year;
  const j = await api(`/leagues?id=${lg}&current=true`, 'season');
  const y = j?.response?.[0]?.seasons?.find(x => x.current)?.year || j?.response?.[0]?.seasons?.slice(-1)[0]?.year;
  if (!y) return null;
  seasons[lg] = { at: Date.now(), year: y };
  writeJson('seasons.json', seasons);
  return y;
}

async function fetchStandings(league, season) {
  const j = await api(`/standings?league=${league}&season=${season}`, 'standings');
  if (!j) return false;
  const groups = j.response?.[0]?.league?.standings || [];
  // An empty answer (a refusal, or the free plan before Pro) is not kept: it would hide the table for hours.
  if (!groups.length) return;
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
  // A league added to leagues.json shows the same day (12 Nov: the AFCON qualifiers waited for the next 06:00 list).
  const sig = Object.keys(order).sort().join(',');
  if (flags.leaguesSig !== sig) {
    for (const d of [d0, d1]) if (days[d]) days[d].slot = -1;
    flags.leaguesSig = sig; saveFlags();
  }
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
  if (soon60.length && await fetchFull(soon60.map(m => m.id), 'lineup')) { soon60.forEach(m => (flags.lineup60[m.id] = 1)); saveFlags(); }
  const soon20 = all.filter(m => m.state === 'pre' && m.start - now < 22 * 60000 && m.start > now && !flags.lineup20[m.id]);
  if (soon20.length && await fetchFull(soon20.map(m => m.id), 'lineup')) { soon20.forEach(m => (flags.lineup20[m.id] = 1)); saveFlags(); }
  // 4) Statistics once after the end (the live update that saw the end already has most; this one is final).
  const ended = all.filter(m => m.state === 'post' && !flags.stats[m.id] && now - m.start < 12 * 3600000 && now - m.start > 2 * 3600000);
  if (ended.length && await fetchFull(ended.map(m => m.id), 'stats')) { ended.forEach(m => (flags.stats[m.id] = 1)); saveFlags(); }
  // 5) Standings: once a day for leagues that played, after their last match of the day ended.
  const byLeague = {};
  for (const m of days[d0]?.matches || []) (byLeague[m.league] ??= []).push(m);
  for (const [lg, ms] of Object.entries(byLeague)) {
    const key = lg + '@' + d0;
    if (flags.standingsDay[key]) continue;
    if (ms.every(m => m.state === 'post' || m.state === 'off') || !standings[lg]) {
      // A failed try (the source down) is tried again; an answer, even an empty one, is enough for the day.
      if (await fetchStandings(lg, ms[0].season) !== false) { flags.standingsDay[key] = 1; saveFlags(); }
    }
  }
  // Old flags go after a few days.
  if (Object.keys(flags.stats).length > 3000) { flags.lineup60 = {}; flags.lineup20 = {}; flags.stats = {}; saveFlags(); }
}

// The channel of each of today's matches, read from yallashoot (tv.js), on its own so a slow site never holds the live updates.
const tvr = require('./tv').create({ log, readJson, writeJson, today: () => baghdadDate(0) });
// Matches API-Football doesn't carry (13 Nov 2026: Iraq × Lebanon, Basra tournament): ESPN for chosen teams + hand-added ones.
const fill = require('./fill').create({ log, teamAr: t => teamAr(t),
  readConfig: () => { try { return JSON.parse(configText || readConfigCopy() || 'null'); } catch { return null; } } });
const allOf = d => { const l = days[d]?.matches || []; return [...l, ...fill.of(d, l)]; };
async function fillLoop() { try { await fill.tick([baghdadDate(0), baghdadDate(1)]); } catch (e) { log('fill:', e.message); } }
let tvBusy = false;
async function tvLoop() {
  if (tvBusy) return;
  tvBusy = true;
  const today = days[baghdadDate(0)]?.matches || [];
  try { await tvr.tick([...today, ...fill.of(baghdadDate(0), today)].map(locMatch)); } catch (e) { log('tv:', e.message); } finally { tvBusy = false; }
}
// Viewers' answers to «هاي المباراة الصحيحة؟» (12 Nov 2026): AM's copies of one channel (F / NM / SA) show different
// matches, so the copy viewers said yes to is sent as tvCh (the exact channel name) and opened first.
let tvVotes = readJson('tvvotes.json', {});          // match id -> { channel name: yes minus no }
const voted = new Map();                             // match id + ip + channel -> time (one answer each)
let votesDirty = false;
setInterval(() => { if (votesDirty) { votesDirty = false; writeJson('tvvotes.json', tvVotes); } }, 30000);
function tvPick(id) {
  const v = tvVotes[id];
  if (!v) return '';
  let best = '', n = 0;
  for (const [c, k] of Object.entries(v)) if (k > n) { n = k; best = c; }
  return best;
}
function withTv(m) {
  const o = locMatch(m);
  if (o && typeof o === 'object') {
    const t = tvr.of(o); if (t) { o.tv = t; o.tvAr = tvr.arOf(o); }
    if (m.handTv) { o.tv = m.handTv; delete o.handTv; }
    const c = tvPick(o.id); if (c) o.tvCh = c;
  }
  return o;
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try { await tick(); } catch (e) { log('tick:', e.message); } finally { running = false; }
}

// ---------- a second home for the app's config.json ----------
// The app reads config.json from GitHub. If GitHub is ever down or the account is closed, it asks here
// (https://api.jaguarxiq.com/config.json). A copy is fetched every 5 minutes and kept on disk; only a copy that
// reads well (has servers) replaces the kept one. To take over by hand (GitHub gone or not trusted): put a file
// named config.override.json beside server.js - it is served instead, within 5 minutes.
const CONFIG_SRC = process.env.CONFIG_SRC || 'https://raw.githubusercontent.com/maythm91mk-droid/jaguar-x-public/main/config.json';
let configText = null;
function goodConfig(t) { try { const o = JSON.parse(t); return Array.isArray(o.servers) && o.servers.length > 0; } catch { return false; } }
function readConfigCopy() {
  for (const f of [path.join(DIR, 'config.override.json'), path.join(DATA, 'config.json')]) {
    try { const t = fs.readFileSync(f, 'utf8'); if (goodConfig(t)) return t; } catch {}
  }
  return null;
}
async function syncConfig() {
  try {
    const r = await fetch(CONFIG_SRC + '?t=' + Date.now(), { signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const t = await r.text();
      if (goodConfig(t)) { const f = path.join(DATA, 'config.json'); fs.writeFileSync(f + '.tmp', t); fs.renameSync(f + '.tmp', f); }
      else log('config copy: the file did not read well, kept the old one');
    } else log('config copy:', r.status);
  } catch (e) { log('config copy:', e.message); }
  configText = readConfigCopy();
}

// ---------- devices of a subscription (main device, joining by a code, one viewer at a time) ----------
let devices = null;
try { devices = require('./devices')({ secret: APP_SECRET, statusKey: STATUS_KEY, readJson, writeJson, log }); }
catch (e) { log('devices: not loaded:', e.message); }
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { devices && devices.flush(); } catch {} process.exit(0); });

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

// Names are put in Arabic when sent (not only when kept), so a fix in names.json shows at once on kept days too.
function locSide(sd) {
  if (!sd || typeof sd !== 'object') return sd;
  // A match added by hand (fill.js) already has its Arabic name and no English one.
  const o = { ...sd, name: !sd.en && /[\u0600-\u06FF]/.test(sd.name || '') ? sd.name : teamAr({ id: sd.id, name: sd.en || sd.name }) };
  const src = teamLogo[ar.key(sd.en || '')];
  if (src && sd.id) { teamLogoId[sd.id] = src; o.logo = PUBLIC_URL + '/logo/team/' + sd.id + '.png?v=' + crypto.createHash('sha1').update(src).digest('hex').slice(0, 8); }
  return o;
}
function locMatch(m) {
  if (!m || typeof m !== 'object') return m;
  const o = { ...m, home: locSide(m.home), away: locSide(m.away) };
  if (m.venue != null) {
    const [place, city] = String(m.venue).split('، ');
    o.venue = [ar.venue(place || ''), city ? ar.words(city) : ''].filter(Boolean).join('، ');
    o.venueEn = m.venue;
  }
  if (m.referee) { o.referee = personAr(m.referee, true); o.refereeEn = m.referee; }
  if (Array.isArray(m.events)) o.events = m.events.map(e => ({ ...e, player: personAr(e.player), assist: personAr(e.assist),
    playerEn: e.player, assistEn: e.assist }));
  if (m.lineups) {
    o.lineups = {};
    for (const [k, l] of Object.entries(m.lineups)) {
      const pl = p => ({ ...p, n: personAr(p.n), ne: p.n });
      o.lineups[k] = { ...l, coach: personAr(l.coach, true), coachEn: l.coach, start: (l.start || []).map(pl), subs: (l.subs || []).map(pl) };
    }
  }
  return o;
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
        days: Object.fromEntries(Object.entries(days).map(([k, v]) => [k, v.matches.length])), leagues: seen, tv: tvr.status(), fill: fill.status(), requests: budget.log });
    }
    // The support page (devices of a subscriber: reset the main one, remove a device). The page holds no key: Maytham types it.
    if (url.pathname === '/support') {
      let page = '';
      try { page = fs.readFileSync(path.join(__dirname, 'support.html'), 'utf8'); } catch (e) {}
      if (!page) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
        'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
      return res.end(page);
    }
    // The kept copy of config.json (public, like the one on GitHub). Before the per-address limit: many homes share one address.
    if (url.pathname === '/config.json') {
      if (!configText) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(configText);
    }
    // Devices of a subscription (devices.js): its own limits and signature. Many homes share one address.
    if (url.pathname.startsWith('/v1/dev/')) {
      if (!devices) return send(res, 404, { error: 'path' });
      const [code, obj] = await devices.handle(req, url, ip);
      return send(res, code, obj);
    }
    if (tooMany(ip)) return send(res, 429, { error: 'slow down' });
    // Our own copy of a league picture set by hand in leagues.json «logo» (fetched once with a proper name, kept on disk).
    const lm = url.pathname.match(/^\/logo\/(league|team)\/(\d+)\.png$/);
    if (lm) {
      const src = lm[1] === 'team' ? teamLogoId[lm[2]] : (leagues.find(x => x.id === +lm[2]) || {}).logo;
      if (!src) { res.writeHead(404); return res.end(); }
      const dir = path.join(DIR, 'logos'); const file = path.join(dir, lm[1] + '-' + lm[2] + '-' + crypto.createHash('sha1').update(src).digest('hex').slice(0, 8) + '.png');
      if (!fs.existsSync(file)) {
        const r = await fetch(src, { headers: { 'User-Agent': 'JaguarXMatches/1.0 (https://api.jaguarxiq.com; league logos for the Jaguar X app)' } });
        if (!r.ok) { log('logo', lm[1], lm[2], r.status); res.writeHead(502); return res.end(); }
        fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      return res.end(fs.readFileSync(file));
    }
    if (!signed(req, url)) return send(res, 403, { error: 'app only' });

    if (url.pathname === '/v1/day') {
      const d = url.searchParams.get('d') || baghdadDate(0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return send(res, 400, { error: 'd' });
      let day = days[d];
      // Another day than today / tomorrow: fetched once when someone asks, then kept.
      if (!day && nearDate(d) && canSpend('day') && mayAsk('day')) { await fetchDay(d); day = days[d]; }
      if (!day) return send(res, 503, { error: 'not ready', limit: left() <= 10 });
      return send(res, 200, { date: d, at: day.at, leagues: leagues.map(l => ({ id: l.id, name: l.ar })), matches: allOf(d).map(withTv) });
    }
    if (url.pathname === '/v1/tvvote') {
      const id = +url.searchParams.get('id');
      const ch = (url.searchParams.get('ch') || '').trim().slice(0, 120);
      const ok = url.searchParams.get('ok') === '1';
      const known = Object.keys(days).some(d => allOf(d).some(m => m.id === id));
      if (!id || !ch || !known) return send(res, 400, { error: 'id' });
      const k = id + '|' + ip + '|' + ch;
      if (!voted.has(k)) {
        voted.set(k, Date.now());
        if (voted.size > 20000) voted.clear();
        const v = (tvVotes[id] ??= {});
        v[ch] = (v[ch] || 0) + (ok ? 1 : -1);
        votesDirty = true;
        // Only this week's matches are kept.
        for (const x of Object.keys(tvVotes)) if (!Object.keys(days).some(d => allOf(d).some(m => String(m.id) === x))) delete tvVotes[x];
        log('tv vote', id, ok ? 'yes' : 'no', ch);
      }
      return send(res, 200, { ok: true, tvCh: tvPick(id) });
    }
    if (url.pathname === '/v1/match') {
      const id = +url.searchParams.get('id');
      if (!id) return send(res, 400, { error: 'id' });
      // ESPN / hand-added matches (fill.js) have nothing more than the day list, and API-Football doesn't know them.
      if (id >= 8e9) { const f = Object.keys(days).flatMap(allOf).find(m => m.id === id); return f ? send(res, 200, { match: locMatch(f) }) : send(res, 404, { error: 'none' }); }
      let d = details[id];
      const known = Object.values(days).flatMap(x => x.matches).find(m => m.id === id);
      // Nothing kept yet (e.g. a match days away): one request, kept 6 hours.
      // A match more than 70 minutes away has nothing more than the day list (line-ups come at T-60 by themselves).
      const early = known && known.state === 'pre' && known.start - Date.now() > 70 * 60000;
      if (!early && (!d || (Date.now() - d.at > 6 * 3600000 && known?.state !== 'post')) && canSpend('detail') && (known || d || mayAsk('match'))) { await fetchFull([id], 'detail'); d = details[id]; }
      const m = d?.match || known;
      if (!m) return send(res, 404, { error: 'none' });
      // Head to head: only on demand, kept a week.
      const key = [m.home.id, m.away.id].sort().join('-');
      let hh = h2h[key];
      if ((!hh || Date.now() - hh.at > 7 * 86400000) && canSpend('h2h')) hh = await fetchH2h(m.home.id, m.away.id);
      return send(res, 200, { at: d?.at || 0, match: locMatch(m), h2h: (hh?.list || []).filter(x => x.id !== id).map(locMatch) });
    }
    if (url.pathname === '/v1/leagues') {
      return send(res, 200, { leagues: leagues.map(l => ({ id: l.id, name: l.ar, logo: leagueLogo[l.id] || `https://media.api-sports.io/football/leagues/${l.id}.png` })) });
    }
    // A league's page: its next and last matches, and its top scorers.
    if (url.pathname === '/v1/leaguegames') {
      const lg = +url.searchParams.get('league');
      if (!lg || !ourLeague(lg)) return send(res, 400, { error: 'league' });
      let g = leagueGames[lg];
      if ((!g || Date.now() - g.at > 30 * 60000) && canSpend('detail')) {
        const season = await currentSeason(lg);
        if (season) {
          const nx = await api(`/fixtures?league=${lg}&season=${season}&next=15&timezone=${encodeURIComponent(TZ)}`, 'league');
          const ls = await api(`/fixtures?league=${lg}&season=${season}&last=15&timezone=${encodeURIComponent(TZ)}`, 'league');
          if (nx || ls) { g = leagueGames[lg] = { at: Date.now(), next: (nx?.response || []).map(brief), last: (ls?.response || []).map(brief) }; }
        }
      }
      if (!g) return send(res, 404, { error: 'none' });
      return send(res, 200, { ...g, next: (g.next || []).map(locMatch), last: (g.last || []).map(locMatch) });
    }
    if (url.pathname === '/v1/scorers') {
      const lg = +url.searchParams.get('league');
      if (!lg || !ourLeague(lg)) return send(res, 400, { error: 'league' });
      let sc = scorers[lg];
      if ((!sc || Date.now() - sc.at > 6 * 3600000) && canSpend('detail')) {
        const season = await currentSeason(lg);
        const j = season ? await api(`/players/topscorers?league=${lg}&season=${season}`, 'scorers') : null;
        const list = (j?.response || []).slice(0, 20).map(x => ({
          id: x.player?.id || 0, n: x.player?.name || '', photo: x.player?.photo || '',
          team: side(x.statistics?.[0]?.team || {}, null), goals: x.statistics?.[0]?.goals?.total ?? 0,
          assists: x.statistics?.[0]?.goals?.assists ?? 0, games: x.statistics?.[0]?.games?.appearences ?? 0,
        // A player with no goals isn't a scorer (the Iraqi league sent one «Sami» with 0).
        })).filter(x => x.goals > 0);
        if (list.length) sc = scorers[lg] = { at: Date.now(), list };
      }
      if (!sc) return send(res, 404, { error: 'none' });
      return send(res, 200, { ...sc, list: (sc.list || []).map(x => ({ ...x, n: personAr(x.n), ne: x.n, team: locSide(x.team) })) });
    }
    if (url.pathname === '/v1/standings') {
      const lg = +url.searchParams.get('league');
      if (!lg || !ourLeague(lg)) return send(res, 400, { error: 'league' });
      let s = standings[lg];
      // Any league from the leagues page: fetched when asked, kept 6 hours (the daily loop refreshes those that played).
      if ((!s || !s.groups?.length || Date.now() - s.at > 6 * 3600000) && canSpend('detail')) {
        const season = await currentSeason(lg);
        if (season) { await fetchStandings(lg, season); s = standings[lg]; }
      }
      if (!s) return send(res, 404, { error: 'none' });
      return send(res, 200, { league: lg, name: leagueAr[lg] || '', ...s,
        groups: (s.groups || []).map(g => g.map(r => ({ ...r, team: locSide(r.team) }))) });
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
  setTimeout(tvLoop, 20000);
  setTimeout(fillLoop, 10000);
  setInterval(fillLoop, 60000);
  setInterval(tvLoop, 5 * 60000);
  configText = readConfigCopy();
  syncConfig();
  setInterval(syncConfig, 5 * 60000);
}
