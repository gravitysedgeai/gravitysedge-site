// Barnacle Public Display-Only Terminal — Strategy Discovery — Live Run #001
const STORAGE_KEY = 'barnacle_live_run_001_snapshot';
const params = new URLSearchParams(location.search);
const RELAY_URL = (params.get('relay') || 'https://barnacle-live-relay.gravitysedge.workers.dev').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
let viewMode = 'lifetime'; // 'first_24h' | 'lifetime'
let vizMode = 'crypto';    // 'crypto' | 'geo'
let chartUnit = 'pct';     // 'pct' | 'pnl' | 'usd'
let showLines = { live_25: true, shadow_25: true, shadow_100: true, shadow_1000: true };
let currentSnap = null;
let es = null;
let retryMs = 2000;

const fmtUsd = (n) => n == null ? 'Not Recorded' : `${n < 0 ? '-' : ''}$${Math.abs(Number(n)).toFixed(2)}`;
const fmtSignedUsd = (n) => n == null ? 'Not Recorded' : `${Number(n) >= 0 ? '+' : '-'}$${Math.abs(Number(n)).toFixed(2)}`;
const fmtEt = (sec) => sec == null ? '—' : new Intl.DateTimeFormat(undefined, {
  timeZone: 'America/New_York', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
}).format(new Date(Number(sec) * 1000));

function loadCached() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}
function saveCached(snap) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snap)); } catch { /* ignore */ }
}

function emptySnapshot() {
  return {
    schema_version: 1,
    published_at_utc: null,
    publish_delay_s: 60,
    barnacle_status: 'STANDBY',
    run: { run_number: 1, run_label: '#001', title: 'Strategy Discovery — Live Run #001', subtitle: 'Authorized Live Capital: $25.00 · Four-Account Controlled Comparison', first_fill_ts: null, milestone_24h_snapshot: null },
    metrics: { initial_capital_usd: 25.0, contributions_usd: 25.0, verified_equity_usd: 25.0, realized_net_usd: 0.0, unrealized_pnl_usd: null, return_pct_excl_deposits: 0.0, fees_usd: 0.0, closed_trades: 0, wins: 0, losses: 0, open_positions: 0 },
    bankroll_series: [], bets: [], feed: [], crypto_markets: [], geo_markets: [],
  };
}

function renderClock(run) {
  const el = $('clock-pill');
  if (!run?.first_fill_ts) {
    el.textContent = '24H CLOCK: AWAITING FIRST FILL';
    return;
  }
  const elapsed = Math.max(0, Date.now() / 1000 - Number(run.first_fill_ts));
  if (elapsed >= 86400) {
    el.textContent = '24H MILESTONE REACHED · CONTINUING';
    el.className = 'pill ok mono';
  } else {
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    el.textContent = `24H CLOCK: ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m / 24h`;
    el.className = 'pill ok mono';
  }
}

