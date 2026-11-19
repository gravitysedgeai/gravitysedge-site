/* Barnacle Live Run #001 — Read-Only Live Portfolio Monitor */
const RELAY_URL = 'https://barnacle-live-relay.gravitysedge.workers.dev';
const CACHE_KEY = 'barnacle_live_snapshot_v2';
const PREV_KEY = 'barnacle_live_prev_snap_v1';
const HIST_KEY = 'barnacle_eq_hist_v1';

let currentSnap = null;
let prevSnap = null;
let chartUnit = 'pct';   // 'pct' | 'usd' | 'pnl'
let chartRange = 'all';  // '1h' | '6h' | '24h' | 'all'
const showLines = {};
const ACCOUNT_COLORS = {
  live_25: '#34d399',
  'lab:btc:cust_xp_b8f53a9912_v1:hold:risk-cp_f10_s25': '#38bdf8',
  'lab:btc:cust_xp_b8f53a9912_v1:hold:risk-cp_f10_s100': '#60a5fa',
  'lab:btc:cust_xp_b8f53a9912_v1:hold:risk-cp_f10_s1000': '#22d3ee',
  'lab:crossmarket:cust_xp_b8f53a9912_fin_v1:hold:risk-cp_f10_s25': '#a78bfa',
  'lab:crossmarket:cust_xp_b8f53a9912_fin_v1:hold:risk-cp_f10_s100': '#c084fc',
  'lab:crossmarket:cust_xp_b8f53a9912_fin_v1:hold:risk-cp_f10_s1000': '#e879f9',
  shadow_25: '#f59e0b',
  shadow_100: '#fb923c',
  shadow_1000: '#f87171',
};
const FALLBACK_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#f472b6', '#2dd4bf', '#fb7185'];

function accountGroupOf(a) {
  if (a.group) return a.group;
  if (a.kind === 'REAL' || a.account_id === 'live_25') return 'live';
  if (String(a.account_id || '').includes('fin_v1')) return 'expanded_financial_validation';
  if (String(a.account_id || '').includes('risk-cp_f10_s')) return 'original_validation';
  return 'previous_shadow';
}

function shortLabelOf(a) {
  const id = a.account_id || '';
  if (id === 'live_25') return 'LIVE $25';
  if (id.includes('fin_v1') && id.endsWith('_s25')) return 'Fin Exp $25';
  if (id.includes('fin_v1') && id.endsWith('_s100')) return 'Fin Exp $100';
  if (id.includes('fin_v1') && id.endsWith('_s1000')) return 'Fin Exp $1,000';
  if (id.endsWith('_s25')) return 'XP Val $25';
  if (id.endsWith('_s100')) return 'XP Val $100';
  if (id.endsWith('_s1000')) return 'XP Val $1,000';
  if (id === 'shadow_25') return 'Old Shadow $25';
  if (id === 'shadow_100') return 'Old Shadow $100';
  if (id === 'shadow_1000') return 'Old Shadow $1,000';
  return (a.label || id).replace(' (Control)', '');
}

function fmtCountdown(closeTs) {
  if (!closeTs) return 'UNAVAILABLE';
  const diff = Math.round(Number(closeTs) - Date.now() / 1000);
  if (diff <= 0) return 'SETTLING / CLOSED';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}
let holdingsAcct = '';
let completedAcct = '';
let lastPollOk = false;
let es = null;
let retryMs = 2000;

const $ = (id) => document.getElementById(id);
const fmtUsd = (v) => (v == null || Number.isNaN(Number(v))) ? 'Unavailable' : `$${Number(v).toFixed(2)}`;
const fmtSignedUsd = (v) => {
  if (v == null || Number.isNaN(Number(v))) return 'Unavailable';
  const n = Number(v);
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
};
const fmtSignedPct = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const fmtEt = (ts) => {
  if (!ts) return '–';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(Number(ts) * 1000)) + ' ET';
  } catch { return String(ts); }
};
const fmtTimeShort = (ts) => {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(Number(ts) * 1000));
  } catch { return ''; }
};

