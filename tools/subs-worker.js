// Jaguar X subtitles server (Cloudflare Worker).
// Keeps the Subdl key (secret SUBDL_API_KEY) away from the app.
//   /search?...   -> api.subdl.com/api/v1/subtitles (only the allowed fields, the key added here)
//   /dl/xxx.zip (or /dl?u=/subtitle/xxx.zip) -> dl.subdl.com (subtitle zips only)
const ALLOWED = ["languages", "subs_per_page", "type", "tmdb_id", "imdb_id", "film_name", "year", "season_number", "episode_number"];

// Only the app may use it: every app version since subtitles came sends this header. Anyone else gets nothing
// (the address is in the public config.json, and the Subdl plan's daily downloads are ours).
// Plus a simple limit per address, so even someone copying the header can't empty the plan quickly.
// (Per Cloudflare server copy; good enough to stop abuse, a real viewer never comes near it.)
const LIMIT = { search: [40, 60_000], dl: [25, 3_600_000] };   // [requests, per ms]
const seen = new Map();
function tooMany(ip, kind) {
  const [max, per] = LIMIT[kind];
  const k = kind + "|" + ip, now = Date.now();
  let h = seen.get(k);
  if (!h || now - h.at > per) { h = { at: now, n: 0 }; seen.set(k, h); }
  if (seen.size > 20000) seen.clear();
  return ++h.n > max;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("no", { status: 405 });
    if (url.pathname !== "/search" && url.pathname !== "/dl" && !url.pathname.startsWith("/dl/")) return new Response("Jaguar X", { status: 200 });
    if (request.headers.get("X-App") !== "jaguarx") return new Response("app only", { status: 403 });
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    if (tooMany(ip, url.pathname === "/search" ? "search" : "dl")) return new Response("slow down", { status: 429 });
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;
    let res;
    if (url.pathname === "/search") {
      const q = new URLSearchParams();
      for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v) q.set(k, v.slice(0, 120)); }
      q.set("api_key", env.SUBDL_API_KEY);
      const r = await fetch("https://api.subdl.com/api/v1/subtitles?" + q.toString());
      // Subdl puts the key inside every link it sends back: take it out before anything leaves this server.
      const j = await r.json().catch(() => ({}));
      for (const s of (j.subtitles || [])) if (s && typeof s.url === "string") s.url = s.url.split("?")[0];
      res = new Response(JSON.stringify(j), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=86400" } });
    } else if (url.pathname === "/dl" || url.pathname.startsWith("/dl/")) {
      const u = url.pathname.startsWith("/dl/") ? "/subtitle/" + url.pathname.slice(4) : (url.searchParams.get("u") || "");
      if (!/^\/subtitle\/[\w\-.]+\.zip$/.test(u)) return new Response("bad", { status: 400 });
      const r = await fetch("https://dl.subdl.com" + u, { headers: { "x-api-key": env.SUBDL_API_KEY } });
      res = new Response(r.body, { status: r.status, headers: { "content-type": "application/zip", "cache-control": "public, max-age=604800" } });
    } else {
      return new Response("Jaguar X", { status: 200 });
    }
    if (res.ok) ctx.waitUntil(cache.put(request, res.clone()));
    return res;
  },
};
