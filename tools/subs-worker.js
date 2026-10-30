// Jaguar X subtitles server (Cloudflare Worker).
// Keeps the Subdl key (secret SUBDL_API_KEY) away from the app.
//   /search?...   -> api.subdl.com/api/v1/subtitles (only the allowed fields, the key added here)
//   /dl/xxx.zip (or /dl?u=/subtitle/xxx.zip) -> dl.subdl.com (subtitle zips only)
const ALLOWED = ["languages", "subs_per_page", "type", "tmdb_id", "imdb_id", "film_name", "year", "season_number", "episode_number"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("no", { status: 405 });
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    let res;
    if (url.pathname === "/search") {
      const q = new URLSearchParams();
      for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 120)); }
      q.set("api_key", env.SUBDL_API_KEY);
      const r = await fetch("https://api.subdl.com/api/v1/subtitles?" + q.toString());
      res = new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" } });
    } else if (url.pathname === "/dl" || url.pathname.startsWith("/dl/")) {
      const u = url.pathname.startsWith("/dl/") ? "/subtitle/" + url.pathname.slice(4) : (url.searchParams.get("u") || "");
      if (!/^\/subtitle\/[\w\-.]+\.zip$/.test(u)) return new Response("bad", { status: 400 });
      const r = await fetch("https://dl.subdl.com" + u);
      res = new Response(r.body, { status: r.status, headers: { "content-type": "application/zip", "cache-control": "public, max-age=604800" } });
    } else {
      return new Response("Jaguar X", { status: 200 });
    }
    if (res.ok) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