function loadJson(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function saveJson(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function recordEquityObservation(snap) {
  if (!snap || !snap.published_ts) return;
  const ts = Number(snap.published_ts);
  const accts = snap.three_accounts?.accounts || [];
  if (!accts.length) return;
  const hist = loadJson(HIST_KEY, {});
  accts.forEach(a => {
    const aid = a.account_id;
    const arr = Array.isArray(hist[aid]) ? hist[aid] : [];
    const last = arr[arr.length - 1];
    if (!last || (ts > Number(last.ts) + 10)) {
      arr.push({
        ts,
        equity_cents: Number(a.equity_cents ?? a.initial_cents ?? 0),
        pnl_cents: Number(a.net_pnl_cents ?? ((a.equity_cents || 0) - (a.initial_cents || 0))),
      });
      if (arr.length > 400) arr.splice(0, arr.length - 400);
      hist[aid] = arr;
    }
  });
  saveJson(HIST_KEY, hist);
}

function acceptSnapshot(snap) {
  if (!snap || !snap.published_at_utc) return;
  const cached = loadJson(CACHE_KEY, null);
  if (cached && cached.event_id && snap.event_id && Number(snap.event_id) !== Number(cached.event_id)) {
    prevSnap = cached;
    saveJson(PREV_KEY, cached);
  } else if (!prevSnap) {
    prevSnap = loadJson(PREV_KEY, null);
  }
  currentSnap = snap;
  saveJson(CACHE_KEY, snap);
  recordEquityObservation(snap);
}

function emptySnapshot() {
  return {
    published_at_utc: null,
    publish_delay_s: 60,
    barnacle_status: 'STANDBY',
    publisher_status: 'DISABLED',
    run: { first_fill_ts: null },
    metrics: {},
    holdings: [],
    completed_trades: [],
    three_accounts: { accounts: [], series: {} },
  };
}

function renderStatusHeader(snap, connState) {
  const pubTs = snap.published_ts || (snap.published_at_utc ? Date.parse(snap.published_at_utc) / 1000 : null);
  const feedAgeS = pubTs ? Math.max(0, Math.round(Date.now() / 1000 - pubTs)) : null;
  const pubSt = snap.publisher_status || 'DISABLED';
  const effState = connState === 'OFFLINE' ? 'OFFLINE'
    : (!pubTs || pubSt === 'DISABLED' || (feedAgeS != null && feedAgeS > 180)) ? 'STALE'
    : 'ONLINE';

  const connPill = $('conn-pill');
  if (effState === 'ONLINE') { connPill.textContent = '● ONLINE'; connPill.className = 'pill ok'; }
  else if (effState === 'STALE') { connPill.textContent = '● STALE'; connPill.className = 'pill warn'; }
  else { connPill.textContent = '● OFFLINE'; connPill.className = 'pill bad'; }

  const armedPill = $('armed-pill');
  if (effState !== 'ONLINE') {
    armedPill.textContent = `LIVE TRADING: UNVERIFIED (${effState})`;
    armedPill.className = 'pill warn';
  } else if (snap.barnacle_status === 'ACTIVE') {
    armedPill.textContent = 'LIVE TRADING: ARMED (ACTIVE)';
    armedPill.className = 'pill ok';
  } else {
    armedPill.textContent = `LIVE TRADING: ${snap.barnacle_status || 'DISARMED'}`;
    armedPill.className = 'pill bad';
  }

  const run = snap.run || {};
  const clockPill = $('clock-pill');
  if (!run.first_fill_ts) {
    clockPill.textContent = '24H CLOCK: STANDBY';
  } else {
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - run.first_fill_ts));
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    clockPill.textContent = `24H CLOCK: ${h}h ${m}m`;
  }

  $('age-pill').textContent = feedAgeS != null ? `AGE: ${feedAgeS}s` : 'AGE: –';
  $('last-verified').textContent = `Last update: ${fmtEt(pubTs)} (${feedAgeS != null ? feedAgeS + 's ago' : '–'}) · Publisher: ${pubSt} · Delay: ${snap.publish_delay_s ?? 60}s`;

  const banner = $('truth-banner');
  const m = snap.metrics || {};
  if (effState !== 'ONLINE') {
    banner.className = effState === 'OFFLINE' ? 'banner bad' : 'banner warn';
    banner.textContent = `${effState} DATA — Feed is ${feedAgeS != null ? feedAgeS + 's' : 'unknown'} old (last published ${fmtEt(pubTs)}). Live trading status cannot be verified from a stale snapshot.`;
  } else {
    banner.className = 'banner';
    const outside = m.shard0_outside_usd ?? 0.58;
    banner.textContent = `LIVE & RECONCILED — Shard 2 Experiment Cash: ${fmtUsd(m.available_cash_usd)} · Open Portfolio Value: ${fmtUsd(m.open_position_value_usd)} · Total Live Equity: ${fmtUsd(m.verified_equity_usd)} (Shard 0 ${fmtUsd(outside)} excluded).`;
  }
}