function renderBankrollChart(snap) {
  const box = $('bankroll-chart');
  const ta = snap?.three_accounts || {};
  const seriesMap = ta.series || {};
  const accounts = ta.accounts || [];
  const lineSpecs = [
    { key: 'live_25', label: 'LIVE (REAL)', color: '#34d399', init: 500 },
    { key: 'shadow_25', label: 'SHADOW $25', color: '#a78bfa', init: 2500 },
    { key: 'shadow_100', label: 'SHADOW $100', color: '#38bdf8', init: 10000 },
    { key: 'shadow_1000', label: 'SHADOW $1,000', color: '#f59e0b', init: 100000 },
  ];
  accounts.forEach(a => {
    const sp = lineSpecs.find(x => x.key === a.account_id);
    if (sp && a.initial_cents) sp.init = a.initial_cents;
  });

  const activeSpecs = lineSpecs.filter(sp => showLines[sp.key]);
  const plottable = [];
  const singleObs = [];
  const allTs = [];
  const allY = [];

  activeSpecs.forEach(sp => {
    const raw = (seriesMap[sp.key] || []).slice();
    if (!raw.length) return;
    if (raw.length === 1) {
      singleObs.push({ ...sp, raw });
    } else {
      plottable.push({ ...sp, raw });
    }
    raw.forEach(p => {
      if (p.ts != null) allTs.push(Number(p.ts));
      const v = chartUnit === 'pct'
        ? ((Number(p.pnl_cents || 0) / Math.max(1, sp.init)) * 100)
        : chartUnit === 'pnl'
          ? (Number(p.pnl_cents || 0) / 100)
          : (Number(p.equity_cents ?? sp.init) / 100);
      allY.push(v);
    });
  });

  if (!plottable.length && !singleObs.length) {
    box.innerHTML = '<div class="muted">No exchange-confirmed or shadow bankroll events published yet.</div>';
    return;
  }

  const w = 540, h = 195, pad = 32;
  const minT = allTs.length ? Math.min(...allTs) : 0;
  const maxT = allTs.length ? Math.max(...allTs) : 1;
  const spanT = Math.max(1, maxT - minT);
  const minV = allY.length ? Math.min(...allY) : 0;
  const maxV = allY.length ? Math.max(...allY) : 1;
  const spanV = Math.max(chartUnit === 'pct' ? 1.0 : 1.0, maxV - minV);

  const valOf = (p, init) => chartUnit === 'pct'
    ? ((Number(p.pnl_cents || 0) / Math.max(1, init)) * 100)
    : chartUnit === 'pnl'
      ? (Number(p.pnl_cents || 0) / 100)
      : (Number(p.equity_cents ?? init) / 100);

  const xOf = (t) => pad + ((Number(t) - minT) / spanT) * (w - 2 * pad);
  const yOf = (v) => h - pad - ((v - minV) / spanV) * (h - 2 * pad);

  const paths = plottable.map(sp => {
    const pts = sp.raw.map(p => ({ x: xOf(p.ts), y: yOf(valOf(p, sp.init)), v: valOf(p, sp.init), p }));
    const d = pts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    const dots = pts.map(pt => {
      const cash = pt.p.cash_cents != null ? `Cash $${(pt.p.cash_cents / 100).toFixed(2)}` : '';
      const comm = pt.p.committed_cents != null ? ` · Committed $${(pt.p.committed_cents / 100).toFixed(2)}` : '';
      return `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2.8" fill="${sp.color}"><title>${sp.label}: ${chartUnit === 'pct' ? pt.v.toFixed(2) + '%' : '$' + pt.v.toFixed(2)} (${cash}${comm} · ${fmtEt(pt.p.ts)})</title></circle>`;
    }).join('');
    return `<path d="${d}" fill="none" stroke="${sp.color}" stroke-width="2.1"/>${dots}`;
  }).join('');

  const singleDots = singleObs.map(sp => {
    const p = sp.raw[0];
    const v = valOf(p, sp.init);
    return `<circle cx="${xOf(p.ts).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4.5" fill="${sp.color}" stroke="#0b1220" stroke-width="1.5"><title>${sp.label}: Insufficient chart history (1 observation) @ ${fmtEt(p.ts)}</title></circle>`;
  }).join('');

  const unitLbl = chartUnit === 'pct' ? '%' : '$';
  const legend = [...plottable.map(s => `<span style="color:${s.color};margin-right:10px">● ${s.label} (${s.raw.length} pts)</span>`),
  ...singleObs.map(s => `<span style="color:${s.color};margin-right:10px">○ ${s.label} (1 obs — insufficient history)</span>`)].join('');

  box.innerHTML = `
    <div style="font-size:11px;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:4px">${legend}</div>
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:190px">
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="rgba(148,163,184,0.2)"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="rgba(148,163,184,0.2)"/>
      ${paths}${singleDots}
      <text x="${pad}" y="14" fill="#94a3b8" font-size="11">High ${unitLbl === '$' ? '$' : ''}${maxV.toFixed(2)}${unitLbl === '%' ? '%' : ''} · Low ${unitLbl === '$' ? '$' : ''}${minV.toFixed(2)}${unitLbl === '%' ? '%' : ''} · ${fmtEt(minT)} → ${fmtEt(maxT)}</text>
    </svg>`;
}

