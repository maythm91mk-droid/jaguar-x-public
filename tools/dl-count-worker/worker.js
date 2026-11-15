// Jaguar X public download counter (Cloudflare Worker).
// Reads the same COUNTS store that the jaguar-dl worker fills ("YYYY-MM-DD|source" -> number)
// and returns only the grand total, so the site can show it without the stats key.
//
//   GET /  ->  {"total": 1234}
//
// Read-only on the store. Past days are summed once a day (kept in the edge cache);
// after that each answer reads only today's few keys. Answers are cached for 2 minutes.

const baghdadDay = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

async function sumKeys(env, prefix, before) {
  let total = 0, cursor;
  do {
    const page = await env.COUNTS.list({ prefix, cursor });
    const names = page.keys.map(k => k.name).filter(n => n.includes("|") && (!before || n.slice(0, 10) < before));
    const vals = await Promise.all(names.map(n => env.COUNTS.get(n)));
    for (const v of vals) total += parseInt(v || "0", 10);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return total;
}

// The day's base sum is kept in the edge cache, never in COUNTS: the jaguar-dl stats page lists every key there.
async function total(env) {
  const today = baghdadDay();
  const cache = caches.default;
  const bkey = new Request("https://jaguar-dl-count.internal/base/" + today);
  let hit = await cache.match(bkey), base;
  if (hit) base = parseInt(await hit.text(), 10);
  else {
    base = await sumKeys(env, "", today);
    await cache.put(bkey, new Response(String(base), { headers: { "cache-control": "public, max-age=86400" } }));
  }
  return base + (await sumKeys(env, today + "|"));
}

export default {
  async fetch(request, env, ctx) {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("no", { status: 405, headers: cors });
    const cache = caches.default;
    const key = new Request(new URL("/", request.url).toString());
    let res = await cache.match(key);
    if (!res) {
      res = new Response(JSON.stringify({ total: await total(env) }), {
        headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=120" },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    return res;
  },
};