function renderScoreboard(snap) {
  const grid = $('scoreboard-grid');
  if (!grid) return;
  const accts = snap?.three_accounts?.accounts || [];
  const holdings = snap?.holdings || [];
  const prevMap = {};
  (prevSnap?.three_accounts?.accounts || []).forEach(pa => { prevMap[pa.account_id] = pa; });

  if (!accts.length) {
    grid.innerHTML = '<div class="acct-card"><div class="muted">Waiting for account data…</div></div>';
    return;
  }

  const renderCard = (a) => {
    const grp = accountGroupOf(a);
    const isReal = grp === 'live';
    const isVal = grp === 'original_validation';
    const initC = Number(a.initial_cents || 0);
    const eqC = Number(a.equity_cents ?? initC);
    const netC = Number(a.net_pnl_cents ?? (eqC - initC));
    const retPct = initC > 0 ? (netC / initC) * 100 : 0;
    const contractsHeld = holdings
      .filter(h => h.account_id === a.account_id)
      .reduce((s, h) => s + Number(h.contracts || 0), 0);

    let prevEqC = prevMap[a.account_id]?.equity_cents;
    if (prevEqC == null) {
      const ser = snap?.three_accounts?.series?.[a.account_id] || [];
      if (ser.length >= 2) prevEqC = ser[ser.length - 2].equity_cents;
    }
    let deltaHtml = '<span class="delta-pill flat">— $0.00</span>';
    if (prevEqC != null) {
      const dC = eqC - Number(prevEqC);
      if (dC > 0) deltaHtml = `<span class="delta-pill up">▲ +$${(dC / 100).toFixed(2)}</span>`;
      else if (dC < 0) deltaHtml = `<span class="delta-pill down">▼ -$${(Math.abs(dC) / 100).toFixed(2)}</span>`;
      else deltaHtml = '<span class="delta-pill flat">— $0.00</span>';
    }

    const posValTxt = a.position_value_cents == null
      ? 'UNAVAILABLE'
      : (a.open_positions > 0 && a.mark_reliable === false)
      ? `${fmtUsd(a.position_value_cents / 100)} *`
      : fmtUsd(a.position_value_cents / 100);
    const sellTxt = a.net_sell_value_cents == null
      ? 'UNAVAILABLE'
      : (a.open_positions > 0 && a.mark_reliable === false && !a.net_sell_value_cents)
      ? 'UNAVAILABLE'
      : fmtUsd(a.net_sell_value_cents / 100);
    const unrealTxt = a.unrealized_pnl_cents == null ? 'UNAVAILABLE' : fmtSignedUsd(a.unrealized_pnl_cents / 100);

    const netCls = netC > 0 ? 'pos' : netC < 0 ? 'neg' : '';
    const titleLabel = isReal
      ? `${a.label} — REAL MONEY`
      : `${a.label.replace(' (Control)', '')} — SIMULATED`;
    const isFin = grp === 'expanded_financial_validation';
    const cardCls = isReal ? 'real-card' : isVal ? 'validation-card' : isFin ? 'fin-card' : 'paper-card';
    const badgeHtml = isReal
      ? '<span class="tag real">REAL MONEY · PAUSED</span>'
      : isVal
      ? '<span class="tag validation">ORIGINAL XP ENGINE · SIMULATED</span>'
      : isFin
      ? '<span class="tag validation" style="background:#a78bfa;border-color:#a78bfa">FINANCIAL EXPANSION · SIMULATED</span>'
      : '<span class="tag legacy">PREVIOUS REWRITTEN · SIMULATED</span>';

    const acctHoldings = holdings.filter(h => h.account_id === a.account_id);
    const posDetailsHtml = acctHoldings.length === 0
      ? '<div class="muted" style="font-size:11px;margin-top:4px">No open positions.</div>'
      : acctHoldings.map(h => {
          const entryLvls = (h.entry_levels || []).map(l => `<span class="depth-chip">${l.qty}x @ ${l.price_cents}¢</span>`).join('');
          const sellLvls = (h.sell_levels || []).length
            ? h.sell_levels.map(l => `<span class="depth-chip">${l.price_cents}¢: ${l.available_qty} avail (sell ${l.sell_qty})</span>`).join('')
            : '<span class="muted">UNAVAILABLE</span>';
          const bestBidTxt = h.best_bid_cents != null ? `${h.best_bid_cents}¢` : 'UNAVAILABLE';
          const estSellTxt = h.estimated_net_sell_usd != null ? fmtUsd(h.estimated_net_sell_usd) : 'UNAVAILABLE';
          const sellPnlTxt = h.sell_pnl_usd != null ? fmtSignedUsd(h.sell_pnl_usd) : 'UNAVAILABLE';
          const sellPnlCls = h.sell_pnl_usd == null ? '' : (h.sell_pnl_usd >= 0 ? 'pos' : 'neg');
          const liqWarn = h.partial_liquidity ? ` (Partial: ${h.fillable_qty}/${h.contracts})` : '';
          const bookFresh = h.book_ts ? `${fmtEt(h.book_ts)} (${h.book_source || 'book'})` : 'UNAVAILABLE';
          return `
          <div class="pos-item">
            <div class="pos-item-head">
              <span class="mono">${h.ticker}</span>
              <span class="tag ${h.side === 'YES' ? 'win' : 'paper'}">${h.side} · ${h.contracts}x</span>
            </div>
            <div class="muted">${h.marketplace || 'Kalshi'} · Series: <span class="mono">${h.series_ticker || '–'}</span> · Event: <span class="mono">${h.event_ticker || '–'}</span></div>
            <div class="pos-kv">
              <span class="k">Purchased (ET)</span><span class="v">${fmtEt(h.opened_ts)}</span>
              <span class="k">Closes / Countdown</span><span class="v">${fmtEt(h.close_ts)} (${fmtCountdown(h.close_ts)})</span>
              <span class="k">Entry Fills</span><span class="v">${entryLvls || '–'}</span>
              <span class="k">Pre-Fee Avg / Fee-Incl Avg</span><span class="v">${h.entry_price_cents}¢ / ${h.fee_inclusive_avg_cents ?? h.entry_price_cents}¢</span>
              <span class="k">Cost + Fees = Cost Basis</span><span class="v">${fmtUsd(h.purchase_cost_usd)} + ${fmtUsd(h.fee_usd)} = ${fmtUsd(h.cost_basis_usd ?? h.invested_usd)}</span>
              <span class="k">Best Selling Bid</span><span class="v">${bestBidTxt}</span>
              <span class="k">Book Freshness</span><span class="v">${bookFresh}</span>
              <span class="k">Est. Net Liquidation${liqWarn}</span><span class="v">${estSellTxt}</span>
              <span class="k">Executable P&amp;L (Sell Now)</span><span class="v ${sellPnlCls}">${sellPnlTxt}</span>
              <span class="k">Max Settlement / Rem. Profit</span><span class="v">${fmtUsd(h.max_payout_usd)} / ${fmtSignedUsd(h.remaining_profit_usd)}</span>
            </div>
            <div><span class="muted">Bid Depth:</span><div class="depth-list">${sellLvls}</div></div>
          </div>`;
        }).join('');

    return `
    <article class="acct-card ${cardCls}">
      <div class="acct-head">
        <span class="acct-title">${titleLabel}</span>
        ${badgeHtml}
      </div>
      <div class="eq-row">
        <span class="eq-val mono">${fmtUsd(eqC / 100)}</span>
        ${deltaHtml}
      </div>
      <div class="net-row ${netCls}">
        <span>Net P&amp;L: ${fmtSignedUsd(netC / 100)}</span>
        <span class="mono">${fmtSignedPct(retPct)}</span>
      </div>
      <div class="stat-badges">
        <div class="stat-mini"><div class="lbl">Win / Loss</div><div class="val mono">${a.wins ?? 0}W / ${a.losses ?? 0}L</div></div>
        <div class="stat-mini"><div class="lbl">Open Pos</div><div class="val mono">${a.open_positions ?? 0}</div></div>
        <div class="stat-mini"><div class="lbl">Contracts</div><div class="val mono">${contractsHeld}</div></div>
      </div>
      <div class="acct-rows">
        <span class="k">Starting Balance</span><span class="v">${fmtUsd(initC / 100)}</span>
        <span class="k">Available Cash</span><span class="v">${fmtUsd((a.available_cents || 0) / 100)}</span>
        <span class="k">Invested Cost Basis</span><span class="v">${fmtUsd((a.invested_cents || 0) / 100)}</span>
        <span class="k">Position Market Value</span><span class="v">${posValTxt}</span>
        <span class="k">Est. Net Sell Value</span><span class="v">${sellTxt}</span>
        <span class="k">Realized / Unrealized</span><span class="v">${fmtSignedUsd((a.realized_net_cents || 0) / 100)} / ${unrealTxt}</span>
        <span class="k">Total Fees</span><span class="v">${fmtUsd((a.fees_cents || 0) / 100)}</span>
      </div>
      <details class="pos-details">
        <summary><span>Open Position Details (${acctHoldings.length})</span><span>▸ Expand</span></summary>
        ${posDetailsHtml}
      </details>
    </article>`;
  };

  const groups = [
    {
      key: 'original_validation',
      title: 'ORIGINAL XP CRYPTO VALIDATION (SIMULATED)',
      sub: 'Fresh $25 / $100 / $1,000 paper accounts running the exact original CustomStrategy + Engine (forward.db).',
      items: accts.filter(a => accountGroupOf(a) === 'original_validation'),
    },
    {
      key: 'expanded_financial_validation',
      title: 'EXPANDED FINANCIAL VALIDATION (SIMULATED)',
      sub: 'Original CustomStrategy + Engine expanded to Crypto, Gold, Silver, Energy, Indices, FX, and Rates (forward.db).',
      items: accts.filter(a => accountGroupOf(a) === 'expanded_financial_validation'),
    },
    {
      key: 'live',
      title: 'PAUSED REAL-MONEY ACCOUNT',
      sub: 'Kalshi Shard 2 real-money ledger (new orders paused).',
      items: accts.filter(a => accountGroupOf(a) === 'live'),
    },
    {
      key: 'previous_shadow',
      title: 'PREVIOUS REWRITTEN EXPERIMENT (SIMULATED)',
      sub: 'Earlier 1-second WebSocket-rewrite shadow accounts (preserved separately for comparison).',
      items: accts.filter(a => accountGroupOf(a) === 'previous_shadow'),
    },
  ].filter(g => g.items.length > 0);

  grid.innerHTML = groups.map(g => `
    <div class="group-section">
      <div class="group-head">
        <span class="group-title">${g.title}</span>
        <span class="group-sub">${g.sub}</span>
      </div>
      <div class="scoreboard-grid">${g.items.map(renderCard).join('')}</div>
    </div>
  `).join('');
}