function renderThreeAccounts(snap) {
  const grid = $('three-accounts-grid');
  if (!grid) return;
  const accts = snap?.three_accounts?.accounts || [
    { account_id: 'live_25', label: 'LIVE $25', kind: 'REAL', initial_cents: 2500, available_cents: 2500, invested_cents: 0, position_value_cents: 0, equity_cents: 2500, net_pnl_cents: 0, realized_net_cents: 0, unrealized_pnl_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, closed_trades: 0, max_drawdown_cents: 0, open_positions: 0 },
    { account_id: 'shadow_25', label: 'SHADOW $25', kind: 'PAPER', initial_cents: 2500, available_cents: 2500, invested_cents: 0, position_value_cents: 0, equity_cents: 2500, net_pnl_cents: 0, realized_net_cents: 0, unrealized_pnl_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, closed_trades: 0, max_drawdown_cents: 0, open_positions: 0 },
    { account_id: 'shadow_100', label: 'SHADOW $100', kind: 'PAPER', initial_cents: 10000, available_cents: 10000, invested_cents: 0, position_value_cents: 0, equity_cents: 10000, net_pnl_cents: 0, realized_net_cents: 0, unrealized_pnl_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, closed_trades: 0, max_drawdown_cents: 0, open_positions: 0 },
    { account_id: 'shadow_1000', label: 'SHADOW $1,000', kind: 'PAPER', initial_cents: 100000, available_cents: 100000, invested_cents: 0, position_value_cents: 0, equity_cents: 100000, net_pnl_cents: 0, realized_net_cents: 0, unrealized_pnl_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, closed_trades: 0, max_drawdown_cents: 0, open_positions: 0 },
  ];
  grid.innerHTML = accts.map(a => {
    const netC = a.net_pnl_cents ?? ((a.equity_cents || 0) - (a.initial_cents || 0));
    const retPct = Number(a.return_pct || 0);
    const netColor = netC >= 0 ? 'var(--pos)' : 'var(--neg)';
    const valLabel = (a.open_positions > 0 && a.mark_reliable === false)
      ? `Position Value (Cost Basis · ${a.marked_positions_count || 0}/${a.open_positions} quoted)`
      : 'Current Position Value';
    return `
    <div class="kpi-card" style="padding:12px">
      <div class="kpi-head"><b>${a.label}</b><span class="tag ${a.kind === 'REAL' ? 'real' : 'info'}">${a.kind === 'REAL' ? 'REAL' : 'PAPER SIM'}</span></div>
      <div style="font-size:11px;color:#94a3b8;margin-top:4px">TOTAL EQUITY</div>
      <div class="kpi-val mono">${fmtUsd((a.equity_cents || 0) / 100)}</div>
      <div class="kpi-sub" style="color:${netColor}">NET P&amp;L: ${fmtSignedUsd(netC / 100)} (${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%)</div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:2px 8px;font-size:11px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(148,163,184,0.15)">
        <span class="muted">Starting Balance</span><span class="mono">${fmtUsd((a.initial_cents || 0) / 100)}</span>
        <span class="muted">Available Cash</span><span class="mono">${fmtUsd((a.available_cents || 0) / 100)}</span>
        <span class="muted">Invested Balance</span><span class="mono">${fmtUsd((a.invested_cents || 0) / 100)}</span>
        <span class="muted">${valLabel}</span><span class="mono">${fmtUsd((a.position_value_cents ?? a.invested_cents ?? 0) / 100)}</span>
        <span class="muted">Est. Net Sell Value</span><span class="mono">${a.net_sell_value_cents != null ? fmtUsd(a.net_sell_value_cents / 100) : '–'}</span>
        <span class="muted">Realized / Unrealized</span><span class="mono">${fmtSignedUsd((a.realized_net_cents || 0) / 100)} / ${fmtSignedUsd((a.unrealized_pnl_cents || 0) / 100)}</span>
      </div>
      <div class="muted" style="font-size:11px;margin-top:6px">Open: ${a.open_positions ?? 0} · Completed: ${a.closed_trades ?? 0} (${a.wins ?? 0}W/${a.losses ?? 0}L) · Fees: ${fmtUsd((a.fees_cents || 0) / 100)}</div>
    </div>`;
  }).join('');
}

