/* Barnacle Live Run #001 — Read-Only Live Portfolio Monitor */
const RELAY_URL = 'https://barnacle-live-relay.gravitysedge.workers.dev';
const CACHE_KEY = 'barnacle_live_snapshot_v2';
const PREV_KEY = 'barnacle_live_prev_snap_v1';
const HIST_KEY = 'barnacle_eq_hist_v1';
const COMPLETED_PAGE_SIZE = 50;
const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

let currentSnap = null;
let prevSnap = null;
let memoryHist = null;
let lastPersistedTs = 0;
let lastScoreboardEventId = null;

let chartUnit = 'pct';   // 'pct' | 'usd' | 'pnl'
let chartRange = 'all';  // '1h' | '6h' | '24h' | 'all'
const showLines = {};
let chartInstance = null;
let chartResizeObserver = null;
let chartZoomState = null; // { startValue, endValue } preserved across live updates
let lastChartSeries = [];

let holdingsAcct = '';
let completedAcct = '';
let completedPage = 0;
const sectionOpenOverrides = {}; // key: `${account_id}:${sec}` -> boolean
let lastPollOk = false;
let es = null;
let retryMs = 2000;
let sseRetryTimer = null;
let pollInFlight = false;

const ACCOUNT_COLORS = {
  'ares-005-25': '#34d399',
  'apollo-002-25': '#38bdf8',
  'apollo-002-100': '#60a5fa',
  'apollo-002-1000': '#22d3ee',
  'athena-003-25': '#a78bfa',
  'athena-003-100': '#c084fc',
  'athena-003-1000': '#e879f9',
  'hermes-004-25': '#2dd4bf',
  'hermes-004-100': '#14b8a6',
  'hermes-004-1000': '#0d9488',
  'hermes-clean-25': '#84cc16',
  'hermes-clean-100': '#22c55e',
  'hermes-clean-1000': '#16a34a',
  'hestia-008-25': '#f472b6',
  'hestia-008-100': '#ec4899',
  'hestia-008-1000': '#db2777',
  'poseidon-006-25': '#f59e0b',
  'poseidon-006-100': '#fb923c',
  'poseidon-006-1000': '#f87171',
};
const FALLBACK_COLORS = ['#38bdf8', '#a78bfa', '#f59e0b', '#f472b6', '#2dd4bf', '#fb7185'];

const $ = (id) => document.getElementById(id);

function accountGroupOf(a) {
  if (a.group) return a.group;
  if (a.kind === 'REAL' || String(a.account_id || '').startsWith('ares-')) return 'live';
  if (String(a.account_id || '').startsWith('hestia-')) return 'clean_slate_hestia';
  if (String(a.account_id || '').startsWith('hermes-clean-')) return 'clean_slate_hermes';
  if (String(a.account_id || '').startsWith('hermes-')) return 'successor_query_discovery';
  if (String(a.account_id || '').startsWith('athena-')) return 'expanded_financial_validation';
  if (String(a.account_id || '').startsWith('apollo-')) return 'original_validation';
  return 'previous_shadow';
}

function shortLabelOf(a) {
  return (a.label || a.account_id || '').replace(' (Control)', '');
}