function renderChart(snap) {
  const box = $('bankroll-chart');
  const legendBox = $('chart-legend');
  const tip = $('chart-tooltip');
  const seriesMap = snap?.three_accounts?.series || {};
  const accounts = snap?.three_accounts?.accounts || [];
  const localHist = loadJson(HIST_KEY, {});

  const specs = accounts.map((a, idx) => {
    const aid = a.account_id;
    if (!(aid in showLines)) showLines[aid] = true;
    const isReal = accountGroupOf(a) === 'live';
    return {
      key: aid,
      label: shortLabelOf(a) + (isReal ? ' (REAL)' : ' (SIM)'),
      shortLabel: shortLabelOf(a),
      color: ACCOUNT_COLORS[aid] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
      dashed: !isReal,
      init: Number(a.initial_cents || 2500),
    };
  });

  const toggleBox = $('line-toggles');
  if (toggleBox) {
    toggleBox.innerHTML = specs.map(sp => `<button class="toggle-btn ${showLines[sp.key] ? 'active' : ''}" data-line="${sp.key}" type="button">${sp.shortLabel}</button>`).join('');
    toggleBox.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.line;
        showLines[k] = !showLines[k];
        renderChart(currentSnap);
      };
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = chartRange === '1h' ? nowSec - 3600
    : chartRange === '6h' ? nowSec - 21600
    : chartRange === '24h' ? nowSec - 86400
    : 0;

  const active = specs.filter(s => showLines[s.key]);
  const prepared = [];
  const allTs = [];
  const allVals = [];

  const valOf = (pt, init) => {
    const eqC = Number(pt.equity_cents ?? init);
    const pnlC = eqC - init;
    if (chartUnit === 'pct') return (pnlC / Math.max(1, init)) * 100;
    if (chartUnit === 'pnl') return pnlC / 100;
    return eqC / 100;
  };

  active.forEach(sp => {
    const merged = [...(seriesMap[sp.key] || []), ...(localHist[sp.key] || [])]
      .filter(p => p && p.ts != null)
      .map(p => ({ ts: Number(p.ts), equity_cents: Number(p.equity_cents ?? sp.init) }))
      .sort((a, b) => a.ts - b.ts);
    // Deduplicate close timestamps (<15s) keeping latest
    const dedup = [];
    for (const p of merged) {
      if (dedup.length && p.ts - dedup[dedup.length - 1].ts < 15) {
        dedup[dedup.length - 1] = p;
      } else {
        dedup.push(p);
      }
    }
    const filtered = cutoff > 0 ? dedup.filter(p => p.ts >= cutoff) : dedup;
    const pts = filtered.length ? filtered : dedup.slice(-1);
    if (!pts.length) return;
    prepared.push({ ...sp, pts });
    pts.forEach(p => {
      allTs.push(p.ts);
      allVals.push(valOf(p, sp.init));
    });
  });

  legendBox.innerHTML = prepared.map(sp => `
    <span class="legend-item" style="color:${sp.color}">
      <span class="legend-line ${sp.dashed ? 'dashed' : ''}"></span>
      <span>${sp.label} (${sp.pts.length} pts)</span>
    </span>`).join('');

  if (!prepared.length || !allTs.length) {
    box.innerHTML = '<div class="muted" style="padding:24px;text-align:center">No historical equity observations available yet for this range.</div>';
    return;
  }

  const w = 780, h = 240, padL = 58, padR = 18, padT = 16, padB = 28;
  const minT = Math.min(...allTs);
  const maxT = Math.max(...allTs);
  const spanT = Math.max(1, maxT - minT);
  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  if (chartUnit !== 'usd') {
    minV = Math.min(minV, 0);
    maxV = Math.max(maxV, 0);
  }
  const padV = Math.max(chartUnit === 'pct' ? 0.5 : 0.25, (maxV - minV) * 0.12);
  minV -= padV;
  maxV += padV;
  const spanV = Math.max(0.01, maxV - minV);

  const xOf = (t) => padL + ((t - minT) / spanT) * (w - padL - padR);
  const yOf = (v) => h - padB - ((v - minV) / spanV) * (h - padT - padB);
  const fmtY = (v) => chartUnit === 'pct' ? `${v.toFixed(1)}%` : `$${v.toFixed(2)}`;

  // Horizontal grid + Y labels
  let gridSvg = '';
  for (let i = 0; i <= 4; i++) {
    const v = minV + (spanV * i) / 4;
    const y = yOf(v);
    gridSvg += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="rgba(148,163,184,0.14)" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="10">${fmtY(v)}</text>`;
  }
  // Zero reference line in % / $ P&L modes
  if (chartUnit !== 'usd' && minV <= 0 && maxV >= 0) {
    const zy = yOf(0);
    gridSvg += `<line x1="${padL}" y1="${zy.toFixed(1)}" x2="${w - padR}" y2="${zy.toFixed(1)}" stroke="rgba(148,163,184,0.4)" stroke-dasharray="3 3" stroke-width="1"/>`;
  }
  // X-axis time ticks
  for (let i = 0; i <= 4; i++) {
    const t = minT + (spanT * i) / 4;
    const x = xOf(t);
    gridSvg += `<text x="${x.toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="#94a3b8" font-size="10">${fmtTimeShort(t)}</text>`;
  }

  const linesSvg = prepared.map(sp => {
    if (sp.pts.length === 1) {
      const p = sp.pts[0];
      const cx = xOf(p.ts).toFixed(1);
      const cy = yOf(valOf(p, sp.init)).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${sp.color}" stroke="#060a12" stroke-width="1.5"/>`;
    }
    const d = sp.pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.ts).toFixed(1)} ${yOf(valOf(p, sp.init)).toFixed(1)}`).join(' ');
    const dash = sp.dashed ? 'stroke-dasharray="6 4"' : '';
    const sw = sp.dashed ? '1.9' : '2.7';
    const last = sp.pts[sp.pts.length - 1];
    const lx = xOf(last.ts).toFixed(1);
    const ly = yOf(valOf(last, sp.init)).toFixed(1);
    return `<path d="${d}" fill="none" stroke="${sp.color}" stroke-width="${sw}" ${dash}/><circle cx="${lx}" cy="${ly}" r="3.5" fill="${sp.color}"/>`;
  }).join('');

  box.innerHTML = `
    <svg id="chart-svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:230px;display:block;touch-action:none">
      ${gridSvg}
      ${linesSvg}
      <line id="chart-hover-line" x1="0" y1="${padT}" x2="0" y2="${h - padB}" stroke="rgba(226,232,240,0.4)" stroke-width="1" style="display:none"/>
    </svg>`;

  const svg = $('chart-svg');
  const hLine = $('chart-hover-line');
  const showHover = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((clientX - rect.left) / Math.max(1, rect.width)) * w;
    const clampedX = Math.max(padL, Math.min(w - padR, relX));
    const targetTs = minT + ((clampedX - padL) / Math.max(1, w - padL - padR)) * spanT;
    hLine.setAttribute('x1', clampedX.toFixed(1));
    hLine.setAttribute('x2', clampedX.toFixed(1));
    hLine.style.display = 'block';

    const rowsHtml = prepared.map(sp => {
      let best = sp.pts[0];
      let bestDist = Math.abs(best.ts - targetTs);
      for (const p of sp.pts) {
        const dist = Math.abs(p.ts - targetTs);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const eq = best.equity_cents / 100;
      const pnl = (best.equity_cents - sp.init) / 100;
      const pct = ((best.equity_cents - sp.init) / Math.max(1, sp.init)) * 100;
      return `<div style="display:flex;justify-content:space-between;gap:10px;color:${sp.color}">
        <span>${sp.shortLabel}</span>
        <span class="mono">${fmtUsd(eq)} (${fmtSignedPct(pct)} / ${fmtSignedUsd(pnl)})</span>
      </div>`;
    }).join('');
    tip.innerHTML = `<div class="muted" style="margin-bottom:4px">${fmtEt(targetTs)}</div>${rowsHtml}`;
    tip.style.display = 'block';
    const leftPx = Math.min(rect.width - 210, Math.max(8, clientX - rect.left + 12));
    tip.style.left = `${leftPx}px`;
    tip.style.top = '34px';
  };
  svg.onmousemove = (e) => showHover(e.clientX, e.clientY);
  svg.ontouchmove = (e) => { if (e.touches[0]) showHover(e.touches[0].clientX, e.touches[0].clientY); };
  svg.onmouseleave = () => { hLine.style.display = 'none'; tip.style.display = 'none'; };
}

function renderAccountFilterTabs(containerId, accts, items, activeAcct, onSelect) {
  const box = $(containerId);
  if (!box) return;
  const defs = [{ aid: '', label: 'All' }, ...accts.map(a => ({ aid: a.account_id, label: shortLabelOf(a) }))];
  box.innerHTML = defs.map(d => {
    const cnt = d.aid ? items.filter(x => x.account_id === d.aid).length : items.length;
    return `<button class="tab-btn ${activeAcct === d.aid ? 'active' : ''}" data-acct="${d.aid}" type="button">${d.label} (${cnt})</button>`;
  }).join('');
  box.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => onSelect(btn.dataset.acct || '');
  });
}

function renderHoldings(snap) {
  const all = snap?.holdings || [];
  const accts = snap?.three_accounts?.accounts || [];
  const totalContracts = all.reduce((s, h) => s + Number(h.contracts || 0), 0);
  $('holdings-summary').textContent = `${all.length} Open Positions · ${totalContracts} Contracts Held Across All ${accts.length} Accounts`;

  renderAccountFilterTabs('holdings-tabs', accts, all, holdingsAcct, (aid) => {
    holdingsAcct = aid;
    if (currentSnap) renderHoldings(currentSnap);
  });

  const q = ($('holdings-q')?.value || '').trim().toLowerCase();
  const rows = all.filter(h => {
    const matchA = !holdingsAcct || h.account_id === holdingsAcct;
    const matchQ = !q || (h.ticker || '').toLowerCase().includes(q) || (h.event_title || '').toLowerCase().includes(q);
    return matchA && matchQ;
  });

  const body = $('holdings-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="11" class="muted">No open holdings match the current filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(h => {
    const isReal = h.kind === 'REAL' || h.account_id === 'live_25';
    const uCls = (h.unrealized_pnl_usd || 0) > 0 ? 'pos' : (h.unrealized_pnl_usd || 0) < 0 ? 'neg' : '';
    return `<tr class="clickable" data-hid="${h.id}">
      <td><span class="tag ${isReal ? 'real' : 'paper'}">${h.account_label || h.account_id}</span></td>
      <td><div class="mono">${h.ticker}</div><div class="muted" style="font-size:11px">${h.event_title || ''}</div></td>
      <td class="mono">${h.side || '–'}</td>
      <td class="mono">${h.contracts ?? 0}</td>
      <td class="mono">${h.entry_price_cents != null ? h.entry_price_cents + '¢' : '–'}</td>
      <td class="mono">${fmtUsd(h.invested_usd)}</td>
      <td class="mono">${h.current_value_usd != null ? fmtUsd(h.current_value_usd) : 'Unavailable'}</td>
      <td class="mono">${h.estimated_net_sell_usd != null ? fmtUsd(h.estimated_net_sell_usd) : 'Unavailable'}</td>
      <td class="mono ${uCls}">${h.unrealized_pnl_usd != null ? fmtSignedUsd(h.unrealized_pnl_usd) : 'Unavailable'}</td>
      <td class="muted">${fmtEt(h.opened_ts || h.ts)}</td>
      <td><span class="pill ok">${h.status || 'OPEN'}</span></td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr.clickable').forEach(tr => {
    tr.onclick = () => {
      const item = rows.find(x => x.id === tr.dataset.hid);
      if (item) openModal(item);
    };
  });
}

