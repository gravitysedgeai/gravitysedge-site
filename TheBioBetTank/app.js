// BioBetTank: ONE generic card template driven only by the biobet.ticket.status v1 contract.
// No strategy-specific code lives here.
(function () {
  "use strict";
  var DATA = "data/tank.json", POLL_MS = 10000;
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
    if (t.state === "running" && gen > 45000) return { cls: "dead", txt: "no update " + ago(gen) };
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
  function hhmmss(s) { return s ? s.slice(5, 19).replace("T", " ") : "–"; }

  function card(t, ref, notes) {
    var f = t.financials, st = t.stats, tk = t.ticket, fr = fresh(t, ref), c = el("div", "card");
    var top = el("div", "top"), l = el("div");
    l.appendChild(el("div", "title", tk.title)); l.appendChild(el("div", "id", tk.id + " · master v" + (tk.master_version || "?")));
    var r = el("div"); r.style.textAlign = "right"; r.appendChild(el("span", "pill s-" + t.state, t.state));
    var fe = el("div", "fresh"); fe.appendChild(el("span", "dot " + fr.cls)); fe.appendChild(document.createTextNode(fr.txt)); r.appendChild(fe);
    top.appendChild(l); top.appendChild(r); c.appendChild(top);
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
    c.appendChild(kv);
    var s = tk.summary || {};
    c.appendChild(el("div", "cfg", [s.strategy, s.trigger, s.entry_range ? "entry " + s.entry_range.join("–") : null, s.exit, s.feed].filter(Boolean).join(" · ")));
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
      table(["Time", "Market", "Trigger→Buy", "Evidence", "Decision"], sg.map(function (x) { var e = x.evidence; return [hhmmss(x.ts), x.ticker, x.trigger_side + "→" + x.target_side, "$" + e.window_value + " / " + e.window_contracts + "c / " + e.window_trades + " trades in " + e.window_s + "s", (x.decision || "") + (x.reason ? ": " + x.reason : "")]; }))
      : el("div", "ev", "None yet")));
    var a = t.activity;
    d.appendChild(section("Activity", el("div", "ev", "Last data " + hhmmss(a.last_data_at) + " · last trade " + hhmmss(a.last_trade_at) + " · last signal " + hhmmss(a.last_signal_at) + " · runtime " + Math.round(a.run_seconds / 60) + " min · activated " + hhmmss(tk.activated_at) + (tk.parent ? " · version of " + tk.parent.ticket_id : ""))));
    c.appendChild(d);
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
    var ref = ts(tank.published_at), all = tank.tickets, counts = { active: 0, completed: 0, archived: 0 };
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
    $("upd").textContent = new Date(ref).toLocaleString();
    var age = Date.now() - ref, b = $("banner");
    b.hidden = age < 180000 || !all.some(function (t) { return t.state === "running"; }); b.textContent = "Publishing looks stale: last update " + ago(age) + ". Ticket data below may be out of date.";
  }

  function load() {
    fetch(DATA + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { tank = j; render(); })
      .catch(function () { var b = $("banner"); b.hidden = false; b.textContent = "Could not load ticket data."; });
  }
  $("q").addEventListener("input", render); $("sort").addEventListener("change", render);
  load(); setInterval(load, POLL_MS);
})();
