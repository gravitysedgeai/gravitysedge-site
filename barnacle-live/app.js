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

// ONE full account-card renderer, shared by the main scoreboard and every other panel that shows paper accounts (e.g. ZEUS capital scaling).
// ctx = { snap, holdings, completedAll, prevMap, secDataMap }; secDataMap is filled so the expandable sections can render their rows lazily.
function buildAccountCard(a, ctx) {
  const { snap, holdings, completedAll, prevMap, secDataMap } = ctx;
  const nowSec = Date.now() / 1000;
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
      ${opsStrip(snap, 'acct:' + a.account_id)}
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
}

function bindAccountDetails(container, secDataMap) {
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

  const ctx = { snap, holdings, completedAll, prevMap, secDataMap };
  const renderCard = (a) => buildAccountCard(a, ctx);

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

  const bindDetails = (container) => bindAccountDetails(container, secDataMap);

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
      ${opsStrip(snap, isMaker ? 'zeus:maker' : 'zeus:taker')}
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

let zeusSecMap = {};
function renderZeusCapitalScaling(snap) {
  const cardsEl = $('zeus-scaling-cards'), cmpEl = $('zeus-scaling-compare'), noteEl = $('zeus-scaling-note');
  if (!cardsEl) return;
  const z = snap?.zeus_capital_scaling;
  if (!z || !(z.standard_accounts || []).length) {
    cardsEl.innerHTML = '';
    if (cmpEl) cmpEl.innerHTML = `<div class="acct-card"><b>UNKNOWN</b> &mdash; the ZEUS capital-scaling experiment is not in the published snapshot${z?.error ? ' (' + esc(z.error) + ')' : ''}. Nothing is shown rather than a guess.</div>`;
    return;
  }
  if (noteEl && z.note) noteEl.textContent = z.note;
  const usd2 = v => `$${Number(v || 0).toFixed(2)}`;
  const pct = v => `${Number(v || 0).toFixed(2)}%`;
  // SENTINEL status for the ops strip comes from the published SENTINEL rows (never assumed): no owner approval => UNAPPROVED
  const sent = snap?.components?.components || [];
  const comps = (z.components || []).map(c => {
    const sr = sent.find(x => x.id === 'sentinel:' + c.sentinel_component);
    return { ...c, integrity: !sr ? 'UNRESOLVED' : (/no_approval/.test(sr.reason || '') ? 'UNAPPROVED' : sr.integrity), verification_id: sr?.verification_id, version_label: sr?.version_label };
  });
  const ctx = {
    snap: { published_ts: snap.published_ts, components: { components: comps } },
    holdings: z.holdings || [], completedAll: z.completed_trades || [],
    prevMap: Object.fromEntries((prevSnap?.zeus_capital_scaling?.standard_accounts || []).map(x => [x.account_id, x])),
    secDataMap: zeusSecMap,
  };
  // the SAME full account card the main scoreboard uses (buildAccountCard): every standard financial field, operations strip, expandable positions
  cardsEl.innerHTML = z.standard_accounts.map(a => buildAccountCard(a, ctx)).join('');
  bindAccountDetails(cardsEl, zeusSecMap);
  const cell = (b, m, f) => `${f(b)} &rarr; ${f(m)}`;
  const vrows = (z.validation || []).map(v => {
    const b = v.baseline || {}, m = v.managed || {}, p = v.parity || {};
    const st = p.status || 'UNKNOWN';
    const cls = st === 'PASS' ? 'ok' : st === 'FAIL' ? 'bad' : 'warn';
    return `<tr><td>$${Number(v.size_usd).toLocaleString()} ${esc(String(v.venue).toUpperCase())}</td>
      <td><span class="tag ${cls}">${esc(st)}</span><div class="muted" style="font-size:11px">${esc(p.detail || '')}</div></td>
      <td class="mono">${b.candidates_received ?? '–'} &rarr; ${m.candidates_received ?? '–'}</td><td class="mono">${b.decisions ?? '–'} &rarr; ${m.decisions ?? '–'}</td>
      <td class="mono">${b.orders_attempted ?? '–'} &rarr; ${m.orders_attempted ?? '–'}</td><td class="mono">${b.fills ?? '–'} &rarr; ${m.fills ?? '–'}</td>
      <td class="mono">${m.allocation_reductions ?? 0} cuts</td><td class="mono">${cell(b, m, x => pct(x.exposure_pct))}</td><td class="mono">${cell(b, m, x => usd2(x.fees_usd))}</td>
      <td class="mono">${cell(b, m, x => fmtSignedUsd(x.realized_net_pnl_usd))}</td><td class="mono">${cell(b, m, x => pct(x.max_drawdown_pct))}</td>
      <td class="mono">${b.missed_opportunities ?? '–'} &rarr; ${m.missed_opportunities ?? m.missed ?? '–'}</td></tr>`;
  }).join('');
  const dec = (z.recent_allocation_decisions || []).slice(0, 8).map(d => `<div class="mono" style="font-size:11px">${fmtEt(d.ts)} &middot; ${esc(d.account_id)} &middot; ${esc(d.ticker)} &middot; ${esc(d.outcome)} ${d.approved_qty}/${d.baseline_qty} &middot; ${esc(d.reasons || 'no constraint binding')} &middot; ${esc(d.allocation_id)}</div>`).join('');
  if (cmpEl) cmpEl.innerHTML = `<div class="muted" style="font-size:12px;margin:4px 0"><b>EXPERIMENTAL</b> &mdash; policy ${esc(z.policy || '')} is an illustrative demo, not calibrated. Each cell reads <b>baseline &rarr; managed</b>. A baseline sees every candidate its rules evaluate; the managed account receives the same pre-decision candidate events (including ones the baseline rejected, cancelled or skipped) and sizes only the baseline&rsquo;s <i>executed</i> trades. Until the updated runner is deployed, managed candidate counts can lag the baseline&rsquo;s and parity stays UNKNOWN. Zero trades on both sides is shown as UNKNOWN, never PASS.</div>
    <div class="table-wrap"><table><thead><tr><th>ACCOUNT PAIR</th><th>STREAM PARITY</th><th>CANDIDATES</th><th>DECISIONS</th><th>ORDERS ATTEMPTED</th><th>FILLS</th><th>ALLOCATION</th><th>EXPOSURE</th><th>FEES</th><th>REALIZED NET</th><th>MAX DRAWDOWN</th><th>MISSED</th></tr></thead><tbody>${vrows}</tbody></table></div>
    <details style="margin:6px 0"><summary class="muted">Recent EQUILIBRIUM allocation decisions with reasons (policy ${esc(z.policy || '')}, EXPERIMENTAL)</summary>${dec || '<div class="muted">none yet &mdash; the baselines have executed no trades, so there was nothing to allocate</div>'}</details>`;
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

// Heartbeat and "last seen" ages are measured at SNAPSHOT time (the publisher's clock), never against the viewer's clock. A snapshot is up to ~60 s old,
// so comparing a heartbeat to the current time made a healthy worker (10 s heartbeat) read STALLED (>35 s) between publishes. Snapshot age is shown separately.
function snapNow(snap) {
  const t = snap && (snap.published_ts || snap.generated_ts);
  return t ? Number(t) : Date.now() / 1000;
}
// One status derivation shared by the CMOS Sync page and the Status Report so the two cannot disagree.
function cmosSyncState(cs, snap) {
  const ref = snapNow(snap);
  const hbAge = cs.heartbeat_ts != null ? Math.max(0, Math.round(ref - cs.heartbeat_ts)) : cs.heartbeat_age_s;
  let status = cs.status || 'PAUSED';
  let reason = cs.status_reason || '';
  if ((status === 'ACTIVE' || status === 'WAITING') && hbAge != null && hbAge > 35) {
    status = 'STALLED';
    reason = `Heartbeat stale (${hbAge}s at snapshot time > 35s); last op: ${cs.operation}`;
  }
  return { status, reason, hbAge };
}

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

  const nowSec = snapNow(snap);
  const { status, reason, hbAge } = cmosSyncState(cs, snap);

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

  const fmtTsEt = ts => ts != null ? new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'NOT AVAILABLE';
  const fmtAge = ts => ts != null ? `${Math.max(0, Math.round(nowSec - ts))}s ago` : 'NOT AVAILABLE';
  const d1 = cs.deltas?.['1m'] || {};
  const d5 = cs.deltas?.['5m'] || {};
  const d15 = cs.deltas?.['15m'] || {};
  const al = cs.adaptive_learning || {};
  const contractsTxt = cs.workload_discovered && cs.contracts_total != null
    ? `${cs.contracts_done || 0} / ${cs.contracts_total}`
    : `${cs.contracts_done || 0} completed (total discovering…)`;
  const overallTxt = cs.overall_pct != null ? `${Number(cs.overall_pct).toFixed(1)}%` : 'DISCOVERING';
  kpisEl.innerHTML = `
    <div class="acct-card"><div class="acct-head"><span class="acct-title">1. Historical Discovery</span><span class="tag">${esc(cs.current_series || cs.current_month || '–')}</span></div>
      <div class="mono" style="font-size:13px">Discovered: <b>${(cs.contracts_total ?? (cs.months || []).find(m => m.month === cs.current_month)?.contracts_total ?? 0).toLocaleString()}</b> · Reqs: <b>${(cs.discovery_requests_done || 0).toLocaleString()}</b></div>
      <div class="muted mono" style="font-size:11px">Last discovery: ${fmtTsEt(cs.last_discovery_ts)} (${fmtAge(cs.last_discovery_ts)})</div>
      <div class="muted mono" style="font-size:11px">Δ Reqs 1m/5m/15m: +${d1.discovery_reqs || 0} / +${d5.discovery_reqs || 0} / +${d15.discovery_reqs || 0} · Ctrs +${d1.contracts_discovered || 0}/1m</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">2. Recovery &amp; Validation</span><span class="tag">${curPctText}</span></div>
      <div class="mono" style="font-size:13px">Contracts: <b>${contractsTxt}</b> · Overall: <b>${overallTxt}</b></div>
      <div class="muted mono" style="font-size:11px">Recovered: ${(cs.records_recovered || 0).toLocaleString()} · Validated: ${(cs.records_verified || 0).toLocaleString()} · Rej: ${cs.records_rejected || 0}</div>
      <div class="muted mono" style="font-size:11px">Last download: ${fmtTsEt(cs.last_download_ts)} (${fmtAge(cs.last_download_ts)}) · Validated: ${fmtAge(cs.last_validation_ts)}</div>
      <div class="muted mono" style="font-size:11px">Δ 1m/5m/15m Ctrs: +${d1.contracts_downloaded || 0}/+${d5.contracts_downloaded || 0}/+${d15.contracts_downloaded || 0} · Recs +${d1.records_recovered || 0}/1m</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">3. Timing, ETA &amp; Training</span><span class="tag">${esc(al.status || 'IDLE')}</span></div>
      <div class="mono" style="font-size:13px">Elapsed: <b>${fmtDur(elapsedS)}</b> · ETA: <b>${cs.workload_discovered ? etaTxt : 'DISCOVERING'}</b></div>
      <div class="muted mono" style="font-size:11px">Cycles: ${al.cycles_completed || 0} · Last training: ${fmtTsEt(al.last_cycle_ts)} (${fmtAge(al.last_cycle_ts)})</div>
      <div class="muted mono" style="font-size:11px">Last DB commit: ${fmtAge(cs.last_commit_ts)} · 429s: ${cs.rate_limit_429_count || 0} · Errs: ${cs.error_count || 0}</div></div>
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
      <td class="mono">${f.series}</td><td class="mono">${f.contracts_total ?? '–'}</td><td class="mono">${f.contracts_done ?? '–'}</td>
      <td class="mono">${f.contracts_verified ?? '–'}</td><td class="mono">${f.contracts_rejected ?? f.records_rejected ?? '–'}</td><td class="mono">${f.records_recovered ?? '–'}</td>
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

// Counts promotions by the checkpoint's CURRENT validation status, so invalidated historical promotions are never shown as valid models.
function cmosPromotionSummary(cs) {
  const al = (cs && cs.adaptive_learning) || {};
  const ck = (cs && cs.checkpoints) || [];
  if (!ck.length) return { known: false, historical: al.models_promoted || 0, validNow: null, invalidated: null, failed: null, text: `${al.models_promoted || 0} promoted (validity UNKNOWN: no checkpoint list)` };
  const invalidated = ck.filter(c => c.validation_status === 'MODEL_INVALIDATED').length;
  const failed = ck.filter(c => c.validation_status === 'VALIDATION_FAILED').length;
  const validNow = ck.filter(c => c.validation_status === 'PROMOTED' && c.deployment_status !== 'SUPERSEDED_INVALID').length;
  return { known: true, historical: al.models_promoted || 0, validNow, invalidated, failed, text: `${validNow} currently valid (${invalidated} historical promotions invalidated, ${failed} failed validation)` };
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
      <div class="mono" style="font-size:13px">Tested: <b>${al.models_tested || 0}</b> · Currently valid: <b>${cmosPromotionSummary(cs).validNow ?? '?'}</b> · Invalidated: <b>${cmosPromotionSummary(cs).invalidated ?? '?'}</b> · Failed: <b>${cmosPromotionSummary(cs).failed ?? '?'}</b></div>
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
    const nowS = snapNow(snap);   // heartbeat ages at snapshot time; snapshot age (below) uses the viewer clock
    const recAge = cs.heartbeat_ts != null ? Math.max(0, Math.round(nowS - cs.heartbeat_ts)) : cs.heartbeat_age_s;
    const trAge = al.heartbeat_ts != null ? Math.max(0, Math.round(nowS - al.heartbeat_ts)) : al.heartbeat_age_s;
    const pubTs = snap?.published_ts ?? snap?.generated_ts;
    const pubAge = pubTs != null ? Math.max(0, Math.round(Date.now() / 1000 - pubTs)) : null;
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
      <div class="muted mono" style="font-size:12px">Tested: ${al.models_tested || 0} · Currently valid: ${cmosPromotionSummary(cs).validNow ?? '?'} · Invalidated: ${cmosPromotionSummary(cs).invalidated ?? '?'} · Failed: ${cmosPromotionSummary(cs).failed ?? '?'}</div></div>`;

  if ($('tcmos-ckpt-count-pill')) $('tcmos-ckpt-count-pill').textContent = `${(cs.checkpoints || []).length} checkpoints`;

  const allCkptsList = cs.checkpoints || [];
  const latestCkpt = allCkptsList[0] || null;
  const prevValidCkpt = allCkptsList.find(c => c.validation_status === 'PROMOTED' && c.version !== latestCkpt?.version) || null;

  const stratBody = $('tcmos-strategy-body');
  if (stratBody) {
    const h100 = (snap?.three_accounts?.accounts || []).find(a => a.account_id === 'hermes-clean-100');
    const zeusT = snap?.zeus_execution_comparison?.taker;
    const mkRow = (name, trd, w, l, wr, pnl, dd, scope) => `<tr>
      <td><b>${esc(name)}</b></td>
      <td class="mono">${trd ?? '–'}</td><td class="mono">${w ?? '–'}</td><td class="mono">${l ?? '–'}</td>
      <td class="mono">${wr != null ? (Number(wr) * 100).toFixed(2) + '%' : '–'}</td>
      <td class="mono ${Number(pnl || 0) >= 0 ? 'pos' : 'neg'}">${pnl != null ? (Number(pnl) >= 0 ? '+' : '') + '$' + Number(pnl).toFixed(2) : '–'}</td>
      <td class="mono" title="Largest decline from a previous account-equity peak">${dd != null ? '$' + Number(dd).toFixed(2) : '–'}</td>
      <td class="muted">${scope}</td>
    </tr>`;
    const zW = Number(zeusT?.wins || 0), zL = Number(zeusT?.losses || 0), zT = zW + zL;
    const hW = Number(h100?.wins || 0), hL = Number(h100?.losses || 0), hT = hW + hL;
    const prevOos = prevValidCkpt?.eval?.historical_oos || {};
    stratBody.innerHTML =
      mkRow('CMOS — Latest Trained Challenger', oos.trades, oos.wins, oos.losses, oos.win_rate, oos.realized_net_pnl_usd, oos.max_drawdown_usd,
        `<span class="tag ${latestCkpt?.validation_status === 'PROMOTED' ? 'ok' : 'bad'}">${esc(latestCkpt?.validation_status || '–')}</span> ${esc(latestCkpt?.training_period || cs.current_month || '2026-02')} OOS ($100, +1¢ slip)`) +
      (prevValidCkpt
        ? mkRow(`CMOS — Previous Valid (${prevValidCkpt.version})`, prevOos.trades, prevOos.wins, prevOos.losses, prevOos.win_rate, prevOos.realized_net_pnl_usd, prevOos.max_drawdown_usd, 'Prior Valid Checkpoint')
        : '<tr><td><b>CMOS — Previous Valid Checkpoint</b></td><td colspan="7" class="muted">None available (no prior checkpoint passed validation).</td></tr>') +
      mkRow('Original ZEUS — Reference Strategy', zT, zW, zL, zT ? zW / zT : null, zeusT?.realized_net_pnl_usd, null, '<span class="tag warn">NOT COMPARABLE</span> Ongoing live paper ($100)') +
      mkRow('HERMES-008B — Fixed 10% Baseline', hT, hW, hL, hT ? hW / hT : null, h100 ? (h100.realized_net_cents || 0) / 100 : null, null, '<span class="tag warn">NOT COMPARABLE</span> Ongoing live paper ($100)');
  }

  const latestEl = $('tcmos-latest-test');
  if (latestEl) {
    const dtFmt = ts => ts ? new Date(ts * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) : 'NOT AVAILABLE';
    const tsFmt = ts => ts ? new Date(ts * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'NOT AVAILABLE';
    const dr = latestCkpt?.eval?.date_ranges || {};
    const endBankroll = 100.0 + Number(oos.realized_net_pnl_usd || 0);
    const valPassed = latestCkpt?.validation_status === 'PROMOTED';
    latestEl.innerHTML = `
      <div class="acct-card"><div class="acct-head"><span class="acct-title">${esc(latestCkpt?.version || al.latest_challenger_version || '–')}</span><span class="tag ${valPassed ? 'ok' : 'bad'}">${valPassed ? 'VALIDATION PASSED' : 'VALIDATION FAILED'}</span></div>
        <div class="mono" style="font-size:12px">Trained: <b>${tsFmt(latestCkpt?.created_ts || al.last_cycle_ts)}</b></div>
        <div class="muted mono" style="font-size:11px">Train range: ${dr.train_start_ts ? `${dtFmt(dr.train_start_ts)} → ${dtFmt(dr.train_end_ts)}` : esc(latestCkpt?.training_period || '2026-02')}</div>
        <div class="muted mono" style="font-size:11px">Test (OOS) range: ${dr.oos_start_ts ? `${dtFmt(dr.oos_start_ts)} → ${dtFmt(dr.oos_end_ts)}` : esc(latestCkpt?.training_period || '2026-02')}</div></div>
      <div class="acct-card"><div class="acct-head"><span class="acct-title">$100 Bankroll Outcome</span><span class="tag">$100 Start</span></div>
        <div class="mono" style="font-size:13px">Ending Bankroll: <b>$${endBankroll.toFixed(2)}</b> · Net P&amp;L: <b class="${Number(oos.realized_net_pnl_usd || 0) >= 0 ? 'pos' : 'neg'}">${Number(oos.realized_net_pnl_usd || 0) >= 0 ? '+' : ''}$${Number(oos.realized_net_pnl_usd || 0).toFixed(2)}</b></div>
        <div class="muted mono" style="font-size:12px" title="Largest decline from a previous account-equity peak">Max Drawdown: <b>$${Number(oos.max_drawdown_usd || 0).toFixed(2)}</b> · vs Prev Valid: ${prevValidCkpt ? `${dlt.net_pnl_delta_usd >= 0 ? '+' : ''}$${Number(dlt.net_pnl_delta_usd || 0).toFixed(2)}` : 'No prior valid model'}</div></div>
      <div class="acct-card"><div class="acct-head"><span class="acct-title">Trade Record (After Fees)</span><span class="tag">OOS</span></div>
        <div class="mono" style="font-size:13px">Trades: <b>${oos.trades ?? 0}</b> · <b>${oos.wins ?? 0}W / ${oos.losses ?? 0}L</b> · Win Rate: <b>${oos.win_rate != null ? (oos.win_rate * 100).toFixed(2) + '%' : '–'}</b></div>
        <div class="muted mono" style="font-size:12px">Gate: ${esc(al.status_reason || '–')}</div></div>`;
  }

  const slipWrap = $('tcmos-slippage-wrap');
  if (slipWrap) {
    const slipRows = latestCkpt?.eval?.slippage_table || [
      { slippage_cents: 1, trades: oos.trades, wins: oos.wins, losses: oos.losses, win_rate: oos.win_rate, net_pnl_usd: oos.realized_net_pnl_usd, max_drawdown_usd: oos.max_drawdown_usd },
    ];
    slipWrap.innerHTML = `<table><thead><tr><th>Slippage</th><th>Trades</th><th>W / L</th><th>Win %</th><th>Net P&amp;L</th><th>Max Drawdown</th></tr></thead><tbody>` +
      slipRows.map(s => `<tr>
        <td class="mono">+${s.slippage_cents}¢</td><td class="mono">${s.trades ?? '–'}</td><td class="mono">${s.wins ?? 0} / ${s.losses ?? 0}</td>
        <td class="mono">${s.win_rate != null ? (s.win_rate * 100).toFixed(2) + '%' : '–'}</td>
        <td class="mono ${Number(s.net_pnl_usd || 0) >= 0 ? 'pos' : 'neg'}">${s.net_pnl_usd != null ? (Number(s.net_pnl_usd) >= 0 ? '+' : '') + '$' + Number(s.net_pnl_usd).toFixed(2) : '–'}</td>
        <td class="mono">${s.max_drawdown_usd != null ? '$' + Number(s.max_drawdown_usd).toFixed(2) : '–'}</td>
      </tr>`).join('') + `</tbody></table>`;
  }

  const monthlyBody = $('tcmos-monthly-body');
  if (monthlyBody) {
    const validMonths = (cs.months || []).filter(m => m.net_pnl_usd != null || m.month === cs.current_month);
    monthlyBody.innerHTML = validMonths.map(m => {
      const hasRes = m.month === cs.current_month && oos.trades != null;
      const mdl = m.checkpoint_version || (hasRes ? (latestCkpt?.version || '–') : 'Pending');
      const trd = hasRes ? oos.trades : '–';
      const wl = hasRes ? `${oos.wins} / ${oos.losses}` : '–';
      const wr = hasRes && oos.win_rate != null ? `${(oos.win_rate * 100).toFixed(2)}%` : '–';
      const pnl = m.net_pnl_usd != null ? `$${Number(m.net_pnl_usd).toFixed(2)}` : (hasRes ? `$${Number(oos.realized_net_pnl_usd || 0).toFixed(2)} (in-progress)` : 'Recovering…');
      const chg = m.delta_vs_prev_usd != null ? `${Number(m.delta_vs_prev_usd) >= 0 ? '+' : ''}$${Number(m.delta_vs_prev_usd).toFixed(2)}` : 'Baseline / In-Progress';
      return `<tr><td class="mono">${esc(m.month)}</td><td class="mono">${esc(mdl)}</td><td class="mono">${trd}</td><td class="mono">${wl}</td><td class="mono">${wr}</td><td class="mono">${pnl}</td><td class="mono">${chg}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">No monthly evaluations completed yet.</td></tr>';
  }

  const splitsEl = $('tcmos-splits');
  if (splitsEl) {
    const mdlName = latestCkpt?.version || al.latest_challenger_version || 'Latest Challenger';
    const mkSplit = (title, tag, d) => `<div class="acct-card"><div class="acct-head"><span class="acct-title">${title}</span><span class="tag">${tag}</span></div>
      <div class="mono" style="font-size:12px">Trades: <b>${d.trades ?? 0}</b> (${d.wins ?? 0}W/${d.losses ?? 0}L) · Win%: <b>${d.win_rate != null ? (d.win_rate * 100).toFixed(2) + '%' : '–'}</b></div>
      <div class="muted mono" style="font-size:12px">Net P&amp;L: $${(d.realized_net_pnl_usd ?? d.net_pnl_usd ?? 0).toFixed(2)} · Max DD: $${(d.max_drawdown_usd ?? 0).toFixed(2)}</div></div>`;
    splitsEl.innerHTML = mkSplit(`1. Training (${mdlName})`, 'SAME MODEL · In-Sample', tr)
      + mkSplit(`2. Validation (${mdlName})`, 'SAME MODEL · Selection', va)
      + mkSplit(`3. Historical OOS (${mdlName})`, 'SAME MODEL · Unseen', oos)
      + mkSplit(`4. Prospective Paper (${al.deployed_paper_model_version || 'CMOS-V1'})`, 'SEPARATE · Live Research', pp);
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
      <div class="acct-card">${_svgSparkline(evs, '#a78bfa', 'Verified Independent Events (as of each checkpoint)', v => String(Math.round(v)))}
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
      <div class="mono" style="font-size:12px">Latest Challenger: <b>${esc(al.latest_challenger_version || '–')}</b> · Currently valid: <b>${cmosPromotionSummary(cs).validNow ?? '?'}</b></div>
      <div class="muted mono" style="font-size:11px">Latest OOS: Brier ${oos.brier_score ?? '–'} · Net $${oos.realized_net_pnl_usd != null ? Number(oos.realized_net_pnl_usd).toFixed(2) : '–'} · ${esc(al.status_reason || '–')}</div></div>
    <div class="acct-card"><div class="acct-head"><span class="acct-title">Paper Isolation</span><span class="tag">${esc(ap.status || 'PREPARED_INACTIVE')}</span></div>
      <div class="mono" style="font-size:12px">Adaptive Paper (<code>cmos_adaptive_100</code>): <b>${esc(ap.status || 'PREPARED_INACTIVE')}</b> ($${Number(ap.bankroll_usd || 100).toFixed(0)})</div>
      <div class="muted mono" style="font-size:11px">Separate CMOS V1 (<code>cmos_interrogator_100</code>): ${pp.trades || 0} settled · ${pp.open_positions || 0} open · Net $${Number(pp.net_pnl_usd || 0).toFixed(2)}</div></div>`;

  if ($('cmos-goto-training')) $('cmos-goto-training').onclick = () => $('nav-tab-training-cmos')?.click();
  if ($('cmos-goto-sync')) $('cmos-goto-sync').onclick = () => $('nav-tab-cmos-sync')?.click();
}

function renderSystemActivityStrip(snap) {
  const strip = $('sys-activity-strip');
  if (!strip || !snap) return;
  strip.style.display = 'block';
  const nowS = Date.now() / 1000;
  const pubTs = snap.published_ts ?? snap.generated_ts;
  const pubAge = pubTs != null ? Math.max(0, Math.round(nowS - pubTs)) : null;
  const pubStale = pubAge == null || pubAge > 90;
  const cs = snap.cmos_sync || {};
  const al = cs.adaptive_learning || {};
  const os = snap.os_services || {};
  const d1 = cs.deltas?.['1m'] || {};
  const mkPill = (lbl, st, cls) => `<span class="pill ${cls} mono" style="font-size:11px">${esc(lbl)}: ${esc(st)}</span>`;

  const recSt = cs.status || 'UNKNOWN';
  const recCls = (recSt === 'ACTIVE' || recSt === 'COMPLETED' || recSt === 'DISCOVERING' || recSt === 'DOWNLOADING') ? 'ok' : (recSt === 'STOPPED' || recSt === 'STALLED' || recSt === 'FAILED' ? 'bad' : 'warn');
  const trSt = al.status || 'IDLE';
  const trCls = trSt === 'TRAINING' ? 'ok' : (trSt === 'STALLED' || trSt === 'ERROR' ? 'bad' : 'warn');
  const colAlive = os.ws_critical?.alive;
  const papAlive = os.fwd_serve?.alive && os.zeus_head_to_head?.alive && os.cmos_paper_runner?.alive;
  const pubTxt = pubStale ? `PUBLISHER STALE (${pubAge ?? '?'}s) — Recovery status cannot currently be confirmed` : `LIVE (${pubAge}s ago)`;

  strip.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${mkPill('Recovery', `${recSt}${cs.worker_pid ? ` (PID ${cs.worker_pid})` : ''}`, recCls)}
        ${mkPill('Training', trSt, trCls)}
        ${mkPill('Collector', colAlive === true ? `RUNNING (${os.ws_critical.pid})` : (colAlive === false ? 'STOPPED' : 'UNKNOWN'), colAlive === true ? 'ok' : (colAlive === false ? 'bad' : 'warn'))}
        ${mkPill('Paper Workers', papAlive === true ? 'RUNNING' : (os.fwd_serve?.alive === false ? 'DEGRADED' : 'UNKNOWN'), papAlive === true ? 'ok' : 'warn')}
        ${mkPill('Publisher/Relay', pubTxt, pubStale ? 'bad' : 'ok')}
      </div>
      <div class="muted mono" style="font-size:11px">Op: <b>${esc(cs.operation || '–')}</b> · Δ1m Reqs +${d1.discovery_reqs || 0}, Ctrs +${d1.contracts_downloaded || 0}, Recs +${d1.records_recovered || 0}</div>
    </div>`;
}


// ---- Finding Better Trades — Shadow Experiment (read-only; every number comes from persisted experiment data) ----
let hunterSlipMode = 'same_trades';
function renderHunterShadow(snap) {
  const panel = $('hunter-panel'), body = $('hunter-body');
  if (!panel || !body) return;
  const h = snap?.hunter_shadow;
  if (!h || !Array.isArray(h.comparison)) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const st = h.status || {};
  const f1 = v => (v == null ? '–' : Number(v).toFixed(1));
  const usd = v => (v == null ? '–' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2));
  const loss = v => usd(v ? -v : 0);
  const ts = t => (t ? new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'never');
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, Date.now() / 1000 - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const per = h.periods || {};
  const testFrom = per.test ? ts(per.test[0]) : '?', testTo = per.test ? ts(per.test[1]) : '?';
  const row = c => `<tr style="${c.__best ? 'background:rgba(34,197,94,.10)' : ''}"><td>${esc(c.label)}${c.__best ? ' <span class="tag ok">highest replay net</span>' : ''}</td><td class="mono">${c.trades}</td><td class="mono">${c.wins}</td><td class="mono">${c.losses}</td><td class="mono">${c.win_pct == null ? '–' : f1(c.win_pct) + '%'}</td><td class="mono">${usd(c.net)}</td><td class="mono">${loss(c.biggest_loss)}</td></tr>`;
  const cmp = h.comparison.map(c => ({ ...c }));
  const traded = cmp.filter(c => c.trades > 0);
  const top = traded.length ? traded.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  if (top) top.__best = true;
  const verdict = !top ? 'No strategy placed a trade.' : top.net > 0
    ? 'The highest net in this replay is highlighted. It is one short period; no winner is declared.'
    : 'No strategy made a net profit in this replay. The highlighted row simply lost the least; no winner is declared.';
  const live = h.live;
  const useLive = !!(live && st.process_running);
  const src = useLive ? { name: 'PROSPECTIVE SHADOW — live search', f: live, t: live.ts } : { name: 'HISTORICAL REPLAY — test period', f: h.funnel, t: h.generated_ts };
  const fn = src.f || {};
  const reasons = Object.entries(fn.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li>${esc(k)}: <b>${v}</b></li>`).join('');
  const found = live?.contracts_found?.open_contracts;
  const best = fn.best_qualifying;
  const bands = h.bands || {};
  const bandRow = k => { const b = bands[k] || {}; return `<tr><td>${k}¢</td><td class="mono">${b.trades ?? '–'}</td><td class="mono">${b.win_pct == null ? '–' : f1(b.win_pct) + '%'}</td><td class="mono">${usd(b.net)}</td><td class="mono">${loss(b.biggest_loss)}</td></tr>`; };
  const slipRows = ((h.slippage || {}).baseline || []).map(x => { const r = x[hunterSlipMode]; return `<tr><td class="mono">+${x.slippage_c}¢</td><td class="mono">${r.trades}</td><td class="mono">${r.wins}</td><td class="mono">${r.losses}</td><td class="mono">${r.win_pct == null ? '–' : f1(r.win_pct) + '%'}</td><td class="mono">${usd(r.net)}</td><td class="mono">${usd(r.max_dd)}</td></tr>`; }).join('');
  const mk = h.markets || [];
  const groups = mk.filter(m => m.submarket === 'ALL').sort((a, b) => b.net_per_contract_set - a.net_per_contract_set);
  const mrow = m => `<tr><td>${esc(m.market)}</td><td>${esc(m.submarket)}</td><td class="mono">${m.events}</td><td class="mono">${m.evidence === 'ok' ? f1(m.win_pct) + '%' : '–'}</td><td class="mono">${m.evidence === 'ok' ? usd(m.net_per_contract_set) : '<span class="tag">INSUFFICIENT DATA</span>'}</td><td class="mono">${loss(m.biggest_loss)}</td></tr>`;
  const mhead = '<thead><tr><th>Market</th><th>Submarket (series / strike type)</th><th>Events</th><th>Win %</th><th>Net (1 contract/event)</th><th>Biggest loss</th></tr></thead>';
  const marketsHtml = groups.map(g => `<details class="pos-details" style="margin:4px 0"><summary class="mono">${esc(g.market)} — ${g.events} events · ${g.evidence === 'ok' ? f1(g.win_pct) + '% win · ' + usd(g.net_per_contract_set) : 'INSUFFICIENT DATA'}</summary>
      <div class="table-wrap"><table>${mhead}<tbody>${mrow(g)}${mk.filter(m => m.market === g.market && m.submarket !== 'ALL').map(mrow).join('')}</tbody></table></div></details>`).join('');
  const lossRows = Object.entries(h.loss_limit || {}).map(([bk, rows]) => rows.map(r => `<tr><td class="mono">$${bk}</td><td class="mono">${r.limit ? (r.limit * 100) + '%' : 'none'}</td><td class="mono">${r.trades}</td><td class="mono">${usd(r.net)}</td><td class="mono">${usd(r.max_dd)}</td><td class="mono">${usd(r.avoided_losses)}</td><td class="mono">${usd(r.forgone_profit)}</td></tr>`).join('')).join('');
  body.innerHTML = `
    <div class="acct-card" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Finding Better Trades — Shadow Experiment</h2>
        <span><span class="tag ${st.process_running ? 'ok' : ''}">${esc(st.label || 'HISTORICAL REPLAY')}</span>${st.stale ? ' <span class="tag bad">STALE RESULTS</span>' : ''}</span>
      </div>
      ${opsStrip(snap, 'shadow:hunter')}
      <div class="muted mono" style="font-size:12px;margin-top:6px">Paper simulation only — no real money; existing accounts untouched. Replay results generated ${ago(h.generated_ts)} (${esc(ts(h.generated_ts))} ET); recorded-quote data through ${esc(ts(h.data_freshness_ts))} ET (${ago(h.data_freshness_ts)}).</div>
      <div class="muted mono" style="font-size:12px;margin-top:4px">HISTORICAL REPLAY on the HERMES-008B market scope, $100 bankroll, test period ${esc(testFrom)} → ${esc(testTo)} ET. Win probabilities are measured training-period win rates (95% lower bound). Market/price-band cells with fewer than ${h.calibration?.min_cell_n ?? 30} measured outcomes are UNVALIDATED and not bought by the filtering strategies.</div>
      <div class="table-wrap" style="margin-top:10px"><table>
        <thead><tr><th>STRATEGY</th><th>TRADES</th><th>WINS</th><th>LOSSES</th><th>WIN %</th><th>NET P&amp;L</th><th>BIGGEST LOSS</th></tr></thead>
        <tbody>${cmp.map(row).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${esc(verdict)} A strategy with 0 trades found no contract with validated positive expected profit.</div>
    </div>
    <div class="acct-card" style="padding:14px 16px;margin-top:10px">
      <h3 style="margin:0 0 6px">What Barnacle is finding <span class="tag">${esc(src.name)}</span></h3>
      <div class="muted mono" style="font-size:12px">${useLive ? '' : 'The prospective shadow search process is not running, so no new searches are happening; figures are from the historical replay. '}Last completed search: <b>${esc(ts(src.t))} ET</b></div>
      <div class="muted mono" style="margin-top:8px;display:flex;gap:18px;flex-wrap:wrap">
        ${found != null ? `<span>Open contracts on Kalshi: <b>${Number(found).toLocaleString()}</b></span>` : ''}
        <span>Contracts examined: <b>${fn.examined ?? fn.contracts_examined ?? '–'}</b></span>
        <span>Meeting price requirements: <b>${fn.meets_price_requirements ?? '–'}</b></span>
        <span>Meeting profitability requirements: <b>${fn.meets_profitability_requirements ?? '–'}</b></span>
        <span>Rejected: <b>${fn.rejected ?? '–'}</b></span></div>
      <ul class="muted" style="margin:6px 0 0 18px;font-size:12px">${reasons}</ul>
      <div style="margin-top:10px" class="mono">${best ? `Contract: <b>${esc(best.ticker)}</b><br>Purchase price: <b>${Number(best.price).toFixed(2)}</b><br>Estimated win probability (95% lower bound, n=${best.n}): <b>${best.est_win_pct}%</b><br>Expected net profit per contract: <b>${usd(best.net_edge)}</b><br>Why selected: highest conservative expected net profit among validated candidates` : '<b>NO QUALIFYING TRADE — SKIPPED</b><div class="muted" style="font-size:12px">No contract met the minimum profitability and risk requirements. Requirements were not loosened to create activity.</div>'}</div>
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>PRICE BAND</th><th>TRADES</th><th>WIN %</th><th>NET P&amp;L</th><th>BIGGEST LOSS</th></tr></thead>
        <tbody>${['72-87', '88-89', '90-94', '95-98'].map(bandRow).join('')}</tbody></table></div>
      <div class="muted" style="font-size:12px">Price bands: whole recorded period, historical replay, existing rule, matched $100 sizing. 72–87¢ is outside the original ≥88% rule (exploratory).</div>
    </div>
    <details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Slippage sensitivity (historical replay)</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div style="margin:8px 0"><label class="muted">Mode: <select id="hunter-slip-mode"><option value="same_trades" ${hunterSlipMode === 'same_trades' ? 'selected' : ''}>Same trades, higher price</option><option value="reconsidered" ${hunterSlipMode === 'reconsidered' ? 'selected' : ''}>Strategy reconsiders purchases</option></select></label></div>
      <div class="table-wrap"><table><thead><tr><th>SLIPPAGE</th><th>TRADES</th><th>WINS</th><th>LOSSES</th><th>WIN %</th><th>NET P&amp;L</th><th>MAX DRAWDOWN</th></tr></thead><tbody>${slipRows}</tbody></table></div>
      <div class="muted" style="font-size:12px">Existing rule on the test period. Underlying-price movement sensitivity has not been run (it needs aligned underlying price history).</div></details>
    <details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Best performing markets (historical replay, whole recorded period)</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="muted" style="font-size:12px;margin:6px 0">1 contract per event, existing rule, fees included. Groups under 30 events are labelled INSUFFICIENT DATA. ${mk.some(m => m.repeatable_edge) ? '' : 'After correcting for multiple comparisons, no market or submarket shows a repeatable positive edge.'}</div>
      ${marketsHtml}</details>
    <details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Single-loss limits by bankroll (historical replay)</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="table-wrap"><table><thead><tr><th>BANKROLL</th><th>MAX LOSS / POSITION</th><th>TRADES</th><th>NET P&amp;L</th><th>MAX DRAWDOWN</th><th>LOSSES AVOIDED</th><th>PROFIT FORGONE</th></tr></thead><tbody>${lossRows}</tbody></table></div></details>`;
  const sel = $('hunter-slip-mode');
  if (sel) sel.onchange = () => { hunterSlipMode = sel.value; renderHunterShadow(currentSnap); };
}


// ===== Order-Book Bargain Hunter (shadow experiment card; same snapshot section feeds the Status Report) =====
function renderBargainHunter(snap) {
  const panel = $('bargain-panel'), body = $('bargain-body');
  if (!panel || !body) return;
  const b = snap && snap.bargain_hunter;
  if (!b) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const st = b.status || {}, lv = b.live || {}, sc = lv.scanning || {}, sh = lv.shadow || {}, rt = b.retro || null;
  const nowSec = snap.published_ts || Math.floor(Date.now() / 1000);
  const ts = t => (t ? new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' }) : 'never');
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, nowSec - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const usd = v => (v == null ? '–' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2));
  const n0 = v => (v == null ? '–' : Number(v).toLocaleString());
  const f2 = v => (v == null ? '–' : Number(v).toFixed(2));
  const pct = v => (v == null ? '–' : (100 * Number(v)).toFixed(0) + '%');
  const tag = (txt, cls) => `<span class="tag ${cls || ''}">${esc(txt)}</span>`;
  const cands = (lv.candidates_recent || []);
  const crow = c => `<tr><td class="mono">${esc(ts(c.ts))}</td><td class="mono">${esc(c.ticker)} ${esc(c.side.toUpperCase())}</td><td class="mono">${f2(c.ask)}</td><td class="mono">${n0(c.qty_top)} / ${n0(c.depth_within_2c)}</td><td class="mono">${f2(c.ref)}</td><td class="mono">-${c.discount_c}¢ (z ${c.z})</td><td class="mono">${c.spread_c}¢</td><td>${esc(c.status)}${c.reason ? ' — ' + esc(c.reason) : ''}</td></tr>`;
  const rej = Object.entries(lv.rejections || {}).sort((a, c) => c[1] - a[1]).map(([k, v]) => `<li>${esc(k)}: <b>${v}</b></li>`).join('');
  const orow = o => `<tr><td class="mono">${esc(o.ticker)} ${esc(o.side.toUpperCase())}</td><td class="mono">${esc(ts(o.entry_ts))}</td><td class="mono">${f2(o.entry_px)} × ${n0(o.qty)}</td><td class="mono">${usd(o.cost)}</td><td class="mono">resting sell ${f2(o.target)}</td><td class="mono">${esc(ts(o.deadline))}</td></tr>`;
  const unfilled = (sh.open || []).length;
  let retroHtml = '';
  if (rt) {
    const a = rt.answers || {};
    const mkRows = arr => (arr || []).map(r => {
      const c = r.conservative, o = r.optimistic;
      const cell = x => (x ? `${usd(x.net_per_trade)} <span class="muted">[${(x.ci95_cluster_event || []).map(f2).join(', ')}] fill ${pct(x.tp_fill_rate)}, n ${x.n}</span>` : '–');
      return `<tr><td class="mono">${esc(r.bucket)}</td><td class="mono">${n0(r.episodes)}</td><td class="mono">${pct(r.entry_rate_next)}</td><td class="mono">${cell(c)}</td><td class="mono">${cell(o)}</td></tr>`;
    }).join('');
    const dr = mkRows(rt.dose_response), drl = mkRows(rt.dose_response_liquid);
    const best = a.q6_q7_best_cell_pessimistic_queue_conservative_entry;
    const pos = a.cells_with_cluster_CI_above_zero || [];
    retroHtml = `<details class="pos-details" style="margin-top:10px"><summary class="mono"><b>Retrospective feasibility on recorded books</b> ${tag('SIMULATED — not prospectively verified', 'warn')} <span class="muted">generated ${esc(ago(rt.generated_ts))}</span></summary>
      <div class="muted" style="font-size:12px;margin:6px 0">${esc(rt.evidence_class || '')}</div>
      <ul style="margin:4px 0 4px 18px;font-size:12px">
        <li><b>1 Frequency:</b> ${esc(a.q1_frequency || '–')}</li>
        <li><b>3 Typical quantity:</b> ${n0((a.q3_quantity || {}).top_level_median_contracts)} contracts at the top level; ${n0((a.q3_quantity || {}).within_2c_median_contracts)} within 2¢ (~${usd((a.q3_quantity || {}).dollars_within_2c_median)})</li>
        <li><b>4 Accessible for:</b> median ${n0(((a.q4_accessible_for || {}).median))} s, p90 ${n0(((a.q4_accessible_for || {}).p90))} s (${pct((a.q4_accessible_for || {}).share_gone_within_15s)} gone within 15 s; resolution limited by recording cadence)</li>
        <li><b>5 Buyable:</b> ${pct((a.q5_buyable || {}).decision_book_optimistic)} on the decision book (optimistic) vs ${pct((a.q5_buyable || {}).next_book_conservative)} still offered on the next recorded book (conservative)</li>
        <li><b>6/7 Best resale cell (conservative entry, pessimistic queue):</b> ${best ? `${esc(best.scope)} / ${esc(best.bucket)} / ${esc(best.exit)}: net ${usd(best.net_per_trade)} per $10 trade, 95% CI [${(best.ci95_cluster_event || []).map(f2).join(', ')}], TP fill ${pct(best.tp_fill_rate)}, failed exits ${pct(best.failed_exit_rate)}, n ${best.n}` : '–'}</li>
        <li><b>Cells with a 95% interval above zero:</b> ${pos.length ? esc(pos.join('; ')) : '<b>none</b>'}</li>
      </ul>
      <div class="table-wrap"><table><thead><tr><th>DISCOUNT BUCKET</th><th>EPISODES</th><th>BUYABLE NEXT BOOK</th><th>CONSERVATIVE: net per $10 trade (tp+3¢, 5 min)</th><th>OPTIMISTIC BOUND (same book, first in line)</th></tr></thead><tbody>${dr}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:8px">Most generous region only (ask 20–80¢, spread ≤ 2¢; relative round-trip cost ≲ 10%) — ${n0(rt.liquid_candidates)} candidate episodes:</div>
      <div class="table-wrap"><table><thead><tr><th>DISCOUNT BUCKET</th><th>EPISODES</th><th>BUYABLE NEXT BOOK</th><th>CONSERVATIVE</th><th>OPTIMISTIC BOUND</th></tr></thead><tbody>${drl}</tbody></table></div>
      <div class="muted" style="font-size:12px">Control = unselected entries with no discount. A bucket must beat the control, not just cost; a failed take-profit is sold at the bid at the deadline with a taker fee.</div></details>`;
  }
  body.innerHTML = `<details class="pos-details panel-details" open><summary class="panel-summary"><div><h2 style="margin:0">Order-Book Bargain Hunter — Shadow Experiment</h2></div><span class="expand-lbl">▸ Expand / collapse</span></summary>
    <div class="acct-card" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px"><span class="muted mono" style="font-size:12px">find underpriced offer → buy → resting take-profit → fill → reinvest</span>
        <span>${tag(st.label || 'UNKNOWN', st.process_running ? 'ok' : '')}${st.stale ? ' ' + tag('STALE', 'bad') : ''}</span></div>
      ${opsStrip(snap, 'shadow:bargain')}
      <div class="muted" style="font-size:12px;margin:4px 0">Paper/shadow only — no real orders, no existing account touched. Labels: <b>OBSERVED</b> = recorded order books; <b>HYPOTHETICAL</b> = a candidate verdict on those books (nothing bought); <b>SIMULATED</b> = shadow purchases and resting sells modeled on later recorded books (book-touch, pessimistic queue). Modeled fills are not print-verified.</div>
      <div class="mono" style="display:flex;gap:18px;flex-wrap:wrap;margin:8px 0;font-size:12px">
        <span>Markets monitored: <b>${n0(sc.markets_monitored)}</b></span><span>Books examined: <b>${n0(sc.books_examined)}</b></span><span>Candidates examined: <b>${n0(sc.candidates_examined)}</b></span>
        <span>Last pass: <b>${esc(ago(sc.last_pass_ts))}</b></span><span>Last meaningful activity: <b>${esc(ago(sc.last_meaningful_activity_ts))}</b></span><span>Started: <b>${esc(ts(lv.prospective_start_ts))} ET</b></span></div>
      <h3 style="margin:10px 0 4px">Shadow account ${tag('SIMULATED', 'warn')}</h3>
      <div class="mono" style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px">
        <span>Bankroll: <b>${usd(sh.bankroll)}</b></span><span>Cash: <b>${usd(sh.cash)}</b></span><span>Shadow purchases: <b>${n0(sh.shadow_bought)}</b></span><span>Entries lost before fill: <b>${n0(sh.entries_lost_before_fill)}</b></span>
        <span>Closed: <b>${n0(sh.closed)}</b> (modeled fills <b>${n0(sh.modeled_fills)}</b>, verified <b>${n0(sh.verified_fills)}</b>)</span><span>Unfilled resting exits: <b>${n0(unfilled)}</b></span><span>Failed exits: <b>${n0(sh.failed_exits)}</b></span>
        <span>Net P&amp;L: <b>${usd(sh.net_pnl)}</b></span><span>Max drawdown: <b>${usd(sh.max_drawdown)}</b></span><span>Median hold: <b>${sh.median_hold_s == null ? '–' : n0(sh.median_hold_s) + ' s'}</b></span>
        <span>Capital-hours: <b>${f2(sh.capital_hours)}</b></span><span>Net per capital-$-hour: <b>${sh.net_per_capital_dollar_hour == null ? '–' : f2(sh.net_per_capital_dollar_hour)}</b></span></div>
      ${unfilled ? `<div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>OPEN SHADOW LOT</th><th>ENTRY TIME</th><th>PRICE × QTY</th><th>CAPITAL</th><th>EXIT ORDER</th><th>DEADLINE</th></tr></thead><tbody>${(sh.open || []).map(orow).join('')}</tbody></table></div>` : ''}
      <h3 style="margin:10px 0 4px">Recent candidate bargains ${tag('HYPOTHETICAL', 'warn')}</h3>
      ${cands.length ? `<div class="table-wrap"><table><thead><tr><th>OBSERVED</th><th>CONTRACT</th><th>EXEC ASK</th><th>QTY top / within 2¢</th><th>PRIOR REF MID</th><th>DISCOUNT</th><th>SPREAD</th><th>OUTCOME</th></tr></thead><tbody>${cands.map(crow).join('')}</tbody></table></div>` : '<div class="muted" style="font-size:12px">No candidate has met the rule since the scan started.</div>'}
      <div class="muted" style="font-size:12px;margin-top:6px">Rejections and reasons (cumulative):</div><ul class="muted" style="margin:2px 0 0 18px;font-size:12px">${rej || '<li>none yet</li>'}</ul>
      ${retroHtml}
    </div></details>`;
}

function renderOpportunityFunnel(snap) {
  const panel = $('funnel-panel'), body = $('funnel-body');
  if (!panel || !body) return;
  const fn = snap && snap.opportunity_funnel;
  if (!fn || !(fn.stages || []).length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const nowSec = snap.published_ts || Math.floor(Date.now() / 1000);
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, nowSec - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const n0 = v => (v == null ? '–' : Number(v).toLocaleString());
  const tag = (txt, cls) => `<span class="tag ${cls || ''}">${esc(txt)}</span>`;
  const stages = fn.stages;
  const maxC = Math.max(...stages.map(s => s.count || 0), 1);
  const w = c => (c > 0 ? Math.max(1.5, 100 * Math.log10(c + 1) / Math.log10(maxC + 1)) : 0);
  const stageRow = (s, i) => {
    const drops = (s.drops || []).filter(d => d.count > 0).slice(0, 4).map(d => `<li>${esc(d.reason)}: <b>${n0(d.count)}</b></li>`).join('');
    return `<div style="margin:8px 0">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-size:13px"><span><b>${i + 1}. ${esc(s.label)}</b> <span class="muted">${esc(s.unit || '')}</span></span><span class="mono"><b>${n0(s.count)}</b></span></div>
      <div style="height:10px;border-radius:5px;background:rgba(148,163,184,.18);overflow:hidden"><div style="width:${w(s.count).toFixed(1)}%;height:100%;background:var(--accent,#38bdf8)"></div></div>
      <div class="muted" style="font-size:11px;margin-top:2px">${esc(s.definition || '')}${s.approx ? ' — ' + esc(s.approx) : ''}</div>
      ${drops ? `<div class="muted" style="font-size:12px;margin-top:2px">Where it is lost / why:<ul style="margin:2px 0 0 18px">${drops}</ul></div>` : ''}</div>`;
  };
  const sRow = r => `<div class="acct-card" style="padding:10px 12px;min-width:240px;flex:1 1 260px">
      <div style="display:flex;justify-content:space-between;gap:6px"><b style="font-size:13px">${esc(r.name)}</b>${r.can_request ? tag('can search venue', 'ok') : tag('watchlist only', 'warn')}</div>
      <div class="muted" style="font-size:11px;margin:2px 0">${esc(r.scope || '')}</div>
      <div class="mono" style="font-size:12px;display:flex;flex-wrap:wrap;gap:4px 12px">
        <span>venue in scope <b>${n0(r.venue_in_scope)}</b></span><span>books 24h <b>${n0(r.books_24h)}</b></span><span>decided <b>${n0(r.decided_24h)}</b></span><span>orders <b>${n0(r.orders_24h)}</b></span><span>filled <b>${n0(r.filled_24h)}</b></span>${r.accounts != null ? `<span>accounts <b>${n0(r.active_accounts)}</b>/${n0(r.accounts)} active</span>` : ''}</div>
      <div class="muted" style="font-size:11px;margin-top:3px">${esc(r.discovery || '')}</div></div>`;
  const sh = fn.shadow || {}, lp = sh.last_pass || {}, oc = sh.outcomes || {};
  const ocLine = Object.entries(oc).map(([k, v]) => `${esc(k)}: ${n0(v.signals)} signals, ${n0(v.settled)} settled, ${n0(v.wins)} won${v.priced_settled ? ', net/contract sum ' + (v.net_per_contract_sum == null ? '–' : Number(v.net_per_contract_sum).toFixed(2)) : ''}`).join(' · ');
  const shRej = Object.entries(sh.reasons || {}).sort((a, c) => c[1] - a[1]).map(([k, v]) => `<li>${esc(k)}: <b>${n0(v)}</b></li>`).join('');
  const bn = (fn.bottlenecks || []).map(b => `<li><b>${esc(b.text)}</b> <span class="muted">— ${esc(b.evidence)}</span></li>`).join('');
  body.innerHTML = `<details class="pos-details panel-details" open><summary class="panel-summary"><div><h2 style="margin:0">Opportunity Funnel — where opportunities are lost</h2></div><span class="expand-lbl">▸ Expand / collapse</span></summary>
    <div class="acct-card" style="padding:14px 16px">
      <div class="muted" style="font-size:12px">Last 24 h, paper only, one snapshot (generated ${esc(ago(fn.generated_ts))}). Bars are log-scaled. Counts of contracts and orders are labelled per stage; the catalog's coverage state is its latest, not the state at first sight.</div>
      ${opsStrip(snap, 'shadow:discovery')}
      ${stages.map(stageRow).join('')}
      <h3 style="margin:14px 0 6px">Discovery coverage by strategy</h3>
      <div style="display:flex;flex-wrap:wrap;gap:10px">${(fn.strategies || []).map(sRow).join('')}</div>
      <h3 style="margin:14px 0 4px">Isolated discovery shadow ${tag('SHADOW — no orders', 'warn')}</h3>
      <div class="muted" style="font-size:12px">Hunter's favourite-carry requirement, requested from the full catalog excluding the old watchlist. ${lp.universe ? `Last pass ${esc(ago(lp.ts))}: ${n0(lp.universe)} open contracts, ${n0(lp.outside_watchlist)} outside the watchlist, ${n0(lp.matched)} matched the requirement, ${n0(lp.requested)} requested, ${n0(lp.inspected)} order books inspected, ${n0(lp.rule_met)} met the rule at the book, ${n0(lp.qualified)} qualified on validated evidence.` : 'No pass yet.'}</div>
      <div class="mono" style="font-size:12px;margin:4px 0">Distinct contracts inspected outside the watchlist: <b>${n0(sh.distinct_outside_watchlist_inspected)}</b> over ${n0((sh.passes || {}).n)} passes (${n0((sh.passes || {}).book_reads)} public book reads) · outcomes: ${ocLine || 'none settled yet'}</div>
      ${shRej ? `<ul class="muted" style="margin:2px 0 0 18px;font-size:12px">${shRej}</ul>` : ''}
      <h3 style="margin:14px 0 4px">Shared bottlenecks</h3><ul style="margin:2px 0 0 18px;font-size:12px">${bn}</ul>
    </div></details>`;
}

function renderAll(snap, connState = 'WAITING', force = false) {
  currentSnap = snap;
  renderStatusHeader(snap, connState);
  renderSystemActivityStrip(snap);
  renderScoreboard(snap, force);
  renderCmosPortfolioPanel(snap);
  renderZeusExecutionComparison(snap);
  renderZeusCapitalScaling(snap);
  renderWalkForwardResearch(snap);
  renderHermesSavings(snap);
  renderHunterShadow(snap);
  renderBargainHunter(snap);
  renderOpportunityFunnel(snap);
  renderPaperLab(snap);
  renderCollectors(snap);
  renderComponents(snap);
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

function buildStatusReportText(snap, opts) {
  const lite = !!(opts && opts.lite);
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
    `# CATEGORY: TRADING ACCOUNTS (REAL MONEY and PAPER SIM)`,
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
    lines.push(`- Status: ${reportStatus(a.runtime_status)} | Mode: ${isReal ? 'REAL MONEY' : 'PAPER SIM'}`);
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
  return lines.concat(buildStatusReportSections(snap, nowSec, lite)).join('\n');
}

// Status vocabulary shared by every report section: ACTIVE, PAUSED, RETIRED, TRAINING, BLOCKED, INACTIVE; STALE/UNKNOWN when freshness/data is missing.
function reportStatus(raw) {
  const u = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!u) return 'UNKNOWN';
  if (['ACTIVE', 'RUNNING', 'LIVE'].includes(u)) return 'ACTIVE';
  if (['STOPPED', 'DISABLED', 'IDLE', 'NOT_REGISTERED'].includes(u)) return 'INACTIVE';
  if (['HALTED', 'FAILED', 'ERROR'].includes(u)) return 'BLOCKED';
  return u;
}
function reportLiveStatus(alive, tsSec, staleS, onLabel, nowSec) {
  if (alive == null) return 'UNKNOWN';
  if (!alive) return 'INACTIVE';
  if (tsSec == null) return 'UNKNOWN';
  return (nowSec - tsSec) > staleS ? 'STALE' : (onLabel || 'ACTIVE');
}

// Everything the site shows outside three_accounts, written from the same snapshot keys the panels read (no second data path).
function buildStatusReportSections(snap, nowSec, lite) {
  const L = [];
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, nowSec - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const at = t => (t ? `${fmtEt(t)} (${ago(t)})` : 'UNKNOWN (no timestamp)');
  const usd = v => (v == null ? 'UNAVAILABLE' : fmtSignedUsd(Number(v)));
  const cash = v => (v == null ? 'UNAVAILABLE' : fmtUsd(Number(v)));
  const n0 = v => (v == null ? 'UNAVAILABLE' : Number(v).toLocaleString());
  const pl = snap.paper_lab, lp = pl && pl.live_paper, svc = (pl && pl.forward_service) || {};
  const fwdTick = svc.last_tick_ts || null;
  const fwdSt = reportLiveStatus(fwdTick != null, fwdTick, 300, 'ACTIVE', nowSec);
  const os = snap.os_services || {};
  const osRow = k => os[k] || null;

  L.push('---', '# STATUS LEGEND',
    'States: ACTIVE, PAUSED, RETIRED, TRAINING, BLOCKED, INACTIVE; STALE = reporting but not updated recently; UNKNOWN = no data published. Nothing is omitted when data is missing.',
    'Result kinds: REAL MONEY (live account), LIVE PAPER (forward paper, simulated fills), SHADOW / MODELED (not exchange-confirmed), HISTORICAL REPLAY / HISTORICAL ANALYSIS (past data, never trading performance).',
    'Sections below use the same snapshot keys as the website panels. A system missing from a section is not published to the relay, which does not mean it is stopped; unpublished systems are listed as UNKNOWN.', '');

  // ---- Paper forward accounts / experiments
  L.push('# CATEGORY: PAPER FORWARD EXPERIMENTS (LIVE PAPER, NO REAL MONEY)');
  if (!lp) {
    L.push('- paper_lab: UNKNOWN (not published in this snapshot)', '');
  } else {
    const T = lp.totals || {};
    L.push(`- Forward paper service: ${fwdSt} | last tick: ${at(fwdTick)} | ticks: ${n0(svc.ticks)} | errors: ${n0(svc.errors)}`);
    L.push(`- Totals: ${n0(T.accounts)} accounts (${n0(T.active_accounts)} active), ${n0(T.open_positions)} open positions, ${n0(T.closed_trades)} closed trades`);
    L.push('### Experiments');
    (lp.experiments || []).forEach(e => {
      const st = reportStatus(e.status);
      const eff = st === 'ACTIVE' && fwdSt !== 'ACTIVE' ? fwdSt : st;
      L.push(`- ${e.name || e.id} [${e.id}] | ${eff} | accounts ${e.active_accounts}/${e.accounts} active | Bankroll ${cash(e.bankroll)} | Equity ${cash(e.equity)} | Realized ${usd(e.realized_pnl)} | Open ${n0(e.open_positions)} | Closed ${n0(e.closed_trades)} | Win rate ${e.win_rate == null ? 'UNAVAILABLE' : (e.win_rate * 100).toFixed(0) + '%'} | LIVE PAPER`);
    });
    const ALIAS = { xp_b8f53a9912: 'ZEUS-001' };
    const named = (lp.accounts || []).filter(a => ALIAS[a.strategy]);
    L.push('### Named strategy accounts');
    if (!named.length) L.push('- ZEUS-001: UNKNOWN (strategy xp_b8f53a9912 not present in published accounts)');
    named.forEach(a => {
      const st = reportStatus(((lp.experiments || []).find(e => e.id === a.experiment) || {}).status);
      const eff = st === 'ACTIVE' && fwdSt !== 'ACTIVE' ? fwdSt : st;
      L.push(`- ${ALIAS[a.strategy]} (${a.strategy} v${a.version}, ${a.experiment}) | ${eff} | Bankroll ${cash(a.bankroll)} | Cash ${cash(a.cash)} | Equity ${cash(a.equity)} | Realized ${usd(a.realized_pnl)} | Open ${n0(a.open_positions)} | Closed ${n0(a.closed_trades)} (wins ${n0(a.wins)}) | Last activity: ${at(a.last_activity_ts)} | LIVE PAPER`);
    });
    const z = snap.zeus_execution_comparison;
    L.push('### ZEUS Maker vs Taker head-to-head ($100 each)');
    if (!z) L.push('- UNKNOWN (zeus_execution_comparison not published)');
    else {
      const series = z.series || {};
      const lastTs = lbl => { const a = series[lbl]; return a && a.length ? a[a.length - 1].ts : null; };
      const runner = osRow('zeus_head_to_head');
      [['taker', 'ZEUS-TAKER', 'LIVE PAPER (simulated taker fills, forward store)'], ['maker', 'ZEUS-MAKER', 'MODELED SHADOW (queue-modeled maker fills, not exchange-confirmed)']].forEach(([k, lbl, kind]) => {
        const a = z[k];
        if (!a) { L.push(`- ${lbl}: UNKNOWN (not published)`); return; }
        const t = lastTs(lbl);
        let st;
        if (k === 'maker') st = runner && runner.alive === false ? 'INACTIVE' : (runner && runner.alive ? reportLiveStatus(true, t, 180, 'ACTIVE', nowSec) : 'UNKNOWN');
        else st = fwdSt;
        const lastQual = (z.recent_orders && z.recent_orders[0] && z.recent_orders[0].decision_ts) || null;
        const why = k !== 'maker' ? '' : (runner && runner.alive === false ? ' | maker runner process not running; figures frozen at last update'
          : st === 'ACTIVE' ? ` | runner cycling (chart sample ${ago(t)}); idle until the next qualifying ZEUS decision, last one ${at(lastQual)}`
          : st === 'STALE' ? ' | runner process present but NOT cycling (no recent sample): possible disconnect' : '');
        L.push(`- ${lbl} | ${st} | ${a.execution_mode} | Start ${cash(a.starting_bankroll_usd)} | Equity ${cash(a.current_equity_usd)} | Cash ${cash(a.available_cash_usd)} | Realized ${usd(a.realized_net_pnl_usd)} (${a.return_pct == null ? 'UNAVAILABLE' : Number(a.return_pct).toFixed(2) + '%'}) | W/L ${a.wins}/${a.losses} | Executed contracts ${n0(a.executed_contracts)} | Unfilled ${n0(a.unfilled_orders)} | Fees ${cash(a.fees_usd)} | Last update: ${at(k === 'taker' ? fwdTick : t)} (${k === 'taker' ? 'forward store tick' : 'maker runner sample'}); comparison chart last sample ${at(t)} | ${kind}${why}`);
      });
      L.push(`- Note: ${z.modeled_note || 'ZEUS-MAKER fills are modeled estimates.'}`);
    }
    const rx = pl.resting_exits;
    L.push('### Resting sell-order execution experiment (live paper)');
    if (!rx) L.push('- UNKNOWN (resting_exits not published)');
    else {
      const bs = Object.entries(rx.by_status || {}).map(([k, v]) => `${k} ${n0(v)}`).join(', ') || 'none';
      const ev = Object.entries(rx.evidence_status || {}).map(([k, v]) => `${k} ${n0(v)}`).join(', ') || 'none';
      L.push(`- ${fwdSt} | orders posted ${n0(rx.orders_total)} (${bs}) | open now ${n0(rx.open_now)} | fills credited ${n0(rx.fills_total)} | first fill: ${at(rx.first_fill_ts)} | evidence: ${ev}`);
      L.push(`- ${rx.note || 'Fills credited only on verified recorded-trade evidence.'}`);
    }
    L.push('');
  }

  // ---- Adaptive training
  L.push('# CATEGORY: ADAPTIVE TRAINING / MODEL LEARNING');
  const cs = snap.cmos_sync;
  if (!cs || cs.available === false) L.push('- CMOS Progressive / Adaptive: UNKNOWN (cmos_sync not published)');
  else {
    const al = cs.adaptive_learning || {};
    const alive = cs.worker_pid_alive === undefined ? null : !!cs.worker_pid_alive;
    const hb = cs.heartbeat_ts || null;
    let syncSt = reportLiveStatus(alive, hb, Math.max(60, 6 * Number(cs.heartbeat_interval_s || 10)), 'ACTIVE', snapNow(snap));   // snapshot-time age, same basis as the CMOS Sync page
    if (syncSt === 'ACTIVE' && /train/i.test(String(al.operation || ''))) syncSt = 'TRAINING';
    L.push(`- CMOS Progressive (historical recovery + monthly training worker) | ${syncSt} | reported status ${cs.status || 'UNKNOWN'}${cs.status_reason ? ' - ' + cs.status_reason : ''} | operation ${cs.operation || 'UNKNOWN'} | month ${cs.current_month || 'UNKNOWN'} (${cs.current_month_pct == null ? 'UNAVAILABLE' : cs.current_month_pct + '%'}) | last heartbeat ${at(hb)} | records verified ${n0(cs.records_verified)} / expected ${n0(cs.records_expected)} | errors ${n0(cs.error_count)} | HISTORICAL DATA RECOVERY (not trading)`);
    const alSt = (syncSt === 'INACTIVE' || syncSt === 'UNKNOWN' || syncSt === 'STALE') ? syncSt : (/train/i.test(String(al.operation || '')) ? 'TRAINING' : 'ACTIVE');
    L.push(`- CMOS Adaptive learning loop | ${alSt} | ${al.status || 'UNKNOWN'} / ${al.operation || 'UNKNOWN'}${al.status_reason ? ' - ' + al.status_reason : ''} | cycles ${n0(al.cycles_completed)} | models tested ${n0(al.models_tested)} | promotions: ${cmosPromotionSummary(cs).text} | ${al.deployed_adaptive_model_version ? 'adaptive model deployed: ' + al.deployed_adaptive_model_version : 'no adaptive model currently deployed'} | independent events ${n0(al.independent_events)} (next trigger in ${n0(al.next_trigger_events)}) | latest challenger ${al.latest_challenger_version || 'none'} | last cycle ${at(al.last_cycle_ts)} | last heartbeat ${at(al.heartbeat_ts || hb)} | HISTORICAL TRAINING (not trading)`);
    L.push(`- CMOS-V1 deployed paper model: ${al.deployed_paper_model_version || 'UNKNOWN'} | adaptive model deployed to paper: ${al.deployed_adaptive_model_version || 'NONE'} | auto-promotion ${al.auto_promotion_enabled ? 'enabled' : 'disabled'} | paper auto-reload ${al.paper_auto_reload_enabled ? 'enabled' : 'disabled'} | last error ${al.last_error || 'none'}`);
    const ev = al.eval && al.eval.train;
    const oosE = al.eval && al.eval.historical_oos;
    if (oosE) L.push(`- Latest OUT-OF-SAMPLE evaluation (historical, not trading; this is the figure the Training page headlines): ${n0(oosE.trades)} trades, win rate ${oosE.win_rate == null ? 'UNAVAILABLE' : (oosE.win_rate * 100).toFixed(1) + '%'}, net ${usd(oosE.realized_net_pnl_usd)}, max drawdown ${cash(oosE.max_drawdown_usd)}`);
    if (ev) L.push(`- In-sample TRAINING evaluation (same model on its own training data; NOT a performance estimate): ${n0(ev.trades)} trades, win rate ${ev.win_rate == null ? 'UNAVAILABLE' : (ev.win_rate * 100).toFixed(1) + '%'}, net ${usd(ev.realized_net_pnl_usd)}, max drawdown ${cash(ev.max_drawdown_usd)}`);
  }
  const mi = snap.model_isolation;
  if (mi) Object.entries(mi).forEach(([k, v]) => { if (v && v.classification) L.push(`- Model isolation - ${k}: ${v.classification}${v.consumes_cmos === false ? ' (does not consume CMOS)' : ''}`); });
  L.push('');

  // ---- Data collection / services
  L.push('# CATEGORY: DATA COLLECTION & SERVICES');
  const SVC = { cmos_progressive: 'CMOS Progressive worker', live_money_worker: 'Live-money worker / publisher (real-money lane stays DISARMED unless the account section says otherwise)', fwd_serve: 'Forward paper evaluator (fwd serve)', zeus_head_to_head: 'ZEUS head-to-head maker runner', cmos_paper_runner: 'CMOS paper runner (legacy standalone script)', ws_critical: 'WebSocket critical-feed collector', dashboard: 'Local dashboard' };
  if (!Object.keys(os).length) L.push('- os_services: UNKNOWN (not published)');
  Object.keys(SVC).forEach(k => {
    const o = osRow(k);
    if (!o) { L.push(`- ${SVC[k]}: UNKNOWN (not reported)`); return; }
    const st = o.alive === null || o.alive === undefined ? 'UNKNOWN' : (o.alive ? 'ACTIVE' : 'INACTIVE');
    L.push(`- ${SVC[k]} | ${st}${o.alive ? ` | pid ${o.pid} | running since ${fmtEt(o.start_ts)}` : ''} | process scan at snapshot time`);
  });
  if (cs && cs.available !== false) {
    L.push(`- Historical API recovery: ${n0(cs.api_requests_done)} API requests done, ${n0(cs.contracts_done)}/${n0(cs.contracts_total)} contracts, ${cs.bytes_downloaded == null ? 'UNAVAILABLE' : (cs.bytes_downloaded / 1e6).toFixed(1) + ' MB'} downloaded, ${n0(cs.rate_limit_429_count)} rate-limit responses, ${n0(cs.retry_count)} retries | last download ${at(cs.last_download_ts)} | last commit ${at(cs.last_commit_ts)}`);
    if (cs.storage) L.push(`- Storage (${cs.storage.drive || 'drive UNKNOWN'}): ${cs.storage.free_gb == null ? 'UNAVAILABLE' : cs.storage.free_gb + ' GB free'} of ${cs.storage.total_gb == null ? 'UNAVAILABLE' : cs.storage.total_gb} GB${cs.storage.critical ? ' - CRITICAL' : ''}${cs.storage.warning ? ' - ' + cs.storage.warning : ''}`);
  }
  const col = snap.collectors && snap.collectors.collectors;
  if (!col) L.push('- Collectors (micro-record, market catalog, trade evidence, BTC reference, weather, BTC contract evidence): UNKNOWN - collector health not published in this snapshot.', '');
  else {
    col.forEach(r => L.push(`- ${r.label} | ${r.state} | process ${r.process_alive == null ? 'UNKNOWN' : r.process_alive ? 'running' : 'not running'} | ${r.data_kind}: ${at(r.data_ts)} (${collectorAgeText(r.data_age_s)} old, expected within ${collectorAgeText(r.max_age_s)}) | ${r.note}${r.last_error ? ' | last error: ' + r.last_error : ''}`));
    L.push('');
  }

  // ---- Opportunity funnel (same snapshot section the funnel card renders)
  L.push('# CATEGORY: OPPORTUNITY FUNNEL (LAST 24 H, PAPER, WHERE OPPORTUNITIES ARE FILTERED OUT)');
  const of = snap.opportunity_funnel;
  if (!of || !(of.stages || []).length) L.push('- Opportunity funnel: UNKNOWN (not published; needs the live-money worker restart)');
  else {
    L.push(`- generated ${at(of.generated_ts)} | stage counts are contracts or orders as labelled | catalog coverage state is the latest, not at first sight`);
    of.stages.forEach((s, i) => {
      L.push(`- ${i + 1}. ${s.label}: ${n0(s.count)} ${s.unit || ''} | ${s.definition || ''}`);
      (s.drops || []).filter(d => d.count > 0).slice(0, 4).forEach(d => L.push(`  - lost: ${d.reason} x${n0(d.count)}`));
    });
    (of.strategies || []).forEach(r => L.push(`- coverage ${r.name} | ${r.can_request ? 'can search venue' : 'watchlist only'} | venue in scope ${n0(r.venue_in_scope)} | books 24h ${n0(r.books_24h)} | decided ${n0(r.decided_24h)} | orders ${n0(r.orders_24h)} | filled ${n0(r.filled_24h)}${r.accounts != null ? ' | active accounts ' + n0(r.active_accounts) + '/' + n0(r.accounts) : ''}`));
    const osh = of.shadow || {}, olp = osh.last_pass || {};
    if (olp.universe) L.push(`- discovery shadow (SHADOW, no orders): ${n0(olp.outside_watchlist)} of ${n0(olp.universe)} open contracts outside the old watchlist | matched ${n0(olp.matched)} | inspected (cumulative) ${n0(osh.distinct_outside_watchlist_inspected)} | last pass ${at(olp.ts)}`);
    Object.entries(osh.reasons || {}).sort((x, y) => y[1] - x[1]).slice(0, 5).forEach(([k, v]) => L.push(`  - shadow rejected/unqualified: ${k} x${n0(v)}`));
    Object.entries(osh.outcomes || {}).forEach(([k, v]) => L.push(`  - shadow outcomes ${k}: ${n0(v.signals)} signals, ${n0(v.settled)} settled, ${n0(v.wins)} won`));
    (of.bottlenecks || []).forEach(b => L.push(`- bottleneck ${b.id}: ${b.text} | ${b.evidence}`));
  }
  L.push('');

  // ---- Research experiments (not trading)
  L.push('# CATEGORY: RESEARCH EXPERIMENTS (SHADOW / HISTORICAL, NOT TRADING PERFORMANCE)');
  const hs = snap.hunter_shadow;
  if (!hs) L.push('- Hunter shadow: UNKNOWN (not published)');
  else {
    const st = hs.status || {};
    const hsSt = st.process_running == null ? 'UNKNOWN' : (!st.process_running ? 'INACTIVE' : (st.stale ? 'STALE' : 'ACTIVE'));
    const lv = hs.live || {};
    L.push(`- Hunter shadow search | ${hsSt} | ${st.label || 'UNKNOWN'} | last heartbeat ${at(st.heartbeat_ts)} | results generated ${at(hs.generated_ts)} | contracts examined ${n0(lv.contracts_examined)} / meets price rules ${n0(lv.meets_price_requirements)} / meets profitability rules ${n0(lv.meets_profitability_requirements)} | SHADOW SEARCH + HISTORICAL REPLAY (no orders)`);
  }
  const bh = snap.bargain_hunter;
  if (!bh) L.push('- Order-Book Bargain Hunter: UNKNOWN (not published; needs the live-money worker restart)');
  else {
    const bst = bh.status || {}, bl = bh.live || {}, bs = bl.scanning || {}, bsh = bl.shadow || {};
    const bhSt = bst.process_running == null ? 'UNKNOWN' : (!bst.process_running ? 'INACTIVE' : (bst.stale ? 'STALE' : 'ACTIVE'));
    L.push(`- Order-Book Bargain Hunter (shadow) | ${bhSt} | ${bst.label || 'UNKNOWN'} | last pass ${at(bs.last_pass_ts)} | last meaningful activity ${at(bs.last_meaningful_activity_ts)} | markets monitored ${n0(bs.markets_monitored)} | books examined ${n0(bs.books_examined)} | candidates examined ${n0(bs.candidates_examined)}`);
    L.push(`  - SIMULATED shadow account: cash ${cash(bsh.cash)} of ${cash(bsh.bankroll)} | purchases ${n0(bsh.shadow_bought)} | closed ${n0(bsh.closed)} (modeled fills ${n0(bsh.modeled_fills)}, verified ${n0(bsh.verified_fills)}) | open resting exits ${n0((bsh.open || []).length)} | failed exits ${n0(bsh.failed_exits)} | net ${usd(bsh.net_pnl)} | max drawdown ${cash(bsh.max_drawdown)} | median hold ${bsh.median_hold_s == null ? 'UNAVAILABLE' : bsh.median_hold_s + ' s'} | net per capital-$-hour ${bsh.net_per_capital_dollar_hour == null ? 'UNAVAILABLE' : bsh.net_per_capital_dollar_hour}`);
    Object.entries(bl.rejections || {}).sort((x, y) => y[1] - x[1]).slice(0, 5).forEach(([k, v]) => L.push(`  - rejected: ${k} x${v}`));
    (bl.candidates_recent || []).slice(0, 3).forEach(c => L.push(`  - HYPOTHETICAL candidate ${c.ticker} ${c.side.toUpperCase()} ask ${c.ask} qty ${c.qty_top} discount ${c.discount_c}c -> ${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`));
    const br = bh.retro;
    if (br) {
      const ba = br.answers || {};
      L.push(`  - RETROSPECTIVE (simulated on recorded books, not prospective) generated ${at(br.generated_ts)}: ${ba.q1_frequency || ''}`);
      L.push(`  - retro buyable next book ${br.buyable_next == null ? 'UNAVAILABLE' : Math.round(100 * br.buyable_next) + '%'} | cells with 95% interval above zero: ${(ba.cells_with_cluster_CI_above_zero || []).length ? ba.cells_with_cluster_CI_above_zero.join('; ') : 'none'}`);
    }
  }
  if (!pl) L.push('- Execution sandbox replay / calibration: UNKNOWN (paper_lab not published)');
  else {
    const sb = pl.sandbox_replay;
    if (!sb) L.push('- Execution sandbox replay: UNKNOWN (no results published)');
    else {
      L.push(`- Execution sandbox replay | HISTORICAL REPLAY | results generated ${at(sb.generated_ts)} | ${sb.scope || ''}`);
      Object.entries(sb.runs || {}).forEach(([q, run]) => (run.variants || []).forEach(v => L.push(`  - ${q}/${v.variant}: start ${cash(v.start_cash)} -> equity ${cash(v.equity_marked)} | net (replay) ${usd(v.realized_net)} | entries filled ${n0(v.entries_filled)} | exits filled ${n0(v.exits_filled)} | capital recycling events ${n0(v.capital_recycling_events)} | cash conservation ${v.conservation_audit_ok ? 'OK' : 'AUDIT FAILED'}`)));
      if (sb.note) L.push(`  - ${sb.note}`);
    }
    const cal = pl.calibration;
    if (!cal) L.push('- Calibration layer: UNKNOWN (no results published)');
    else {
      L.push(`- Calibration layer | HISTORICAL ANALYSIS | results generated ${at(cal.generated_ts)} | ${cal.scope || ''} | entries ${n0(cal.entries)}`);
      (cal.exit_policies || []).forEach(x => L.push(`  - exit policy ${x.policy}: ${n0(x.entries)} entries, mean net/contract ${x.mean_net_per_contract == null ? 'UNAVAILABLE' : Number(x.mean_net_per_contract).toFixed(4)}, net per capital-hour ${x.net_per_capital_hour == null ? 'UNAVAILABLE' : Number(x.net_per_capital_hour).toFixed(5)}`));
    }
  }
  const wf = snap.walk_forward_research;
  if (!wf) L.push('- Walk-forward research: UNKNOWN (not published)');
  else Object.entries(wf).forEach(([k, v]) => { const o = (v && v.oos_weeks_2_to_5) || {}; L.push(`- Walk-forward ${k} | ARCHIVED HISTORICAL RESEARCH | ${(v && v.execution_model) || 'UNKNOWN model'} | OOS weeks 2-5: baseline ${usd(o.baseline_net_pnl)} vs learned ${usd(o.learned_net_pnl)} (from $100)`); });
  const hv = snap.hermes_savings;
  if (!hv || hv.available === false) L.push('- HERMES savings sweep: UNKNOWN (not published)');
  else L.push(`- HERMES savings sweep (paper account) | since ${fmtEt(hv.activated_ts)} | trading equity ${cash(hv.trading_equity_usd)} | savings ${cash(hv.total_savings_usd)} | combined ${cash(hv.combined_equity_usd)} | realized since activation ${usd(hv.realized_since_activation_usd)} | PAPER`);
  L.push('', `Report sections generated from snapshot published ${at(snap.published_ts)}.`);
  // ===== ALL COMPONENTS: one roll-up, identical to the System Components panel =====
  {
    const cm = snap.components;
    L.push('# CATEGORY: ALL COMPONENTS (single roll-up of everything running; same data as the System Components panel)');
    if (!cm || !cm.components) {
      L.push('- UNKNOWN - component roll-up not published in this snapshot.', '');
    } else {
      const order = ['TRADING', 'EVALUATING', 'TRAINING', 'COLLECTING', 'IDLE', 'BLOCKED', 'STALE', 'ERROR', 'STOPPED'];
      const tally = {}; cm.components.filter(c => c.view === 'active').forEach(c => { tally[c.status] = (tally[c.status] || 0) + 1; });
      L.push('Statuses: TRADING, EVALUATING, TRAINING, COLLECTING (doing work now); IDLE (running, nothing to do - reason given); BLOCKED (a gate is holding it); STALE (alive but nothing new); STOPPED; ERROR. Enabled is not the same as working.');
      L.push(`Live view: ${order.filter(k => tally[k]).map(k => k + ' ' + tally[k]).join(', ') || 'none'}. Inactive/retired: ${cm.components.filter(c => c.view !== 'active').length}. Generated ${at(cm.generated_ts)}.`, '');
      const line = c => `- ${c.name} | ${c.status}${c.integrity ? ' | integrity: ' + integrityLabel(c) : ''} | ${c.reason || '-'} | last activity: ${c.last_activity_ts ? at(c.last_activity_ts) : 'none observed'}${c.last_activity ? ' (' + c.last_activity + ')' : ''}` +
        `${componentProgress(c) ? ' | progress: ' + componentProgress(c) : ''}${c.performance ? ' | result: ' + c.performance : ''}${(c.recent || []).length ? ' | recent: ' + c.recent.join('; ') : ''}`;
      [...new Set(cm.components.filter(c => c.view === 'active').map(c => c.category))].forEach(cat => {
        L.push(`## ${cat} (live view)`);
        cm.components.filter(c => c.view === 'active' && c.category === cat).forEach(c => L.push(line(c)));
        L.push('');
      });
      const ina = cm.components.filter(c => c.view !== 'active');
      if (ina.length) {
        L.push(`## Inactive, stopped and retired (${ina.length})`);
        ina.forEach(c => L.push(`- ${c.name} | ${c.status} | ${c.category} | ${c.reason || '-'}`));
        L.push('');
      }
    }
  }
  // ===== INTEGRITY & AUTHORIZATION (SENTINEL): alarms and the public audit-ledger anchor, same data as the component rows =====
  {
    const sn = snap.components && snap.components.sentinel;
    L.push('# CATEGORY: INTEGRITY & AUTHORIZATION (SENTINEL; ORIGIN lineage and EQUILIBRIUM contracts are in the same registry)');
    if (!sn) {
      L.push('- No integrity registry is published in this snapshot (SENTINEL has no registered components yet or the report could not be built).', '');
    } else {
      const al = sn.alarms || [];
      L.push(`Alarms: ${al.length ? al.length : 'none'}. Statuses: VERIFIED, BLOCKED, UNREGISTERED, MISMATCH, UNRESOLVED, REVOKED, DISCOVERY BYPASS, STALE.`);
      al.forEach(a => L.push(`- ALARM | ${a.component_id} | ${a.integrity} | ${a.text} | reason class: ${a.reason_class || '-'} | event: ${a.event_ts ? at(a.event_ts) : 'unknown'} | affected: ${a.affected_operation} | last valid state: ${a.last_valid_ts ? at(a.last_valid_ts) : 'none recorded'}`));
      (sn.components || []).forEach(c => L.push(`- ${c.name} | ${integrityLabel(c)} | enforcing: ${c.enforcing ? 'yes' : 'no (shadow period)'} | last authorized entry: ${c.last_valid_ts ? at(c.last_valid_ts) : 'none'}`));
      if (sn.ledger) L.push(`- Audit ledger anchor | chain ${sn.ledger.chain_ok ? 'VERIFIED' : 'FAILED VERIFICATION'} | sequence ${sn.ledger.ledger_seq} | head ${sn.ledger.head_hash} | snapshot ${at(sn.ledger.snapshot_ts)} | ledger id ${sn.ledger.ledger_id} (tamper-evident reference, not proof against an actor who controls both the ledger and the anchors)`);
      L.push('');
    }
  }
  // ===== Page detail: everything the three pages show that the sections above only summarise =====
  try { buildReportDetailSections(snap, nowSec, lite).forEach(x => L.push(x)); } catch (e) { L.push('# CATEGORY: PAGE DETAIL', `- Detail sections could not be built: ${e && e.message}`, ''); }
  return L;
}

// Detail written from the same snapshot keys the three pages render (Portfolio, #cmos-sync, #training-cmos). No second data path.
function buildReportDetailSections(snap, nowSec, lite) {
  const L = [];
  const skip = (what, n) => L.push(`- ${what}: ${n} rows omitted in the LITE report (counts only); use Copy Status Report for the full list.`);
  const ref = snapNow(snap);
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, nowSec - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const at = t => (t ? `${fmtEt(t)} (${ago(t)})` : 'never');
  const usd = v => (v == null ? '–' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2));
  const sg = v => (v == null ? '–' : (Number(v) >= 0 ? '+' : '-') + '$' + Math.abs(Number(v)).toFixed(2));
  const n0 = v => (v == null ? '–' : Number(v).toLocaleString());
  const fx = (v, d) => (v == null ? '–' : Number(v).toFixed(d));
  const pc = v => (v == null ? '–' : (Number(v) * 100).toFixed(1) + '%');
  const pw = v => (v == null ? '–' : Number(v).toFixed(1) + '%');

  // ---------------- PORTFOLIO PAGE ----------------
  if (lite) L.push('# LITE REPORT: full ledgers and long row lists are omitted below and replaced by counts; every summary, status and table of limited size is still included.', '');
  L.push('# CATEGORY: PORTFOLIO PAGE DETAIL (every table behind the website cards; kinds are labelled, none is real-money performance unless marked REAL)');
  const hs = snap.hunter_shadow;
  if (hs && Array.isArray(hs.comparison)) {
    const st = hs.status || {}, per = hs.periods || {};
    L.push(`## Finding Better Trades - shadow experiment (${st.label || 'HISTORICAL REPLAY'}${st.stale ? ', STALE RESULTS' : ''}) | HISTORICAL REPLAY + SHADOW SEARCH, no orders`);
    L.push(`- replay generated ${at(hs.generated_ts)} | recorded-quote data through ${at(hs.data_freshness_ts)} | test period ${per.test ? fmtEt(per.test[0]) + ' -> ' + fmtEt(per.test[1]) : 'UNKNOWN'} | $100 bankroll, HERMES-008B market scope`);
    hs.comparison.forEach(c => L.push(`  - strategy ${c.label}: trades ${c.trades}, wins ${c.wins}, losses ${c.losses}, win ${c.win_pct == null ? '–' : fx(c.win_pct, 1) + '%'}, net ${usd(c.net)}, biggest loss ${usd(c.biggest_loss ? -c.biggest_loss : 0)}`));
    const lv = hs.live, src = lv && st.process_running ? { n: 'PROSPECTIVE SHADOW (live search)', f: lv } : { n: 'HISTORICAL REPLAY (search process not running)', f: hs.funnel || {} };
    const fn = src.f || {};
    L.push(`- What Barnacle is finding [${src.n}] | open contracts on Kalshi ${n0(lv && lv.contracts_found && lv.contracts_found.open_contracts)} | examined ${n0(fn.examined ?? fn.contracts_examined)} | meets price rules ${n0(fn.meets_price_requirements)} | meets profitability rules ${n0(fn.meets_profitability_requirements)} | rejected ${n0(fn.rejected)}`);
    Object.entries(fn.reasons || {}).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push(`  - reason: ${k} x${n0(v)}`));
    const bq = fn.best_qualifying;
    L.push(bq ? `  - best qualifying: ${bq.ticker} price ${fx(bq.price, 2)} est. win ${bq.est_win_pct}% (95% lower bound, n=${bq.n}) expected net/contract ${usd(bq.net_edge)}` : '  - NO QUALIFYING TRADE - SKIPPED (requirements were not loosened to create activity)');
    ['72-87', '88-89', '90-94', '95-98'].forEach(k => { const b = (hs.bands || {})[k] || {}; L.push(`  - price band ${k}c: trades ${b.trades ?? '–'}, win ${b.win_pct == null ? '–' : fx(b.win_pct, 1) + '%'}, net ${usd(b.net)}, biggest loss ${usd(b.biggest_loss ? -b.biggest_loss : 0)}`); });
    ((hs.slippage || {}).baseline || []).forEach(x => ['same_trades', 'reconsidered'].forEach(m => { const r = x[m]; if (r) L.push(`  - slippage +${x.slippage_c}c [${m === 'same_trades' ? 'same trades, higher price' : 'strategy reconsiders purchases'}]: trades ${r.trades}, W/L ${r.wins}/${r.losses}, win ${r.win_pct == null ? '–' : fx(r.win_pct, 1) + '%'}, net ${usd(r.net)}, max drawdown ${usd(r.max_dd)}`); }));
    const mk = hs.markets || [];
    mk.filter(m => m.submarket === 'ALL').sort((a, b) => b.net_per_contract_set - a.net_per_contract_set).forEach(g => {
      L.push(`  - market ${g.market}: ${g.events} events | ${g.evidence === 'ok' ? 'win ' + fx(g.win_pct, 1) + '%, net/contract-set ' + usd(g.net_per_contract_set) : 'INSUFFICIENT DATA'} | biggest loss ${usd(g.biggest_loss ? -g.biggest_loss : 0)} | repeatable edge after multiple-comparison correction: ${g.repeatable_edge ? 'YES' : 'no'}`);
      mk.filter(m => m.market === g.market && m.submarket !== 'ALL').forEach(m => L.push(`    - submarket ${m.submarket}: ${m.events} events | ${m.evidence === 'ok' ? 'win ' + fx(m.win_pct, 1) + '%, net ' + usd(m.net_per_contract_set) : 'INSUFFICIENT DATA'}`));
    });
    Object.entries(hs.loss_limit || {}).forEach(([bk, rows]) => rows.forEach(r => L.push(`  - single-loss limit bankroll $${bk} cap ${r.limit ? r.limit * 100 + '%' : 'none'}: trades ${r.trades}, net ${usd(r.net)}, max drawdown ${usd(r.max_dd)}, losses avoided ${usd(r.avoided_losses)}, profit forgone ${usd(r.forgone_profit)}`)));
    L.push('');
  }

  const bh = snap.bargain_hunter;
  if (bh) {
    const lv = bh.live || {}, sh = lv.shadow || {};
    L.push('## Order-Book Bargain Hunter - detail (SIMULATED / HYPOTHETICAL, no orders)');
    (sh.open || []).forEach(o => L.push(`- open shadow lot ${o.ticker} ${String(o.side).toUpperCase()} | entry ${at(o.entry_ts)} | ${fx(o.entry_px, 2)} x ${n0(o.qty)} | capital ${usd(o.cost)}`));
    (lv.candidates_recent || []).forEach(c => L.push(`- HYPOTHETICAL candidate observed ${at(c.ts)} | ${c.ticker} ${String(c.side).toUpperCase()} | exec ask ${fx(c.ask, 2)} | qty top/within 2c ${n0(c.qty_top)}/${n0(c.depth_within_2c)} | prior ref mid ${fx(c.ref, 2)} | discount ${c.discount_c}c | status ${c.status}${c.reason ? ' (' + c.reason + ')' : ''}`));
    Object.entries(lv.rejections || {}).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push(`- rejection (cumulative): ${k} x${n0(v)}`));
    const rt = bh.retro;
    if (rt) {
      const row = r => { const c = r.conservative, o = r.optimistic; const cell = x => x ? `${usd(x.net_per_trade)} [${(x.ci95_cluster_event || []).map(v => fx(v, 2)).join(', ')}] fill ${pc(x.tp_fill_rate)} n ${x.n}` : '–'; return `- retro bucket ${r.bucket}: episodes ${n0(r.episodes)} | buyable next book ${pc(r.entry_rate_next)} | conservative ${cell(c)} | optimistic bound ${cell(o)}`; };
      (rt.dose_response || []).forEach(r => L.push(row(r)));
      (rt.dose_response_liquid || []).forEach(r => L.push(row(r).replace('- retro bucket', '- retro (liquid region) bucket')));
    }
    L.push('');
  }

  const pl = snap.paper_lab, lp = pl && pl.live_paper;
  if (lp) {
    const accs = (lp.accounts || []).slice().sort((a, b) => (a.experiment === b.experiment ? (b.closed_trades - a.closed_trades) : String(a.experiment).localeCompare(String(b.experiment))));
    L.push(`## Every paper account (${accs.length}) - LIVE PAPER`);
    if (lite) skip('per-account rows', accs.length); else accs.forEach(a => L.push(`- ${a.strategy} v${a.version} [${a.experiment}] ${a.account} | bankroll ${usd(a.bankroll)} | cash ${usd(a.cash)} | equity ${usd(a.equity)} | realized ${sg(a.realized_pnl)} | open ${a.open_positions} | closed ${a.closed_trades} | win ${a.closed_trades ? pc(a.wins / a.closed_trades) : '–'}`));
    L.push('');
    L.push(`## Open paper positions (${n0(lp.open_positions_total)}; ${(lp.open_positions || []).length} listed) - LIVE PAPER`);
    (lp.open_positions || []).forEach(o => L.push(`- ${o.account} | ${o.ticker} ${String(o.side).toUpperCase()} x${o.qty} | entry ${fx(o.entry_price, 2)} at ${at(o.entry_ts)} | ${o.resting_sell ? `resting sell @ ${fx(o.resting_sell.price, 2)} (${o.resting_sell.status}${o.resting_sell.filled ? ', ' + o.resting_sell.filled + ' filled' : ''}; evidence ${o.resting_sell.evidence})` : 'no resting sell posted'}`));
    L.push('');
    L.push(`## Recent completed paper trades (${(lp.recent_closed || []).length}) - LIVE PAPER`);
    if (lite) skip('recent completed paper trades', (lp.recent_closed || []).length); else (lp.recent_closed || []).forEach(t => L.push(`- closed ${at(t.exit_ts)} | ${t.account} | ${t.ticker} ${String(t.side).toUpperCase()} x${t.qty} | ${fx(t.entry_price, 2)} -> ${fx(t.exit_price, 2)} | ${t.exit_kind || ''} | net ${sg(t.net_pnl)}`));
    L.push('');
    const rx = pl.resting_exits;
    if (rx) {
      L.push('## Resting sell orders - detail (LIVE PAPER)');
      const rd = rx.evidence_reader || {};
      L.push(`- trade-evidence reader heartbeat ${at(rd.heartbeat_ts)}${rd.order_trades ? ` | last cycle: ${rd.order_trades.open_order_tickers ?? 0} open-order tickers, ${rd.order_trades.read ?? 0} read, ${rd.order_trades.already_covered ?? 0} already covered, ${rd.order_trades.errors ?? 0} errors` : ''}`);
      (rx.by_day || []).forEach(d => L.push(`- ${d.date} UTC: posted ${n0(d.posted)}, verified window ${n0(d.verified)}, unverified (routing defect, fixed Nov 19) ${n0(d.unverified_no_trade_store)}, unverified (no trade coverage) ${n0(d.unverified_no_coverage)}`));
      (rx.recent_fills || []).forEach(f => L.push(`- fill ${at(f.ts)} | ${f.account} | ${f.ticker} | ${f.qty} @ ${fx(f.price, 2)} | net proceeds ${usd(f.proceeds_net)} | P&L ${sg(f.pnl)} | evidence ${f.evidence}`));
      if (!(rx.recent_fills || []).length) L.push('- no resting-sell fills recorded yet');
      L.push('');
    }
    const cal = pl.calibration;
    if (cal && cal.folds) {
      L.push('## Probability calibration folds (HISTORICAL ANALYSIS)');
      Object.entries(cal.folds).forEach(([k, f]) => L.push(`- test period ${k}: test entries ${n0(f.test_entries)} | frozen cells ${f.frozen_cells ?? '–'} | replicated ${f.replicated_cells ?? '–'} | net-positive after fees ${f.net_positive_after_fee_cells ?? '–'} | Brier gain ${f.brier_gain == null ? '–' : Number(f.brier_gain).toFixed(5)}`));
      if (cal.verdict) L.push(`- verdict: ${cal.verdict}`);
      L.push('');
    }
  }

  const hv = snap.hermes_savings;
  if (hv && hv.available) {
    const tx = hv.transactions || [];
    L.push(`## HERMES savings - transaction history (${tx.length}) | SIMULATED SAVINGS LEDGER`);
    L.push(`- initial transfer ${usd(hv.starting_savings_transfer_usd)} | new savings since activation ${sg(hv.post_activation_savings_usd)} | trading bankroll remaining ${usd(hv.trading_equity_usd)} (target ${usd(hv.target_principal_usd)}) | today ${sg(hv.today_savings_usd)} | week ${sg(hv.weekly_savings_usd)} | month ${sg(hv.monthly_savings_usd)} | conservation diff ${usd(hv.conservation_diff_usd)}`);
    if (lite) skip('savings transactions', tx.length); else tx.forEach(t => L.push(`- ${at(t.ts)} | ${t.entry_type} | ${sg(t.amount_usd)} | savings balance after ${usd(t.balance_after_usd)} | trading equity after ${usd(t.trading_equity_after_usd)} | ${t.detail || ''}`));
    L.push('');
  }

  const accts = (snap.three_accounts && snap.three_accounts.accounts) || [];
  const arch = accts.filter(a => a.archived);
  L.push(`## Archived experiments (${arch.length} accounts; each is also listed above with its full figures)`);
  arch.forEach(a => L.push(`- ${a.label || a.codename} | ${reportStatus(a.runtime_status)} | equity ${usd((a.equity_cents ?? 0) / 100)} | realized ${sg((a.realized_net_cents || 0) / 100)} | wins/losses ${a.wins ?? 0}/${a.losses ?? 0}`));
  L.push('');

  const ct = snap.completed_trades || [];
  L.push(`## Completed transactions ledger (${ct.length} transactions; newest first as published)`);
  if (lite) { const net = ct.reduce((a, t) => a + Number(t.realized_net_usd ?? t.net_pnl_usd ?? 0), 0), w = ct.filter(t => t.result === 'WIN').length; L.push(`- ${ct.length} completed transactions, ${w} wins, aggregate net ${sg(net)} (per-trade rows omitted in the LITE report)`); } else ct.forEach(t => L.push(`- ${fmtEt(t.closed_ts || t.ts)} | ${t.account_label || t.account_id} | ${t.ticker} ${t.side || '–'} x${t.contracts ?? 0} | invested ${usd(t.invested_usd)} | fee ${usd(t.fee_usd || 0)} | net ${sg(t.realized_net_usd ?? t.net_pnl_usd ?? 0)} | ${t.result || t.status || 'SETTLED'}${t.kind === 'REAL' ? ' | REAL-KIND' : ''}`));
  L.push('');
  L.push('## Page notes (static text on the Portfolio page)',
    '- Real vs. Simulated: ARES-005 (REAL) reflects reconciled Kalshi shard 2 cash, actual fills and exchange settlements. SIMULATED accounts model order-book fills on independent ledgers.',
    '- Hypothetical sell-now estimates walk live bid-side depth minus estimated Kalshi taker fees. Barnacle holds to settlement; sell-now figures are informational, never completed sales.',
    '- Read-only and sanitized: no trading controls, API keys, skipped signals or strategy thresholds are exposed.', '');

  // ---------------- CMOS SYNC PAGE ----------------
  const cs = snap.cmos_sync;
  { const zs = snap.zeus_capital_scaling;
    L.push('# CATEGORY: ZEUS CAPITAL SCALING ($1,000 / $5,000 baselines vs EQUILIBRIUM-managed variants)');
    if (!zs || !(zs.accounts || []).length) L.push('- UNKNOWN (zeus_capital_scaling not published)');
    else {
      zs.accounts.forEach(x => L.push(`- ${x.label} | ${x.controller} | Equity ${usd(x.current_equity_usd)} | Realized ${sg(x.realized_net_pnl_usd)} | Return ${x.return_pct}% | MaxDD ${x.max_drawdown_pct}% | Exposure ${x.exposure_pct}% | Fees ${usd(x.fees_usd)} | Missed ${x.missed_opportunities} | Cuts ${x.allocation_reductions || 0}`));
      (zs.validation || []).forEach(v => { const b = v.baseline || {}, m = v.managed || {}, p = v.parity || {}; L.push(`- VALIDATION $${v.size_usd} ${String(v.venue).toUpperCase()} | parity ${p.status || 'UNKNOWN'} (${p.detail || ''}) | candidates ${b.candidates_received}->${m.candidates_received} | decisions ${b.decisions}->${m.decisions} | orders ${b.orders_attempted}->${m.orders_attempted} | fills ${b.fills}->${m.fills} | cuts ${m.allocation_reductions || 0} | exposure ${b.exposure_pct}%->${m.exposure_pct}% | fees ${usd(b.fees_usd)}->${usd(m.fees_usd)} | net ${sg(b.realized_net_pnl_usd)}->${sg(m.realized_net_pnl_usd)} | maxDD ${b.max_drawdown_pct}%->${m.max_drawdown_pct}% | missed ${b.missed_opportunities}->${m.missed_opportunities ?? m.missed}`); });
      L.push('- NOTE: EQUILIBRIUM policy eq-demo-0.1 is EXPERIMENTAL and uncalibrated; zero trades is not proof the accounts work; SENTINEL status of these components: UNAPPROVED (no owner signature).');
      if (lite) L.push(`- (LITE: ${(zs.recent_allocation_decisions || []).length} recent allocation decisions omitted)`);
      else (zs.recent_allocation_decisions || []).forEach(d => L.push(`  - ${fmtEt(d.ts)} | ${d.account_id} | ${d.ticker} | ${d.outcome} ${d.approved_qty}/${d.baseline_qty} | ${d.reasons || 'no constraint binding'} | ${d.allocation_id}`));
    }
    L.push(''); }
  L.push('# CATEGORY: CMOS SYNC PAGE (#cmos-sync) - HISTORICAL DATA RECOVERY + ADAPTIVE LEARNING, NOT TRADING');
  if (!cs || !cs.available) {
    L.push(`- UNKNOWN or PAUSED: ${(cs && cs.status_reason) || 'cmos_sync not published'}`, '');
  } else {
    const { status, reason, hbAge } = cmosSyncState(cs, snap);
    const d = k => (cs.deltas && cs.deltas[k]) || {};
    const al = cs.adaptive_learning || {};
    const fmtDur = s => s == null ? '–' : (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`));
    const sa = t => (t != null ? `${fmtEt(t)} (${Math.max(0, Math.round(ref - t))}s before snapshot)` : 'NOT AVAILABLE');
    L.push(`- Page status: ${status} | ${reason} | heartbeat ${hbAge != null ? hbAge + 's' : '–'} at snapshot time (snapshot itself is ${Math.max(0, Math.round(nowSec - ref))}s old now) | month ${cs.current_month || '–'} | op ${String(cs.operation || '–').toUpperCase()} | last OK op ${cs.last_success_op || '–'}`);
    const curM = (cs.months || []).find(m => m.month === cs.current_month);
    L.push(`- 1 Historical discovery [${cs.current_series || cs.current_month || '–'}]: discovered ${n0(cs.contracts_total ?? (curM && curM.contracts_total))} | requests ${n0(cs.discovery_requests_done)} | last discovery ${sa(cs.last_discovery_ts)} | delta requests 1m/5m/15m +${d('1m').discovery_reqs || 0}/+${d('5m').discovery_reqs || 0}/+${d('15m').discovery_reqs || 0} | contracts discovered +${d('1m').contracts_discovered || 0}/1m`);
    L.push(`- 2 Recovery & validation: contracts ${n0(cs.contracts_done)} / ${cs.workload_discovered && cs.contracts_total != null ? n0(cs.contracts_total) : 'discovering'} | month ${cs.workload_discovered ? fx(cs.current_month_pct, 1) + '%' : 'DISCOVERING'} | overall ${cs.overall_pct != null ? fx(cs.overall_pct, 1) + '%' : 'DISCOVERING'} | recovered ${n0(cs.records_recovered)} | validated ${n0(cs.records_verified)} | rejected ${n0(cs.records_rejected)} | last download ${sa(cs.last_download_ts)} | last validation ${sa(cs.last_validation_ts)} | delta contracts 1m/5m/15m +${d('1m').contracts_downloaded || 0}/+${d('5m').contracts_downloaded || 0}/+${d('15m').contracts_downloaded || 0} | records +${d('1m').records_recovered || 0}/1m`);
    L.push(`- 3 Timing, ETA & training [${al.status || 'IDLE'}]: elapsed ${fmtDur(cs.started_ts ? Math.max(0, ref - cs.started_ts) : 0)} | ETA ${cs.workload_discovered ? (cs.eta_seconds != null ? fmtDur(cs.eta_seconds) + ' (estimate)' : '–') : 'DISCOVERING'} | cycles ${al.cycles_completed || 0} | last training ${sa(al.last_cycle_ts)} | last DB commit ${sa(cs.last_commit_ts)} | HTTP 429s ${cs.rate_limit_429_count || 0} | errors ${cs.error_count || 0}`);
    const stg = cs.storage || {};
    L.push(`- Storage safety (D: NVMe) [${stg.critical ? 'CRITICAL' : stg.low ? 'LOW SPACE' : stg.temp_verified_d ? 'D: LOCKED' : 'CHECK'}]: free ${stg.free_gb != null ? fx(stg.free_gb, 2) + ' GB' : '–'} of ${stg.total_gb != null ? fx(stg.total_gb, 0) + ' GB' : '–'} | CMOS data ${stg.cmos_used_mb != null ? fx(stg.cmos_used_mb, 2) + ' MB' : '–'} | temp/DuckDB/cache ${stg.temp_verified_d ? 'verified on D:' : 'pending verification'}${stg.warning ? ' | warning: ' + stg.warning : ''}`);
    L.push('### Month timeline');
    (cs.months || []).forEach(m => {
      const stt = m.training_status === 'COMPLETED' || (m.recovery_pct >= 100 && m.validation_pct >= 100) ? 'COMPLETED' : (m.month === cs.current_month ? status : 'PENDING');
      L.push(`- ${m.month} | ${stt} | recovery ${m.workload_discovered ? fx(m.recovery_pct, 1) + '%' : (m.month === cs.current_month ? 'DISCOVERING' : 'PENDING')} | validation ${fx(m.validation_pct, 1)}%`);
    });
    L.push('### Monthly learning & validation progress (observed counts; ETA is an estimate)');
    (cs.months || []).forEach(m => L.push(`- ${m.month} | recovery ${m.workload_discovered ? fx(m.recovery_pct, 1) + '%' : 'DISCOVERING'} | validation ${fx(m.validation_pct, 1)}% | train/eval ${m.training_status} / ${m.eval_status} | quality ${m.quality_score != null ? fx(m.quality_score, 2) + '%' : '–'} | independent events ${m.independent_events || 0} | Brier ${m.brier_score != null ? fx(m.brier_score, 4) : '–'} | log loss ${m.log_loss != null ? fx(m.log_loss, 4) : '–'} | net ${m.net_pnl_usd != null ? sg(m.net_pnl_usd) : '–'} | max DD ${m.max_drawdown_usd != null ? usd(m.max_drawdown_usd) : '–'} | delta vs prev ${m.delta_vs_prev_usd != null ? sg(m.delta_vs_prev_usd) : '–'} | ZEUS net ${m.zeus_net_pnl_usd != null ? sg(m.zeus_net_pnl_usd) : '–'}`));
    L.push('### Per-market-family recovery & validation');
    (cs.families || []).forEach(f => L.push(`- ${f.series}${f.month ? ' (' + f.month + ')' : ''} | discovered ${n0(f.contracts_total)} | recovered ${n0(f.contracts_done)} | validated ${n0(f.contracts_verified)} | rejected ${n0(f.contracts_rejected ?? f.records_rejected)} | records ${n0(f.records_recovered)}`));
    if (!(cs.families || []).length) L.push('- no family records yet');
    L.push('### Track B: adaptive learning & challenger evaluation');
    const oos = (al.eval && al.eval.historical_oos) || {}, dlt = al.delta_vs_previous || {}, pp = al.prospective_paper || {};
    const ps = cmosPromotionSummary(cs);
    L.push(`- ${al.status || 'IDLE'} | active ${al.active_model_version || '–'} | best ${al.best_model_version || '–'} | ${al.status_reason || ''}`);
    L.push(`- Model lineage & promotion: auto-promotion ${al.auto_promotion_enabled ? 'ON' : 'manual'} | deployed paper ${al.deployed_paper_model_version || 'CMOS-V1 (cmos_model.json)'} | deployed adaptive ${al.deployed_adaptive_model_version || al.active_model_version || '–'} | latest challenger ${al.latest_challenger_version || '–'} | paper auto-reload ${al.paper_auto_reload_enabled ? 'yes' : 'no (isolated)'}`);
    L.push(`- Training data & trigger: verified observations ${n0(al.verified_observations)} | independent events ${al.independent_events || 0} (current count; checkpoint rows show the count at that checkpoint) | last cycle ${sa(al.last_cycle_ts)} (${al.last_cycle_duration_s ?? '–'}s) | next trigger in ${al.next_trigger_events ?? '–'} new events`);
    L.push(`- Historical OOS performance (out-of-sample): Brier ${oos.brier_score ?? '–'} | log loss ${oos.log_loss ?? '–'} | net ${usd(oos.realized_net_pnl_usd)} | expected net ${usd(oos.expected_net_pnl_usd)} | W/L ${oos.wins || 0}/${oos.losses || 0} | max DD ${usd(oos.max_drawdown_usd)} | delta PnL vs previous ${dlt.net_pnl_delta_usd != null ? sg(dlt.net_pnl_delta_usd) : '–'}`);
    L.push(`- Challenger gate & paper: tested ${al.models_tested || 0} | ${ps.text} | prospective paper ${pp.trades || 0} trades, net ${usd(pp.net_pnl_usd || 0)}, open ${pp.open_positions || 0}`);
    const cps = cs.checkpoints || [];
    L.push('### Checkpoints & activity / retry log');
    L.push(cps.length ? `- latest checkpoint ${cps[0].version} (${cps[0].month}, ${n0(cps[0].train_bars)} bars)` : '- no versioned monthly checkpoint committed yet (baseline 2026-01)');
    const evs = cs.events || [];
    L.push(`- ${evs.length} events (all published, newest first):`);
    if (lite) { evs.filter(e => e.level !== 'INFO').slice(0, 5).forEach(e => L.push(`  - ${fmtEt(e.ts)} | ${e.level} | ${e.month || '–'} | ${e.operation || '–'} | ${String(e.message || '').replace(/\s+/g, ' ').slice(0, 160)}`)); L.push(`  - (LITE: ${evs.length} events omitted except up to 5 warnings/errors)`); } else evs.forEach(e => L.push(`  - ${fmtEt(e.ts)} | ${e.level} | ${e.month || '–'} | ${e.operation || '–'} | ${String(e.message || '').replace(/\s+/g, ' ')}`));
    L.push('');

    // ---------------- TRAINING -> CMOS PAGE ----------------
    L.push('# CATEGORY: TRAINING -> CMOS PAGE (#training-cmos) - HISTORICAL TRAINING, NOT TRADING');
    const tr = (al.eval && al.eval.train) || {}, va = (al.eval && al.eval.validation) || {};
    const recAge = hbAge, trAge = al.heartbeat_ts != null ? Math.max(0, Math.round(ref - al.heartbeat_ts)) : al.heartbeat_age_s;
    const pubAge = Math.max(0, Math.round(nowSec - ref));
    const recAlive = (cs.status === 'ACTIVE' || cs.status === 'COMPLETED') && (recAge == null || recAge <= 60);
    const blocked = !al.active_model_version && (al.cycles_completed || 0) > 0;
    L.push(`- Headline: ${blocked ? 'PROMOTION BLOCKED' : (al.status || 'IDLE')} | active adaptive: ${al.active_model_version || 'NONE (BLOCKED)'} | best: ${al.best_model_version || 'NONE'} | challenger: ${al.latest_challenger_version || '–'} | ${al.status_reason || 'Idle'} | heartbeat age ${al.heartbeat_age_s ?? '–'}s | op ${al.operation || 'idle'}`);
    if (!al.active_model_version) L.push('- Banner: No validated adaptive model available - research and recovery continuing.');
    L.push(`- Health: 1 historical recovery worker ${recAlive ? 'ACTIVE' : (cs.status || 'PAUSED')} (op ${cs.operation || '–'}, heartbeat ${recAge != null ? recAge + 's' : '–'} at snapshot) | 2 adaptive training worker ${al.status === 'IDLE' && recAlive ? 'IDLE (waiting for 250-event batch)' : (al.status || 'IDLE')} (op ${al.operation || 'idle'}, last cycle/heartbeat ${trAge != null ? trAge + 's' : '–'} at snapshot) | 3 publisher/relay ${pubAge <= 90 ? 'LIVE' : 'STALE'} (snapshot age ${pubAge}s, ${cps.length} checkpoints)`);
    const oosx = oos;
    L.push(`- Active & best models: deployed paper ${al.deployed_paper_model_version || 'CMOS-V1 (cmos_model.json)'} | deployed adaptive ${al.active_model_version || 'NONE (VALIDATION FAILED)'} | best validated ${al.best_model_version || 'None'} | cycles ${al.cycles_completed || 0}`);
    L.push(`- Candidate vs selected calibration: observations ${n0(al.verified_observations)} | events ${al.independent_events || 0} | all-candidate predicted/actual ${oosx.pred_win_prob ?? '–'} / ${oosx.actual_win_prob ?? '–'} | selected predicted/actual ${oosx.selected_pred_win_prob ?? '–'} / ${oosx.selected_actual_win_prob ?? '–'}`);
    L.push(`- OOS economics & risk (after fees): net ${usd(oosx.realized_net_pnl_usd)} | max DD ${usd(oosx.max_drawdown_usd)} | risk-adjusted return ${oosx.risk_adjusted_return ?? '–'} | per trade ${usd(oosx.profit_per_trade_usd)} | turnover ${oosx.capital_turnover ?? '–'}x`);
    L.push(`- Delta vs previous checkpoint: Brier ${dlt.brier_delta ?? '–'} | PnL ${dlt.net_pnl_delta_usd != null ? sg(dlt.net_pnl_delta_usd) : '–'} | tested ${al.models_tested || 0} | ${ps.text}`);
    const latest = cps[0] || null;
    const prevValid = cps.find(c => c.validation_status === 'PROMOTED' && c.version !== (latest && latest.version)) || null;
    const h100 = accts.find(a => a.account_id === 'hermes-clean-100');
    const zt = snap.zeus_execution_comparison && snap.zeus_execution_comparison.taker;
    L.push('### 1. Strategy comparison (comparisons are valid only for the same period, $100 bankroll, universe and execution rules; live paper rows are NOT COMPARABLE)');
    L.push(`- CMOS latest trained challenger | trades ${oos.trades ?? '–'} | W/L ${oos.wins ?? '–'}/${oos.losses ?? '–'} | win ${oos.win_rate != null ? fx(oos.win_rate * 100, 2) + '%' : '–'} | net ${usd(oos.realized_net_pnl_usd)} | max DD ${usd(oos.max_drawdown_usd)} | ${(latest && latest.validation_status) || '–'} ${(latest && latest.training_period) || cs.current_month || ''} OOS ($100, +1c slip)`);
    if (prevValid) { const po = (prevValid.eval && prevValid.eval.historical_oos) || {}; L.push(`- CMOS previous valid (${prevValid.version}) | trades ${po.trades ?? '–'} | net ${usd(po.realized_net_pnl_usd)}`); } else L.push('- CMOS previous valid checkpoint: none available (no prior checkpoint passed validation)');
    const zW = Number(zt && zt.wins || 0), zL = Number(zt && zt.losses || 0);
    const hW = Number(h100 && h100.wins || 0), hL = Number(h100 && h100.losses || 0);
    L.push(`- Original ZEUS reference | trades ${zW + zL} | W/L ${zW}/${zL} | win ${zW + zL ? fx(100 * zW / (zW + zL), 2) + '%' : '–'} | net ${sg(zt && zt.realized_net_pnl_usd)} | NOT COMPARABLE (ongoing live paper, $100; this is the taker settled-trade count, the head-to-head section above counts executed contracts)`);
    L.push(`- HERMES-008B fixed 10% baseline | trades ${hW + hL} | W/L ${hW}/${hL} | win ${hW + hL ? fx(100 * hW / (hW + hL), 2) + '%' : '–'} | net ${h100 ? sg((h100.realized_net_cents || 0) / 100) : '–'} | NOT COMPARABLE (ongoing live paper, $100)`);
    L.push('### 2. Latest CMOS test');
    const dr = (latest && latest.eval && latest.eval.date_ranges) || {};
    const dfmt = t => t ? new Date(t * 1000).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) : 'NOT AVAILABLE';
    const valPassed = latest && latest.validation_status === 'PROMOTED';
    L.push(`- ${(latest && latest.version) || al.latest_challenger_version || '–'} | ${valPassed ? 'VALIDATION PASSED' : 'VALIDATION FAILED'} | trained ${at(latest && latest.created_ts || al.last_cycle_ts)} | train range ${dr.train_start_ts ? dfmt(dr.train_start_ts) + ' -> ' + dfmt(dr.train_end_ts) : ((latest && latest.training_period) || '–')} | test (OOS) range ${dr.oos_start_ts ? dfmt(dr.oos_start_ts) + ' -> ' + dfmt(dr.oos_end_ts) : ((latest && latest.training_period) || '–')}`);
    L.push(`- $100 bankroll outcome: ending ${usd(100 + Number(oos.realized_net_pnl_usd || 0))} | net ${sg(oos.realized_net_pnl_usd || 0)} | max drawdown ${usd(oos.max_drawdown_usd || 0)} | vs previous valid ${prevValid ? sg(dlt.net_pnl_delta_usd || 0) : 'no prior valid model'}`);
    L.push(`- Trade record after fees (OOS): trades ${oos.trades ?? 0} | ${oos.wins ?? 0}W / ${oos.losses ?? 0}L | win ${oos.win_rate != null ? fx(oos.win_rate * 100, 2) + '%' : '–'} | gate: ${al.status_reason || '–'}`);
    const slipRows = (latest && latest.eval && latest.eval.slippage_table) || [{ slippage_cents: 1, trades: oos.trades, wins: oos.wins, losses: oos.losses, win_rate: oos.win_rate, net_pnl_usd: oos.realized_net_pnl_usd, max_drawdown_usd: oos.max_drawdown_usd }];
    slipRows.forEach(s => L.push(`  - slippage +${s.slippage_cents}c: trades ${s.trades ?? '–'} | W/L ${s.wins ?? 0}/${s.losses ?? 0} | win ${s.win_rate != null ? fx(s.win_rate * 100, 2) + '%' : '–'} | net ${s.net_pnl_usd != null ? sg(s.net_pnl_usd) : '–'} | max DD ${s.max_drawdown_usd != null ? usd(s.max_drawdown_usd) : '–'}`));
    L.push('### 3. Monthly learning report (does each completed month improve or hurt out-of-sample performance)');
    (cs.months || []).filter(m => m.net_pnl_usd != null || m.month === cs.current_month).forEach(m => {
      const has = m.month === cs.current_month && oos.trades != null;
      L.push(`- ${m.month} | model ${m.checkpoint_version || (has ? (latest && latest.version) || '–' : 'Pending')} | trades ${has ? oos.trades : '–'} | W/L ${has ? oos.wins + ' / ' + oos.losses : '–'} | win ${has && oos.win_rate != null ? fx(oos.win_rate * 100, 2) + '%' : '–'} | net ${m.net_pnl_usd != null ? sg(m.net_pnl_usd) : (has ? sg(oos.realized_net_pnl_usd || 0) + ' (in progress)' : 'recovering')} | change vs previous ${m.delta_vs_prev_usd != null ? sg(m.delta_vs_prev_usd) : 'baseline / in progress'}`);
    });
    L.push('### 4. Model splits (the first three evaluate the SAME challenger; prospective paper is a separate model)');
    const mdl = (latest && latest.version) || al.latest_challenger_version || 'latest challenger';
    [[`1 Training (${mdl}) SAME MODEL, IN-SAMPLE`, tr], [`2 Validation (${mdl}) SAME MODEL, SELECTION`, va], [`3 Historical OOS (${mdl}) SAME MODEL, UNSEEN`, oos], [`4 Prospective paper (${al.deployed_paper_model_version || 'CMOS-V1'}) SEPARATE, LIVE RESEARCH`, pp]].forEach(([t, x]) =>
      L.push(`- ${t} | trades ${x.trades ?? 0} (${x.wins ?? 0}W/${x.losses ?? 0}L) | win ${x.win_rate != null ? fx(x.win_rate * 100, 2) + '%' : '–'} | net ${usd(x.realized_net_pnl_usd ?? x.net_pnl_usd ?? 0)} | max DD ${usd(x.max_drawdown_usd ?? 0)}`));
    L.push(`### 5. Technical diagnostics, learning charts & checkpoints (${cps.length} checkpoints)`);
    const asc = [...cps].reverse();
    const series = (key) => asc.map(c => c[key]).filter(v => v != null).map(Number);
    const sline = (label, v, f) => v.length ? `- ${label}: latest ${f(v[v.length - 1])} | min ${f(Math.min(...v))} | max ${f(Math.max(...v))} (${v.length} checkpoints)` : `- ${label}: no series yet`;
    L.push(sline('OOS Brier score (lower is better)', series('oos_brier'), v => v.toFixed(4)));
    L.push(sline('OOS net P&L' + (asc.some(c => c.validation_status === 'MODEL_INVALIDATED') ? ' (includes invalidated 2c-bug history)' : ''), series('oos_net_pnl_usd'), v => '$' + v.toFixed(2)));
    L.push(sline('OOS max drawdown', series('max_drawdown_usd'), v => '$' + v.toFixed(2)));
    L.push(sline('Verified independent events (as of each checkpoint)', series('independent_events'), v => String(Math.round(v))));
    Object.entries(oos.by_family || {}).forEach(([ser, f]) => L.push(`  - OOS family ${ser}: ${f.trades} trades | net ${usd(f.net_pnl_usd || 0)} | Brier ${f.brier_score ?? '–'}`));
    if (!Object.keys(oos.by_family || {}).length) L.push('  - no family OOS breakdown yet');
    L.push('- Checkpoints (all, newest first): version | created | period | mode | events | OOS Brier | OOS net | max DD | validation | deployment | sha256 (first 12)');
    if (lite) { cps.slice(0, 3).forEach(c => L.push(`  - ${c.version} | ${at(c.created_ts)} | ${c.training_period || c.month || '–'} | OOS Brier ${c.oos_brier ?? '–'} | OOS net ${c.oos_net_pnl_usd != null ? usd(c.oos_net_pnl_usd) : '–'} | ${c.validation_status || '–'} | ${c.deployment_status || '–'}`)); L.push(`  - (LITE: ${Math.max(0, cps.length - 3)} older checkpoints omitted)`); } else cps.forEach(c => L.push(`  - ${c.version} | ${at(c.created_ts)} | ${c.training_period || c.month || '–'} | ${c.training_mode || '–'} | ${c.independent_events ?? '–'} | ${c.oos_brier ?? '–'} | ${c.oos_net_pnl_usd != null ? usd(c.oos_net_pnl_usd) + (c.validation_status === 'MODEL_INVALIDATED' ? ' INVALID (2c scaling artifact, not verified profit)' : '') : '–'} | ${c.max_drawdown_usd != null ? usd(c.max_drawdown_usd) : '–'} | ${c.validation_status || '–'} | ${c.deployment_status || '–'} | ${c.checkpoint_sha256 ? String(c.checkpoint_sha256).slice(0, 12) : '–'}`));
    const rb = al.rollback_audit || [];
    L.push(`### Checkpoint rollback audit log (${rb.length})`);
    if (!rb.length) L.push('- no rollbacks recorded');
    rb.forEach(r => L.push(`- ${at(r.ts || r.created_ts)} | actor ${r.actor || '–'} | replaced ${r.replaced || r.replaced_version || '–'} | restored ${r.restored || r.restored_version || '–'} | sha256 ${r.sha256 ? String(r.sha256).slice(0, 12) : '–'} | ${r.reason || ''}`));
    L.push('');
  }
  return L;
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

  const wireCopy = (id, label, lite) => {
  const copyBtn = $(id);
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const txt = buildStatusReportText(currentSnap, { lite });
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
      setTimeout(() => { copyBtn.textContent = label; }, 2500);
    };
  }
  };
  wireCopy('copy-report-btn', '📋 Copy Status Report', false);
  wireCopy('copy-report-lite-btn', '📋 Copy LITE (no ledgers)', true);
}

// Init once
wireControls();
initNavTabs();
prevSnap = loadJson(PREV_KEY, null);
const initialSnap = loadJson(CACHE_KEY, null) || emptySnapshot();
renderAll(initialSnap, 'WAITING', true);

// ---- Paper Strategies & Experiments (read-only). Three kinds are kept apart and labelled: LIVE PAPER accounts, HISTORICAL REPLAY (isolated sandbox), HISTORICAL ANALYSIS (calibration).
// Nothing here is real-money performance; paper fills are modelled by the paper broker.
// Collector health: process alive is shown separately from whether data is actually advancing.
function collectorAgeText(sec) {
  if (sec == null) return 'no data';
  return sec < 90 ? sec + ' s' : sec < 5400 ? Math.round(sec / 60) + ' min' : sec < 172800 ? (sec / 3600).toFixed(1) + ' h' : (sec / 86400).toFixed(1) + ' days';
}
// System components: ONE roll-up of everything running (accounts, experiments, models, collectors, workers, services), built by the publisher
// from the same data the other sections use. Status says whether a component is accomplishing work, not whether it is enabled.
function componentAgo(ts, nowSec) {
  if (!ts) return 'no activity observed';
  const sec = Math.max(0, nowSec - ts);
  return (sec < 90 ? Math.round(sec) + ' s' : sec < 5400 ? Math.round(sec / 60) + ' min' : sec < 172800 ? (sec / 3600).toFixed(1) + ' h' : (sec / 86400).toFixed(1) + ' days') + ' ago';
}
// SENTINEL integrity label: text + symbol + shape (never colour alone). Public-safe fields only.
function integrityLabel(c) {
  if (!c || !c.integrity) return '';
  const sym = ({ VERIFIED: '✔ VERIFIED', VERIFIED_PARTIAL: '✔* VERIFIED (declared dynamic inputs not hashed)', UNREGISTERED: '⚠ UNREGISTERED', BLOCKED: '✖ BLOCKED', REVOKED: '✖ REVOKED', MISMATCH: '⚠ MISMATCH', UNRESOLVED: '? UNRESOLVED', DISCOVERY_BYPASS: '⚠ DISCOVERY BYPASS', UNAPPROVED: '✖ UNAPPROVED (no owner signature; shadow period)' })[c.integrity] || c.integrity;
  return sym + (c.verification_id ? ' · id ' + c.verification_id : '') + (c.version_label ? ' · ' + c.version_label : '');
}
function componentProgress(c) {
  if (c.work == null) return '';
  const label = c.work_label || 'units';
  const val = typeof c.work === 'number' && c.work > 1e9 ? '' : Number(c.work).toLocaleString();
  if (c.work_delta == null) return val ? `${val} ${label}; since previous update: not yet measured` : '';
  const win = c.work_window_s ? Math.round(c.work_window_s / 60) : 0;
  const d = (c.work_delta > 0 ? '+' : '') + Number(c.work_delta).toLocaleString();
  return `${val ? val + ' ' + label + '; ' : ''}${d} in last ${win || '<1'} min`;
}
function componentTagClass(st) {
  return ({ TRADING: 'ok', EVALUATING: 'ok', TRAINING: 'ok', COLLECTING: 'ok', IDLE: 'warn', STALE: 'warn', BLOCKED: 'bad', ERROR: 'bad', STOPPED: 'legacy' })[st] || 'warn';
}
// Compact live-status strip placed INSIDE the existing account / experiment cards. Data = snap.components (same roll-up as the Status Report).
function opsStrip(snap, cid) {
  const c = (snap && snap.components && snap.components.components || []).find(x => x.id === cid);
  if (!c) return '';
  const nowSec = snap.published_ts || Math.floor(Date.now() / 1000);
  const prog = componentProgress(c);
  const reasonShown = c.status === 'TRADING' || c.status === 'COLLECTING' || c.status === 'EVALUATING' || c.status === 'TRAINING' ? '' : c.reason;
  return `<div class="ops-strip" style="display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;font-size:11px;margin:6px 0;padding:5px 8px;border:1px solid rgba(148,163,184,.25);border-radius:6px">
      <span class="tag ${componentTagClass(c.status)}">${esc(c.status)}</span>
      ${c.integrity ? `<span class="mono">${esc(integrityLabel(c))}</span>` : ''}
      <span class="mono">last activity: ${esc(componentAgo(c.last_activity_ts, nowSec))}${c.last_activity ? ' &middot; ' + esc(c.last_activity) : ''}</span>
      ${prog ? `<span class="muted mono">${esc(prog)}</span>` : ''}
      ${reasonShown ? `<span class="muted" style="flex-basis:100%">${esc(reasonShown)}</span>` : ''}
    </div>`;
}
// Components that already have their own card/table elsewhere on the page (shown there with a status strip); the monitoring section lists the rest.
function isCardComponent(c) {
  return /^(acct:|exp:|zeus:|shadow:hunter$|shadow:bargain$|shadow:discovery$|rest:exits$)/.test(c.id);
}

function renderComponents(snap) {
  const panel = $('components-panel'), body = $('components-body');
  if (!panel || !body) return;
  const cm = snap && snap.components;
  if (!cm || !cm.components) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const nowSec = snap.published_ts || Math.floor(Date.now() / 1000);
  const mon = cm.components.filter(c => !isCardComponent(c)), cardSum = cm.components.filter(isCardComponent);
  const act = mon.filter(c => c.view === 'active'), inact = mon.filter(c => c.view !== 'active');
  const order = ['TRADING', 'EVALUATING', 'TRAINING', 'COLLECTING', 'IDLE', 'BLOCKED', 'STALE', 'ERROR', 'STOPPED'];
  const cnt = {}; act.forEach(c => { cnt[c.status] = (cnt[c.status] || 0) + 1; });
  const chips = order.filter(k => cnt[k]).map(k => `<span class="tag ${componentTagClass(k)}" title="${esc(k)}">${esc(k)} ${cnt[k]}</span>`).join(' ');
  const cats = [...new Set(act.map(c => c.category))];
  const row = c => `<tr><td><span class="tag ${componentTagClass(c.status)}">${esc(c.status)}</span></td>
      <td><b>${esc(c.name)}</b><div class="muted" style="font-size:11px">${esc(c.kind || '')}</div>${c.integrity ? '<div class="mono" style="font-size:11px;border:1px solid currentColor;display:inline-block;padding:1px 5px;margin-top:3px">' + esc(integrityLabel(c)) + '</div>' : ''}</td>
      <td style="font-size:12px">${esc(c.reason || '')}</td>
      <td class="mono" style="font-size:12px">last: ${esc(componentAgo(c.last_activity_ts, nowSec))}${c.last_activity ? '<div class="muted">' + esc(c.last_activity) + '</div>' : ''}${componentProgress(c) ? '<div class="muted">' + esc(componentProgress(c)) + '</div>' : ''}</td>
      <td style="font-size:12px">${esc(c.performance || '')}${(c.recent || []).length ? '<details><summary class="muted">recent</summary>' + c.recent.map(r => '<div>' + esc(r) + '</div>').join('') + '</details>' : ''}</td></tr>`;
  const table = rows => `<div class="table-wrap"><table><thead><tr><th>STATUS</th><th>COMPONENT</th><th>WHY / WHAT IT IS DOING</th><th>LAST ACTIVITY / PROGRESS</th><th>RESULT / RECENT</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
  const groups = cats.map(cat => `<details open><summary style="cursor:pointer;margin:10px 0 4px"><b>${esc(cat)}</b> <span class="muted">(${act.filter(c => c.category === cat).length})</span></summary>${table(act.filter(c => c.category === cat))}</details>`).join('');
  const inCats = [...new Set(inact.map(c => c.category))];
  const inactiveHtml = inact.length ? `<details style="margin-top:12px"><summary style="cursor:pointer"><b>Inactive, stopped and retired</b> <span class="muted">(${inact.length}) &mdash; kept separate so the live view stays readable</span></summary>${inCats.map(cat => `<div style="margin:8px 0 2px" class="muted">${esc(cat)}</div>${table(inact.filter(c => c.category === cat))}`).join('')}</details>` : '';
  body.innerHTML = `<div class="acct-card" style="padding:14px 16px">
      <div class="acct-head"><span class="acct-title">Operational monitoring &mdash; collectors, workers, jobs, feeds and services</span><span class="tag">${act.length} LIVE</span></div>
      <div style="margin:8px 0">${chips}</div>
      <div class="muted" style="font-size:12px;margin-bottom:6px">${esc(cm.note || '')} Updated ${esc(componentAgo(cm.generated_ts, nowSec))}.</div>
      ${groups}${inactiveHtml}
      ${cardSum.length ? `<details style="margin-top:12px"><summary style="cursor:pointer" class="muted">Optional: one-line status summary of accounts and experiments (${cardSum.length}) &mdash; the cards above are the primary view</summary>${table(cardSum)}</details>` : ''}</div>`;
}

function renderCollectors(snap) {
  const panel = $('collectors-panel'), body = $('collectors-body');
  if (!panel || !body) return;
  const c = snap && snap.collectors;
  if (!c || !c.collectors) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const cls = st => (st === 'ACTIVE' ? 'ok' : (st === 'STALE' || st === 'UNKNOWN') ? 'warn' : 'bad');
  const rows = c.collectors.map(r => `<tr><td>${esc(r.label)}</td><td><span class="tag ${cls(r.state)}">${esc(r.state)}</span></td>
      <td class="mono">${r.process_alive == null ? 'UNKNOWN' : r.process_alive ? 'running' : 'not running'}</td>
      <td class="mono">${esc(r.data_kind)}: ${esc(collectorAgeText(r.data_age_s))} old (expected within ${esc(collectorAgeText(r.max_age_s))})</td>
      <td class="muted" style="font-size:12px">${esc(r.note)}${r.last_error ? ' &middot; last error: ' + esc(r.last_error) : ''}</td></tr>`).join('');
  body.innerHTML = `<div class="acct-card" style="padding:14px 16px">
      <div class="acct-head"><span class="acct-title">Data collectors</span><span class="tag">HEALTH ONLY &mdash; NOT TRADING</span></div>
      <div class="muted" style="font-size:12px;margin:6px 0 10px">A collector is ACTIVE only when its process is running and its newest data is within the expected interval. A running process with old data is STALE.</div>
      <div class="table-wrap"><table><thead><tr><th>COLLECTOR</th><th>STATE</th><th>PROCESS</th><th>NEWEST DATA</th><th>NOTE</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function renderPaperLab(snap) {
  const panel = $('paperlab-panel'), body = $('paperlab-body');
  if (!panel || !body) return;
  const p = snap?.paper_lab;
  if (!p || !p.live_paper) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const lp = p.live_paper, rx = p.resting_exits || {}, sb = p.sandbox_replay, cal = p.calibration;
  const usd = v => (v == null ? '–' : (Number(v) < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2));
  const pnlCls = v => (v == null || Number(v) === 0 ? '' : Number(v) > 0 ? 'pos' : 'neg');
  const pct = v => (v == null ? '–' : (Number(v) * 100).toFixed(0) + '%');
  const n0 = v => (v == null ? '–' : Number(v).toLocaleString());
  const ts = t => (t ? new Date(t * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
  const ago = t => { if (!t) return 'never'; const s = Math.max(0, Date.now() / 1000 - t); return s < 90 ? Math.round(s) + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : (s / 3600).toFixed(1) + ' h ago'; };
  const svc = p.forward_service || {};
  const stale = svc.last_tick_ts ? (Date.now() / 1000 - svc.last_tick_ts) > 300 : true;
  const T = lp.totals || {};
  const expRows = (lp.experiments || []).map(e => `<tr><td>${esc(e.name)}<div class="muted mono" style="font-size:11px">${esc(e.id)} · ${esc(e.mode || '')}</div>${opsStrip(snap, 'exp:' + e.id)}</td>
      <td><span class="tag ${e.status === 'active' ? 'ok' : ''}">${esc((e.status || '').toUpperCase())}</span></td>
      <td class="mono">${e.active_accounts}/${e.accounts}</td><td class="mono">${usd(e.bankroll)}</td><td class="mono">${usd(e.equity)}</td>
      <td class="mono ${pnlCls(e.realized_pnl)}">${usd(e.realized_pnl)}</td><td class="mono">${e.open_positions}</td><td class="mono">${n0(e.closed_trades)}</td><td class="mono">${pct(e.win_rate)}</td></tr>`).join('');
  const accRows = (lp.accounts || []).slice().sort((a, b) => (a.experiment === b.experiment ? (b.closed_trades - a.closed_trades) : a.experiment.localeCompare(b.experiment)))
    .map(a => `<tr><td class="mono" title="${esc(a.account)}">${esc(a.strategy)} v${esc(a.version)}<div class="muted" style="font-size:11px">${esc(a.experiment)}</div></td><td class="mono">${usd(a.bankroll)}</td><td class="mono">${usd(a.cash)}</td>
      <td class="mono">${usd(a.equity)}</td><td class="mono ${pnlCls(a.realized_pnl)}">${usd(a.realized_pnl)}</td><td class="mono">${a.open_positions}</td><td class="mono">${a.closed_trades}</td>
      <td class="mono">${a.closed_trades ? pct(a.wins / a.closed_trades) : '–'}</td></tr>`).join('');
  const openRows = (lp.open_positions || []).map(o => `<tr><td class="mono">${esc(o.account)}</td><td class="mono">${esc(o.ticker)}</td><td class="mono">${esc(String(o.side).toUpperCase())} ×${o.qty}</td>
      <td class="mono">${o.entry_price == null ? '–' : Number(o.entry_price).toFixed(2)}</td><td class="mono">${ts(o.entry_ts)}</td>
      <td class="mono">${o.resting_sell ? `resting sell @ ${Number(o.resting_sell.price).toFixed(2)} (${esc(o.resting_sell.status)}${o.resting_sell.filled ? ', ' + o.resting_sell.filled + ' filled' : ''}) · ${esc(o.resting_sell.evidence)}` : 'none posted'}</td></tr>`).join('');
  const closedRows = (lp.recent_closed || []).map(t => `<tr><td class="mono">${ts(t.exit_ts)}</td><td class="mono">${esc(t.account)}</td><td class="mono">${esc(t.ticker)}</td><td class="mono">${esc(String(t.side).toUpperCase())} ×${t.qty}</td>
      <td class="mono">${t.entry_price == null ? '–' : Number(t.entry_price).toFixed(2)} → ${t.exit_price == null ? '–' : Number(t.exit_price).toFixed(2)}</td><td class="mono">${esc(t.exit_kind || '')}</td><td class="mono ${pnlCls(t.net_pnl)}">${usd(t.net_pnl)}</td></tr>`).join('');
  const bs = rx.by_status || {};
  const ev = Object.entries(rx.evidence_status || {}).map(([k, v]) => `<li>${esc(k)}: <b>${n0(v)}</b></li>`).join('');
  const dayRows = (rx.by_day || []).map(d => `<tr><td class="mono">${esc(d.date)} UTC</td><td class="mono">${n0(d.posted)}</td><td class="mono">${n0(d.verified)}</td><td class="mono">${n0(d.unverified_no_trade_store)}</td><td class="mono">${n0(d.unverified_no_coverage)}</td></tr>`).join('');
  const fillRows = (rx.recent_fills || []).map(f => `<tr><td class="mono">${ts(f.ts)}</td><td class="mono">${esc(f.account)}</td><td class="mono">${esc(f.ticker)}</td><td class="mono">${f.qty} @ ${Number(f.price).toFixed(2)}</td>
      <td class="mono">${usd(f.proceeds_net)}</td><td class="mono ${pnlCls(f.pnl)}">${usd(f.pnl)}</td><td class="mono">${esc(f.evidence)}</td></tr>`).join('');
  const rd = rx.evidence_reader || {};
  const sbHtml = !sb ? '' : Object.entries(sb.runs || {}).map(([q, run]) => `<div class="muted mono" style="margin-top:8px">Queue assumption: <b>${esc(run.queue_bound)}</b> · ${run.markets} recorded markets</div>
      <div class="table-wrap"><table><thead><tr><th>VARIANT (isolated test)</th><th>START</th><th>END EQUITY</th><th>NET (REPLAY)</th><th>ENTRIES FILLED</th><th>EXITS FILLED</th><th>FAILED EXITS</th><th>CAPITAL RECYCLING</th><th>AUDIT</th></tr></thead><tbody>
      ${(run.variants || []).map(v => `<tr><td class="mono">${esc(v.variant)}</td><td class="mono">${usd(v.start_cash)}</td><td class="mono">${usd(v.equity_marked)}</td><td class="mono ${pnlCls(v.realized_net)}">${usd(v.realized_net)}</td>
        <td class="mono">${n0(v.entries_filled)}</td><td class="mono">${n0(v.exits_filled)}</td><td class="mono">${n0(v.failed_exits)}</td><td class="mono">${n0(v.capital_recycling_events)}</td><td><span class="tag ${v.conservation_audit_ok ? 'ok' : 'bad'}">${v.conservation_audit_ok ? 'cash conserved' : 'AUDIT FAILED'}</span></td></tr>`).join('')}</tbody></table></div>`).join('');
  const calFolds = !cal ? '' : Object.entries(cal.folds || {}).map(([k, f]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${n0(f.test_entries)}</td><td class="mono">${f.frozen_cells ?? '–'}</td><td class="mono">${f.replicated_cells ?? '–'}</td><td class="mono">${f.net_positive_after_fee_cells ?? '–'}</td><td class="mono">${f.brier_gain == null ? '–' : Number(f.brier_gain).toFixed(5)}</td></tr>`).join('');
  const calPol = !cal ? '' : (cal.exit_policies || []).map(x => `<tr><td class="mono">${esc(x.policy)}</td><td class="mono">${n0(x.entries)}</td><td class="mono ${pnlCls(x.mean_net_per_contract)}">${x.mean_net_per_contract == null ? '–' : Number(x.mean_net_per_contract).toFixed(4)}</td><td class="mono">${x.net_per_capital_hour == null ? '–' : Number(x.net_per_capital_hour).toFixed(5)}</td></tr>`).join('');
  body.innerHTML = `
    <div class="acct-card paper-card" style="padding:14px 16px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <h2 style="margin:0">Paper Strategies &amp; Experiments</h2>
        <span><span class="tag paper">PAPER — NO REAL MONEY</span>${stale ? ' <span class="tag bad">FORWARD SERVICE STALE</span>' : ''}</span>
      </div>
      <div class="muted mono" style="font-size:12px;margin-top:6px">Generated ${ago(p.generated_ts)}; forward paper evaluator last ticked ${ago(svc.last_tick_ts)}. These are simulated accounts on recorded Kalshi books. They are separate from the real-money account above and are not its performance.</div>
      <div class="muted mono" style="font-size:12px;margin-top:6px"><span class="tag paper">LIVE PAPER</span> forward accounts running now &nbsp; <span class="tag legacy">HISTORICAL REPLAY</span> isolated test on a past window &nbsp; <span class="tag validation">HISTORICAL ANALYSIS</span> research on past prints. Only the first is a live experiment; none is trading performance.</div>
    </div>
    <div class="acct-card paper-card" style="padding:14px 16px;margin-top:10px">
      <h3 style="margin:0 0 6px">Live paper experiments <span class="tag paper">LIVE PAPER</span></h3>
      <div class="muted mono" style="font-size:12px">${n0(T.accounts)} paper accounts (${n0(T.active_accounts)} have traded) · ${n0(T.open_positions)} open positions · ${n0(T.closed_trades)} completed trades. Bankroll, equity and realized P&amp;L are per experiment, fees included.</div>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>EXPERIMENT</th><th>STATUS</th><th>ACCOUNTS (TRADED/ALL)</th><th>BANKROLL</th><th>EQUITY</th><th>REALIZED P&amp;L</th><th>OPEN</th><th>COMPLETED</th><th>WIN %</th></tr></thead><tbody>${expRows}</tbody></table></div>
    </div>
    <details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Every paper account (${n0(T.accounts)}) — strategy, bankroll, equity, P&amp;L</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="table-wrap"><table><thead><tr><th>STRATEGY</th><th>BANKROLL</th><th>CASH</th><th>EQUITY</th><th>REALIZED P&amp;L</th><th>OPEN</th><th>COMPLETED</th><th>WIN %</th></tr></thead><tbody>${accRows}</tbody></table></div></details>
    <details class="pos-details panel-details" style="margin-top:10px" open><summary class="panel-summary"><div><h2>Open paper positions (${n0(lp.open_positions_total)})</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="table-wrap"><table><thead><tr><th>ACCOUNT</th><th>MARKET</th><th>SIDE</th><th>ENTRY</th><th>OPENED</th><th>RESTING SELL ORDER</th></tr></thead><tbody>${openRows || '<tr><td colspan="6" class="muted">No open paper positions.</td></tr>'}</tbody></table></div></details>
    <details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Recent completed paper trades (last ${(lp.recent_closed || []).length})</h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="table-wrap"><table><thead><tr><th>CLOSED</th><th>ACCOUNT</th><th>MARKET</th><th>SIDE</th><th>ENTRY → EXIT</th><th>EXIT TYPE</th><th>NET P&amp;L</th></tr></thead><tbody>${closedRows}</tbody></table></div></details>
    <div class="acct-card paper-card" style="padding:14px 16px;margin-top:10px">
      <h3 style="margin:0 0 6px">Are resting sell orders filling? <span class="tag paper">LIVE PAPER</span></h3>
      ${opsStrip(snap, 'rest:exits')}
      <div class="mono" style="display:flex;gap:18px;flex-wrap:wrap">
        <span>Orders posted: <b>${n0(rx.orders_total)}</b></span><span>Filled: <b>${n0(bs.filled)}</b></span><span>Cancelled: <b>${n0(bs.cancelled)}</b></span><span>Expired: <b>${n0(bs.expired)}</b></span>
        <span>Open now: <b>${n0(rx.open_now)}</b></span><span>Fill events recorded: <b>${n0(rx.fills_total)}</b></span><span>First fill: <b>${ts(rx.first_fill_ts)}</b></span></div>
      <div class="muted" style="font-size:12px;margin-top:6px">${esc(rx.note || '')}</div>
      <div class="muted mono" style="font-size:12px;margin-top:6px">Trade-evidence reader (follows tickers with open resting orders): heartbeat ${ago(rd.heartbeat_ts)}${rd.order_trades ? ` · last cycle: ${rd.order_trades.open_order_tickers ?? 0} open-order tickers, ${rd.order_trades.read ?? 0} read, ${rd.order_trades.already_covered ?? 0} already covered, ${rd.order_trades.errors ?? 0} errors` : ''}</div>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>DAY</th><th>ORDERS</th><th>VERIFIED WINDOW</th><th>UNVERIFIED (ROUTING DEFECT, FIXED NOV 19)</th><th>UNVERIFIED (NO TRADE COVERAGE)</th></tr></thead><tbody>${dayRows}</tbody></table></div>
      <ul class="muted" style="margin:6px 0 0 18px;font-size:12px">${ev}</ul>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>FILLED</th><th>ACCOUNT</th><th>MARKET</th><th>FILL</th><th>NET PROCEEDS</th><th>P&amp;L</th><th>EVIDENCE</th></tr></thead><tbody>${fillRows || '<tr><td colspan="7" class="muted">No resting-sell fills recorded yet.</td></tr>'}</tbody></table></div>
    </div>
    ${sb ? `<details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Execution sandbox — capital recycling &amp; resting orders <span class="tag legacy">HISTORICAL REPLAY</span></h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="muted" style="font-size:12px;margin:6px 0">${esc(sb.label)}. Generated ${ago(sb.generated_ts)}. ${esc(sb.note)} Isolated: not a live account, not trading performance.</div>${sbHtml}</details>` : ''}
    ${cal ? `<details class="pos-details panel-details" style="margin-top:10px"><summary class="panel-summary"><div><h2>Probability calibration <span class="tag validation">HISTORICAL ANALYSIS</span></h2></div><span class="expand-lbl">▸ Expand</span></summary>
      <div class="muted" style="font-size:12px;margin:6px 0">${esc(cal.label)}. Generated ${ago(cal.generated_ts)}. ${n0(cal.entries)} point-in-time entries over ${n0(cal.events)} events. ${esc(cal.verdict)}</div>
      <div class="table-wrap"><table><thead><tr><th>TEST PERIOD</th><th>TEST ENTRIES</th><th>FROZEN CELLS</th><th>REPLICATED</th><th>NET + AFTER FEES</th><th>BRIER GAIN</th></tr></thead><tbody>${calFolds}</tbody></table></div>
      <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>EXIT POLICY (HISTORICAL)</th><th>ENTRIES</th><th>MEAN NET / CONTRACT</th><th>NET / CAPITAL-HOUR</th></tr></thead><tbody>${calPol}</tbody></table></div></details>` : ''}`;
}

// Single set of background timers (never duplicated on SSE reconnect)
pollSnapshot();
setInterval(pollSnapshot, 15000);
setInterval(() => { if (currentSnap) renderStatusHeader(currentSnap, lastPollOk ? 'LIVE' : 'OFFLINE'); }, 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistStateIfDue(true); });
connectStream();