function renderMarketViz(snap, effState = 'STALE', feedAgeS = null) {
  const box = $('market-viz');
  const run = snap?.run || {};
  const accts = snap?.three_accounts?.accounts || [];
  const totalOpen = accts.reduce((acc, a) => acc + Number(a.open_positions || 0), 0);
  const totalTrades = accts.reduce((acc, a) => acc + Number(a.trades_count || 0), 0);
  const armedLabel = effState === 'ONLINE'
    ? (snap?.barnacle_status || 'STANDBY')
    : `UNVERIFIED (${effState}${feedAgeS != null ? ' · ' + feedAgeS + 's old' : ''})`;
  box.innerHTML = `<div style="width:100%;display:grid;gap:8px;font-size:13px">
    <div><b>Publisher Connectivity:</b> ${effState} · <b>Live Trading Armed:</b> ${armedLabel}</div>
    <div><b>24h Clock:</b> ${run.first_fill_ts ? fmtEt(run.first_fill_ts) : 'Awaiting first fill'} · <b>Total Trades (4 Accounts):</b> ${totalTrades} · <b>Open Holdings:</b> ${totalOpen}</div>
    <div class="muted">Public feed reports reconciled balances, actual open holdings, and completed trades across all 4 accounts.</div>
  </div>`;
}

function openBetModal(bet) {
  $('modal-title').textContent = bet.ticker || 'Bet Detail';
  $('modal-body').innerHTML = `
    <p>${bet.description || ''}</p>
    <pre class="mono" style="white-space:pre-wrap;font-size:12px;background:#050914;padding:10px;border-radius:8px">${JSON.stringify(bet, null, 2)}</pre>`;
  $('trace-modal').showModal();
}

