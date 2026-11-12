// Which Arab channel carries a match (Maytham, 12 Nov 2026: the app guessed from the IPTV guide and opened a replay).
// Read from yallashoot (ysscores.com), which writes the channel for each match: «القناة: بي إن سبورت 2».
// Only today's list (Baghdad), every 2 hours, and each match page at most once per 3 hours.
// Gives the app an English channel name it can find in the provider's list ("beIN SPORTS 2"), several split by '|'.
'use strict';

const BASE = 'https://www.ysscores.com/ar';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

function normAr(s) {
  return String(s || '').replace(/[^\p{L}\p{N}]/gu, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
}
function words(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
    .filter(w => w.length >= 4 && !['team', 'united', 'city', 'club', 'republic', 'democratic', 'national'].includes(w));
}

/** «بي إن سبورت 2» → "beIN SPORTS 2". Unknown names are kept as they are (the app also compares Arabic names). */
function channelEn(a) {
  const s = String(a || '').replace(/\s+/g, ' ').trim();
  const n = (s.match(/(\d+)\s*$/) || [])[1] || '';
  const tail = n ? ' ' + n : '';
  if (/بي ?إن|بين سبورت|beIN/i.test(s)) {
    if (/بريميوم|premium/i.test(s)) return 'beIN SPORTS PREMIUM' + tail;
    if (/إكسترا|اكسترا|xtra|extra/i.test(s)) return 'beIN SPORTS XTRA' + tail + '|beIN XTRA' + tail;
    if (/ماكس|max/i.test(s)) return 'beIN SPORTS MAX' + tail;
    if (/الإخبارية|الاخبارية|news/i.test(s)) return 'beIN SPORTS NEWS';
    return 'beIN SPORTS' + tail;
  }
  if (/إس إس سي|اس اس سي|ssc/i.test(s)) return 'SSC' + tail;
  if (/الكأس|الكاس|alkass/i.test(s)) return 'Alkass' + tail;
  if (/أبوظبي|ابوظبي|أبو ظبي|ابو ظبي|abu ?dhabi/i.test(s)) return 'Abu Dhabi Sports' + tail;
  if (/دبي|dubai/i.test(s)) return 'Dubai Sports' + tail;
  if (/الشارقة|sharjah/i.test(s)) return 'Sharjah Sports';
  if (/العراقية/i.test(s)) return 'العراقية الرياضية|Iraqia Sport|Al Iraqiya Sport';
  if (/أون تايم|اون تايم|on ?time/i.test(s)) return 'ON Time Sports' + tail;
  if (/ثمانية|thmanyah/i.test(s)) return 'Thmanyah' + tail;
  // «MBC شاهد | رياضة» (12 Nov): a bare «رياضة» would match every sports channel.
  if (/mbc|شاهد/i.test(s)) return 'Shahid Sport|MBC Sport|MBC Action';
  return s.replace(/\|/g, ' ');
}

function create({ log, readJson, writeJson, today }) {
  let kept = readJson('tv.json', { day: '', list: [], pages: {} });   // list: [{ys, slug, h, a}], pages[ys] = {at, ch: []}
  let lastList = 0;

  async function get(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ar' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.text();
  }

  async function readList() {
    const h = await get(BASE + '/today_matches');
    const out = [];
    const tags = h.match(/<a\s[^>]*\bmatch_id="\d+"[^>]*>/g) || [];
    const at = (t, k) => ((t.match(new RegExp('\\b' + k + '="([^"]*)"')) || [])[1] || '');
    for (const t of tags) {
      const href = at(t, 'href'), ys = at(t, 'match_id') || (at(t, 'id').match(/\d+/) || [])[0];
      const slug = (href.match(/\/match\/\d+\/([^"?#]+)/) || [])[1];
      if (!ys || !slug) continue;
      let sl = slug; try { sl = decodeURIComponent(slug); } catch {}
      if (!out.some(o => o.ys === ys)) out.push({ ys, slug: sl, h: at(t, 'home_name'), a: at(t, 'away_name') });
    }
    return out;
  }

  async function readPage(ys, slug) {
    const h = await get(BASE + '/match/' + ys + '/' + encodeURIComponent(slug).replace(/%2F/g, '/'));
    const ch = [];
    const re = /class="channel_info"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(h))) { const c = m[1].trim(); if (c && !ch.includes(c)) ch.push(c); }
    return ch;
  }

  /** Our match ↔ a yallashoot row: both sides by Arabic name or by a word of the English name in its address. */
  function sideOk(ours, arName, slugPart) {
    const a = normAr(ours.name), b = normAr(arName);
    if (a && b && (a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))))) return true;
    const sw = words(slugPart.replace(/-/g, ' '));
    return words(ours.en).some(w => sw.includes(w));
  }
  function find(m) {
    for (const r of kept.list) {
      const [hs, as] = r.slug.split('-vs-');
      if (!as) continue;
      if (sideOk(m.home, r.h, hs) && sideOk(m.away, r.a, as)) return r;
      if (sideOk(m.home, r.a, as) && sideOk(m.away, r.h, hs)) return r;
    }
    return null;
  }

  /** Called every minute with today's matches (already in Arabic). Does real work only every 2 hours. */
  async function tick(matches) {
    const now = Date.now(), d = today();
    if (kept.day !== d) { kept = { day: d, list: [], pages: {} }; lastList = 0; }
    if (now - lastList < 2 * 3600000 && kept.list.length) return;
    lastList = now;
    try { kept.list = await readList(); } catch (e) { log('tv list:', e.message); return; }
    let read = 0;
    for (const m of matches) {
      if (m.state === 'post' || m.state === 'off') continue;
      const r = find(m);
      if (!r) continue;
      const p = kept.pages[r.ys];
      if (p && now - p.at < 3 * 3600000) continue;
      try { kept.pages[r.ys] = { at: now, ch: await readPage(r.ys, r.slug) }; read++; }
      catch (e) { log('tv page', r.ys, e.message); }
      await new Promise(f => setTimeout(f, 1500));
      if (read >= 40) break;
    }
    writeJson('tv.json', kept);
    log('tv: list', kept.list.length, 'pages read', read);
  }

  /** The channel(s) for one of our matches, "" when not known. */
  function of(m) {
    const r = find(m);
    const ch = r && kept.pages[r.ys]?.ch;
    if (!ch || !ch.length) return '';
    return [...new Set(ch.map(channelEn).join('|').split('|'))].join('|');
  }
  function arOf(m) {
    const r = find(m);
    return (r && kept.pages[r.ys]?.ch || []).join('، ');
  }
  return { tick, of, arOf, status: () => ({ day: kept.day, list: kept.list.length, pages: Object.keys(kept.pages).length }) };
}

module.exports = { create, channelEn };
