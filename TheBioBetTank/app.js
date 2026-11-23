// BioBetTank: ONE generic card template driven only by the biobet.ticket.status v1 contract.
// No strategy-specific code lives here.
(function () {
  "use strict";
  var DATA = "https://biobet-tank.gravitysedge.workers.dev/data", POLL_MS = 10000;   // live endpoint (Cloudflare Worker, never cached); no site redeploy is needed for data or new tickets
  var tank = null, tab = "active", open = {};   // open: ticket id -> true (keeps <details> state across refreshes)

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(v) { if (v == null) return "–"; var s = Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return (v < 0 ? "-$" : "$") + s; }
  function signed(v) { return (v > 0 ? "+" : "") + money(v).replace("$-", "-$"); }
  function pct(v) { return v == null ? "–" : (v > 0 ? "+" : "") + v.toFixed(2) + "%"; }
  function ts(s) { return s ? Date.parse(s) : null; }
  function ago(ms) { if (ms == null) return "never"; var s = Math.max(0, Math.round(ms / 1000)); if (s < 90) return s + "s ago"; if (s < 5400) return Math.round(s / 60) + "m ago"; if (s < 129600) return Math.round(s / 3600) + "h ago"; return Math.round(s / 86400) + "d ago"; }
  function sgn(v) { return v > 0 ? "up" : v < 0 ? "dn" : ""; }

  // freshness is measured against the time the Tank file was published (no dependence on the viewer's clock)
  function fresh(t, ref) {
    if (t.state === "archived" || t.state === "completed") return { cls: "", txt: "final " + ago(ref - ts(t.generated_at)) };
    var gen = ref - ts(t.generated_at), data = t.activity.last_data_at ? ref - ts(t.activity.last_data_at) : null;
    if (t.state === "running" && gen > 90000) return { cls: "dead", txt: "no update " + ago(gen) };
    if (t.state === "paused" || t.state === "failed") return { cls: "", txt: "stopped " + ago(gen) };
    if (data == null) return { cls: "dead", txt: "no market data yet" };
    if (data > 60000) return { cls: "slow", txt: "data " + ago(data) };
    return { cls: "live", txt: "live · data " + ago(data) };
  }

  function spark(curve, start) {
    var NS = "http://www.w3.org/2000/svg", s = document.createElementNS(NS, "svg");
    s.setAttribute("class", "spark"); s.setAttribute("viewBox", "0 0 100 30"); s.setAttribute("preserveAspectRatio", "none");
    if (!curve || curve.length < 2) return s;
    var v = curve.map(function (p) { return p[1]; }), lo = Math.min.apply(null, v.concat(start)), hi = Math.max.apply(null, v.concat(start)), rg = hi - lo || 1;
    var pts = v.map(function (y, i) { return (i / (v.length - 1) * 100).toFixed(1) + "," + (28 - (y - lo) / rg * 26).toFixed(1); }).join(" ");
    var base = document.createElementNS(NS, "line"); base.setAttribute("x1", 0); base.setAttribute("x2", 100);
    base.setAttribute("y1", (28 - (start - lo) / rg * 26).toFixed(1)); base.setAttribute("y2", base.getAttribute("y1"));
    base.setAttribute("stroke", "currentColor"); base.setAttribute("opacity", ".25"); base.setAttribute("stroke-dasharray", "2");
    var pl = document.createElementNS(NS, "polyline"); pl.setAttribute("points", pts); pl.setAttribute("fill", "none");
    pl.setAttribute("stroke", v[v.length - 1] >= start ? "var(--up)" : "var(--dn)"); pl.setAttribute("stroke-width", "1.5"); pl.setAttribute("vector-effect", "non-scaling-stroke");
    s.appendChild(base); s.appendChild(pl); return s;
  }

  function table(cols, rows) {
    var w = el("div", "wrap"), t = el("table", "tbl"), h = el("tr");
    cols.forEach(function (c) { h.appendChild(el("th", "", c)); }); t.appendChild(h);
    rows.forEach(function (r) { var tr = el("tr"); r.forEach(function (c) { var td = el("td"); if (c && c.cls) { td.className = c.cls; td.textContent = c.t; } else td.textContent = c; tr.appendChild(td); }); t.appendChild(tr); });
    w.appendChild(t); return w;
  }
  function section(title, node) { var s = el("div", "sec"); s.appendChild(el("h4", "", title)); s.appendChild(node); return s; }
  // all times on this page are shown in US Eastern (EST/EDT) with seconds; the published data keeps the original UTC timestamps
  var ETF = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });
  var ETY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" });
  function et(s, year) { var m = s ? Date.parse(s) : NaN; return isNaN(m) ? "–" : (year ? ETY : ETF).format(new Date(m)); }
  function hhmmss(s) { return et(s); }


  // ---- latency (generic: reads only the optional `latency` block of biobet.ticket.status v1; older tickets simply have none)
  function ms(v) { return v == null ? "–" : v < 1000 ? Math.round(v) + " ms" : (v / 1000).toFixed(v < 10000 ? 2 : 1) + " s"; }
  // never shows a number as "current" unless a genuine live event arrived: stopped / silent / recorded-tape-only tickets are labelled instead
  function latState(t, ref) {
    var L = t.latency; if (!L) return null;
    if (t.state !== "running" || ref - ts(t.generated_at) > 90000) return { cls: "off", txt: "OFFLINE", why: "ticket is not running; the numbers below are from its last measurement window" };
    if (L.feed_state === "simulated") return { cls: "sim", txt: "SIMULATED", why: "synthetic data: no real latency exists" };
    if (L.feed_state === "no_live_feed") return { cls: "none", txt: "NO LIVE FEED", why: "no genuine live market event has been received since this window began (recorded tape is never counted as live)" };
    if (L.feed_state === "stale") return { cls: "stale", txt: "STALE", why: "no live market event for " + ms((L.last_event || {}).age_s * 1000) };
    var fa = L.feed_age_ms && L.feed_age_ms.median;
    return { cls: "live", txt: "LIVE" + (fa != null ? " · feed " + ms(fa) : ""), why: "genuine live events are arriving" };
  }
  function latencyDetails(t, ref) {
    var L = t.latency, ls = latState(t, ref), tk = t.ticket;
    var d = el("details", "lat"); d.open = !!open["lat:" + tk.id]; d.addEventListener("toggle", function () { open["lat:" + tk.id] = d.open; });
    d.appendChild(el("summary", "", "Latency & feed quality · " + ls.txt));
    d.appendChild(el("div", "ev", ls.why + ". Window started " + et(L.window_started_at) + " (" + L.window_s + " s)."));
    var haveAge = L.event_age_ms && L.event_age_ms.n > 0;
    if (L.feed_state === "no_live_feed" && !L.events.total) return d;
    if (L.feed_state !== "simulated") {
      var row = function (name, s2) { return [name, ms(s2.last), ms(s2.median), ms(s2.p95), ms(s2.p99), ms(s2.max), s2.n]; };
      var rows = [row("Feed age (receipt → ticket, exact)", L.feed_age_ms)];
      if (haveAge) { rows.push(row("Source latency (venue → receipt, est.)", L.source_latency_ms)); rows.push(row("Event age (venue → ticket, est.)", L.event_age_ms)); }
      rows.push(row("Signal detection + decision", L.processing.signal_decision_ms)); rows.push(row("Paper entry delay (signal → fill)", L.execution.paper_delay_ms));
      d.appendChild(section("Timing", table(["Measure", "Last", "Median", "p95", "p99", "Max", "N"], rows)));
      if (haveAge && L.clock) d.appendChild(el("div", "ev", "Clock uncertainty: " + L.clock.note + (L.clock.offset_floor_ms != null ? " Fastest-1% source latency: " + ms(L.clock.offset_floor_ms) + " (a constant offset cannot be separated from a constant delay)." : "")));
    }
    var e = L.events, q = L.quality, le = L.last_event;
    var kv = el("div", "kv");
    [["Events/s now", e.per_sec_now], ["Events/s window", e.per_sec_window], ["Peak events/s", e.peak_per_sec], ["Events", e.total],
     ["Last live event", le ? ago(ref - ts(le.received_at)) : "none"], ["Gaps >" + q.gap_threshold_s + "s", q.gaps + (q.gaps ? " (max " + q.max_gap_s + "s)" : "")],
     ["Stale episodes", q.stale_episodes + (q.stale_seconds ? " (" + q.stale_seconds + "s)" : "")], ["Resyncs", q.resyncs], ["Invalid", q.invalid_events], ["Dropped (producer)", q.dropped_by_producer],
     ["Late backlog", q.backlog_events], ["Signals / entries", L.execution.signals + " / " + L.execution.paper_entries]]
      .forEach(function (p) { var x = el("div"); x.appendChild(el("span", "", p[0])); x.appendChild(document.createTextNode(p[1])); kv.appendChild(x); });
    d.appendChild(kv);
    return d;
  }

  // display status derived from the ticket's own published fields (no ticket changes): RUNNING / WAITING FOR MATCH / PAUSED / OFFLINE / ERROR / COMPLETED / ARCHIVED
  function label(t, ref) {
    var s = t.state;
    if (s === "archived") return { k: "archived", txt: "ARCHIVED" };
    if (s === "completed") return { k: "completed", txt: "COMPLETED" };
    if (s === "paused") return { k: "paused", txt: "PAUSED" };
    if (s === "failed") return { k: "failed", txt: "ERROR" };
    if (s !== "running") return { k: "paused", txt: String(s).toUpperCase() };
    var gen = ref - ts(t.generated_at), L = t.latency || {}, h = t.health || {};
    if (gen > 90000) return { k: "offline", txt: "OFFLINE" };                       // runtime not updating
    if ((L.feed_state && L.feed_state !== "live") || (t.activity.last_data_at && ref - ts(t.activity.last_data_at) > 60000)) return { k: "offline", txt: "OFFLINE" };   // feed disconnected
    if (h.last_error_at && ref - ts(h.last_error_at) < 120000) return { k: "failed", txt: "ERROR" };
    if (t.experiment && t.experiment.stalled) return { k: "paused", txt: "STALLED (below $1 stake)" };
    var busy = (t.open_positions || []).length > 0;
    return busy ? { k: "running", txt: "RUNNING" } : { k: "waiting", txt: "WAITING FOR MATCH" };
  }
  // generic counters: markets observed, signals, entries, skipped (with reasons), completed trades
  function counters(t) {
    var r = t.market_report || null, st = t.stats || {}, sg = t.signals || [], skipped = {}, nSig = 0, nEnt = 0, mk = {}, tot = 0;
    if (r) { skipped = r.skips || {}; Object.keys(skipped).forEach(function (k) { tot += skipped[k]; }); return { markets: r.markets_seen, signals: null, entries: r.entries, skips: tot, why: skipped, trades: st.completed_trades }; }
    sg.forEach(function (x) { mk[x.ticker] = 1; nSig++; var d = String(x.decision || ""); if (d.indexOf("entr") === 0) nEnt++; else if (d) { var k = d + (x.reason ? ": " + String(x.reason).split(/[ (,:]/)[0] : ""); skipped[k] = (skipped[k] || 0) + 1; tot++; } });
    return { markets: Object.keys(mk).length, signals: nSig, entries: nEnt, skips: tot, why: skipped, trades: st.completed_trades, recent: true };
  }
  function evText(e) {
    if (!e) return "–";
    if (e.frenzy) { var f = e.frenzy; return f.sample_trades + " trades in " + (f.t_since_open_s != null ? f.t_since_open_s + "s after open" : "window") + " · YES " + f.yes_purchases + " / NO " + f.no_purchases; }
    if (e.trigger_trades) return e.trigger_trades.length + " trades " + e.trigger_trades.map(function (x) { return "$" + x.dollars; }).join(" + ");
    var o = []; Object.keys(e).slice(0, 4).forEach(function (k) { if (typeof e[k] !== "object") o.push(k + "=" + e[k]); }); return o.join(" ") || "–";
  }
  // ---- per-strategy monitor: start, data->ticket latency (kept apart from the configured simulated execution delay), last market data, last simulated fill
  function monitorBox(t, ref) {
    var m = t.monitor, run = t.state === "running", box = el("div", "mon");
    if (!m || m.error) { box.appendChild(el("div", "monnote", "Monitoring data unavailable for this ticket.")); return box; }
    var gen = ref - ts(t.generated_at), ldat = m.last_data_at || (t.activity || {}).last_data_at, dage = ldat ? ref - ts(ldat) : null;
    function cell(name, val, sub, cls, tip) { var d = el("div", "mc" + (cls ? " " + cls : "")); if (tip) d.title = tip; d.appendChild(el("span", "", name)); d.appendChild(el("b", "", val)); if (sub) d.appendChild(el("small", "", sub)); return d; }
    if (run && m.process_alive === false) box.appendChild(el("div", "monalert", "PROCESS NOT RUNNING: this ticket reports running but its process has exited. It needs a restart."));
    // start: the original start from the ticket's own ledger, so it survives feed and process restarts
    box.appendChild(cell("Started", et(m.started_at, true), m.resumes ? "resumed " + m.resumes + "x · this run since " + et(m.current_run_started_at) : (m.current_run_started_at && m.current_run_started_at !== m.started_at ? "this run since " + et(m.current_run_started_at) : "original start"), "", "UTC " + (m.started_at || "-")));
    // last usable market data
    var dcls = !run ? "" : dage == null ? "dead" : dage <= 45000 ? "live" : dage <= 120000 ? "slow" : "dead";
    box.appendChild(cell("Last market data", ldat ? et(ldat) : "none yet", !run ? "ticket not running" : dage == null ? "no market data received" : ago(dage) + (dcls === "dead" ? " · STALE" : ""), dcls, "UTC " + (ldat || "-") + ". The page refreshes about every 20 s, so ages under ~30 s are normal."));
    // latency: data -> ticket processing (exact, same PC clock). The configured order delay is a simulation setting, shown separately.
    var L = m.latency || {}, dp = L.data_processing_ms || {}, sim = L.simulated_execution_delay || {}, lv;
    if (!run) lv = ["not running", "", "off"];
    else if (!L.available || dp.median == null) lv = ["UNAVAILABLE", "no measurements yet", "dead"];
    else if (L.feed_state !== "live" || gen > 90000) lv = ["STALE · last " + ms(dp.median), "feed " + (L.feed_state || "unknown"), "dead"];
    else lv = [ms(dp.median) + " median", "p95 " + ms(dp.p95) + " · last " + ms(dp.last), dp.median > 2000 ? "slow" : "live"];
    box.appendChild(cell("Data → ticket latency", lv[0], lv[1], lv[2], L.definition || ""));
    box.appendChild(cell("Simulated order delay (setting)", (sim.configured_entry_s == null ? "-" : sim.configured_entry_s + " s entry") + " · " + (sim.configured_exit_s == null ? "-" : sim.configured_exit_s + " s exit"), sim.measured_paper_delay_ms != null ? "measured paper entry delay " + ms(sim.measured_paper_delay_ms) : "no entry fills measured", "sim", sim.note || ""));
    // last simulated fill: an actual BUY or SELL in the ledger, never a signal or a data event
    var lf = m.last_fill;
    box.appendChild(cell("Last fill", lf ? et(lf.at) : "No fills yet", lf ? String(lf.action).toUpperCase() + " " + lf.contracts + " " + String(lf.side || "").toUpperCase() + " @ " + (lf.price != null ? lf.price.toFixed(2) : "-") + " · " + lf.ticker : (m.last_signal_at ? "last signal " + et(m.last_signal_at) : "no signal yet"), "", lf ? "UTC " + lf.at : ""));
    return box;
  }
  function card(t, ref, notes) {
    var f = t.financials, st = t.stats, tk = t.ticket, fr = fresh(t, ref), c = el("div", "card");
    var top = el("div", "top"), l = el("div");
    l.appendChild(el("div", "title", tk.title)); l.appendChild(el("div", "id", tk.id + " · master v" + (tk.master_version || "?")));
    var r = el("div"); r.style.textAlign = "right"; var lbl = label(t, ref); r.appendChild(el("span", "pill s-" + lbl.k, lbl.txt));
    var fe = el("div", "fresh"); fe.appendChild(el("span", "dot " + fr.cls)); fe.appendChild(document.createTextNode(fr.txt)); r.appendChild(fe);
    var ls = latState(t, ref);
    if (ls) { var lp = el("div", "latpill " + ls.cls); lp.title = ls.why; lp.appendChild(el("span", "dot")); lp.appendChild(document.createTextNode(ls.txt)); r.appendChild(lp); }
    top.appendChild(l); top.appendChild(r); c.appendChild(top);
    c.appendChild(monitorBox(t, ref));
    var fd = t.feed || {}, nt = (notes || {})[tk.id], lab = nt && nt.label ? nt.label : fd.mode === "market_tape" ? "LIVE-DATA PAPER TEST" : fd.mode === "simulated" ? "SIMULATED DATA" : null;
    if (lab) {
      var lb = el("div", "live-label"); lb.appendChild(el("b", "", lab));
      if (nt && nt.caveat) lb.appendChild(el("div", "", nt.caveat));
      else if (fd.mode === "market_tape") lb.appendChild(el("div", "", "Paper trades on recorded live market data. Not validated trading performance; fills not realistically executable."));
      if (fd.mode === "market_tape") lb.appendChild(el("div", "", "Feed: " + (fd.resyncs || 0) + " resync(s) · " + (fd.invalid || 0) + " invalid · " + (fd.producer_dropped || 0) + " dropped · books trusted " + fd.books_trusted + "/" + fd.books_total));
      if (nt && nt.warnings) { var ul = el("ul", "warns"); nt.warnings.forEach(function (w) { ul.appendChild(el("li", "", w)); }); lb.appendChild(ul); }
      c.appendChild(lb);
    }
    var eq = el("div", "eq"); eq.appendChild(el("b", "", money(f.equity)));
    eq.appendChild(el("span", "pnl " + sgn(f.pnl), signed(f.pnl) + "  (" + pct(f.pnl_pct) + ")")); c.appendChild(eq);
    c.appendChild(spark(t.equity_curve, f.starting_bankroll));
    var kv = el("div", "kv");
    [["Start", money(f.starting_bankroll)], ["Cash", money(f.cash)], ["Fees", money(f.fees_paid)],
     ["W / L", st.wins + " / " + st.losses + (st.win_rate != null ? " (" + st.win_rate + "%)" : "")], [st.unresolved_positions || t.state === "archived" || t.state === "completed" ? "Unresolved" : "Open", st.open_positions], ["Trades", st.completed_trades]]
      .forEach(function (p) { var d = el("div"); d.appendChild(el("span", "", p[0])); d.appendChild(document.createTextNode(p[1])); kv.appendChild(d); });
    if (f.max_drawdown != null) {                        // tickets that publish the extended account block (e.g. compounding variants) show it in full
      [["Available cash", money(f.available_cash)], ["Invested", money(f.invested)], ["Realized P&L", signed(f.realized_pnl)], ["Unrealized P&L", signed(f.unrealized_pnl)],
       ["Max drawdown", money(f.max_drawdown) + " (" + f.max_drawdown_pct + "%)"], ["Equity", money(f.equity)]]
        .forEach(function (p) { var d = el("div"); d.appendChild(el("span", "", p[0])); d.appendChild(document.createTextNode(p[1])); kv.appendChild(d); });
    }
    c.appendChild(kv);
    var s = tk.summary || {};
    c.appendChild(el("div", "cfg", [s.strategy, s.trigger, s.entry_range ? "entry " + s.entry_range.join("–") : null, s.exit, s.feed].filter(Boolean).join(" · ")));
    var cn = counters(t), why = Object.keys(cn.why).map(function (k) { return k + " ×" + cn.why[k]; }).join(", ");
    var cr = el("div", "cfg", "Markets " + (cn.markets == null ? "–" : cn.markets) + (cn.recent ? " (recent)" : " observed") + " · signals " + (cn.signals == null ? "–" : cn.signals) + " · entries " + (cn.entries == null ? "–" : cn.entries) + " · skipped " + cn.skips + (why ? " (" + why + ")" : "") + " · completed trades " + cn.trades);
    c.appendChild(cr);
    if (t.experiment) {                                  // generic: any ticket may publish an `experiment` block (plain-English explanation + results); rendered the same for every ticket
      var xp = t.experiment, ex = xp.explain || {}, bx = el("div", "xplain");
      [["Triggers when", ex.what_triggers_a_trade], ["Why it entered", ex.why_it_entered], ["What happened", ex.what_happened_afterward], ["Result", ex.money]].forEach(function (p) {
        if (p[1]) { var r = el("div"); r.appendChild(el("b", "", p[0] + ": ")); r.appendChild(document.createTextNode(p[1])); bx.appendChild(r); }
      });
      var ms = [["Opportunities (markets)", xp.opportunities_markets], ["Signals", xp.signals], ["Attempted entries", xp.attempted_entries], ["Fills", xp.executable_fills], ["Net P&L", xp.net_pnl_realized == null ? "–" : signed(xp.net_pnl_realized)],
                ["Avg / trade", xp.avg_net_per_trade == null ? "–" : signed(xp.avg_net_per_trade)], ["Max drawdown", xp.max_drawdown == null ? "–" : money(xp.max_drawdown)], ["Avg hold", xp.avg_hold_s == null ? "–" : xp.avg_hold_s + "s"]];
      var xk = el("div", "kv");
      ms.forEach(function (p) { var d2 = el("div"); d2.appendChild(el("span", "", p[0])); d2.appendChild(document.createTextNode(p[1])); xk.appendChild(d2); });
      bx.appendChild(xk);
      var miss = Object.keys(xp.missed_due_to_latency_or_price || {}).map(function (k) { return k + " ×" + xp.missed_due_to_latency_or_price[k]; }).join(", ");
      var rj = Object.keys(xp.rejected_candidates || {}).map(function (k) { return k + " ×" + xp.rejected_candidates[k]; }).join(", ");
      if (miss) bx.appendChild(el("div", "ev", "Missed (latency / price): " + miss));
      if (rj) bx.appendChild(el("div", "ev", "Candidates rejected: " + rj));
      var sb = xp.shadow_vs_baseline || {};
      Object.keys(sb).forEach(function (k) {
        bx.appendChild(el("div", "ev", "Same-signal comparison · " + k.replace(/_/g, " ") + ": " + Object.keys(sb[k]).map(function (h) { var v = sb[k][h]; return h + "s → " + (v.mean_net_per_contract == null ? "–" : signed(v.mean_net_per_contract) + "/contract") + " (n=" + v.n + ", win " + (v.win_pct == null ? "–" : v.win_pct + "%") + ")"; }).join(" · ")));
      });
      if (xp.verdict) bx.appendChild(el("div", "ev", xp.verdict));
      c.appendChild(bx);
    }
    if (t.health.errors) c.appendChild(el("div", "err", t.health.errors + " error(s)" + (t.health.last_error ? " · last: " + t.health.last_error : "")));

    var d = el("details"); d.open = !!open[tk.id];
    d.addEventListener("toggle", function () { open[tk.id] = d.open; });
    d.appendChild(el("summary", "", "Positions, trades & signals"));
    var unres = t.open_positions.length && (t.state === "archived" || t.state === "completed" || t.open_positions.some(function (p) { return p.unresolved; }));
    d.appendChild(section(unres ? "Unresolved positions (" + t.open_positions.length + ") · not settled, valued at last observed bid" : "Open positions (" + t.open_positions.length + ")", t.open_positions.length ?
      table(["Market", "Side", "Qty", "Entry", "Mark", "Unrl."], t.open_positions.map(function (p) { return [p.ticker, p.side.toUpperCase(), p.contracts, p.entry_price.toFixed(2), p.mark == null ? "–" : p.mark.toFixed(2), { t: signed(p.unrealized), cls: sgn(p.unrealized) }]; }))
      : el("div", "ev", "None")));
    var tr = t.trades.slice().reverse().slice(0, 50);
    d.appendChild(section("Completed trades (" + st.completed_trades + ")", tr.length ?
      table(["Closed", "Market", "Side", "Qty", "In→Out", "Fees", "P&L", "Exit"], tr.map(function (x) { return [hhmmss(x.closed_at), x.ticker, x.side.toUpperCase(), x.contracts, x.entry_price.toFixed(2) + "→" + x.exit_price.toFixed(2), money(x.entry_fee + x.exit_fee), { t: signed(x.pnl), cls: sgn(x.pnl) }, x.exit_reason]; }))
      : el("div", "ev", "None yet")));
    var sg = t.signals.slice().reverse().slice(0, 15);
    d.appendChild(section("Latest signals", sg.length ?
      table(["Time", "Market", "Trigger→Buy", "Evidence", "Decision"], sg.map(function (x) { var e = x.evidence; return [hhmmss(x.ts), x.ticker, x.trigger_side + "→" + x.target_side, (e.window_value != null ? "$" + e.window_value + " / " + e.window_contracts + "c / " + e.window_trades + " trades in " + e.window_s + "s" : evText(e)), (x.decision || "") + (x.reason ? ": " + x.reason : "")]; }))
      : el("div", "ev", "None yet")));
    var a = t.activity;
    d.appendChild(section("Activity", el("div", "ev", "Last data " + hhmmss(a.last_data_at) + " · last trade " + hhmmss(a.last_trade_at) + " · last signal " + hhmmss(a.last_signal_at) + " · runtime " + Math.round(a.run_seconds / 60) + " min · activated " + hhmmss(tk.activated_at) + (tk.parent ? " · version of " + tk.parent.ticket_id : ""))));
    c.appendChild(d);
    if (t.latency) c.appendChild(latencyDetails(t, ref));
    return c;
  }

  function groupOf(t) { return t.state === "archived" ? "archived" : t.state === "completed" ? "completed" : "active"; }
  var SORT = {
    pnl: function (a, b) { return b.financials.pnl - a.financials.pnl; },
    pnl_pct: function (a, b) { return b.financials.pnl_pct - a.financials.pnl_pct; },
    equity: function (a, b) { return b.financials.equity - a.financials.equity; },
    win: function (a, b) { return (b.stats.win_rate || -1) - (a.stats.win_rate || -1); },
    recent: function (a, b) { return (ts(b.activity.last_trade_at) || 0) - (ts(a.activity.last_trade_at) || 0); },
    title: function (a, b) { return a.ticket.title.localeCompare(b.ticket.title); }
  };

  function render() {
    if (!tank) return;
    var ref = tank.server_time, all = tank.tickets, counts = { active: 0, completed: 0, archived: 0 };
    all.forEach(function (t) { counts[groupOf(t)]++; });
    var shown = all.filter(function (t) { return t.state !== "archived" || true; });
    var live = all.filter(function (t) { return groupOf(t) === "active"; }), pnl = live.reduce(function (s, t) { return s + t.financials.pnl; }, 0);
    var tiles = $("tiles"); tiles.textContent = "";
    [["Active tickets", counts.active], ["Completed", counts.completed], ["Archived", counts.archived], ["Active net P&L", signed(pnl), sgn(pnl)],
     ["Profitable (active)", live.filter(function (t) { return t.financials.pnl > 0; }).length + " / " + live.length]]
      .forEach(function (p) { var d = el("div", "tile"); d.appendChild(el("span", "", p[0])); d.appendChild(el("b", p[2] || "", p[1])); tiles.appendChild(d); });
    var tabs = $("tabs"); tabs.textContent = "";
    [["active", "Active"], ["completed", "Completed"], ["archived", "Archived"], ["all", "All"]].forEach(function (p) {
      var b = el("button", "", p[0] === "all" ? "All (" + all.length + ")" : p[1] + " (" + counts[p[0]] + ")"); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", tab === p[0]);
      b.onclick = function () { tab = p[0]; render(); }; tabs.appendChild(b);
    });
    var q = $("q").value.trim().toLowerCase();
    shown = all.filter(function (t) { return (tab === "all" || groupOf(t) === tab) && (!q || (t.ticket.title + " " + t.ticket.id + " " + (t.ticket.description || "")).toLowerCase().indexOf(q) >= 0); });
    shown.sort(SORT[$("sort").value]);
    var g = $("grid"); g.textContent = ""; shown.forEach(function (t) { g.appendChild(card(t, ref, tank.notes)); });
    $("empty").hidden = shown.length > 0;
    var since = tank.last_ingest ? ref - tank.last_ingest : null, b = $("banner");
    $("upd").textContent = tank.last_ingest ? et(new Date(tank.last_ingest).toISOString()) + " (" + ago(since) + " at last check)" : "never";
    var fetchFail = Date.now() - fetchedAt > 3 * POLL_MS;
    b.hidden = !(fetchFail || since == null || since > 60000);
    b.textContent = fetchFail ? "Cannot reach the live data endpoint. Showing the last data received, which is now out of date." : "Live data is stale: the publisher last sent an update " + ago(since) + ". Ticket cards below may be out of date.";
  }

  var fetchedAt = Date.now();
  function load() {
    fetch(DATA, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { tank = j; fetchedAt = Date.now(); render(); })
      .catch(function () { var b = $("banner"); b.hidden = false; b.textContent = tank ? "Cannot reach the live data endpoint. Showing the last data received, which is now out of date." : "Could not load ticket data."; });
  }
  $("q").addEventListener("input", render); $("sort").addEventListener("change", render);
  load(); setInterval(load, POLL_MS);
})();
