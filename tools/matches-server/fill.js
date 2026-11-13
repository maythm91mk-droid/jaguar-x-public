// Matches our data source (API-Football) doesn't carry, added beside its list (Maytham, 13 Nov 2026: Iraq × Lebanon in the
// Basra four-team friendly tournament was on Alwan Sport 2 but missing from «مباشر هسه»).
//  1) ESPN: the public scoreboard of a few competitions (config.json matchesFill.espn), only matches of the teams in
//     matchesFill.teams (English names, default Iraq), only when API-Football doesn't already have them.
//  2) By hand: config.json matchesFill.extra = [{ "h": "العراق", "a": "فلسطين", "t": "2026-11-17 18:00", "tv": "Alwan Sport 2",
//     "lg": "بطولة البصرة الدولية" }] (Baghdad time). Shown live from its start for 115 minutes, no score.
// Ids are 9e9 + the ESPN event id (hand ones 8e9 + a hash) so they never meet API-Football ids.
'use strict';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const DEF = { espn: ['fifa.friendly'], teams: ['Iraq'], extra: [] };

function create({ log, readConfig, teamAr }) {
  let espn = {};          // date (yyyy-mm-dd, Baghdad) -> [match]
  let at = 0, live = false;

  const settings = () => ({ ...DEF, ...((readConfig() || {}).matchesFill || {}) });
  const ymd = d => d.replace(/-/g, '');
  const nameKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function side(c) {
    const t = c.team || {};
    const en = t.displayName || t.name || '';
    return { id: +t.id || 0, name: teamAr({ name: en }) || en, en, logo: t.logo || '', goals: c.score == null || c.score === '' ? null : +c.score };
  }
  function fromEspn(ev, slug, dayOf) {
    const c = (ev.competitions || [])[0] || {};
    const st = (c.status || ev.status || {});
    const ty = st.type || {};
    const name = ty.name || '';
    const state = ty.state === 'in' ? 'in' : ty.state === 'post' ? 'post' : /POSTPONED|CANCELED/.test(name) ? 'off' : 'pre';
    const short = /HALFTIME/.test(name) ? 'HT' : state === 'in' ? ((st.period || 1) >= 2 ? '2H' : '1H') : state === 'post' ? 'FT' : state === 'off' ? 'PST' : 'NS';
    const minute = state === 'in' && short !== 'HT' ? (parseInt(st.displayClock, 10) || null) : null;
    const status = { HT: 'استراحة بين الشوطين', FT: 'انتهت', PST: 'تأجلت' }[short] || '';
    const cs = c.competitors || [];
    const h = cs.find(x => x.homeAway === 'home') || cs[0] || {};
    const a = cs.find(x => x.homeAway === 'away') || cs[1] || {};
    const lg = (ev.league || {});
    return {
      id: 9e9 + (+ev.id || 0), league: 0, leagueName: slug === 'fifa.friendly' ? 'مباريات ودية دولية' : (lg.name || ''), leagueLogo: '',
      season: 0, round: '', start: Date.parse(ev.date || c.date) || 0, state, short, status, minute, extra: null,
      home: side(h), away: side(a), venue: '', referee: '', src: 'espn', day: dayOf,
    };
  }

  /** Today and tomorrow (Baghdad) from ESPN: every 2 minutes while one of them is played, else every 30 minutes. */
  async function tick(dates) {
    if (Date.now() - at < (live ? 2 : 30) * 60000) return;
    at = Date.now();
    const s = settings();
    const want = new Set((s.teams || []).map(nameKey));
    const out = {};
    for (const d of dates) out[d] = [];
    for (const slug of s.espn || []) {
      // ESPN days are UTC: the day before and the day itself cover a Baghdad day.
      for (const d of dates) {
        const prev = new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
        for (const q of [prev, d]) {
          let j;
          try {
            const r = await fetch(`${ESPN}/${slug}/scoreboard?dates=${ymd(q)}`, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) { log('fill: espn', slug, q, 'http', r.status); continue; }
            j = await r.json();
          } catch (e) { log('fill: espn', slug, q, e.message); continue; }
          for (const ev of j.events || []) {
            const teams = ((ev.competitions || [])[0]?.competitors || []).map(c => nameKey(c.team?.displayName));
            if (!teams.some(t => want.has(t))) continue;
            const m = fromEspn(ev, slug, d);
            const day = new Date(m.start + 3 * 3600000).toISOString().slice(0, 10);
            if (day === d && !out[d].some(x => x.id === m.id)) out[d].push(m);
          }
        }
      }
    }
    espn = out;
    live = Object.values(out).some(l => l.some(m => m.state === 'in'));
    const n = Object.values(out).reduce((k, l) => k + l.length, 0);
    if (n) log('fill: espn', Object.entries(out).map(([d, l]) => d + ' ' + l.map(m => m.home.en + '-' + m.away.en + ' ' + m.state).join(', ')).join(' | '));
  }

  function hand(d) {
    const out = [];
    for (const x of settings().extra || []) {
      const t = Date.parse(String(x.t || '').replace(' ', 'T') + ':00+03:00');
      if (!t || new Date(t + 3 * 3600000).toISOString().slice(0, 10) !== d) continue;
      const now = Date.now();
      const state = now < t ? 'pre' : now < t + 115 * 60000 ? 'in' : 'post';
      const key = [x.h, x.a, x.t].join('|');
      let hsh = 0; for (const ch of key) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      const sd = n => ({ id: 0, name: String(n || ''), en: '', logo: '', goals: null });
      out.push({
        id: 8e9 + (hsh % 1e9), league: 0, leagueName: String(x.lg || ''), leagueLogo: '', season: 0, round: '', start: t, state,
        short: state === 'in' ? '1H' : state === 'post' ? 'FT' : 'NS', status: state === 'in' ? 'مباشر' : state === 'post' ? 'انتهت' : '',
        minute: null, extra: null, home: sd(x.h), away: sd(x.a), venue: '', referee: '', src: 'hand', handTv: String(x.tv || ''),
      });
    }
    return out;
  }

  /** The matches to add to [have] (API-Football's list for day [d]): ESPN ones it doesn't have, and the hand ones. */
  function of(d, have) {
    const known = new Set((have || []).map(m => nameKey(m.home?.en) + '|' + nameKey(m.away?.en)));
    const e = (espn[d] || []).filter(m => !known.has(nameKey(m.home.en) + '|' + nameKey(m.away.en)) && !known.has(nameKey(m.away.en) + '|' + nameKey(m.home.en)));
    return [...e, ...hand(d)];
  }
  return { tick, of, status: () => Object.fromEntries(Object.entries(espn).map(([d, l]) => [d, l.length])) };
}

module.exports = { create };
