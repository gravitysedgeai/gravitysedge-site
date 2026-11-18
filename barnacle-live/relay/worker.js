/**
 * Cloudflare Worker SSE & Snapshot Relay for Barnacle Public Live Experiment (/barnacle-live/).
 * Accepts authenticated outbound POST /ingest from Barnacle; serves read-only GET /events (SSE) and GET /snapshot.
 */
let latestSnapshot = null;
const clients = new Set();

function cacheUrl(requestUrl) {
  const u = new URL("/__latest_snapshot.json", requestUrl);
  return u.toString();
}

async function saveSnap(snap, requestUrl) {
  latestSnapshot = snap;
  try {
    await caches.default.put(cacheUrl(requestUrl), new Response(JSON.stringify(snap), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400" },
    }));
  } catch {}
}

async function loadSnap(requestUrl) {
  let cached = null;
  try {
    const hit = await caches.default.match(cacheUrl(requestUrl));
    if (hit) cached = await hit.json();
  } catch {}
  if (cached && (!latestSnapshot || Number(cached.event_id || 0) >= Number(latestSnapshot.event_id || 0))) {
    latestSnapshot = cached;
  }
  return latestSnapshot;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (env.INGEST_TOKEN) {
        const auth = request.headers.get("Authorization") || "";
        if (auth !== `Bearer ${env.INGEST_TOKEN}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      }
      const snap = await request.json();
      await saveSnap(snap, request.url);
      const payload = `id: ${snap.event_id || Date.now()}\ndata: ${JSON.stringify(snap)}\n\n`;
      const enc = new TextEncoder().encode(payload);
      for (const ctrl of clients) {
        try { ctrl.enqueue(enc); } catch { clients.delete(ctrl); }
      }
      return new Response(JSON.stringify({ ok: true, event_id: snap.event_id }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    if (url.pathname === "/snapshot" && request.method === "GET") {
      const snap = await loadSnap(request.url);
      return new Response(JSON.stringify(snap || { barnacle_status: "OFFLINE", published_at_utc: null }), {
        headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const snap = await loadSnap(request.url);
      let ctrlRef;
      const stream = new ReadableStream({
        start(controller) {
          ctrlRef = controller;
          clients.add(controller);
          if (snap) {
            const msg = `id: ${snap.event_id || Date.now()}\ndata: ${JSON.stringify(snap)}\n\n`;
            controller.enqueue(new TextEncoder().encode(msg));
          }
        },
        cancel() {
          if (ctrlRef) clients.delete(ctrlRef);
        },
      });
      return new Response(stream, {
        headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    return new Response("Barnacle Public Relay", { status: 200, headers: CORS });
  },
};
