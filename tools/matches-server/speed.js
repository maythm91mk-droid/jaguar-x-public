// Speed test for the Jaguar X app («فحص الانترنت»), speaking the LibreSpeed backend protocol, so the app's test
// works the same against this server and against a stock LibreSpeed server (PHP or speedtest-go) placed in Iraq later.
//
//   GET  /st/garbage.php?ckSize=N   N chunks of 1 MB of random bytes (download test), N capped at 100
//   POST /st/empty.php              reads and drops the body (upload test), body capped at 64 MB
//   GET  /st/empty.php              empty answer (latency test)
//   GET  /st/getIP.php              the caller's address as the server sees it (shown to nobody, kept nowhere)
//
// Open to anyone (people who are not subscribers can test their line too), so it guards itself: at most 12 open
// transfers per address and 8 GB a day per address. Nothing is written to disk and no address is kept past the day.

'use strict';
const crypto = require('crypto');

module.exports = function create({ log }) {
  const CHUNK = crypto.randomBytes(1024 * 1024);   // one random megabyte, sent again and again (it can't be compressed)
  const MAX_CHUNKS = 100;
  const MAX_UP = 64 * 1024 * 1024;
  const MAX_OPEN = 12;
  const DAY_BYTES = 8 * 1024 * 1024 * 1024;

  const open = new Map();     // address -> open transfers
  let day = '';
  let used = new Map();       // address -> bytes today
  let total = 0, tests = 0;

  function roll() {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== day) {
      if (day) log('speed', day, 'tests', tests, 'GB', (total / 1e9).toFixed(1), 'addresses', used.size);
      day = d; used = new Map(); total = 0; tests = 0;
    }
  }
  const add = (ip, n) => { used.set(ip, (used.get(ip) || 0) + n); total += n; };

  function head(res, code, type, extra) {
    res.writeHead(code, Object.assign({
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding',
    }, extra || {}));
  }

  function busy(ip) {
    const n = open.get(ip) || 0;
    if (n >= MAX_OPEN) return true;
    if ((used.get(ip) || 0) > DAY_BYTES) return true;
    open.set(ip, n + 1);
    return false;
  }
  function done(ip) {
    const n = (open.get(ip) || 1) - 1;
    if (n <= 0) open.delete(ip); else open.set(ip, n);
  }

  // Returns true when the request was one of ours.
  function handle(req, res, url, ip) {
    if (!url.pathname.startsWith('/st/')) return false;
    roll();
    const p = url.pathname.slice(4);
    if (req.method === 'OPTIONS') { head(res, 204, 'text/plain'); res.end(); return true; }

    if (p === 'garbage.php' || p === 'garbage') {
      if (busy(ip)) { head(res, 429, 'text/plain'); res.end(); return true; }
      tests++;
      let left = Math.max(1, Math.min(MAX_CHUNKS, parseInt(url.searchParams.get('ckSize') || '4', 10) || 4));
      head(res, 200, 'application/octet-stream', { 'Content-Description': 'File Transfer', 'Content-Length': String(left * CHUNK.length) });
      let closed = false;
      const finish = () => { if (!closed) { closed = true; done(ip); } };
      res.on('close', finish);
      const pump = () => {
        while (left > 0 && !closed) {
          left--; add(ip, CHUNK.length);
          if (!res.write(CHUNK)) { res.once('drain', pump); return; }
        }
        if (!closed) { res.end(); finish(); }
      };
      pump();
      return true;
    }

    if (p === 'empty.php' || p === 'empty') {
      if (req.method !== 'POST') { head(res, 200, 'text/plain', { 'Connection': 'keep-alive' }); res.end(); return true; }
      if (busy(ip)) { head(res, 429, 'text/plain'); res.end(); req.resume(); return true; }
      let got = 0, closed = false;
      const finish = () => { if (!closed) { closed = true; done(ip); } };
      req.on('data', b => {
        got += b.length; add(ip, b.length);
        if (got > MAX_UP) { finish(); req.destroy(); }
      });
      req.on('end', () => { finish(); head(res, 200, 'text/plain', { 'Connection': 'keep-alive' }); res.end(); });
      req.on('error', finish);
      req.on('close', finish);
      return true;
    }

    if (p === 'getIP.php' || p === 'getIP') {
      head(res, 200, 'application/json; charset=utf-8');
      res.end(JSON.stringify({ processedString: ip, rawIspInfo: '' }));
      return true;
    }

    head(res, 404, 'text/plain'); res.end();
    return true;
  }

  function status() { roll(); return { day, tests, gb: +(total / 1e9).toFixed(2), addresses: used.size, open: open.size }; }

  return { handle, status };
};
