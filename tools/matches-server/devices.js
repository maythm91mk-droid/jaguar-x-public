// Jaguar X devices: which devices belong to a subscription, which one is the main, joining by a code, and
// who is watching now (one viewer at a time). Part of the match server (server.js loads it).
//
// - A subscription is known here only by a hash the app makes (server name + username). No password ever comes here:
//   when the main device lets a new one in, the login goes between the two devices locked (the new device's own key),
//   this server only carries the locked text and forgets it once it is taken.
// - What a device is watching is never sent here and never kept: only "playing now: yes / no", in memory.
// - Kept on disk (data/devices.json): the devices, their names, the main one. Codes and "playing" live in memory.
// - Every request is a POST with JSON, signed like the rest of the app's requests (time + HMAC with APP_SECRET, over
//   time + path + body).
'use strict';
const crypto = require('crypto');

module.exports = function make({ secret, statusKey, readJson, writeJson, log }) {
  const MAX = 5;                       // devices per subscription, the main one included
  const LINK_MS = 2 * 60000;           // a joining code lives two minutes
  const TEMP_MS = 24 * 3600000;        // a temporary device is removed by itself after a day
  const PLAY_MS = 50000;               // no sign of life for this long = not playing any more (the app says "still playing" every 20 s)
  const HOLD_MS = 5 * 60000;           // a device the main put out of playback can't start again for this long
  const GRACE_MS = 3 * 86400000;       // devices that were already logged in before the feature join by themselves for this long (his choice: 3 days)
  const FILE = 'devices.json';

  let subs = readJson(FILE, {});
  let dirty = false;
  const save = () => { dirty = true; };
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    try { writeJson(FILE, subs); } catch (e) { log('devices: save', e.message); dirty = true; }
  }, 5000).unref();

  const links = new Map();    // code -> { lt, did, model, type, pub, sub, exp, state, result, tries }
  const playing = new Map();  // sub -> { did, at }
  const out = new Map();      // sub|did -> why the device was put out ('main' | 'kick'), told on its next sign of life
  const holds = new Map();    // sub|did -> time until which it can't start playing
  const tries = new Map();    // did -> { at, n } wrong codes typed
  const hits = new Map();     // address -> { at, n }

  const now = () => Date.now();
  const rnd = n => crypto.randomBytes(n).toString('hex');
  const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length &&
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const isSub = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  const isDid = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
  const TYPES = ['tv', 'box', 'phone', 'tablet'];
  const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f⁦-⁩‪-‮]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

  function busy(ip, per) {
    const t = now(), k = ip + '|' + per;
    const h = hits.get(k) || { at: t, n: 0 };
    if (t - h.at > 60000) { h.at = t; h.n = 0; }
    h.n++; hits.set(k, h);
    if (hits.size > 100000) hits.clear();
    return h.n > per;
  }

  // Temporary devices whose day has passed leave by themselves.
  function purge(sub, s) {
    const t = now();
    for (const [did, d] of Object.entries(s.devices)) {
      if (d.until && d.until < t) {
        delete s.devices[did];
        (s.gone ||= {})[did] = t;
        if (playing.get(sub)?.did === did) playing.delete(sub);
        save();
      }
    }
  }
  const count = s => Object.keys(s.devices).length;
  const isPlaying = (sub, did) => { const p = playing.get(sub); return !!p && p.did === did && now() - p.at < PLAY_MS; };

  function add(s, did, b, extra) {
    const type = TYPES.includes(b.type) ? b.type : 'phone';
    const model = clean(b.model, 60);
    if (s.gone) delete s.gone[did];   // let in again (by the main device): it is welcome back
    s.devices[did] = { name: clean(extra?.name || model || 'جهاز', 30), type, model, tok: rnd(24), added: now(), seen: now(), ...(extra?.until ? { until: extra.until } : {}) };
    save();
    return s.devices[did];
  }

  // What a device is told about itself.
  function state(sub, s, did) {
    const d = s.devices[did];
    return { in: true, tok: d.tok, main: s.main === did, hasMain: !!s.main, name: d.name, until: d.until || 0, count: count(s), max: MAX };
  }

  function list(sub, s, me) {
    return Object.entries(s.devices).map(([did, d]) => ({
      did, name: d.name, type: d.type, model: d.model, main: s.main === did, me: did === me,
      until: d.until || 0, seen: d.seen || 0, playing: isPlaying(sub, did),
    })).sort((a, b) => (b.main - a.main) || (b.me - a.me) || (a.name < b.name ? -1 : 1));
  }

  // The device behind a request, when its token is right.
  function who(b) {
    if (!isSub(b.sub) || !isDid(b.did)) return null;
    const s = subs[b.sub];
    if (!s) return null;
    purge(b.sub, s);
    const d = s.devices[b.did];
    if (!d || !eq(d.tok, b.tok || '')) return null;
    if (now() - (d.seen || 0) > 60000) { d.seen = now(); save(); }
    return { sub: b.sub, s, did: b.did, d, main: s.main === b.did };
  }
  // Not let in: the subscription isn't known here at all (the app introduces itself again), or this device was removed.
  const outside = b => ({ in: false, why: isSub(b.sub) && subs[b.sub] ? 'gone' : 'new' });

  function newCode() {
    for (let i = 0; i < 50; i++) {
      const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!links.has(c)) return c;
    }
    return null;
  }
  function sweep() {
    const t = now();
    for (const [c, l] of links) if (l.exp + 90000 < t) links.delete(c);
    for (const [k, v] of holds) if (v < t) holds.delete(k);
    for (const [k, p] of playing) if (t - p.at > PLAY_MS * 2) playing.delete(k);
    for (const [k, v] of tries) if (t - v.at > 600000) tries.delete(k);
    if (out.size > 20000) out.clear();
  }
  setInterval(sweep, 30000).unref();

  const acts = {
    // A device that logged in with the username and password introduces itself.
    hello(b) {
      if (!isSub(b.sub) || !isDid(b.did)) return { error: 'bad' };
      let s = subs[b.sub];
      if (s) purge(b.sub, s);
      if (s && s.devices[b.did] && eq(s.devices[b.did].tok, b.tok || '')) {
        s.devices[b.did].seen = now(); save();
        return state(b.sub, s, b.did);
      }
      if (!s) {
        s = subs[b.sub] = { at: now(), main: null, label: clean(b.label, 80), devices: {} };
        add(s, b.did, b);
        // A new subscriber's first device is the main one. Someone who was already using the app chooses it himself.
        if (!b.existing) s.main = b.did;
        save();
        return { ...state(b.sub, s, b.did), first: !b.existing };
      }
      if (s.devices[b.did]) delete s.devices[b.did];   // same device, lost its token: it joins again like a new one
      const full = count(s) >= MAX;
      // Nobody chose a main device yet, or a device that was logged in before the feature came (for two weeks).
      // A device the main one removed (or whose temporary day ended) never comes back by itself: only by barcode.
      if (!s.main || (b.existing && now() - s.at < GRACE_MS && !s.gone?.[b.did])) {
        if (full) return { in: false, why: 'full', max: MAX };
        add(s, b.did, b);
        return state(b.sub, s, b.did);
      }
      return { in: false, why: full ? 'full' : 'link', max: MAX };
    },

    // Opening the app, the «أجهزتي» page, and every little while on the main device (to see who wants to join).
    sync(b) {
      const w = who(b);
      if (!w) return outside(b);
      const pending = [];
      if (w.main) for (const [code, l] of links) if (l.sub === w.sub && l.state === 'wait' && l.exp > now()) pending.push({ code, model: l.model, type: l.type });
      return { ...state(w.sub, w.s, w.did), devices: list(w.sub, w.s, w.did), pending };
    },

    // «خلي هذا الجهاز الرئيسي»: the first device to press wins.
    claim(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (w.s.main && w.s.main !== w.did) return { ok: false, why: 'taken', ...state(w.sub, w.s, w.did) };
      if (w.d.until) return { ok: false, why: 'temp' };
      w.s.main = w.did; save();
      return { ok: true, ...state(w.sub, w.s, w.did) };
    },

    rename(b) {
      const w = who(b);
      if (!w) return outside(b);
      const target = isDid(b.target) ? b.target : w.did;
      if (target !== w.did && !w.main) return { ok: false, why: 'main' };
      const name = clean(b.name, 30);
      if (!name || !w.s.devices[target]) return { ok: false, why: 'name' };
      w.s.devices[target].name = name; save();
      return { ok: true, devices: list(w.sub, w.s, w.did) };
    },

    remove(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      if (!isDid(b.target) || b.target === w.did || !w.s.devices[b.target]) return { ok: false, why: 'target' };
      delete w.s.devices[b.target];
      (w.s.gone ||= {})[b.target] = now(); save();
      if (playing.get(w.sub)?.did === b.target) playing.delete(w.sub);
      return { ok: true, devices: list(w.sub, w.s, w.did) };
    },

    // «طلّعه من البث»: the device stops playing and can't start again for a few minutes.
    kick(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      if (!isDid(b.target) || b.target === w.did || !w.s.devices[b.target]) return { ok: false, why: 'target' };
      const k = w.sub + '|' + b.target;
      if (playing.get(w.sub)?.did === b.target) playing.delete(w.sub);
      out.set(k, 'kick'); holds.set(k, now() + HOLD_MS);
      return { ok: true, devices: list(w.sub, w.s, w.did) };
    },

    // The main device hands the role to another one of the subscription's devices.
    move(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      const t = isDid(b.target) ? w.s.devices[b.target] : null;
      if (!t || t.until) return { ok: false, why: 'target' };
      w.s.main = b.target; save();
      return { ok: true, ...state(w.sub, w.s, w.did), devices: list(w.sub, w.s, w.did) };
    },

    // A device with no place in the subscription asks for a code to show (with its barcode).
    'link/start'(b, ip) {
      if (!isDid(b.did)) return { error: 'bad' };
      if (busy(ip, 20)) return { error: 'slow' };
      const pub = String(b.pub || '');
      if (pub.length < 40 || pub.length > 400) return { error: 'bad' };
      for (const [c, l] of links) if (l.did === b.did) links.delete(c);
      const code = newCode();
      if (!code) return { error: 'slow' };
      const lt = rnd(16);
      links.set(code, { lt, did: b.did, model: clean(b.model, 60), type: TYPES.includes(b.type) ? b.type : 'phone', pub,
        sub: isSub(b.sub) && subs[b.sub] ? b.sub : null, exp: now() + LINK_MS, state: 'wait' });
      return { code, lt, ms: LINK_MS };
    },

    // The waiting device asks: did the main device answer?
    'link/poll'(b) {
      const l = links.get(String(b.code || ''));
      if (!l || !eq(l.lt, b.lt || '')) return { state: 'expired' };
      if (l.state === 'ok') { links.delete(String(b.code)); return { state: 'ok', ...l.result }; }
      if (l.state === 'refused') { links.delete(String(b.code)); return { state: 'refused', why: l.why || '' }; }
      if (l.exp < now()) return { state: 'expired' };
      return { state: 'wait', ms: l.exp - now() };
    },

    // The main device read a barcode or typed a code: which device is it?
    'link/peek'(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      const t = tries.get(w.did) || { at: now(), n: 0 };
      if (now() - t.at > 600000) { t.at = now(); t.n = 0; }
      if (t.n >= 8) return { ok: false, why: 'slow' };
      const l = links.get(String(b.code || ''));
      if (!l || l.state !== 'wait' || l.exp < now()) { t.n++; tries.set(w.did, t); return { ok: false, why: 'code' }; }
      if (count(w.s) >= MAX && !w.s.devices[l.did]) return { ok: false, why: 'full', max: MAX };
      return { ok: true, model: l.model, type: l.type, pub: l.pub, known: w.s.devices[l.did]?.name || '' };
    },

    'link/approve'(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      const l = links.get(String(b.code || ''));
      if (!l || l.state !== 'wait' || l.exp < now()) return { ok: false, why: 'code' };
      const name = clean(b.name, 30);
      if (!name) return { ok: false, why: 'name' };
      if (l.did === w.did) return { ok: false, why: 'code' };
      const enc = b.enc && typeof b.enc === 'object' ? { k: String(b.enc.k || ''), iv: String(b.enc.iv || ''), ct: String(b.enc.ct || '') } : null;
      if (!enc || !enc.k || !enc.iv || !enc.ct || enc.k.length + enc.iv.length + enc.ct.length > 4000) return { ok: false, why: 'bad' };
      if (w.s.devices[l.did]) delete w.s.devices[l.did];
      if (count(w.s) >= MAX) return { ok: false, why: 'full', max: MAX };
      const d = add(w.s, l.did, { type: l.type, model: l.model }, { name, until: b.temp ? now() + TEMP_MS : 0 });
      l.state = 'ok'; l.exp = now();
      l.result = { sub: w.sub, tok: d.tok, name: d.name, until: d.until || 0, enc };
      return { ok: true, devices: list(w.sub, w.s, w.did) };
    },

    'link/refuse'(b) {
      const w = who(b);
      if (!w) return outside(b);
      if (!w.main) return { ok: false, why: 'main' };
      const l = links.get(String(b.code || ''));
      if (l && l.state === 'wait') { l.state = 'refused'; l.exp = now(); }
      return { ok: true };
    },

    // One viewer at a time: "start" when play is pressed, "beat" every 20 s while playing, "stop" on leaving.
    play(b) {
      const w = who(b);
      if (!w) return outside(b);
      const k = w.sub + '|' + w.did, t = now();
      const p = playing.get(w.sub);
      const other = p && p.did !== w.did && t - p.at < PLAY_MS && w.s.devices[p.did] ? p : null;
      const name = other ? w.s.devices[other.did].name : '';
      if (b.action === 'stop') {
        if (p && p.did === w.did) playing.delete(w.sub);
        // Put out a moment ago (the stream was cut before the next beat): say why, so the device can tell the viewer.
        const o = out.get(k);
        out.delete(k);
        return o ? { ok: true, why: o } : { ok: true };
      }
      if (b.action === 'start') {
        const h = holds.get(k) || 0;
        if (h > t && !w.main) return { ok: false, why: 'held', min: Math.ceil((h - t) / 60000) };
        if (other) {
          if (!w.main) return { ok: false, why: 'busy', by: name, byMain: other.did === w.s.main };
          // The main device is asked first: put the other one out, or let it go on (his wish, 10 Nov 2026).
          if (!b.force) return { ok: false, why: 'ask', by: name };
          out.set(w.sub + '|' + other.did, 'main');
        }
        out.delete(k);
        playing.set(w.sub, { did: w.did, at: t });
        return { ok: true, took: name };
      }
      // beat
      const o = out.get(k);
      if (o) { out.delete(k); if (p && p.did === w.did) playing.delete(w.sub); return { ok: false, why: o }; }
      if (other) {
        if (!w.main) return { ok: false, why: 'busy', by: name, byMain: other.did === w.s.main };
        out.set(w.sub + '|' + other.did, 'main');
      }
      playing.set(w.sub, { did: w.did, at: t });
      return { ok: true };
    },
  };

  function signed(req, pathname, body) {
    if (!secret) return false;
    const t = req.headers['x-jx-time'] || '';
    const sig = req.headers['x-jx-sig'] || '';
    if (!/^\d{10,13}$/.test(t) || Math.abs(now() - +t) > 5 * 60000) return false;
    const want = crypto.createHmac('sha256', secret).update(t + pathname + body).digest('hex');
    return eq(sig, want);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', c => { size += c.length; if (size > 8192) { reject(new Error('big')); req.destroy(); } else parts.push(c); });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  // For Maytham (support): /v1/dev/admin?key=STATUS_KEY&user=<username>&do=list | reset (the devices choose a main again) | wipe
  function admin(url) {
    if (!statusKey || url.searchParams.get('key') !== statusKey) return [403, { error: 'key' }];
    const user = (url.searchParams.get('user') || '').trim().toLowerCase();
    const todo = url.searchParams.get('do') || 'list';
    if (!user) return [200, { subscriptions: Object.keys(subs).length, links: links.size, playing: playing.size }];
    const found = Object.entries(subs).filter(([, s]) => (s.label || '').toLowerCase().split('@')[0] === user);
    const res = found.map(([sub, s]) => {
      if (todo === 'reset') { s.main = null; s.at = now(); save(); }
      if (todo === 'wipe') { delete subs[sub]; playing.delete(sub); save(); }
      return { label: s.label, main: s.main ? s.devices[s.main]?.name : null, done: todo,
        devices: Object.values(s.devices).map(d => ({ name: d.name, type: d.type, model: d.model, temp: !!d.until, seen: new Date(d.seen || 0).toISOString() })) };
    });
    return [200, { found: res.length, result: res }];
  }

  /** Answers /v1/dev/... requests. Returns [code, object]. */
  async function handle(req, url, ip) {
    const name = url.pathname.slice('/v1/dev/'.length);
    if (name === 'admin') return admin(url);
    if (req.method !== 'POST' || !Object.prototype.hasOwnProperty.call(acts, name)) return [404, { error: 'path' }];
    if (busy(ip, 900)) return [429, { error: 'slow' }];
    let body;
    try { body = await readBody(req); } catch { return [413, { error: 'big' }]; }
    if (!signed(req, url.pathname, body)) return [403, { error: 'sign' }];
    let b;
    try { b = JSON.parse(body || '{}'); } catch { return [400, { error: 'json' }]; }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return [400, { error: 'json' }];
    return [200, acts[name](b, ip)];
  }

  return { handle, flush: () => { if (dirty) { dirty = false; writeJson(FILE, subs); } } };
};