function renderCompleted(snap) {
  const all = snap?.completed_trades || [];
  const accts = snap?.three_accounts?.accounts || [];

  // Cumulative W/L/WinRate/Realized summary strip per account
  $('completed-summary').innerHTML = accts.map(a => {
    const w = Number(a.wins || 0);
    const l = Number(a.losses || 0);
    const tot = w + l;
    const wr = tot > 0 ? `${((w / tot) * 100).toFixed(1)}%` : '–';
    const net = Number(a.realized_net_cents || 0) / 100;
    const isReal = a.kind === 'REAL' || a.account_id === 'live_25';
    return `<div class="cum-box">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${a.label.replace(' (Control)', '')}</b>
        <span class="tag ${isReal ? 'real' : 'paper'}">${isReal ? 'REAL' : 'PAPER'}</span>
      </div>
      <div class="mono" style="margin-top:4px">${w}W / ${l}L (${wr}) · <span class="${net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(net)}</span></div>
    </div>`;
  }).join('');

  renderAccountFilterTabs('completed-tabs', accts, all, completedAcct, (aid) => {
    completedAcct = aid;
    if (currentSnap) renderCompleted(currentSnap);
  });

  const q = ($('completed-q')?.value || '').trim().toLowerCase();
  const rows = all.filter(t => {
    const matchA = !completedAcct || t.account_id === completedAcct;
    const matchQ = !q || (t.ticker || '').toLowerCase().includes(q) || (t.event_title || '').toLowerCase().includes(q);
    return matchA && matchQ;
  });

  const body = $('completed-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="muted">No completed trades match the current filter.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(t => {
    const isReal = t.kind === 'REAL' || t.account_id === 'live_25';
    const net = Number(t.realized_net_usd ?? t.net_pnl_usd ?? 0);
    const payout = t.result === 'WIN' ? Number(t.contracts || 1) * 1.0 : 0.0;
    const resCls = t.result === 'WIN' ? 'win' : 'loss';
    return `<tr class="clickable" data-cid="${t.id}">
      <td><span class="tag ${isReal ? 'real' : 'paper'}">${t.account_label || t.account_id}</span></td>
      <td><div class="mono">${t.ticker}</div><div class="muted" style="font-size:11px">${t.event_title || ''}</div></td>
      <td class="mono">${t.side || '–'}</td>
      <td class="mono">${t.contracts ?? 0}</td>
      <td class="mono">${fmtUsd(t.invested_usd)}</td>
      <td class="mono">${fmtUsd(payout)}</td>
      <td class="mono">${fmtUsd(t.fee_usd || 0)}</td>
      <td class="mono ${net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(net)}</td>
      <td><span class="tag ${resCls}">${t.result || t.status || 'SETTLED'}</span></td>
      <td class="muted">${fmtEt(t.closed_ts || t.ts)}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('tr.clickable').forEach(tr => {
    tr.onclick = () => {
      const item = rows.find(x => x.id === tr.dataset.cid);
      if (item) openModal(item);
    };
  });
}

function openModal(item) {
  $('modal-title').textContent = `${item.account_label || ''} · ${item.ticker || 'Position Detail'}`;
  $('modal-body').innerHTML = `<pre class="mono" style="white-space:pre-wrap;font-size:12px;background:#050914;padding:10px;border-radius:8px;max-height:60vh;overflow:auto">${JSON.stringify(item, null, 2)}</pre>`;
  $('trace-modal').showModal();
}

function renderAll(snap, connState = 'WAITING') {
  currentSnap = snap;
  renderStatusHeader(snap, connState);
  renderScoreboard(snap);
  renderChart(snap);
  renderHoldings(snap);
  renderCompleted(snap);
}

async function pollSnapshot() {
  try {
    const r = await fetch(`${RELAY_URL}/snapshot`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snap = await r.json();
    if (snap && snap.published_at_utc) {
      lastPollOk = true;
      acceptSnapshot(snap);
      renderAll(snap, 'LIVE');
    } else {
      lastPollOk = false;
      renderAll(currentSnap || loadJson(CACHE_KEY, null) || emptySnapshot(), 'OFFLINE');
    }
  } catch {
    lastPollOk = false;
    renderAll(currentSnap || loadJson(CACHE_KEY, null) || emptySnapshot(), 'OFFLINE');
  }
}

function connectStream() {
  pollSnapshot();
  setInterval(pollSnapshot, 15000);
  setInterval(() => { if (currentSnap) renderStatusHeader(currentSnap, lastPollOk ? 'LIVE' : 'OFFLINE'); }, 5000);
  try {
    if (es) es.close();
    es = new EventSource(`${RELAY_URL}/events`);
    es.onmessage = (ev) => {
      retryMs = 2000;
      lastPollOk = true;
      const snap = JSON.parse(ev.data);
      acceptSnapshot(snap);
      renderAll(snap, 'LIVE');
    };
    es.onerror = () => {
      if (!lastPollOk) renderAll(currentSnap || loadJson(CACHE_KEY, null) || emptySnapshot(), 'OFFLINE');
      es.close();
      setTimeout(connectStream, retryMs);
      retryMs = Math.min(30000, retryMs * 2);
    };
  } catch {
    if (!lastPollOk) renderAll(currentSnap || loadJson(CACHE_KEY, null) || emptySnapshot(), 'OFFLINE');
  }
}

// Wire controls
const setUnit = (u, btn) => {
  chartUnit = u;
  ['unit-pct', 'unit-usd', 'unit-pnl'].forEach(id => $(id).classList.remove('active'));
  btn.classList.add('active');
  if (currentSnap) renderChart(currentSnap);
};
$('unit-pct').onclick = () => setUnit('pct', $('unit-pct'));
$('unit-usd').onclick = () => setUnit('usd', $('unit-usd'));
$('unit-pnl').onclick = () => setUnit('pnl', $('unit-pnl'));

const setRange = (r, btn) => {
  chartRange = r;
  ['range-1h', 'range-6h', 'range-24h', 'range-all'].forEach(id => $(id).classList.remove('active'));
  btn.classList.add('active');
  if (currentSnap) renderChart(currentSnap);
};
$('range-1h').onclick = () => setRange('1h', $('range-1h'));
$('range-6h').onclick = () => setRange('6h', $('range-6h'));
$('range-24h').onclick = () => setRange('24h', $('range-24h'));
$('range-all').onclick = () => setRange('all', $('range-all'));

$('holdings-q').oninput = () => { if (currentSnap) renderHoldings(currentSnap); };
$('completed-q').oninput = () => { if (currentSnap) renderCompleted(currentSnap); };
$('modal-close').onclick = () => $('trace-modal').close();

prevSnap = loadJson(PREV_KEY, null);
renderAll(loadJson(CACHE_KEY, null) || emptySnapshot(), 'WAITING');
connectStream();