function fmtBankrollShort(initCents) {
  const usd = Math.round(Number(initCents || 0) / 100);
  return usd >= 1000 ? '$1k' : `$${usd}`;
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
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

function getMemoryHist() {
  if (!memoryHist) memoryHist = loadJson(HIST_KEY, {});
  return memoryHist;
}

function persistStateIfDue(force = false) {
  const now = Date.now();
  if (!force && now - lastPersistedTs < 60000) return;
  lastPersistedTs = now;
  if (currentSnap) saveJson(CACHE_KEY, currentSnap);
  if (prevSnap) saveJson(PREV_KEY, prevSnap);
  if (memoryHist) saveJson(HIST_KEY, memoryHist);
}

function recordEquityObservation(snap) {
  if (!snap || !snap.published_ts) return;
  const ts = Number(snap.published_ts);
  const accts = snap.three_accounts?.accounts || [];
  if (!accts.length) return;
  const hist = getMemoryHist();
  accts.forEach(a => {
    const aid = a.account_id;
    const arr = Array.isArray(hist[aid]) ? hist[aid] : [];
    const last = arr[arr.length - 1];
    if (!last || (ts > Number(last.ts) + 15)) {
      arr.push({
        ts,
        equity_cents: Number(a.equity_cents ?? a.initial_cents ?? 0),
      });
      if (arr.length > 250) arr.splice(0, arr.length - 250);
      hist[aid] = arr;
    }
  });
}

function acceptSnapshot(snap) {
  if (!snap || !snap.published_at_utc) return false;
  const isNewEvent = !currentSnap || !currentSnap.event_id || Number(snap.event_id) !== Number(currentSnap.event_id);
  if (isNewEvent && currentSnap) {
    prevSnap = currentSnap;
  }
  currentSnap = snap;
  if (isNewEvent) {
    recordEquityObservation(snap);
    persistStateIfDue(false);
  }
  return isNewEvent;
}

function emptySnapshot() {
  return {
    published_at_utc: null,
    publish_delay_s: 60,
    barnacle_status: 'PAUSED',
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
  if (effState === 'ONLINE') { connPill.textContent = '● SYSTEM ONLINE'; connPill.className = 'pill ok'; }
  else if (effState === 'STALE') { connPill.textContent = '● SYSTEM STALE'; connPill.className = 'pill warn'; }
  else { connPill.textContent = '● SYSTEM OFFLINE'; connPill.className = 'pill bad'; }

  const accts = snap?.three_accounts?.accounts || [];
  const paperAccts = accts.filter(a => accountGroupOf(a) !== 'live');
  const paperRunning = paperAccts.some(a => String(a.runtime_status || 'ACTIVE').toUpperCase().includes('ACTIVE'));
  const paperPill = $('paper-pill');
  if (paperPill) {
    if (!paperAccts.length) {
      paperPill.textContent = 'PAPER EXPERIMENTS: –';
      paperPill.className = 'pill warn';
    } else if (paperRunning) {
      paperPill.textContent = 'PAPER EXPERIMENTS RUNNING';
      paperPill.className = 'pill ok';
    } else {
      paperPill.textContent = 'PAPER EXPERIMENTS PAUSED';
      paperPill.className = 'pill warn';
    }
  }

  const realAcct = accts.find(a => accountGroupOf(a) === 'live');
  const realActive = snap.barnacle_status === 'ACTIVE' || String(realAcct?.runtime_status || '').toUpperCase() === 'ACTIVE';
  const armedPill = $('armed-pill');
  if (effState !== 'ONLINE' && !pubTs) {
    armedPill.textContent = 'REAL CASH: UNVERIFIED';
    armedPill.className = 'pill warn';
  } else if (realActive) {
    armedPill.textContent = 'REAL CASH ACTIVE';
    armedPill.className = 'pill ok';
  } else {
    armedPill.textContent = 'REAL CASH PAUSED';
    armedPill.className = 'pill warn';
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
  if (banner) {
    if (effState !== 'ONLINE') {
      banner.style.display = 'block';
      banner.className = effState === 'OFFLINE' ? 'banner bad' : 'banner warn';
      banner.textContent = `${effState} DATA — Feed is ${feedAgeS != null ? feedAgeS + 's' : 'unknown'} old (last published ${fmtEt(pubTs)}).`;
    } else {
      banner.style.display = 'none';
    }
  }
}

function renderAccountDetailsBody(type, items) {
  const renderEntryLvls = (h) => (h.entry_levels || []).map(l => {
    const tsStr = (l.timestamps || []).map(t => fmtEt(t)).join(', ');
    const costStr = l.total_cost_usd != null ? ` · ${fmtUsd(l.total_cost_usd)}` : '';
    return `<span class="depth-chip" title="${tsStr}">${l.qty}x @ ${l.price_cents}¢${costStr}${tsStr ? ' (' + tsStr + ')' : ''}</span>`;
  }).join('');

  if (type === 'active') {
    if (!items.length) return '<div class="muted" style="font-size:11px;margin-top:4px">No active open positions.</div>';
    return items.map(h => {
      const entryLvls = renderEntryLvls(h);
      const sellLvls = (h.sell_levels || []).length
        ? h.sell_levels.map(l => `<span class="depth-chip">${l.price_cents}¢: ${l.available_qty} avail (sell ${l.sell_qty})</span>`).join('')
        : '<span class="muted">UNAVAILABLE</span>';
      const bestBidTxt = h.best_bid_cents != null ? `${h.best_bid_cents}¢` : 'UNAVAILABLE';
      const estSellTxt = h.estimated_net_sell_usd != null ? fmtUsd(h.estimated_net_sell_usd) : 'UNAVAILABLE';
      const sellPnlTxt = h.sell_pnl_usd != null ? fmtSignedUsd(h.sell_pnl_usd) : 'UNAVAILABLE';
      const sellPnlCls = h.sell_pnl_usd == null ? '' : (h.sell_pnl_usd >= 0 ? 'pos' : 'neg');
      const liqWarn = h.partial_liquidity ? ` (Partial: ${h.fillable_qty}/${h.contracts})` : '';
      const bookFresh = h.book_ts ? `${fmtEt(h.book_ts)} (${h.book_source || 'Exchange Order Book'})` : 'UNAVAILABLE';
      const sizingRow = h.alloc_pct != null
        ? `<span class="k">Position Sizing</span><span class="v">Allocation: ${h.alloc_pct}% | Confidence: ${h.confidence_status || 'n/a'} | Mode: ${h.allocation_mode || 'n/a'}${h.limiting_factor ? ' | Limit: ' + h.limiting_factor : ''}</span>`
        : '';
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
          <span class="k">Pre-Fee Avg / Break-Even (Fee-Incl)</span><span class="v">${h.entry_price_cents}¢ / ${h.fee_inclusive_avg_cents ?? h.entry_price_cents}¢</span>
          <span class="k">Cost + Fees = Cost Basis</span><span class="v">${fmtUsd(h.purchase_cost_usd)} + ${fmtUsd(h.fee_usd)} = ${fmtUsd(h.cost_basis_usd ?? h.invested_usd)}</span>
          <span class="k">Best Selling Bid</span><span class="v">${bestBidTxt}</span>
          <span class="k">Book Freshness</span><span class="v">${bookFresh}</span>
          <span class="k">Est. Net Liquidation${liqWarn}</span><span class="v">${estSellTxt}</span>
          <span class="k">Executable P&amp;L (Sell Now)</span><span class="v ${sellPnlCls}">${sellPnlTxt}</span>
          <span class="k">Max Settlement / Rem. Profit</span><span class="v">${fmtUsd(h.max_payout_usd)} / ${fmtSignedUsd(h.remaining_profit_usd)}</span>
          ${sizingRow}
        </div>
        <div><span class="muted">Bid Depth:</span><div class="depth-list">${sellLvls}</div></div>
      </div>`;
    }).join('');
  }

  if (type === 'awaiting') {
    if (!items.length) return '<div class="muted" style="font-size:11px;margin-top:4px">No positions awaiting settlement.</div>';
    return items.map(h => {
      const entryLvls = renderEntryLvls(h);
      return `
      <div class="pos-item">
        <div class="pos-item-head">
          <span class="mono">${h.ticker}</span>
          <span class="tag legacy">PENDING SETTLEMENT · ${h.side} · ${h.contracts}x</span>
        </div>
        <div class="muted">${h.marketplace || 'Kalshi'} · Series: <span class="mono">${h.series_ticker || '–'}</span> · Event: <span class="mono">${h.event_ticker || '–'}</span></div>
        <div class="pos-kv">
          <span class="k">Purchased (ET)</span><span class="v">${fmtEt(h.opened_ts)}</span>
          <span class="k">Trading Closed (ET)</span><span class="v">${fmtEt(h.close_ts)}</span>
          <span class="k">Entry Fills</span><span class="v">${entryLvls || '–'}</span>
          <span class="k">Cost Basis (Invested)</span><span class="v">${fmtUsd(h.cost_basis_usd ?? h.invested_usd)}</span>
          <span class="k">Executable Resale</span><span class="v muted">CLOSED (AWAITING SETTLEMENT)</span>
          <span class="k">Status</span><span class="v">PENDING OUTCOME</span>
        </div>
      </div>`;
    }).join('');
  }

  if (!items.length) return '<div class="muted" style="font-size:11px;margin-top:4px">No completed positions yet.</div>';
  return items.slice(0, 60).map(t => {
    const net = Number(t.realized_net_usd ?? t.net_pnl_usd ?? 0);
    const proceeds = t.proceeds_usd != null ? fmtUsd(t.proceeds_usd) : (t.result === 'WIN' ? fmtUsd(Number(t.contracts || 0)) : '$0.00');
    const resBadge = t.result === 'WIN' ? 'win' : t.result === 'SOLD' ? 'paper' : 'loss';
    return `
    <div class="pos-item">
      <div class="pos-item-head">
        <span class="mono">${t.ticker}</span>
        <span class="tag ${resBadge}">${t.result || t.status || 'SETTLED'} · ${t.side} · ${t.contracts}x</span>
      </div>
      <div class="pos-kv">
        <span class="k">Entry Cost / Fees</span><span class="v">${fmtUsd(t.invested_usd)} / ${fmtUsd(t.fee_usd || 0)}</span>
        <span class="k">${t.result === 'SOLD' ? 'Sale Proceeds' : 'Settlement Payout'}</span><span class="v">${proceeds}</span>
        <span class="k">Realized Net P&amp;L</span><span class="v ${net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(net)}</span>
        <span class="k">Completed (ET)</span><span class="v">${fmtEt(t.closed_ts || t.ts)}</span>
      </div>
    </div>`;
  }).join('');
}

function renderScoreboard(snap, force = false) {
  const grid = $('scoreboard-grid');
  if (!grid) return;
  const evId = snap?.event_id ?? null;
  if (!force && evId != null && evId === lastScoreboardEventId && grid.children.length > 0) {
    return;
  }
  lastScoreboardEventId = evId;

  const accts = snap?.three_accounts?.accounts || [];
  const holdings = snap?.holdings || [];
  const completedAll = snap?.completed_trades || [];
  const prevMap = {};
  (prevSnap?.three_accounts?.accounts || []).forEach(pa => { prevMap[pa.account_id] = pa; });

  if (!accts.length) {
    grid.innerHTML = '<div class="acct-card"><div class="muted">Waiting for account data…</div></div>';
    return;
  }

  const nowSec = Date.now() / 1000;
  const secDataMap = {};

  const renderCard = (a) => {
    const grp = accountGroupOf(a);
    const isReal = grp === 'live';
    const isVal = grp === 'original_validation';
    const isFin = grp === 'expanded_financial_validation';
    const isSucc = grp === 'successor_query_discovery' || grp === 'clean_slate_hermes' || grp === 'clean_slate_hestia';
    const initC = Number(a.initial_cents || 0);
    const eqC = Number(a.equity_cents ?? initC);
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

    const acctHoldings = holdings.filter(h => h.account_id === a.account_id);
    const activeHoldings = acctHoldings.filter(h => !h.trading_closed && (!h.close_ts || Number(h.close_ts) > nowSec));
    const awaitingHoldings = acctHoldings.filter(h => h.trading_closed || (h.close_ts && Number(h.close_ts) <= nowSec));
    const acctCompleted = completedAll.filter(t => t.account_id === a.account_id);

    secDataMap[`${a.account_id}:active`] = { type: 'active', items: activeHoldings };
    secDataMap[`${a.account_id}:awaiting`] = { type: 'awaiting', items: awaitingHoldings };
    secDataMap[`${a.account_id}:completed`] = { type: 'completed', items: acctCompleted };

    const realizedC = Number(a.realized_net_cents ?? 0);
    const realCls = realizedC > 0 ? 'pos' : realizedC < 0 ? 'neg' : '';
    const realRetPct = initC > 0 ? (realizedC / initC) * 100 : 0;
    const potAllWinC = Number(a.potential_total_all_win_cents ?? ((a.available_cents || 0) + (contractsHeld * 100)));
    const maxRemPayoutC = Number(a.max_remaining_payout_cents ?? (contractsHeld * 100));
    const actCount = a.active_open_positions ?? activeHoldings.length;
    const setCount = a.settling_positions ?? awaitingHoldings.length;
    const titleLabel = isReal ? `${a.label} — REAL MONEY` : `${shortLabelOf(a)} — SIMULATED`;
    const cardCls = isReal ? 'real-card' : (isVal || isSucc) ? 'validation-card' : isFin ? 'fin-card' : 'paper-card';
    const badgeHtml = isReal
      ? `<span class="tag real">REAL MONEY · ${a.runtime_status || 'PAUSED'}</span>`
      : `<span class="tag ${isVal || isSucc ? 'validation' : 'paper'}">${a.codename || 'PAPER'} · SIMULATED (${a.runtime_status || 'ACTIVE'})</span>`;

    const actOpen = Boolean(sectionOpenOverrides[`${a.account_id}:active`]);
    const awtOpen = Boolean(sectionOpenOverrides[`${a.account_id}:awaiting`]);
    const cmpOpen = Boolean(sectionOpenOverrides[`${a.account_id}:completed`]);

    return `
    <article class="acct-card ${cardCls}">
      <div class="acct-head">
        <span class="acct-title">${titleLabel}</span>
        ${badgeHtml}
      </div>
      <div class="muted" style="font-size:11px;display:flex;flex-wrap:wrap;gap:6px">
        <span>Codename: <b class="mono">${a.codename || '–'}</b></span>
        <span>· Mode: <b>${isReal ? 'REAL MONEY' : 'PAPER SIM'}</b></span>
        <span>· Status: <b>${a.runtime_status || 'ACTIVE'}</b></span>
      </div>
      <div class="eq-row">
        <div>
          <div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.04em">Current Account Equity</div>
          <span class="eq-val mono">${fmtUsd(eqC / 100)}</span>
          ${deltaHtml}
        </div>
        <div class="potential-box" title="Hypothetical maximum if all ${contractsHeld} open contracts win ($1.00/contract) — NOT guaranteed">
          <div class="potential-lbl">POTENTIAL TOTAL — ALL WIN</div>
          <div class="potential-val mono">${fmtUsd(potAllWinC / 100)}</div>
        </div>
      </div>
      <div class="net-row ${realCls}">
        <span>Realized P&amp;L (Settled): <b>${fmtSignedUsd(realizedC / 100)}</b></span>
        <span class="mono">${fmtSignedPct(realRetPct)}</span>
      </div>
      <div class="muted" style="font-size:11px;display:flex;justify-content:space-between;gap:6px">
        <span>Est. Unrealized (Resale):</span>
        <span class="mono unreal-neutral">${unrealTxt}</span>
      </div>
      <div class="stat-badges-4">
        <div class="stat-mini"><div class="lbl">Open</div><div class="val mono">${actCount}</div></div>
        <div class="stat-mini"><div class="lbl">Settling</div><div class="val mono">${setCount}</div></div>
        <div class="stat-mini"><div class="lbl">Settled W</div><div class="val mono pos">${a.wins ?? 0}</div></div>
        <div class="stat-mini"><div class="lbl">Settled L</div><div class="val mono neg">${a.losses ?? 0}</div></div>
      </div>
      <div class="acct-rows">
        <span class="k">Starting Bankroll</span><span class="v">${fmtUsd(initC / 100)}</span>
        <span class="k">Available Cash</span><span class="v">${fmtUsd((a.available_cents || 0) / 100)}</span>
        ${Number(a.withdrawn_to_savings_cents || 0) > 0 ? `<a class="k" href="#hermes-savings-panel" onclick="document.getElementById('hermes-savings-panel')?.scrollIntoView({behavior:'smooth'});return false;" style="color:#38bdf8;text-decoration:none">Savings Withdrawn</a><span class="v mono">-${fmtUsd(a.withdrawn_to_savings_cents / 100)}</span>` : ''}
        <span class="k">Capital Invested (Cost Basis)</span><span class="v">${fmtUsd((a.invested_cents || 0) / 100)}</span>
        <span class="k">Max Remaining Payout (${contractsHeld}x)</span><span class="v">${fmtUsd(maxRemPayoutC / 100)}</span>
        <span class="k">Est. Resale / Liquidation</span><span class="v">${posValTxt} / ${sellTxt}</span>
        <span class="k">Fees Paid</span><span class="v">${fmtUsd((a.fees_cents || 0) / 100)}</span>
      </div>
      <details class="pos-details" data-sec="${a.account_id}:active" ${actOpen ? 'open' : ''}>
        <summary><span>1. Active Positions (${activeHoldings.length})</span><span class="sec-lbl">${actOpen ? '▾ Collapse' : '▸ Expand'}</span></summary>
        <div class="sec-body">${actOpen ? renderAccountDetailsBody('active', activeHoldings) : ''}</div>
      </details>
      <details class="pos-details" data-sec="${a.account_id}:awaiting" ${awtOpen ? 'open' : ''}>
        <summary><span>2. Awaiting Settlement (${awaitingHoldings.length})</span><span class="sec-lbl">${awtOpen ? '▾ Collapse' : '▸ Expand'}</span></summary>
        <div class="sec-body">${awtOpen ? renderAccountDetailsBody('awaiting', awaitingHoldings) : ''}</div>
      </details>
      <details class="pos-details" data-sec="${a.account_id}:completed" ${cmpOpen ? 'open' : ''}>
        <summary><span>3. Completed Positions (${acctCompleted.length})</span><span class="sec-lbl">${cmpOpen ? '▾ Collapse' : '▸ Expand'}</span></summary>
        <div class="sec-body">${cmpOpen ? renderAccountDetailsBody('completed', acctCompleted) : ''}</div>
      </details>
    </article>`;
  };

  const activeAccts = accts.filter(a => !a.archived);
  const archivedAccts = accts.filter(a => Boolean(a.archived));

  const activeGroups = [
    {
      key: 'clean_slate_hestia',
      title: 'HESTIA-008 · ADAPTIVE POSITION SIZING — NOT CONTINUOUS LEARNING',
      sub: 'Adjusts position size (up to 50% ceiling) using static kalshi-calibration-model.json probability estimates, validation rules, and L2 depth. Does not consume CMOS retraining.',
      items: activeAccts.filter(a => accountGroupOf(a) === 'clean_slate_hestia'),
    },
    {
      key: 'clean_slate_hermes',
      title: 'HERMES-008B · FIXED 10% BASELINE — NO MODEL TRAINING',
      sub: 'Fixed 10% bankroll sizing with static cust_xp_hermes_clean_v1 entry rules. No model training or CMOS dependency.',
      items: activeAccts.filter(a => accountGroupOf(a) === 'clean_slate_hermes'),
    },
    {
      key: 'live',
      title: 'ARES-005 (REAL MONEY · PAUSED)',
      sub: 'Real-money exchange ledger (new orders paused).',
      items: activeAccts.filter(a => accountGroupOf(a) === 'live'),
    },
  ].filter(g => g.items.length > 0);

  const archivedGroups = [
    {
      key: 'successor_query_discovery',
      title: 'HERMES-004 (RETIRED)',
      sub: 'Halted paper run; existing positions settle normally.',
      items: archivedAccts.filter(a => accountGroupOf(a) === 'successor_query_discovery'),
    },
    {
      key: 'original_validation',
      title: 'APOLLO-002 (RETIRED)',
      sub: 'Halted paper run; existing positions settle normally.',
      items: archivedAccts.filter(a => accountGroupOf(a) === 'original_validation'),
    },
    {
      key: 'expanded_financial_validation',
      title: 'ATHENA-003 (RETIRED)',
      sub: 'Halted paper run; existing positions settle normally.',
      items: archivedAccts.filter(a => accountGroupOf(a) === 'expanded_financial_validation'),
    },
    {
      key: 'previous_shadow',
      title: 'POSEIDON-006 (RETIRED · LEGACY)',
      sub: 'Halted legacy WS paper run; existing positions settle normally.',
      items: archivedAccts.filter(a => accountGroupOf(a) === 'previous_shadow'),
    },
  ].filter(g => g.items.length > 0);

  const renderGroupHtml = (groupsList) => groupsList.map(g => `
    <div class="group-section">
      <div class="group-head">
        <div>
          <h2 class="group-title">${g.title}</h2>
          <div class="muted" style="font-size:12px">${g.sub}</div>
        </div>
      </div>
      <div class="scoreboard-grid">${g.items.map(renderCard).join('')}</div>
    </div>`).join('');

  const bindDetails = (container) => {
    if (!container) return;
    container.querySelectorAll('details.pos-details').forEach(det => {
      const key = det.dataset.sec;
      const lbl = det.querySelector('.sec-lbl');
      const body = det.querySelector('.sec-body');
      det.addEventListener('toggle', () => {
        sectionOpenOverrides[key] = det.open;
        if (lbl) lbl.textContent = det.open ? '▾ Collapse' : '▸ Expand';
        if (det.open && body && !body.innerHTML && secDataMap[key]) {
          body.innerHTML = renderAccountDetailsBody(secDataMap[key].type, secDataMap[key].items);
        }
      });
    });
  };

  grid.innerHTML = renderGroupHtml(activeGroups);
  bindDetails(grid);

  const archPanel = $('archived-panel');
  const archDet = $('archived-panel-details');
  const archGrid = $('archived-grid');
  const archBadge = $('archived-count-badge');
  if (archPanel && archGrid && archBadge) {
    if (!archivedGroups.length) {
      archPanel.style.display = 'none';
    } else {
      archPanel.style.display = 'block';
      archBadge.textContent = `${archivedAccts.length} accounts`;
      if (archDet && archDet.open) {
        archGrid.innerHTML = renderGroupHtml(archivedGroups);
        bindDetails(archGrid);
      } else {
        archGrid.innerHTML = '';
        if (archDet && !archDet.dataset.wired) {
          archDet.dataset.wired = '1';
          archDet.addEventListener('toggle', () => {
            const lbl = $('archived-toggle-lbl');
            if (lbl) lbl.textContent = archDet.open ? '▾ Collapse' : '▸ Expand';
            if (archDet.open && !archGrid.innerHTML) {
              archGrid.innerHTML = renderGroupHtml(archivedGroups);
              bindDetails(archGrid);
            }
          });
        }
      }
    }
  }
}

let zeusH2HChart = null;

function renderZeusExecutionComparison(snap) {
  const cardsEl = $('zeus-h2h-cards');
  const noteEl = $('zeus-h2h-note');
  const chartEl = $('zeus-h2h-chart');
  if (!cardsEl) return;
  const h2h = snap?.zeus_execution_comparison;
  if (noteEl && h2h?.modeled_note) noteEl.textContent = h2h.modeled_note;

  const t = h2h?.taker || { label: 'ZEUS-TAKER', available_cash_usd: 100, invested_capital_usd: 0, realized_net_pnl_usd: 0, current_equity_usd: 100, wins: 0, losses: 0, open_orders: 0, unfilled_orders: 0, profit_per_executed_contract: 0, missed_opportunities: 0, executed_contracts: 0, fees_usd: 0 };
  const m = h2h?.maker || { label: 'ZEUS-MAKER', available_cash_usd: 100, invested_capital_usd: 0, realized_net_pnl_usd: 0, current_equity_usd: 100, wins: 0, losses: 0, open_orders: 0, unfilled_orders: 0, maker_partial_fill_est_qty: 0, maker_partial_fill_est_orders: 0, profit_per_executed_contract: 0, missed_opportunities: 0, executed_contracts: 0, fees_usd: 0, conservative_maker_fees_usd: 0 };

  const fmtUsd = v => `$${Number(v || 0).toFixed(2)}`;
  const cardHtml = (a, isMaker) => `
    <div class="acct-card ${isMaker ? 'validation-card' : ''}">
      <div class="acct-head">
        <span class="acct-title">${a.label} · $100</span>
        <span class="tag ${isMaker ? 'warn' : 'validation'}">${isMaker ? 'CONSERVATIVE MODELED MAKER' : 'PAPER TAKER (ZEUS)'}</span>
      </div>
      <div class="muted" style="font-size:12px;margin:4px 0 8px">
        ${isMaker ? 'Resting limit orders · queue-modeled fills (not confirmed exchange fills) · no fallback' : 'Authentic 60s grid · 30s latency · cp_f10 risk · hold-to-settlement'}
      </div>
      <div class="acct-metrics" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;font-size:12px">
        <div><span class="muted">Equity:</span> <b class="mono">${fmtUsd(a.current_equity_usd)}</b></div>
        <div><span class="muted">Realized Net:</span> <b class="mono ${a.realized_net_pnl_usd >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(a.realized_net_pnl_usd)}</b></div>
        <div><span class="muted">Available Cash:</span> <b class="mono">${fmtUsd(a.available_cash_usd)}</b></div>
        <div><span class="muted">Invested:</span> <b class="mono">${fmtUsd(a.invested_capital_usd)}</b></div>
        <div><span class="muted">Settled W / L:</span> <b class="mono">${a.wins}W / ${a.losses}L</b></div>
        <div><span class="muted">Open / Unfilled:</span> <b class="mono">${a.open_orders} / ${a.unfilled_orders}</b></div>
        <div><span class="muted">Profit / Contract:</span> <b class="mono">${fmtSignedUsd(a.profit_per_executed_contract)}</b></div>
        <div><span class="muted">Missed Opps:</span> <b class="mono">${a.missed_opportunities}</b></div>
        <div><span class="muted">Executed Qty:</span> <b class="mono">${a.executed_contracts}</b></div>
        <div><span class="muted">${isMaker ? 'Est. Partial Fills:' : 'Fees:'}</span> <b class="mono">${isMaker ? `${a.maker_partial_fill_est_qty} cts (${a.maker_partial_fill_est_orders})` : fmtUsd(a.fees_usd)}</b></div>
      </div>
    </div>`;

  cardsEl.innerHTML = cardHtml(t, false) + cardHtml(m, true);

  if (chartEl && typeof echarts !== 'undefined') {
    if (!zeusH2HChart) zeusH2HChart = echarts.init(chartEl);
    const tPts = (h2h?.series?.['ZEUS-TAKER'] || []).map(p => [p.ts * 1000, p.equity_usd]);
    const mPts = (h2h?.series?.['ZEUS-MAKER'] || []).map(p => [p.ts * 1000, p.equity_usd]);
    zeusH2HChart.setOption({
      backgroundColor: 'transparent',
      tooltip: { trigger: 'axis' },
      legend: { data: ['ZEUS-TAKER ($)', 'ZEUS-MAKER (modeled $)'], textStyle: { color: '#94a3b8' } },
      grid: { left: 52, right: 20, top: 32, bottom: 28 },
      xAxis: { type: 'time', axisLabel: { color: '#94a3b8' } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: '#94a3b8', formatter: v => `$${Number(v).toFixed(2)}` }, splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } } },
      series: [
        { name: 'ZEUS-TAKER ($)', type: 'line', showSymbol: tPts.length <= 2, data: tPts, smooth: false, lineStyle: { width: 2, color: '#38bdf8' }, itemStyle: { color: '#38bdf8' } },
        { name: 'ZEUS-MAKER (modeled $)', type: 'line', showSymbol: mPts.length <= 2, data: mPts, smooth: false, lineStyle: { width: 2, type: 'dashed', color: '#f59e0b' }, itemStyle: { color: '#f59e0b' } },
      ],
    }, true);
  }
}

function renderWalkForwardResearch(snap) {
  const panel = $('wf-research-panel');
  const body = $('wf-research-body');
  if (!panel || !body) return;
  const wf = snap?.walk_forward_research;
  if (!wf || (!wf.KXBTCD && !wf.KXBTC)) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const cards = ['KXBTCD', 'KXBTC'].filter(k => wf[k]).map(ser => {
    const d = wf[ser];
    const oos = d.oos_weeks_2_to_5 || {};
    const rows = (d.weekly || []).map(w => {
      const b = w.baseline || {};
      const l = w.learned;
      const lHtml = l
        ? `<span class="${l.realized_pnl >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(l.realized_pnl)}</span> (${l.wins}W/${l.losses}L, DD $${Number(l.max_drawdown || 0).toFixed(2)})`
        : '<span class="muted">Train V1</span>';
      return `<tr>
        <td>${w.label}</td>
        <td class="mono">${w.checkpoint_created || w.mode}</td>
        <td class="mono"><span class="${b.realized_pnl >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(b.realized_pnl)}</span> (${b.wins}W/${b.losses}L)</td>
        <td class="mono">${lHtml}</td>
      </tr>`;
    }).join('');
    return `
      <div class="acct-card validation-card" style="margin-bottom:10px">
        <div class="acct-head">
          <span class="acct-title">${ser} · Dec 2025 Walk-Forward ($100 Start)</span>
          <span class="tag validation">OOS Weeks 2–5: Learned ${fmtSignedUsd(oos.learned_net_pnl)} vs Base ${fmtSignedUsd(oos.baseline_net_pnl)}</span>
        </div>
        <div class="table-wrap" style="margin-top:8px">
          <table>
            <thead><tr><th>Week</th><th>Checkpoint / Mode</th><th>Unchanged Baseline</th><th>Learned Walk-Forward</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
  body.innerHTML = `<div class="scoreboard-grid">${cards}</div>`;
}

function buildChartSpecs(accounts) {
  return accounts.map((a, idx) => {
    const aid = a.account_id;
    if (!(aid in showLines)) showLines[aid] = !Boolean(a.archived);
    const isReal = accountGroupOf(a) === 'live';
    return {
      key: aid,
      codename: a.codename || shortLabelOf(a),
      bankrollShort: fmtBankrollShort(a.initial_cents),
      label: `${a.codename || shortLabelOf(a)} · ${fmtBankrollShort(a.initial_cents)}`,
      shortLabel: shortLabelOf(a),
      isReal,
      color: ACCOUNT_COLORS[aid] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
      init: Number(a.initial_cents || 2500),
    };
  });
}

function renderSeriesToggles(specs) {
  const toggleBox = $('line-toggles');
  if (!toggleBox) return;
  const byCodename = [];
  const seen = {};
  specs.forEach(sp => {
    if (!seen[sp.codename]) {
      seen[sp.codename] = { codename: sp.codename, items: [] };
      byCodename.push(seen[sp.codename]);
    }
    seen[sp.codename].items.push(sp);
  });

  const groupsHtml = byCodename.map(g => {
    const chips = g.items.map(sp => `
      <button class="series-chip ${showLines[sp.key] ? 'active' : ''}" data-line="${sp.key}" type="button" title="Toggle ${sp.label}">
        <span class="series-dot" style="background:${sp.color}"></span>
        <span>${sp.bankrollShort}</span>
      </button>`).join('');
    return `<div class="series-group">
      <span class="series-group-lbl" data-group="${g.codename}" title="Toggle all ${g.codename}">${g.codename}</span>
      ${chips}
    </div>`;
  }).join('');

  toggleBox.innerHTML = `
    <div style="display:flex;gap:4px;margin-right:4px">
      <button id="series-all-btn" class="toggle-btn" type="button">All</button>
      <button id="series-none-btn" class="toggle-btn" type="button">None</button>
    </div>
    ${groupsHtml}`;

  toggleBox.querySelectorAll('.series-chip').forEach(btn => {
    btn.onclick = () => {
      const k = btn.dataset.line;
      showLines[k] = !showLines[k];
      if (currentSnap) renderChart(currentSnap, true);
    };
  });
  toggleBox.querySelectorAll('.series-group-lbl').forEach(lbl => {
    lbl.onclick = () => {
      const gName = lbl.dataset.group;
      const items = specs.filter(s => s.codename === gName);
      const anyOff = items.some(s => !showLines[s.key]);
      items.forEach(s => { showLines[s.key] = anyOff; });
      if (currentSnap) renderChart(currentSnap, true);
    };
  });
  const allBtn = $('series-all-btn');
  const noneBtn = $('series-none-btn');
  if (allBtn) allBtn.onclick = () => { specs.forEach(s => { showLines[s.key] = true; }); if (currentSnap) renderChart(currentSnap, true); };
  if (noneBtn) noneBtn.onclick = () => { specs.forEach(s => { showLines[s.key] = false; }); if (currentSnap) renderChart(currentSnap, true); };
}

function ensureChartInstance() {
  const el = $('bankroll-chart');
  if (!el || typeof echarts === 'undefined') return null;
  if (!chartInstance) {
    chartInstance = echarts.init(el, null, { renderer: 'canvas' });
    chartInstance.on('datazoom', () => {
      const opt = chartInstance.getOption();
      const dz = opt?.dataZoom?.[0];
      if (dz && (dz.startValue != null || dz.endValue != null)) {
        chartZoomState = { startValue: dz.startValue, endValue: dz.endValue };
      }
    });
    if (typeof ResizeObserver !== 'undefined' && !chartResizeObserver) {
      chartResizeObserver = new ResizeObserver(() => {
        if (chartInstance) chartInstance.resize();
      });
      chartResizeObserver.observe(el);
    }
  }
  return chartInstance;
}

function renderChart(snap, forceToggleRebuild = false) {
  const el = $('bankroll-chart');
  if (!el) return;
  const seriesMap = snap?.three_accounts?.series || {};
  const accounts = snap?.three_accounts?.accounts || [];
  const specs = buildChartSpecs(accounts);

  if (forceToggleRebuild || !$('line-toggles')?.children.length) {
    renderSeriesToggles(specs);
  } else {
    $('line-toggles')?.querySelectorAll('.series-chip').forEach(btn => {
      btn.classList.toggle('active', Boolean(showLines[btn.dataset.line]));
    });
  }

  if (typeof echarts === 'undefined') {
    el.innerHTML = '<div class="muted" style="padding:24px;text-align:center">Chart library loading…</div>';
    return;
  }

  const chart = ensureChartInstance();
  if (!chart) return;

  const localHist = getMemoryHist();
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = chartRange === '1h' ? nowSec - 3600
    : chartRange === '6h' ? nowSec - 21600
      : chartRange === '24h' ? nowSec - 86400
        : 0;

  const valOf = (eqC, init) => {
    const pnlC = eqC - init;
    if (chartUnit === 'pct') return Number(((pnlC / Math.max(1, init)) * 100).toFixed(4));
    if (chartUnit === 'pnl') return Number((pnlC / 100).toFixed(2));
    return Number((eqC / 100).toFixed(2));
  };

  const active = specs.filter(s => showLines[s.key]);
  const echartsSeries = [];
  const metaByName = {};

  active.forEach(sp => {
    const merged = [...(seriesMap[sp.key] || []), ...(localHist[sp.key] || [])]
      .filter(p => p && p.ts != null)
      .map(p => ({ ts: Number(p.ts), equity_cents: Number(p.equity_cents ?? sp.init) }))
      .sort((a, b) => a.ts - b.ts);

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

    // Preserve genuine gaps in dense series (> 1800s gap between recorded points)
    const data = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0 && pts.length > 6 && (p.ts - pts[i - 1].ts) > 1800) {
        data.push([Math.round((pts[i - 1].ts + p.ts) * 500), null]);
      }
      data.push({
        value: [Math.round(p.ts * 1000), valOf(p.equity_cents, sp.init)],
        eqUsd: p.equity_cents / 100,
        pnlUsd: (p.equity_cents - sp.init) / 100,
        pct: ((p.equity_cents - sp.init) / Math.max(1, sp.init)) * 100,
      });
    }

    metaByName[sp.label] = sp;
    echartsSeries.push({
      name: sp.label,
      type: 'line',
      data,
      smooth: false,
      connectNulls: false,
      sampling: 'lttb',
      showSymbol: pts.length <= 4,
      symbolSize: 6,
      lineStyle: {
        width: sp.isReal ? 2.8 : 1.9,
        type: sp.isReal ? 'solid' : 'dashed',
        color: sp.color,
      },
      itemStyle: { color: sp.color },
      emphasis: { focus: 'series' },
    });
  });

  lastChartSeries = echartsSeries;

  const dzInside = { type: 'inside', xAxisIndex: 0, filterMode: 'none' };
  const dzSlider = {
    type: 'slider',
    xAxisIndex: 0,
    height: 24,
    bottom: 8,
    borderColor: 'rgba(148,163,184,0.22)',
    backgroundColor: 'rgba(5,9,20,0.7)',
    fillerColor: 'rgba(56,189,248,0.16)',
    handleStyle: { color: '#38bdf8', borderColor: '#060a12' },
    textStyle: { color: '#94a3b8', fontSize: 10 },
    filterMode: 'none',
  };
  if (chartZoomState && chartZoomState.startValue != null && chartZoomState.endValue != null) {
    dzInside.startValue = chartZoomState.startValue;
    dzInside.endValue = chartZoomState.endValue;
    dzSlider.startValue = chartZoomState.startValue;
    dzSlider.endValue = chartZoomState.endValue;
  }

  const option = {
    animation: false,
    backgroundColor: 'transparent',
    grid: { left: 62, right: 20, top: 18, bottom: 62 },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      enterable: false,
      axisPointer: {
        type: 'cross',
        lineStyle: { color: 'rgba(56,189,248,0.45)', width: 1, type: 'dashed' },
        crossStyle: { color: 'rgba(148,163,184,0.35)' },
        label: { backgroundColor: '#0f172a', borderColor: '#38bdf8', borderWidth: 1, fontSize: 10 },
      },
      extraCssText: 'z-index:99999;max-height:290px;overflow-y:auto;background:rgba(9,14,28,0.96);border:1px solid rgba(56,189,248,0.38);border-radius:10px;padding:10px 12px;box-shadow:0 14px 36px rgba(0,0,0,0.75);pointer-events:none;',
      formatter: (params) => {
        if (!params || !params.length) return '';
        const tsMs = params[0].axisValue;
        const rows = params
          .filter(p => p.data && p.data.value && p.data.value[1] != null)
          .sort((a, b) => (b.data.pct ?? 0) - (a.data.pct ?? 0))
          .map(p => {
            const d = p.data;
            const pctStr = fmtSignedPct(d.pct);
            const pnlStr = fmtSignedUsd(d.pnlUsd);
            const eqStr = fmtUsd(d.eqUsd);
            return `<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;font-size:11px;line-height:1.45;color:#e2e8f0">
              <span style="display:inline-flex;align-items:center;gap:6px">
                <span style="width:7px;height:7px;border-radius:50%;background:${p.color};display:inline-block"></span>
                <span>${p.seriesName}</span>
              </span>
              <span style="font-family:ui-monospace,monospace;white-space:nowrap">${eqStr} · <b>${pctStr}</b> (${pnlStr})</span>
            </div>`;
          }).join('');
        return `<div style="font-size:11px;color:#38bdf8;font-weight:700;margin-bottom:6px;border-bottom:1px solid rgba(148,163,184,0.2);padding-bottom:4px">${fmtEt(tsMs / 1000)}</div>${rows || '<div class="muted">No observations</div>'}`;
      },
    },
    xAxis: {
      type: 'time',
      boundaryGap: false,
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.25)' } },
      axisLabel: { color: '#94a3b8', fontSize: 10 },
      splitLine: { show: true, lineStyle: { color: 'rgba(148,163,184,0.08)' } },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLine: { show: false },
      axisLabel: {
        color: '#94a3b8',
        fontSize: 10,
        formatter: (v) => chartUnit === 'pct' ? `${v.toFixed(1)}%` : `$${v.toFixed(2)}`,
      },
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.12)' } },
    },
    dataZoom: [dzInside, dzSlider],
    series: echartsSeries,
  };

  chart.setOption(option, { notMerge: true, lazyUpdate: true });
}

function renderAccountFilterTabs(containerId, accts, items, activeAcct, onSelect) {
  const el = $(containerId);
  if (!el) return;
  const counts = {};
  items.forEach(x => { counts[x.account_id] = (counts[x.account_id] || 0) + 1; });
  const btns = [{ account_id: '', label: `All (${items.length})` }].concat(
    accts.map(a => ({ account_id: a.account_id, label: `${shortLabelOf(a)} (${counts[a.account_id] || 0})` }))
  );
  el.innerHTML = btns.map(b => `<button class="tab-btn ${activeAcct === b.account_id ? 'active' : ''}" data-acct="${b.account_id}" type="button">${b.label}</button>`).join('');
  el.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => onSelect(btn.dataset.acct || '');
  });
}

function renderHoldings(snap) {
  const all = snap?.holdings || [];
  const accts = snap?.three_accounts?.accounts || [];
  const totalContracts = all.reduce((s, h) => s + Number(h.contracts || 0), 0);
  const badge = $('holdings-count-badge');
  if (badge) badge.textContent = `${all.length} positions`;
  $('holdings-summary').textContent = `${all.length} Open Positions · ${totalContracts} Contracts Held Across All ${accts.length} Accounts`;

  const det = $('holdings-panel-details');
  if (det && !det.open) return; // Skip heavy DOM table render while collapsed

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
  const badge = $('completed-count-badge');
  if (badge) badge.textContent = `${all.length} transactions`;

  const det = $('completed-panel-details');
  if (det && !det.open) return; // Skip heavy DOM table render while collapsed

  $('completed-summary').innerHTML = accts.map(a => {
    const w = Number(a.wins || 0);
    const l = Number(a.losses || 0);
    const tot = w + l;
    const wr = tot > 0 ? `${((w / tot) * 100).toFixed(1)}%` : '–';
    const net = Number(a.realized_net_cents || 0) / 100;
    const isReal = a.kind === 'REAL' || a.account_id === 'live_25';
    return `<div class="cum-box">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <b>${shortLabelOf(a)}</b>
        <span class="tag ${isReal ? 'real' : 'paper'}">${isReal ? 'REAL' : 'PAPER'}</span>
      </div>
      <div class="mono" style="margin-top:4px">${w}W / ${l}L (${wr}) · <span class="${net >= 0 ? 'pos' : 'neg'}">${fmtSignedUsd(net)}</span></div>
    </div>`;
  }).join('');

  renderAccountFilterTabs('completed-tabs', accts, all, completedAcct, (aid) => {
    completedAcct = aid;
    completedPage = 0;
    if (currentSnap) renderCompleted(currentSnap);
  });

  const q = ($('completed-q')?.value || '').trim().toLowerCase();
  const rows = all.filter(t => {
    const matchA = !completedAcct || t.account_id === completedAcct;
    const matchQ = !q || (t.ticker || '').toLowerCase().includes(q) || (t.event_title || '').toLowerCase().includes(q);
    return matchA && matchQ;
  });

  const body = $('completed-body');
  const pager = $('completed-pager');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="muted">No completed trades match the current filter.</td></tr>';
    if (pager) pager.innerHTML = '';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / COMPLETED_PAGE_SIZE));
  if (completedPage >= totalPages) completedPage = totalPages - 1;
  const start = completedPage * COMPLETED_PAGE_SIZE;
  const pageRows = rows.slice(start, start + COMPLETED_PAGE_SIZE);

  body.innerHTML = pageRows.map(t => {
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
      const item = pageRows.find(x => x.id === tr.dataset.cid);
      if (item) openModal(item);
    };
  });

  if (pager) {
    pager.innerHTML = `
      <span>Showing ${start + 1}–${Math.min(start + pageRows.length, rows.length)} of ${rows.length}</span>
      <div style="display:flex;gap:6px">
        <button id="cmp-prev" class="toggle-btn" type="button" ${completedPage <= 0 ? 'disabled' : ''}>← Prev</button>
        <span class="mono" style="padding:4px 8px">Page ${completedPage + 1} / ${totalPages}</span>
        <button id="cmp-next" class="toggle-btn" type="button" ${completedPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
      </div>`;
    const prevBtn = $('cmp-prev');
    const nextBtn = $('cmp-next');
    if (prevBtn) prevBtn.onclick = () => { if (completedPage > 0) { completedPage--; renderCompleted(currentSnap); } };
    if (nextBtn) nextBtn.onclick = () => { if (completedPage < totalPages - 1) { completedPage++; renderCompleted(currentSnap); } };
  }
}

let cmosLogPage = 0;
const CMOS_LOG_PAGE_SIZE = 25;

function initNavTabs() {
  const bPort = $('nav-tab-portfolio');
  const bCmos = $('nav-tab-cmos-sync');
  const bTrain = $('nav-tab-training-cmos');
  const vPort = $('view-portfolio');
  const vCmos = $('view-cmos-sync');
  const vTrain = $('view-training-cmos');
  if (!bPort || !bCmos || !vPort || !vCmos) return;
  const setTab = (tab) => {
    vPort.style.display = tab === 'portfolio' ? 'block' : 'none';
    vCmos.style.display = tab === 'cmos-sync' ? 'block' : 'none';
    if (vTrain) vTrain.style.display = tab === 'training-cmos' ? 'block' : 'none';
    bPort.classList.toggle('active', tab === 'portfolio');
    bCmos.classList.toggle('active', tab === 'cmos-sync');
    if (bTrain) bTrain.classList.toggle('active', tab === 'training-cmos');
    if (tab === 'cmos-sync' && currentSnap) renderCmosSync(currentSnap);
    if (tab === 'training-cmos' && currentSnap) renderTrainingCmos(currentSnap);
  };
  bPort.onclick = () => { location.hash = ''; setTab('portfolio'); };
  bCmos.onclick = () => { location.hash = '#cmos-sync'; setTab('cmos-sync'); };
  if (bTrain) bTrain.onclick = () => { location.hash = '#training-cmos'; setTab('training-cmos'); };
  if (location.hash === '#cmos-sync') setTab('cmos-sync');
  else if (location.hash === '#training-cmos') setTab('training-cmos');
}

function renderCmosSync(snap) {
  const pill = $('cmos-sync-status-pill');
  const mPill = $('cmos-sync-month-pill');
  const opPill = $('cmos-sync-op-pill');
  const reasonEl = $('cmos-sync-reason');
  const kpisEl = $('cmos-sync-kpis');
  const tlEl = $('cmos-sync-timeline');
  const mBody = $('cmos-months-body');
  const fBody = $('cmos-families-body');
  const cpBox = $('cmos-checkpoints-box');
  const eBody = $('cmos-events-body');
  const ePager = $('cmos-events-pager');
  const logCnt = $('cmos-log-count');
  if (!kpisEl) return;

  const cs = snap?.cmos_sync;
  if (!cs || !cs.available) {
    if (pill) { pill.className = 'pill warn'; pill.textContent = 'PAUSED'; }
    if (reasonEl) reasonEl.textContent = cs?.status_reason || 'CMOS sync worker not initialized yet.';
    kpisEl.innerHTML = '';
    return;
  }

  const nowSec = Date.now() / 1000;
  const hbAge = cs.heartbeat_ts != null ? Math.max(0, Math.round(nowSec - cs.heartbeat_ts)) : cs.heartbeat_age_s;
  let status = cs.status || 'PAUSED';
  let reason = cs.status_reason || '';
  if ((status === 'ACTIVE' || status === 'WAITING') && hbAge != null && hbAge > 35) {
    status = 'STALLED';
    reason = `Heartbeat stale (${hbAge}s > 35s); last op: ${cs.operation}`;
  }

  const pillCls = status === 'ACTIVE' || status === 'COMPLETED' ? 'ok' : (status === 'FAILED' || status === 'STALLED' ? 'bad' : 'warn');
  if (pill) { pill.className = `pill ${pillCls}`; pill.textContent = status; }
  if (mPill) mPill.textContent = `MONTH: ${cs.current_month || '–'}`;
  if (opPill) opPill.textContent = `OP: ${String(cs.operation || '–').toUpperCase()}`;
  if (reasonEl) reasonEl.textContent = `${reason} · Heartbeat: ${hbAge != null ? hbAge + 's ago' : '–'} · Last OK: ${cs.last_success_op || '–'}`;

  const curPctText = cs.workload_discovered
    ? (cs.current_month_pct != null ? `${Number(cs.current_month_pct).toFixed(1)}%` : '0.0%')
    : 'DISCOVERING';
  const remRec = Math.max(0, (cs.records_expected || 0) - (cs.records_recovered || 0));
  const elapsedS = cs.started_ts ? Math.max(0, Math.round(nowSec - cs.started_ts)) : 0;
  const fmtDur = s => s == null ? '–' : (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`));
  const etaTxt = cs.eta_seconds != null ? `${fmtDur(cs.eta_seconds)} (est)` : '–';

  const contractsTxt = cs.workload_discovered && cs.contracts_total != null
    ? `${cs.contracts_done || 0} / ${cs.contracts_total}`
    : `${cs.contracts_done || 0} completed (total discovering…)`;
  const overallTxt = cs.overall_pct != null ? `${Number(cs.overall_pct).toFixed(1)}%` : 'Discovering';
  kpisEl.innerHTML = `
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Current Month Progress</span><span class="tag">${cs.current_month || '–'}</span></div>
      <div style="font-size:24px;font-weight:700" class="mono">${curPctText}</div>
      <div class="muted" style="font-size:12px">Contracts: ${contractsTxt} · 4-Mo Overall: ${overallTxt}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Records (Observed)</span><span class="tag">1m Bars</span></div>
      <div class="mono" style="font-size:13px">Recovered: <b>${(cs.records_recovered || 0).toLocaleString()}</b>${cs.workload_discovered && cs.records_expected != null ? ` / ${cs.records_expected.toLocaleString()}` : ' (discovering total…)'}</div>
      <div class="muted mono" style="font-size:12px">Verified: ${(cs.records_verified || 0).toLocaleString()} · Rejected: ${cs.records_rejected || 0}${cs.workload_discovered ? ` · Rem: ${remRec.toLocaleString()}` : ''}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">API &amp; Throughput</span><span class="tag">Advanced</span></div>
      <div class="mono" style="font-size:13px">${Number(cs.throughput_rps || 0).toFixed(2)} req/s · ${Number(cs.throughput_rec_s || 0).toFixed(0)} rec/s · ${Number(cs.throughput_mb_s || 0).toFixed(3)} MB/s</div>
      <div class="muted mono" style="font-size:12px">Reqs: ${cs.api_requests_done || 0} done / ${cs.api_requests_remaining ?? '–'} rem · 429s: ${cs.rate_limit_429_count || 0} · Retries: ${cs.retry_count || 0} · Errs: ${cs.error_count || 0}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Timing &amp; ETA</span><span class="tag">Estimate</span></div>
      <div class="mono" style="font-size:13px">Elapsed: <b>${fmtDur(elapsedS)}</b> · ETA: <b>${etaTxt}</b></div>
      <div class="muted mono" style="font-size:12px">Downloaded: ${(Number(cs.bytes_downloaded || 0) / (1024 * 1024)).toFixed(2)} MB · Heartbeat cadence: ${cs.heartbeat_interval_s || 10}s</div></div>
    ${(() => {
      const stg = cs.storage || {};
      const freeGb = stg.free_gb != null ? Number(stg.free_gb).toFixed(2) : "—";
      const totGb = stg.total_gb != null ? Number(stg.total_gb).toFixed(0) : "—";
      const usedMb = stg.cmos_used_mb != null ? Number(stg.cmos_used_mb).toFixed(2) : "—";
      const tagCls = stg.critical ? "bad" : (stg.low ? "warn" : "ok");
      const tagTxt = stg.critical ? "CRITICAL" : (stg.low ? "LOW SPACE" : (stg.temp_verified_d ? "D: LOCKED" : "CHECK"));
      const warnLine = stg.warning ? `<div class="muted mono" style="font-size:12px;color:#f59e0b">${esc(stg.warning)}</div>` : "";
      return `<div class="acct-card"><div class="acct-head"><span class="acct-title">Storage Safety (D: NVMe)</span><span class="tag ${tagCls}">${tagTxt}</span></div>
      <div class="mono" style="font-size:13px">Free: <b>${freeGb} GB</b> / ${totGb} GB · CMOS: <b>${usedMb} MB</b></div>
      <div class="muted mono" style="font-size:12px">Temp/DuckDB/Cache: ${stg.temp_verified_d ? "D:\\BarnacleCore (verified)" : "Pending"}</div>${warnLine}</div>`;
    })()}`;

  if (tlEl) {
    tlEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px">` +
      (cs.months || []).map(m => {
        const st = m.training_status === 'COMPLETED' || (m.recovery_pct >= 100 && m.validation_pct >= 100) ? 'COMPLETED' : (m.month === cs.current_month ? status : 'PENDING');
        const cls = st === 'COMPLETED' ? 'ok' : (st === 'ACTIVE' || st === 'WAITING' ? 'warn' : '');
        const pct = m.workload_discovered ? `${Number(m.recovery_pct || 0).toFixed(0)}%` : (m.month === cs.current_month ? 'DISCOVERING' : 'PENDING');
        return `<div class="acct-card" style="padding:8px 10px"><div class="row between"><b>${m.month}</b><span class="pill ${cls}">${st}</span></div><div class="muted mono" style="font-size:12px;margin-top:4px">Rec ${pct} · Val ${Number(m.validation_pct || 0).toFixed(0)}%</div></div>`;
      }).join('') + `</div>`;
  }

  if (mBody) {
    mBody.innerHTML = (cs.months || []).map(m => `<tr>
      <td class="mono"><b>${m.month}</b></td>
      <td class="mono">${m.workload_discovered ? Number(m.recovery_pct || 0).toFixed(1) + '%' : 'DISCOVERING'}</td>
      <td class="mono">${Number(m.validation_pct || 0).toFixed(1)}%</td>
      <td class="mono">${m.training_status} / ${m.eval_status}</td>
      <td class="mono">${m.quality_score != null ? Number(m.quality_score).toFixed(2) + '%' : '–'}</td>
      <td class="mono">${m.independent_events || 0}</td>
      <td class="mono">${m.brier_score != null ? Number(m.brier_score).toFixed(4) : '–'}</td>
      <td class="mono">${m.log_loss != null ? Number(m.log_loss).toFixed(4) : '–'}</td>
      <td class="mono">${m.net_pnl_usd != null ? fmtSignedUsd(m.net_pnl_usd) : '–'}</td>
      <td class="mono">${m.max_drawdown_usd != null ? '$' + Number(m.max_drawdown_usd).toFixed(2) : '–'}</td>
      <td class="mono">${m.delta_vs_prev_usd != null ? fmtSignedUsd(m.delta_vs_prev_usd) : '–'}</td>
      <td class="mono">${m.zeus_net_pnl_usd != null ? fmtSignedUsd(m.zeus_net_pnl_usd) : '–'}</td>
    </tr>`).join('');
  }

  if (fBody) {
    fBody.innerHTML = (cs.families || []).map(f => `<tr>
      <td class="mono">${f.series}</td><td class="mono">${f.contracts_total}</td><td class="mono">${f.contracts_done}</td>
      <td class="mono">${f.contracts_verified}</td><td class="mono">${f.contracts_rejected}</td><td class="mono">${f.records_recovered}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No family records yet.</td></tr>';
  }

  if (cpBox) {
    const cps = cs.checkpoints || [];
    cpBox.innerHTML = cps.length
      ? `<div class="muted" style="font-size:12px">Latest checkpoint: <b class="mono">${cps[0].version}</b> (${cps[0].month}, ${cps[0].train_bars} bars)</div>`
      : '<div class="muted" style="font-size:12px">No versioned monthly checkpoint committed yet (baseline 2026-01).</div>';
  }

  const evs = cs.events || [];
  if (logCnt) logCnt.textContent = `${evs.length} events`;
  const totalPages = Math.max(1, Math.ceil(evs.length / CMOS_LOG_PAGE_SIZE));
  cmosLogPage = Math.min(cmosLogPage, totalPages - 1);
  const pageEvs = evs.slice(cmosLogPage * CMOS_LOG_PAGE_SIZE, (cmosLogPage + 1) * CMOS_LOG_PAGE_SIZE);
  if (eBody) {
    eBody.innerHTML = pageEvs.map(e => `<tr>
      <td class="mono">${new Date(e.ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}</td>
      <td class="mono">${e.level}</td><td class="mono">${e.month || '–'}</td><td class="mono">${e.operation || '–'}</td>
      <td>${String(e.message || '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No events logged yet.</td></tr>';
  }
  if (ePager) {
    ePager.innerHTML = totalPages > 1
      ? `<button id="cmos-prev-pg" class="toggle-btn" type="button">Prev</button> <span class="muted mono">${cmosLogPage + 1}/${totalPages}</span> <button id="cmos-next-pg" class="toggle-btn" type="button">Next</button>`
      : '';
    if ($('cmos-prev-pg')) $('cmos-prev-pg').onclick = () => { if (cmosLogPage > 0) { cmosLogPage--; renderCmosSync(currentSnap); } };
    if ($('cmos-next-pg')) $('cmos-next-pg').onclick = () => { if (cmosLogPage < totalPages - 1) { cmosLogPage++; renderCmosSync(currentSnap); } };
  }
  renderAdaptiveTrackB(cs);
}

function _svgSparkline(vals, color, label, fmtFn) {
  if (!vals || !vals.length) return `<div class="muted mono" style="font-size:12px">No ${label} series yet</div>`;
  const w = 280, h = 68, pad = 6;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const span = Math.max(1e-6, mx - mn);
  const pts = vals.map((v, i) => {
    const x = vals.length === 1 ? w / 2 : pad + (i / (vals.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - mn) / span) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = vals[vals.length - 1];
  return `<div style="display:flex;justify-content:space-between;font-size:12px" class="mono"><span>${label}</span><b>${fmtFn(last)}</b></div>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:68px;background:#050914;border-radius:6px;margin-top:4px">
      <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" />
    </svg>
    <div class="muted mono" style="font-size:11px">Min: ${fmtFn(mn)} · Max: ${fmtFn(mx)} (${vals.length} ckpts)</div>`;
}

function renderAdaptiveTrackB(cs) {
  const al = cs?.adaptive_learning || {};
  const kpis = $('cmos-sync-adaptive-kpis');
  if (!kpis) return;
  const stPill = $('cmos-adaptive-status-pill');
  const actPill = $('cmos-adaptive-active-pill');
  const bestPill = $('cmos-adaptive-best-pill');
  const reason = $('cmos-adaptive-reason');
  if (stPill) {
    stPill.className = `pill mono ${al.status === 'ERROR' || al.status === 'STALLED' ? 'bad' : (al.status === 'TRAINING' ? 'ok' : 'warn')}`;
    stPill.textContent = al.status || 'IDLE';
  }
  if (actPill) actPill.textContent = `ACTIVE: ${al.active_model_version || '–'}`;
  if (bestPill) bestPill.textContent = `BEST: ${al.best_model_version || '–'}`;
  if (reason) reason.textContent = al.status_reason || 'Awaiting verified batch observations…';

  const oos = al.eval?.historical_oos || {};
  const dlt = al.delta_vs_previous || {};
  const pp = al.prospective_paper || {};
  const lastCycleTxt = al.last_cycle_ts ? `${new Date(al.last_cycle_ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} (${al.last_cycle_duration_s ?? '–'}s)` : '–';
  kpis.innerHTML = `
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Model Lineage &amp; Promotion</span><span class="tag">${al.auto_promotion_enabled ? 'AUTO-PROMOTE ON' : 'MANUAL'}</span></div>
      <div class="mono" style="font-size:12px">Deployed Paper (V1): <b>${esc(al.deployed_paper_model_version || 'CMOS-V1 (cmos_model.json)')}</b></div>
      <div class="mono" style="font-size:12px">Deployed Adaptive: <b>${esc(al.deployed_adaptive_model_version || al.active_model_version || '–')}</b> · Best: <b>${esc(al.best_model_version || '–')}</b></div>
      <div class="muted mono" style="font-size:11px">Latest Challenger: ${esc(al.latest_challenger_version || '–')} · Paper Auto-Reload: ${al.paper_auto_reload_enabled ? 'Yes' : 'No (Isolated)'}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Training Data &amp; Trigger</span><span class="tag">Verified D:</span></div>
      <div class="mono" style="font-size:13px">Obs: <b>${(al.verified_observations || 0).toLocaleString()}</b> · Events: <b>${al.independent_events || 0}</b></div>
      <div class="muted mono" style="font-size:12px">Last: ${lastCycleTxt} · Next trigger: ${al.next_trigger_events ?? '–'} new events</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Historical OOS Performance</span><span class="tag">Out-of-Sample</span></div>
      <div class="mono" style="font-size:13px">Brier: <b>${oos.brier_score ?? '–'}</b> · LogLoss: <b>${oos.log_loss ?? '–'}</b> · Net: <b>$${(oos.realized_net_pnl_usd ?? 0).toFixed(2)}</b></div>
      <div class="muted mono" style="font-size:12px">Exp: $${(oos.expected_net_pnl_usd ?? 0).toFixed(2)} · W/L: ${oos.wins || 0}/${oos.losses || 0} · DD: $${(oos.max_drawdown_usd ?? 0).toFixed(2)} · ΔPnL: ${dlt.net_pnl_delta_usd != null ? (dlt.net_pnl_delta_usd >= 0 ? '+' : '') + '$' + dlt.net_pnl_delta_usd.toFixed(2) : '–'}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Challenger Gate &amp; Paper</span><span class="tag">Separated</span></div>
      <div class="mono" style="font-size:13px">Tested: <b>${al.models_tested || 0}</b> · Promoted: <b>${al.models_promoted || 0}</b> · Rejected: <b>${al.models_rejected || 0}</b></div>
      <div class="muted mono" style="font-size:12px">Prospective Paper: ${pp.trades || 0} trades · Net $${(pp.net_pnl_usd || 0).toFixed(2)} · Open ${pp.open_positions || 0}</div></div>`;
}

let _pendingRestoreVersion = null;
let _tcmosCkptPage = 0;
const TCMOS_CKPT_PAGE_SIZE = 20;

function renderTrainingCmos(snap) {
  const cs = snap?.cmos_sync;
  const kpis = $('tcmos-kpis');
  if (!kpis || !cs) return;
  const al = cs.adaptive_learning || {};
  const tr = al.eval?.train || {};
  const va = al.eval?.validation || {};
  const oos = al.eval?.historical_oos || {};
  const pp = al.prospective_paper || {};
  const dlt = al.delta_vs_previous || {};

  const noModelEl = $('tcmos-no-model-banner');
  if (noModelEl) {
    noModelEl.style.display = !al.active_model_version ? 'block' : 'none';
  }
  const healthEl = $('tcmos-health-bar');
  if (healthEl) {
    const nowS = Date.now() / 1000;
    const recAge = cs.heartbeat_ts != null ? Math.max(0, Math.round(nowS - cs.heartbeat_ts)) : cs.heartbeat_age_s;
    const trAge = al.heartbeat_ts != null ? Math.max(0, Math.round(nowS - al.heartbeat_ts)) : al.heartbeat_age_s;
    const pubAge = snap?.generated_ts != null ? Math.max(0, Math.round(nowS - snap.generated_ts)) : null;
    const recAlive = (cs.status === 'ACTIVE' || cs.status === 'COMPLETED') && (recAge == null || recAge <= 60);
    const trStateTxt = (al.status === 'IDLE' && recAlive) ? 'IDLE (Waiting for 250-event batch)' : (al.status || 'IDLE');
    healthEl.innerHTML = `
      <div class="acct-card"><div class="acct-head"><span class="acct-title">1. Historical Recovery Worker</span><span class="tag ${recAlive ? 'ok' : 'bad'}">${esc(cs.status || 'PAUSED')}</span></div>
        <div class="mono" style="font-size:12px">Op: <b>${esc(cs.operation || '–')}</b> · Heartbeat: <b>${recAge != null ? recAge + 's ago' : '–'}</b></div></div>
      <div class="acct-card"><div class="acct-head"><span class="acct-title">2. Adaptive Training Worker</span><span class="tag ${al.status === 'ERROR' || al.status === 'STALLED' ? 'bad' : (al.status === 'TRAINING' ? 'ok' : 'warn')}">${esc(trStateTxt)}</span></div>
        <div class="mono" style="font-size:12px">Op: <b>${esc(al.operation || 'idle')}</b> · Last cycle/hb: <b>${trAge != null ? trAge + 's ago' : '–'}</b></div></div>
      <div class="acct-card"><div class="acct-head"><span class="acct-title">3. Publisher / Relay</span><span class="tag ${pubAge != null && pubAge <= 90 ? 'ok' : 'warn'}">${pubAge != null && pubAge <= 90 ? 'LIVE' : 'STALE'}</span></div>
        <div class="mono" style="font-size:12px">Snapshot age: <b>${pubAge != null ? pubAge + 's ago' : '–'}</b> · Checkpoints: <b>${(cs.checkpoints || []).length}</b></div></div>`;
  }

  if ($('tcmos-reason')) $('tcmos-reason').textContent = `${al.status_reason || 'Idle'} · Heartbeat age: ${al.heartbeat_age_s ?? '–'}s · Op: ${al.operation || 'idle'}`;
  if ($('tcmos-status-pill')) {
    const blocked = !al.active_model_version && (al.cycles_completed || 0) > 0;
    $('tcmos-status-pill').className = `pill mono ${blocked || al.status === 'ERROR' || al.status === 'STALLED' ? 'bad' : (al.status === 'TRAINING' ? 'ok' : 'warn')}`;
    $('tcmos-status-pill').textContent = blocked ? 'PROMOTION BLOCKED' : (al.status || 'IDLE');
  }
  if ($('tcmos-active-pill')) $('tcmos-active-pill').textContent = `ACTIVE ADAPTIVE: ${al.active_model_version || 'NONE (BLOCKED)'}`;
  if ($('tcmos-best-pill')) $('tcmos-best-pill').textContent = `BEST: ${al.best_model_version || 'NONE'}`;
  if ($('tcmos-challenger-pill')) $('tcmos-challenger-pill').textContent = `CHALLENGER: ${al.latest_challenger_version || '–'}`;

  kpis.innerHTML = `
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Active &amp; Best Models</span><span class="tag ${al.active_model_version ? 'ok' : 'bad'}">${al.active_model_version ? esc(cs.current_month || '–') : 'PROMOTION BLOCKED'}</span></div>
      <div class="mono" style="font-size:12px">Deployed Paper (V1): <b>${esc(al.deployed_paper_model_version || 'CMOS-V1 (cmos_model.json)')}</b></div>
      <div class="mono" style="font-size:12px">Deployed Adaptive: <b>${esc(al.active_model_version || 'NONE (VALIDATION FAILED)')}</b></div>
      <div class="muted mono" style="font-size:11px">Best Validated: ${esc(al.best_model_version || 'None')} · Cycles: ${al.cycles_completed || 0}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Candidate vs Selected Calibration</span><span class="tag">D: NVMe</span></div>
      <div class="mono" style="font-size:13px">Obs: <b>${(al.verified_observations || 0).toLocaleString()}</b> · Events: <b>${al.independent_events || 0}</b></div>
      <div class="muted mono" style="font-size:11px">All-Cand Pred/Act: ${oos.pred_win_prob ?? '–'} / ${oos.actual_win_prob ?? '–'} · Selected: ${oos.selected_pred_win_prob ?? '–'} / ${oos.selected_actual_win_prob ?? '–'}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">OOS Economics &amp; Risk</span><span class="tag">After Fees</span></div>
      <div class="mono" style="font-size:13px">Net P&amp;L: <b>$${(oos.realized_net_pnl_usd ?? 0).toFixed(2)}</b> · Max DD: <b>$${(oos.max_drawdown_usd ?? 0).toFixed(2)}</b></div>
      <div class="muted mono" style="font-size:12px">RAR: ${oos.risk_adjusted_return ?? '–'} · $/Trade: $${(oos.profit_per_trade_usd ?? 0).toFixed(2)} · Turnover: ${oos.capital_turnover ?? '–'}x</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Δ vs Previous Checkpoint</span><span class="tag">Gate</span></div>
      <div class="mono" style="font-size:13px">ΔBrier: <b>${dlt.brier_delta ?? '–'}</b> · ΔPnL: <b>${dlt.net_pnl_delta_usd != null ? (dlt.net_pnl_delta_usd >= 0 ? '+' : '') + '$' + dlt.net_pnl_delta_usd.toFixed(2) : '–'}</b></div>
      <div class="muted mono" style="font-size:12px">Tested: ${al.models_tested || 0} · Promoted: ${al.models_promoted || 0} · Rejected: ${al.models_rejected || 0}</div></div>`;

  const splitsEl = $('tcmos-splits');
  if (splitsEl) {
    const mkSplit = (title, tag, d) => `<div class="acct-card"><div class="acct-head"><span class="acct-title">${title}</span><span class="tag">${tag}</span></div>
      <div class="mono" style="font-size:12px">Events: <b>${d.n_events ?? d.trades ?? 0}</b> · Brier: <b>${d.brier_score ?? '–'}</b> · LogLoss: <b>${d.log_loss ?? '–'}</b></div>
      <div class="muted mono" style="font-size:12px">Net P&amp;L: $${(d.realized_net_pnl_usd ?? d.net_pnl_usd ?? 0).toFixed(2)} · DD: $${(d.max_drawdown_usd ?? 0).toFixed(2)} · WinRate: ${d.win_rate != null ? (d.win_rate * 100).toFixed(1) + '%' : '–'}</div></div>`;
    splitsEl.innerHTML = mkSplit('1. Training Split', 'In-Sample', tr)
      + mkSplit('2. Validation Split', 'Model Selection', va)
      + mkSplit('3. Historical OOS', 'Unseen History', oos)
      + mkSplit('4. Prospective Paper', 'Live Research', pp);
  }

  const chartsEl = $('tcmos-charts');
  const ckptsAsc = [...(cs.checkpoints || [])].reverse();
  if (chartsEl) {
    const briers = ckptsAsc.map(c => c.oos_brier).filter(v => v != null).map(Number);
    const pnls = ckptsAsc.map(c => c.oos_net_pnl_usd).filter(v => v != null).map(Number);
    const dds = ckptsAsc.map(c => c.max_drawdown_usd).filter(v => v != null).map(Number);
    const evs = ckptsAsc.map(c => c.independent_events).filter(v => v != null).map(Number);
    const famRows = Object.entries(oos.by_family || {}).map(([ser, f]) =>
      `<div class="mono" style="font-size:12px">${esc(ser)}: ${f.trades} trades · Net $${Number(f.net_pnl_usd || 0).toFixed(2)} · Brier ${f.brier_score ?? '–'}</div>`
    ).join('') || '<div class="muted mono" style="font-size:12px">No family OOS breakdown yet</div>';
    const hasInvalid = ckptsAsc.some(c => c.validation_status === 'MODEL_INVALIDATED');
    const pnlTitle = hasInvalid ? 'OOS Net P&L ($) — *includes invalidated 2c-bug history' : 'OOS Net P&L ($)';
    chartsEl.innerHTML = `
      <div class="acct-card">${_svgSparkline(briers, '#38bdf8', 'OOS Brier Score (Lower=Better)', v => v.toFixed(4))}</div>
      <div class="acct-card">${_svgSparkline(pnls, '#22c55e', pnlTitle, v => '$' + v.toFixed(2))}</div>
      <div class="acct-card">${_svgSparkline(dds, '#f59e0b', 'OOS Max Drawdown ($)', v => '$' + v.toFixed(2))}</div>
      <div class="acct-card">${_svgSparkline(evs, '#a78bfa', 'Verified Independent Events', v => String(Math.round(v)))}
        <div style="margin-top:6px;border-top:1px solid #1f2937;padding-top:6px">${famRows}</div></div>`;
  }

  const allCkpts = cs.checkpoints || [];
  const totalPages = Math.max(1, Math.ceil(allCkpts.length / TCMOS_CKPT_PAGE_SIZE));
  if (_tcmosCkptPage >= totalPages) _tcmosCkptPage = totalPages - 1;
  const pageStart = _tcmosCkptPage * TCMOS_CKPT_PAGE_SIZE;
  const pageCkpts = allCkpts.slice(pageStart, pageStart + TCMOS_CKPT_PAGE_SIZE);

  const cBody = $('tcmos-checkpoints-body');
  if (cBody) {
    cBody.innerHTML = pageCkpts.map(c => {
      const ts = c.created_ts ? new Date(c.created_ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '–';
      const sha = c.checkpoint_sha256 ? esc(String(c.checkpoint_sha256).slice(0, 12)) : '–';
      const isAct = c.deployment_status === 'ACTIVE_PAPER';
      const vs = String(c.validation_status || '–');
      const isInv = vs === 'MODEL_INVALIDATED';
      const vBadge = isInv
        ? '<span class="tag bad">MODEL INVALIDATED</span>'
        : (vs === 'VALIDATION_FAILED' ? '<span class="tag bad">VALIDATION FAILED</span>'
          : (vs === 'PROMOTION_BLOCKED' ? '<span class="tag warn">PROMOTION BLOCKED</span>' : esc(vs)));
      const pnlCell = c.oos_net_pnl_usd != null
        ? (isInv
          ? `<span class="muted" style="text-decoration:line-through" title="Invalidated 2c scaling artifact — not verified profit">$${Number(c.oos_net_pnl_usd).toFixed(2)}</span> <span class="tag bad">INVALID</span>`
          : `$${Number(c.oos_net_pnl_usd).toFixed(2)}`)
        : '–';
      const btn = isAct
        ? '<span class="tag ok">ACTIVE</span>'
        : (isInv || vs === 'VALIDATION_FAILED'
          ? '<span class="muted mono" style="font-size:11px">Blocked</span>'
          : `<button class="toggle-btn tcmos-restore-btn" data-version="${esc(c.version)}" type="button">Restore Checkpoint</button>`);
      return `<tr>
        <td class="mono">${esc(c.version)}</td><td class="mono">${ts}</td><td class="mono">${esc(c.training_period || c.month || '–')}</td>
        <td class="mono">${esc(c.training_mode || '–')}</td><td class="mono">${c.independent_events ?? '–'}</td>
        <td class="mono">${c.oos_brier ?? '–'}</td><td class="mono">${pnlCell}</td>
        <td class="mono">${c.max_drawdown_usd != null ? '$' + Number(c.max_drawdown_usd).toFixed(2) : '–'}</td>
        <td class="mono">${vBadge}</td><td class="mono">${esc(c.deployment_status || '–')}</td>
        <td class="mono">${sha}</td><td>${btn}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="12" class="muted">No checkpoints created yet.</td></tr>';

    const cPager = $('tcmos-checkpoints-pager');
    if (cPager) {
      cPager.innerHTML = allCkpts.length > 0
        ? `<button id="tcmos-ckpt-prev" class="toggle-btn" type="button">Prev</button> <span class="muted mono">Page ${_tcmosCkptPage + 1}/${totalPages} · ${allCkpts.length} checkpoints</span> <button id="tcmos-ckpt-next" class="toggle-btn" type="button">Next</button>`
        : '';
      if ($('tcmos-ckpt-prev')) $('tcmos-ckpt-prev').onclick = () => { if (_tcmosCkptPage > 0) { _tcmosCkptPage--; renderTrainingCmos(currentSnap); } };
      if ($('tcmos-ckpt-next')) $('tcmos-ckpt-next').onclick = () => { if (_tcmosCkptPage < totalPages - 1) { _tcmosCkptPage++; renderTrainingCmos(currentSnap); } };
    }

    document.querySelectorAll('.tcmos-restore-btn').forEach(btn => {
      btn.onclick = () => {
        _pendingRestoreVersion = btn.getAttribute('data-version');
        const modal = $('tcmos-rollback-modal');
        if ($('tcmos-rollback-desc')) {
          $('tcmos-rollback-desc').textContent = `Replace active CMOS paper model (${al.active_model_version || 'none'}) with verified checkpoint ${_pendingRestoreVersion}? Existing paper ledgers and real-money PAUSED settings are untouched.`;
        }
        if ($('tcmos-rollback-msg')) $('tcmos-rollback-msg').textContent = '';
        if (modal) modal.style.display = 'flex';
      };
    });
  }

  const rBody = $('tcmos-rollback-body');
  const rCnt = $('tcmos-rollback-count');
  const rList = al.rollback_audit || [];
  if (rCnt) rCnt.textContent = String(rList.length);
  if (rBody) {
    rBody.innerHTML = rList.map(r => `<tr>
      <td class="mono">${new Date(r.ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}</td>
      <td class="mono">${esc(r.actor)}</td><td class="mono">${esc(r.from_version || '–')}</td>
      <td class="mono">${esc(r.to_version)}</td><td class="mono">${esc(String(r.checkpoint_sha256 || '').slice(0, 12))}</td>
      <td>${esc(r.reason)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">No rollbacks recorded.</td></tr>';
  }
}

if ($('tcmos-rollback-cancel')) {
  $('tcmos-rollback-cancel').onclick = () => {
    _pendingRestoreVersion = null;
    if ($('tcmos-rollback-modal')) $('tcmos-rollback-modal').style.display = 'none';
  };
}
if ($('tcmos-rollback-confirm')) {
  $('tcmos-rollback-confirm').onclick = async () => {
    if (!_pendingRestoreVersion) return;
    const msgEl = $('tcmos-rollback-msg');
    const reason = ($('tcmos-rollback-reason')?.value || 'Dashboard operator checkpoint restore').trim();
    try {
      const resp = await fetch('/api/live-money/cmos/restore-checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: _pendingRestoreVersion, confirm: true, reason }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`);
      if (msgEl) msgEl.textContent = `Restored ${data.restored_version} (sha256=${String(data.sha256 || '').slice(0, 12)})`;
      setTimeout(() => { if ($('tcmos-rollback-modal')) $('tcmos-rollback-modal').style.display = 'none'; }, 900);
    } catch (err) {
      if (msgEl) msgEl.textContent = `Local Barnacle API required for write actions (${err.message}).`;
    }
  };
}

function openModal(item) {
  $('modal-title').textContent = `${item.account_label || ''} · ${item.ticker || 'Position Detail'}`;
  $('modal-body').innerHTML = `<pre class="mono" style="white-space:pre-wrap;font-size:12px;background:#050914;padding:10px;border-radius:8px;max-height:60vh;overflow:auto">${JSON.stringify(item, null, 2)}</pre>`;
  $('trace-modal').showModal();
}

function renderHermesSavings(snap) {
  const panel = $('hermes-savings-panel');
  const card = $('hermes-sav-card');
  const chart = $('hermes-sav-chart');
  const txBody = $('hermes-sav-tx-body');
  const txCnt = $('hermes-sav-tx-count');
  if (!panel || !card) return;
  const hs = snap?.hermes_savings;
  if (!hs || !hs.available) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const tot = Number(hs.total_savings_usd || 0);
  const startTr = Number(hs.starting_savings_transfer_usd || 0);
  const postAct = Number(hs.post_activation_savings_usd || 0);
  const target = Number(hs.target_principal_usd || 1000);

  card.innerHTML = `
    <div class="acct-card" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <div style="font-size:22px;font-weight:700" class="mono">HERMES SAVINGS — $${tot.toFixed(2)}</div>
        <span class="tag ok">SIMULATED SAVINGS LEDGER</span>
      </div>
      <div class="muted mono" style="font-size:12px;margin-top:8px;display:flex;gap:18px;flex-wrap:wrap">
        <span>Initial transfer: <b>$${startTr.toFixed(2)}</b></span>
        <span>New savings since activation: <b>+$${postAct.toFixed(2)}</b></span>
        <span>Trading bankroll remaining: <b>$${Number(hs.trading_equity_usd || 0).toFixed(2)}</b> (target $${target.toFixed(0)})</span>
      </div>
    </div>`;

  if (chart) {
    const ser = hs.cumulative_savings_series || [];
    const savVals = ser.map(p => Number(p.savings_total || 0));
    chart.innerHTML = `<div class="acct-card">${_svgSparkline(savVals, '#22c55e', 'Simulated Savings Balance Over Time ($)', v => '$' + v.toFixed(2))}</div>`;
  }

  const txs = hs.transactions || [];
  if (txCnt) txCnt.textContent = String(txs.length);
  if (txBody) {
    txBody.innerHTML = txs.map(t => `<tr>
      <td class="mono">${new Date(t.ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' })}</td>
      <td class="mono">${t.entry_type === 'STARTING_SAVINGS_TRANSFER' ? '<span class="tag">STARTING TRANSFER</span>' : '<span class="tag ok">POST-ACT DEPOSIT</span>'}</td>
      <td class="mono">+$${Number(t.amount_usd || 0).toFixed(2)}</td>
      <td class="mono">$${Number(t.balance_after_usd || 0).toFixed(2)}</td>
      <td class="mono">$${Number(t.trading_equity_after_usd || 0).toFixed(2)}</td>
      <td class="mono">${esc((t.linked_position_ids || []).join(', ') || '–')}</td>
      <td>${esc(t.detail)}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">No savings sweeps yet.</td></tr>';
  }
}

function renderCmosPortfolioPanel(snap) {
  const panel = $('cmos-portfolio-panel');
  const body = $('cmos-portfolio-body');
  if (!panel || !body) return;
  const cs = snap?.cmos_sync;
  if (!cs || !cs.available) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const al = cs.adaptive_learning || {};
  const oos = al.eval?.historical_oos || {};
  const ap = al.adaptive_paper_account || {};
  const pp = al.prospective_paper || {};
  const blocked = !al.active_model_version && (al.cycles_completed || 0) > 0;
  const valCls = blocked ? 'bad' : (al.active_model_version ? 'ok' : 'warn');
  const valTxt = blocked ? 'PROMOTION BLOCKED / VALIDATION FAILED' : (al.active_model_version ? 'VALIDATED & ACTIVE' : 'AWAITING VALIDATION');

  body.innerHTML = `
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Recovery &amp; Training Status</span><span class="tag">${esc(cs.status || '–')}</span></div>
      <div class="mono" style="font-size:12px">Month <b>${esc(cs.current_month || '–')}</b>: ${cs.contracts_done || 0} completed (${cs.workload_discovered ? `${cs.contracts_total} total` : 'discovering total…'})</div>
      <div class="muted mono" style="font-size:11px">Training: ${esc(al.status || 'IDLE')} · Cycles: ${al.cycles_completed || 0} · Events: ${al.independent_events || 0}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Model &amp; Validation Gate</span><span class="tag ${valCls}">${valTxt}</span></div>
      <div class="mono" style="font-size:12px">Latest Challenger: <b>${esc(al.latest_challenger_version || '–')}</b> · Validated: <b>${al.models_promoted || 0}</b></div>
      <div class="muted mono" style="font-size:11px">Latest OOS: Brier ${oos.brier_score ?? '–'} · Net $${oos.realized_net_pnl_usd != null ? Number(oos.realized_net_pnl_usd).toFixed(2) : '–'} · ${esc(al.status_reason || '–')}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Paper Isolation</span><span class="tag">${esc(ap.status || 'PREPARED_INACTIVE')}</span></div>
      <div class="mono" style="font-size:12px">Adaptive Paper (<code>cmos_adaptive_100</code>): <b>${esc(ap.status || 'PREPARED_INACTIVE')}</b> ($${Number(ap.bankroll_usd || 100).toFixed(0)})</div>
      <div class="muted mono" style="font-size:11px">Separate CMOS V1 (<code>cmos_interrogator_100</code>): ${pp.trades || 0} settled · ${pp.open_positions || 0} open · Net $${Number(pp.net_pnl_usd || 0).toFixed(2)}</div></div>`;

  if ($('cmos-goto-training')) $('cmos-goto-training').onclick = () => $('nav-tab-training-cmos')?.click();
  if ($('cmos-goto-sync')) $('cmos-goto-sync').onclick = () => $('nav-tab-cmos-sync')?.click();
}

function renderAll(snap, connState = 'WAITING', force = false) {
  currentSnap = snap;
  renderStatusHeader(snap, connState);
  renderScoreboard(snap, force);
  renderCmosPortfolioPanel(snap);
  renderZeusExecutionComparison(snap);
  renderWalkForwardResearch(snap);
  renderHermesSavings(snap);
  renderChart(snap, force);
  renderHoldings(snap);
  renderCompleted(snap);
  renderCmosSync(snap);
  renderTrainingCmos(snap);
}

async function pollSnapshot() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const r = await fetch(`${RELAY_URL}/snapshot`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snap = await r.json();
    if (snap && snap.published_at_utc) {
      lastPollOk = true;
      const changed = acceptSnapshot(snap);
      if (changed) renderAll(snap, 'LIVE');
      else renderStatusHeader(snap, 'LIVE');
    } else {
      lastPollOk = false;
      renderStatusHeader(currentSnap || emptySnapshot(), 'OFFLINE');
    }
  } catch {
    lastPollOk = false;
    renderStatusHeader(currentSnap || emptySnapshot(), 'OFFLINE');
  } finally {
    pollInFlight = false;
  }
}

function scheduleSseReconnect() {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(() => {
    sseRetryTimer = null;
    connectStream();
  }, retryMs);
  retryMs = Math.min(30000, retryMs * 2);
}

function connectStream() {
  try {
    if (es) { es.close(); es = null; }
    es = new EventSource(`${RELAY_URL}/events`);
    es.onmessage = (ev) => {
      retryMs = 2000;
      lastPollOk = true;
      const snap = JSON.parse(ev.data);
      const changed = acceptSnapshot(snap);
      if (changed) renderAll(snap, 'LIVE');
      else renderStatusHeader(snap, 'LIVE');
    };
    es.onerror = () => {
      if (es) { es.close(); es = null; }
      if (!lastPollOk && currentSnap) renderStatusHeader(currentSnap, 'OFFLINE');
      scheduleSseReconnect();
    };
  } catch {
    scheduleSseReconnect();
  }
}

function buildStatusReportText(snap) {
  if (!snap) return 'No snapshot loaded yet.';
  const pubTs = snap.published_ts || (snap.published_at_utc ? Date.parse(snap.published_at_utc) / 1000 : null);
  const ageS = pubTs ? Math.max(0, Math.round(Date.now() / 1000 - pubTs)) : null;
  const accts = snap.three_accounts?.accounts || [];
  const holds = snap.holdings || [];
  const nowSec = Date.now() / 1000;
  const lines = [
    `# Barnacle Status Report`,
    `Generated: ${fmtEt(nowSec)}`,
    `Data Timestamp: ${fmtEt(pubTs)} (${ageS != null ? ageS + 's old' : 'freshness UNAVAILABLE'})`,
    ``,
  ];
  accts.forEach(a => {
    const isReal = accountGroupOf(a) === 'live';
    const initC = Number(a.initial_cents || 0);
    const eqC = Number(a.equity_cents ?? initC);
    const acctH = holds.filter(h => h.account_id === a.account_id);
    const actH = acctH.filter(h => !h.trading_closed && (!h.close_ts || Number(h.close_ts) > nowSec));
    const awtH = acctH.filter(h => h.trading_closed || (h.close_ts && Number(h.close_ts) <= nowSec));
    const contractsHeld = acctH.reduce((s, h) => s + Number(h.contracts || 0), 0);
    const unrealStr = a.unrealized_pnl_cents == null ? 'UNAVAILABLE' : fmtSignedUsd(a.unrealized_pnl_cents / 100);
    const netSellStr = a.net_sell_value_cents == null ? 'UNAVAILABLE' : fmtUsd(a.net_sell_value_cents / 100);
    const potAllWin = Number(a.potential_total_all_win_cents ?? ((a.available_cents || 0) + (contractsHeld * 100)));
    lines.push(`## ${a.label || a.codename} (${a.codename || 'EXPERIMENT'})`);
    lines.push(`- Status: ${a.runtime_status || 'ACTIVE'} | Mode: ${isReal ? 'REAL MONEY' : 'PAPER SIM'}`);
    lines.push(`- Starting Bankroll: ${fmtUsd(initC / 100)} | Current Equity: ${fmtUsd(eqC / 100)} | Available Cash: ${fmtUsd((a.available_cents || 0) / 100)} | Invested: ${fmtUsd((a.invested_cents || 0) / 100)} | Potential Total (All Win): ${fmtUsd(potAllWin / 100)}`);
    lines.push(`- Realized P&L: ${fmtSignedUsd((a.realized_net_cents || 0) / 100)} | Est. Unrealized (Resale): ${unrealStr} | Est. Net Liquidation: ${netSellStr} | Fees Paid: ${fmtUsd((a.fees_cents || 0) / 100)}`);
    lines.push(`- Open: ${actH.length} | Settling: ${awtH.length} | Settled Wins: ${a.wins ?? 0} | Settled Losses: ${a.losses ?? 0} | Contracts Held: ${contractsHeld}`);
    if (actH.length) {
      lines.push(`### Active Positions`);
      actH.forEach(h => {
        const fills = (h.entry_levels || []).map(l => `${l.qty}x @ ${l.price_cents}c`).join(', ');
        const depth = (h.sell_levels || []).length ? h.sell_levels.map(l => `${l.price_cents}c:${l.available_qty}`).join(', ') : 'UNAVAILABLE';
        const bid = h.best_bid_cents != null ? `${h.best_bid_cents}c` : 'UNAVAILABLE';
        const liq = h.estimated_net_sell_usd != null ? fmtUsd(h.estimated_net_sell_usd) : 'UNAVAILABLE';
        const spnl = h.sell_pnl_usd != null ? fmtSignedUsd(h.sell_pnl_usd) : 'UNAVAILABLE';
        lines.push(`- ${h.ticker} (${h.side}) x${h.contracts} | Bought: ${fmtEt(h.opened_ts)} | Closes: ${fmtEt(h.close_ts)} | Fills: [${fills}] | Total Cost (incl fees): ${fmtUsd(h.cost_basis_usd ?? h.invested_usd)} | Best Bid: ${bid} | Depth: [${depth}] | Est. Sale Proceeds: ${liq} | Est. Sell P&L: ${spnl} | Max Payout: ${fmtUsd(h.max_payout_usd)}`);
      });
    }
    if (awtH.length) {
      lines.push(`### Awaiting Settlement (${awtH.length})`);
      awtH.forEach(h => {
        lines.push(`- ${h.ticker} (${h.side}) x${h.contracts} | Cost Basis: ${fmtUsd(h.cost_basis_usd ?? h.invested_usd)} | Closed: ${fmtEt(h.close_ts)} | Status: PENDING SETTLEMENT`);
      });
    }
    lines.push('');
  });
  return lines.join('\n');
}

function wireControls() {
  const setUnit = (u, btn) => {
    chartUnit = u;
    ['unit-pct', 'unit-usd', 'unit-pnl'].forEach(id => $(id)?.classList.remove('active'));
    btn.classList.add('active');
    if (currentSnap) renderChart(currentSnap);
  };
  $('unit-pct').onclick = () => setUnit('pct', $('unit-pct'));
  $('unit-usd').onclick = () => setUnit('usd', $('unit-usd'));
  $('unit-pnl').onclick = () => setUnit('pnl', $('unit-pnl'));

  const setRange = (r, btn) => {
    chartRange = r;
    chartZoomState = null;
    ['range-1h', 'range-6h', 'range-24h', 'range-all'].forEach(id => $(id)?.classList.remove('active'));
    btn.classList.add('active');
    if (currentSnap) renderChart(currentSnap);
  };
  $('range-1h').onclick = () => setRange('1h', $('range-1h'));
  $('range-6h').onclick = () => setRange('6h', $('range-6h'));
  $('range-24h').onclick = () => setRange('24h', $('range-24h'));
  $('range-all').onclick = () => setRange('all', $('range-all'));

  $('chart-reset').onclick = () => {
    chartZoomState = null;
    if (currentSnap) renderChart(currentSnap);
  };
  $('chart-fit').onclick = () => {
    chartRange = 'all';
    chartZoomState = null;
    ['range-1h', 'range-6h', 'range-24h', 'range-all'].forEach(id => $(id)?.classList.remove('active'));
    $('range-all')?.classList.add('active');
    if (currentSnap) renderChart(currentSnap);
  };
  $('chart-fullscreen').onclick = () => {
    const panel = $('chart-panel');
    if (!panel) return;
    panel.classList.toggle('fullscreen');
    $('chart-fullscreen').textContent = panel.classList.contains('fullscreen') ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
    if (chartInstance) setTimeout(() => chartInstance.resize(), 60);
  };

  $('holdings-panel-details')?.addEventListener('toggle', (e) => {
    const open = e.target.open;
    const lbl = $('holdings-toggle-lbl');
    if (lbl) lbl.textContent = open ? '▾ Collapse' : '▸ Expand';
    if (open && currentSnap) renderHoldings(currentSnap);
  });
  $('completed-panel-details')?.addEventListener('toggle', (e) => {
    const open = e.target.open;
    const lbl = $('completed-toggle-lbl');
    if (lbl) lbl.textContent = open ? '▾ Collapse' : '▸ Expand';
    if (open && currentSnap) renderCompleted(currentSnap);
  });

  $('holdings-q').oninput = () => { if (currentSnap) renderHoldings(currentSnap); };
  $('completed-q').oninput = () => { completedPage = 0; if (currentSnap) renderCompleted(currentSnap); };
  $('modal-close').onclick = () => $('trace-modal').close();

  const copyBtn = $('copy-report-btn');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const txt = buildStatusReportText(currentSnap);
      let ok = false;
      try {
        await navigator.clipboard.writeText(txt);
        ok = true;
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = txt;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = document.execCommand('copy');
          document.body.removeChild(ta);
        } catch { }
      }
      copyBtn.textContent = ok ? '✓ Copied!' : '✗ Copy Failed';
      setTimeout(() => { copyBtn.textContent = '📋 Copy Status Report'; }, 2500);
    };
  }
}

// Init once
wireControls();
initNavTabs();
prevSnap = loadJson(PREV_KEY, null);
const initialSnap = loadJson(CACHE_KEY, null) || emptySnapshot();
renderAll(initialSnap, 'WAITING', true);

// Single set of background timers (never duplicated on SSE reconnect)
pollSnapshot();
setInterval(pollSnapshot, 15000);
setInterval(() => { if (currentSnap) renderStatusHeader(currentSnap, lastPollOk ? 'LIVE' : 'OFFLINE'); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistStateIfDue(true); });
connectStream();