function renderAll(snap, connState = 'WAITING') {
  currentSnap = snap;
  const run = snap.run || {};
  const m24 = run.milestone_24h_snapshot;
  const use24 = viewMode === 'first_24h' && m24;
  const m = use24 ? {
    initial_capital_usd: (m24.initial_capital_cents || 500) / 100,
    contributions_usd: (m24.contributions_cents || 500) / 100,
    verified_equity_usd: (m24.reconciled_equity_cents || 500) / 100,
    realized_net_usd: (m24.realized_net_cents || 0) / 100,
    unrealized_pnl_usd: null,
    return_pct_excl_deposits: m24.return_pct_excl_deposits || 0,
    fees_usd: (m24.fees_cents || 0) / 100,
    wins: m24.wins || 0,
    losses: m24.losses || 0,
  } : (snap.metrics || {});

  $('run-title').textContent = run.title || 'Strategy Discovery — Live Run #001';
  const startUsd = m.starting_capital_usd ?? m.authorized_bankroll_usd ?? 25.0;
  const availUsd = m.available_cash_usd ?? startUsd;
  const posValUsd = m.open_position_value_usd ?? 0.0;
  const invUsd = m.invested_balance_usd ?? 0.0;
  const eqUsd = m.verified_equity_usd ?? (availUsd + posValUsd);
  const netPnlUsd = m.net_pnl_usd ?? (eqUsd - startUsd);
  const outsideUsd = m.shard0_outside_usd ?? 0.58;
  $('run-subtitle').textContent = `Starting Capital: ${fmtUsd(startUsd)} · Four-Account Controlled Comparison`;
  const walletTxt = m.verified_kalshi_wallet_usd != null ? fmtUsd(m.verified_kalshi_wallet_usd) : '–';
  $('kpi-init').textContent = fmtUsd(startUsd);
  $('kpi-contrib').textContent = `Original Allocation · Excluded Outside Cash: ${fmtUsd(outsideUsd)}`;
  if ($('kpi-avail')) $('kpi-avail').textContent = fmtUsd(availUsd);
  if ($('kpi-wallet')) $('kpi-wallet').textContent = `Kalshi Shard 2 · Combined Wallet: ${walletTxt}`;
  if ($('kpi-posval')) $('kpi-posval').textContent = fmtUsd(posValUsd);
  if ($('kpi-invested')) $('kpi-invested').textContent = `Invested: ${fmtUsd(invUsd)} · Est. Net Sell: ${m.estimated_net_sell_usd != null ? fmtUsd(m.estimated_net_sell_usd) : '–'} · ${m.open_positions ?? 0} Open`;
  $('kpi-equity').textContent = fmtUsd(eqUsd);
  $('kpi-return').textContent = `Cash + Position Value · Return: ${Number(m.return_pct_excl_deposits || 0) >= 0 ? '+' : ''}${Number(m.return_pct_excl_deposits || 0).toFixed(2)}%`;
  $('kpi-pnl').textContent = fmtSignedUsd(netPnlUsd);
  $('kpi-pnl').style.color = Number(netPnlUsd || 0) >= 0 ? 'var(--pos)' : 'var(--neg)';
  $('kpi-unrealized').textContent = `Realized: ${fmtSignedUsd(m.realized_net_usd || 0)} · Unrealized: ${m.unrealized_pnl_usd == null ? '–' : fmtSignedUsd(m.unrealized_pnl_usd)}`;
  $('kpi-record').textContent = `${m.wins ?? 0}W / ${m.losses ?? 0}L`;
  $('kpi-fees').textContent = `Open: ${m.open_positions ?? 0} · Total fees: ${fmtUsd(m.fees_usd)}`;
  $('feed-delay').textContent = `Public delay: ${snap.publish_delay_s ?? 60}s`;
  const pubTs = snap.published_ts || (snap.published_at_utc ? Date.parse(snap.published_at_utc) / 1000 : null);
  const feedAgeS = pubTs ? Math.max(0, Math.round(Date.now() / 1000 - pubTs)) : null;
  const pubSt = snap.publisher_status || 'DISABLED';
  const effState = connState === 'OFFLINE' ? 'OFFLINE'
    : (!pubTs || pubSt === 'DISABLED' || (feedAgeS != null && feedAgeS > 180)) ? 'STALE'
      : 'ONLINE';
  $('chart-asof').textContent = snap.published_at_utc ? `As of ${snap.published_at_utc} (${feedAgeS}s ago)` : 'Awaiting live feed';
  $('last-verified').textContent = `Publisher: ${pubSt} · Last Published: ${fmtEt(snap.last_published_ts || pubTs)} · Source Event: ${fmtEt(snap.source_event_ts)} · Feed Age: ${feedAgeS != null ? feedAgeS + 's' : '–'}`;

  const pill = $('conn-pill');
  if (effState === 'ONLINE') { pill.textContent = '● ONLINE'; pill.className = 'pill ok'; }
  else if (effState === 'STALE') { pill.textContent = '● STALE / SNAPSHOT'; pill.className = 'pill warn'; }
  else { pill.textContent = '● OFFLINE'; pill.className = 'pill bad'; }

  const banner = $('truth-banner');
  if (viewMode === 'first_24h' && !m24) {
    banner.textContent = 'First 24 Hours milestone has not completed yet — the 24-hour clock starts on the first exchange-confirmed real fill.';
  } else if (connState === 'OFFLINE') {
    banner.textContent = `Barnacle relay offline or unreachable. Showing last verified snapshot (${snap.published_at_utc || 'none'}).`;
  } else if (pubSt === 'DISABLED') {
    banner.textContent = `Public publishing is currently DISABLED in Barnacle — displaying last verified snapshot (${snap.published_at_utc || 'standby'}) rather than live updates.`;
  } else if (effState === 'STALE') {
    banner.textContent = `STALE SNAPSHOT (${feedAgeS != null ? feedAgeS + 's old' : 'age unknown'}) — Live trading armed status cannot be verified from a stale snapshot. Last published: ${snap.published_at_utc || 'unknown'}.`;
  } else {
    banner.textContent = `Publisher: ONLINE · Live Trading: ${snap.barnacle_status || 'STANDBY'} · Delay: ${snap.publish_delay_s ?? 60}s · Shard 2 Cash: ${fmtUsd(availUsd)} · Portfolio Value: ${fmtUsd(posValUsd)} · Total Equity: ${fmtUsd(eqUsd)}.`;
  }

  renderClock(run);
  renderThreeAccounts(snap);
  renderBankrollChart(snap);
  renderMarketViz(snap, effState, feedAgeS);

  // Open Holdings (All 4 Accounts: REAL + PAPER SIM)
  const openBox = $('open-positions-cards');
  const holdings = snap.holdings || snap.open_positions_list || (snap.bets || []).filter(b => String(b.status || '').toUpperCase() === 'OPEN');
  if (openBox) {
    openBox.innerHTML = '';
    if (!holdings.length) {
      openBox.innerHTML = '<div class="muted">No open holdings right now.</div>';
    } else {
      holdings.slice(0, 30).forEach(p => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'bet-card';
        const isReal = p.kind === 'REAL' || p.account_id === 'live_25';
        const valTxt = p.current_value_usd != null ? fmtUsd(p.current_value_usd) : 'Cost Basis (No Quote)';
        const sellTxt = p.estimated_net_sell_usd != null ? fmtUsd(p.estimated_net_sell_usd) : '–';
        const sellPnlTxt = p.sell_pnl_usd != null ? fmtSignedUsd(p.sell_pnl_usd) : '–';
        const uTxt = p.unrealized_pnl_usd != null ? fmtSignedUsd(p.unrealized_pnl_usd) : '–';
        btn.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
            <span><span class="tag ${isReal ? 'real' : 'info'}" style="font-size:10px;margin-right:6px">${p.account_label || 'LIVE $25'}</span><b>${p.ticker}</b></span>
            <span class="tag ${isReal ? 'real' : 'info'}">${p.side || 'OPEN'} · ${p.contracts ?? p.count ?? 0}x</span>
          </div>
          <div class="muted" style="font-size:11px;margin-top:2px">${p.event_title || ''}</div>
          <div class="muted" style="font-size:12px;margin-top:4px">
            Entry: ${p.entry_price_cents != null ? p.entry_price_cents + '¢' : '–'} · Invested: ${fmtUsd(p.invested_usd)} · Cur Value: ${valTxt} · Unrealized: ${uTxt}
          </div>
          <div class="muted" style="font-size:11px;margin-top:2px">
            Est. Net Sell (hypothetical): ${sellTxt} (${sellPnlTxt})
          </div>`;
        btn.onclick = () => openBetModal(p);
        openBox.append(btn);
      });
    }
  }

  // Completed & Settled Trades (All 4 Accounts)
  const betsBox = $('bet-cards');
  const completedTrades = snap.completed_trades || (snap.bets || []).filter(b => ['SETTLED', 'SOLD', 'settled'].includes(String(b.status || '')));
  betsBox.innerHTML = '';
  if (!completedTrades.length) {
    betsBox.innerHTML = '<div class="muted">No completed settlements yet across the 4 accounts.</div>';
  } else {
    completedTrades.slice(0, 30).forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bet-card';
      const isReal = b.kind === 'REAL' || b.account_id === 'live_25';
      const pnl = b.realized_net_usd ?? b.net_pnl_usd ?? 0;
      btn.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span><span class="tag ${isReal ? 'real' : 'info'}" style="font-size:10px;margin-right:6px">${b.account_label || 'LIVE $25'}</span><b>${b.ticker}</b></span>
          <span class="pill">${b.result || b.status || 'SETTLED'} (${fmtSignedUsd(pnl)})</span>
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">${b.side || ''} · ${b.contracts ?? b.count ?? 0}x @ ${b.entry_price_cents ?? '–'}¢ · Fee: ${fmtUsd(b.fee_usd || 0)}</div>`;
      btn.onclick = () => openBetModal(b);
      betsBox.append(btn);
    });
  }

  // Purchases & Holdings Explorer (Open Holdings first, followed by Completed Trades)
  const allActual = [...holdings, ...completedTrades];
  const q = $('filter-q').value.trim().toLowerCase();
  const acctFilter = $('filter-account') ? $('filter-account').value : '';
  const stFilter = $('filter-status').value.toUpperCase();
  const rows = allActual.filter(b => {
    const matchQ = !q || (b.ticker || '').toLowerCase().includes(q) || (b.event_title || '').toLowerCase().includes(q);
    const matchAcct = !acctFilter || b.account_id === acctFilter;
    const matchSt = !stFilter || String(b.status || '').toUpperCase() === stFilter;
    return matchQ && matchAcct && matchSt;
  });
  $('explorer-body').innerHTML = rows.length
    ? rows.map(b => {
      const isOpen = String(b.status || '').toUpperCase() === 'OPEN';
      const isReal = b.kind === 'REAL' || b.account_id === 'live_25';
      const curOrUnreal = isOpen
        ? `${b.current_value_usd != null ? fmtUsd(b.current_value_usd) : 'No Quote'} (${b.unrealized_pnl_usd != null ? fmtSignedUsd(b.unrealized_pnl_usd) : '–'})`
        : 'Settled';
      const sellCol = isOpen
        ? `${b.estimated_net_sell_usd != null ? fmtUsd(b.estimated_net_sell_usd) : '–'} (${b.sell_pnl_usd != null ? fmtSignedUsd(b.sell_pnl_usd) : '–'})`
        : '—';
      const statusOrRealized = isOpen
        ? `OPEN · Fee $${Number(b.fee_usd || 0).toFixed(2)}`
        : `${b.result || b.status} · ${fmtSignedUsd(b.realized_net_usd ?? b.net_pnl_usd ?? 0)}`;
      return `<tr>
          <td>${fmtEt(b.opened_ts || b.ts)}</td>
          <td><span class="tag ${isReal ? 'real' : 'info'}" style="font-size:10px">${b.account_label || 'LIVE $25'}</span></td>
          <td><div class="mono">${b.ticker}</div><div class="muted" style="font-size:11px">${b.event_title || ''}</div></td>
          <td>${b.side || '–'}</td>
          <td>${b.contracts ?? b.count ?? '–'}</td>
          <td>${b.entry_price_cents != null ? b.entry_price_cents + '¢' : '–'}</td>
          <td class="mono">${fmtUsd(b.invested_usd)}</td>
          <td class="mono">${curOrUnreal}</td>
          <td class="mono">${sellCol}</td>
          <td>${statusOrRealized}</td>
        </tr>`;
    }).join('')
    : '<tr><td colspan="10" class="muted">No purchases or holdings match the current filter.</td></tr>';
}

