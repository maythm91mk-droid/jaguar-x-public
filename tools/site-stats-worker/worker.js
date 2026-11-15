// Jaguar X site stats (Cloudflare Worker).
// The site sends one small beacon per page view and per important button press:
//   POST /e   body: {"e":"view|wa|dl-phone|dl-tv|tg|agent-tg|agent-wa|dock-wa|dock-dl","s":"instagram|tiktok|..."}
// Each one adds 1 to "YYYY-MM-DD|event|source" (Baghdad day) in the SITE store.
// Report:  /stats?key=YOUR_STATS_KEY   (STATS_KEY is a secret set in Cloudflare, never in code)
// Note: the free plan allows about 1,000 store writes a day; past that, extra hits that day are not counted.

const EVENTS = { view: "زيارة", wa: "اشترك واتساب", "dl-phone": "تنزيل موبايل", "dl-tv": "تنزيل تلفزيون", tg: "قناة التلگرام", "agent-tg": "وكيل: تلگرام", "agent-wa": "وكيل: واتساب", "dock-wa": "الشريط: واتساب", "dock-dl": "الشريط: تنزيل", price: "زر باقة" };
const SOURCES = { instagram: "إنستغرام", tiktok: "تيك توك", facebook: "فيسبوك", whatsapp: "واتساب", telegram: "تلگرام", google: "Google", direct: "مباشر/غير معروف", site: "داخل الموقع", other: "غيره" };
const day = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const clean = (v, allowed) => (v = String(v || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20), allowed[v] ? v : null);
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET", "access-control-allow-headers": "content-type" };

async function bump(env, key) {
  const n = parseInt((await env.SITE.get(key)) || "0", 10) + 1;
  await env.SITE.put(key, String(n));
}

async function report(env) {
  const rows = {};
  let cursor;
  do {
    const page = await env.SITE.list({ cursor });
    const vals = await Promise.all(page.keys.map(k => env.SITE.get(k.name)));
    page.keys.forEach((k, i) => {
      const [d, e, s] = k.name.split("|");
      if (!s) return;
      (rows[d] ||= {})[e] ||= {};
      rows[d][e][s] = parseInt(vals[i] || "0", 10);
    });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const days = Object.keys(rows).sort().reverse();
  const evs = Object.keys(EVENTS);
  const tot = (d, e) => Object.values((rows[d] || {})[e] || {}).reduce((a, b) => a + b, 0);
  const all = e => days.reduce((a, d) => a + tot(d, e), 0);
  const srcAll = {};
  for (const d of days) for (const s in (rows[d].view || {})) srcAll[s] = (srcAll[s] || 0) + rows[d].view[s];
  const card = (l, v) => `<div class="c"><div class="n">${v}</div><div>${l}</div></div>`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>زوار jaguarxiq.com</title>
<style>body{font-family:system-ui;background:#111;color:#eee;padding:16px;direction:rtl}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border:1px solid #333;padding:6px 10px;text-align:center}th{background:#222}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0 24px}.c{background:#1c1c1c;border-radius:10px;padding:12px;text-align:center}.n{font-size:32px;color:#f5b301;font-weight:700}</style>
<h2>زوار jaguarxiq.com</h2>
<div class="cards">${card("زيارات اليوم", tot(day(), "view"))}${card("كل الزيارات", all("view"))}${card("ضغطات اشترك واتساب", all("wa") + all("dock-wa"))}${card("ضغطات التنزيل", all("dl-phone") + all("dl-tv") + all("dock-dl"))}</div>
<h3>الزوار جايين من وين (كل الأيام)</h3>
<table><tr>${Object.keys(srcAll).map(s => `<th>${SOURCES[s] || s}</th>`).join("")}</tr><tr>${Object.keys(srcAll).map(s => `<td>${srcAll[s]}</td>`).join("")}</tr></table>
<h3>حسب اليوم</h3>
<table><tr><th>اليوم</th>${evs.map(e => `<th>${EVENTS[e]}</th>`).join("")}</tr>
${days.map(d => `<tr><td>${d}</td>${evs.map(e => `<td>${tot(d, e)}</td>`).join("")}</tr>`).join("")}</table>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/e" && request.method === "POST") {
      let b = {};
      try { b = await request.json(); } catch {}
      const e = clean(b.e, EVENTS), s = clean(b.s, SOURCES) || "other";
      if (e) ctx.waitUntil(bump(env, `${day()}|${e}|${s}`));
      return new Response(null, { status: 204, headers: cors });
    }
    if (url.pathname === "/stats") {
      if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) return new Response("no", { status: 403 });
      return report(env);
    }
    return new Response("Jaguar X", { headers: cors });
  },
};
