/**
 * Cloudflare Worker SSE & Snapshot Relay for Barnacle Public Live Experiment (/barnacle-live/).
 * Accepts authenticated outbound POST /ingest from Barnacle; serves read-only GET /events (SSE) and GET /snapshot.
 *
 * Single source of truth: ONE Durable Object ("latest") holds the newest valid snapshot. The previous version kept the snapshot in per-isolate memory and in
 * the per-colo Cache API, so different isolates/colos each served whichever snapshot they had last seen (alternating fresh/stale responses). Now every read and
 * every write goes through the same object, so there is exactly one answer, and an ingest older than the stored snapshot can never replace it (monotonic by event_id).
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Last-Event-ID",
};
const JSON_H = { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" };
const CHUNK = 400000; // characters per SQLite row (limit is 2 MB per row)

export class RelayStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS snap_chunks (i INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.clients = new Set();
    this.cached = null; // {text, event_id}
  }

  meta(k) {
    const r = [...this.sql.exec("SELECT v FROM meta WHERE k=?", k)];
    return r.length ? r[0].v : null;
  }

  load() {
    if (this.cached) return this.cached;
    const id = this.meta("event_id");
    if (id === null) return null;
    const parts = [...this.sql.exec("SELECT body FROM snap_chunks ORDER BY i")].map((r) => r.body);
    if (!parts.length) return null;
    this.cached = { text: parts.join(""), event_id: Number(id), stored_at: Number(this.meta("stored_at") || 0) };
    return this.cached;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/put" && request.method === "POST") {
      const text = await request.text();
      let snap;
      try { snap = JSON.parse(text); } catch { return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), { status: 400, headers: JSON_H }); }
      const incoming = Number(snap.event_id || 0);
      const cur = this.load();
      if (cur && incoming < cur.event_id) {
        // never let an older snapshot replace a newer one
        return new Response(JSON.stringify({ ok: true, stale: true, kept_event_id: cur.event_id, ignored_event_id: incoming }), { headers: JSON_H });
      }
      const chunks = [];
      for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
      this.state.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM snap_chunks");
        chunks.forEach((c, i) => this.sql.exec("INSERT INTO snap_chunks (i, body) VALUES (?, ?)", i, c));
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('event_id', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(incoming));
        this.sql.exec("INSERT INTO meta (k, v) VALUES ('stored_at', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(Date.now()));
      });
      this.cached = { text, event_id: incoming, stored_at: Date.now() };
      const enc = new TextEncoder().encode(`id: ${incoming || Date.now()}\ndata: ${text}\n\n`);
      for (const ctrl of this.clients) {
        try { ctrl.enqueue(enc); } catch { this.clients.delete(ctrl); }
      }
      return new Response(JSON.stringify({ ok: true, event_id: incoming }), { headers: JSON_H });
    }
    if (url.pathname === "/get") {
      const cur = this.load();
      return new Response(cur ? cur.text : JSON.stringify({ barnacle_status: "OFFLINE", published_at_utc: null }), {
        headers: { ...JSON_H, "X-Relay-Event-Id": String(cur ? cur.event_id : 0), "X-Relay-Stored-At": String(cur ? cur.stored_at : 0) },
      });
    }
    if (url.pathname === "/events") {
      const cur = this.load();
      let ctrlRef;
      const stream = new ReadableStream({
        start: (controller) => {
          ctrlRef = controller;
          this.clients.add(controller);
          if (cur) controller.enqueue(new TextEncoder().encode(`id: ${cur.event_id || Date.now()}\ndata: ${cur.text}\n\n`));
        },
        cancel: () => { if (ctrlRef) this.clients.delete(ctrlRef); },
      });
      return new Response(stream, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const stub = env.RELAY.get(env.RELAY.idFromName("latest"));

    if (url.pathname === "/ingest" && request.method === "POST") {
      if (env.INGEST_TOKEN) {
        const auth = request.headers.get("Authorization") || "";
        if (auth !== `Bearer ${env.INGEST_TOKEN}`) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_H });
      }
      return stub.fetch("https://relay/put", { method: "POST", body: await request.text() });
    }
    if (url.pathname === "/snapshot" && request.method === "GET") return stub.fetch("https://relay/get");
    if (url.pathname === "/events" && request.method === "GET") return stub.fetch("https://relay/events");
    return new Response("Barnacle Public Relay", { status: 200, headers: CORS });
  },
};