let lastPollOk = false;

async function pollSnapshot() {
  if (!RELAY_URL) return;
  try {
    const r = await fetch(`${RELAY_URL}/snapshot`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const snap = await r.json();
    if (snap && snap.published_at_utc) {
      lastPollOk = true;
      saveCached(snap);
      renderAll(snap, 'LIVE');
    } else {
      lastPollOk = false;
      renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
    }
  } catch {
    lastPollOk = false;
    renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
  }
}

function connectStream() {
  if (!RELAY_URL) return;
  pollSnapshot();
  setInterval(pollSnapshot, 20000);
  try {
    if (es) es.close();
    es = new EventSource(`${RELAY_URL}/events`);
    es.onmessage = (ev) => {
      retryMs = 2000;
      lastPollOk = true;
      const snap = JSON.parse(ev.data);
      saveCached(snap);
      renderAll(snap, 'LIVE');
    };
    es.onerror = () => {
      if (!lastPollOk) renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
      es.close();
      setTimeout(connectStream, retryMs);
      retryMs = Math.min(30000, retryMs * 2);
    };
  } catch {
    if (!lastPollOk) renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
  }
}

$('btn-24h').onclick = () => { viewMode = 'first_24h'; $('btn-24h').classList.add('active'); $('btn-life').classList.remove('active'); renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING'); };
$('btn-life').onclick = () => { viewMode = 'lifetime'; $('btn-life').classList.add('active'); $('btn-24h').classList.remove('active'); renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING'); };
const setUnit = (u, btn) => { chartUnit = u;['unit-pct', 'unit-pnl', 'unit-usd'].forEach(id => $(id).classList.remove('active')); btn.classList.add('active'); renderBankrollChart(currentSnap); };
$('unit-pct').onclick = () => setUnit('pct', $('unit-pct'));
$('unit-pnl').onclick = () => setUnit('pnl', $('unit-pnl'));
$('unit-usd').onclick = () => setUnit('usd', $('unit-usd'));
$('line-live').onclick = () => { showLines.live_25 = !showLines.live_25; $('line-live').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('line-s25').onclick = () => { showLines.shadow_25 = !showLines.shadow_25; $('line-s25').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('line-s100').onclick = () => { showLines.shadow_100 = !showLines.shadow_100; $('line-s100').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('line-s1000').onclick = () => { showLines.shadow_1000 = !showLines.shadow_1000; $('line-s1000').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('filter-q').oninput = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
if ($('filter-account')) $('filter-account').onchange = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('filter-status').onchange = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('modal-close').onclick = () => $('trace-modal').close();

renderAll(loadCached() || emptySnapshot(), 'WAITING');
connectStream();
