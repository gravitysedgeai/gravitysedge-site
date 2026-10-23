// CORA Lite community API (stage 1: secure connection check).
// The public publishing routes are deliberately NOT enabled yet.
// Cloudflare Worker binding: DB -> songwriting-community.
const SITE_ORIGIN = "https://gravitysedgeai.github.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    };
    if (origin === SITE_ORIGIN) {
      headers["access-control-allow-origin"] = SITE_ORIGIN;
      headers["vary"] = "Origin";
    }
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response(JSON.stringify({error: "Not found"}), {status: 404, headers});
    }
    if (!env.DB) {
      return new Response(JSON.stringify({ok: false, error: "Missing D1 binding: DB"}), {status: 503, headers});
    }
    try {
      const tables = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('authors', 'author_sessions', 'songs', 'song_likes') ORDER BY name"
      ).all();
      const found = new Set((tables.results || []).map(row => row.name));
      const required = ["authors", "author_sessions", "songs", "song_likes"];
      const missing = required.filter(name => !found.has(name));
      return new Response(JSON.stringify({
        ok: missing.length === 0,
        service: "songwriting-community-api",
        tablesFound: required.length - missing.length,
        missingTables: missing
      }), {status: missing.length ? 503 : 200, headers});
    } catch (error) {
      console.error("D1 health check failed:", String(error));
      return new Response(JSON.stringify({ok: false, error: "Database query failed"}), {status: 500, headers});
    }
  }
};
