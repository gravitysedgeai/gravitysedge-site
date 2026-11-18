// Barnacle Public Display-Only Terminal — Strategy Discovery — Live Run #001
const STORAGE_KEY = 'barnacle_live_run_001_snapshot';
const params = new URLSearchParams(location.search);
const RELAY_URL = (params.get('relay') || 'https://barnacle-live-relay.gravitysedge.workers.dev').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
let viewMode = 'lifetime'; // 'first_24h' | 'lifetime'
let vizMode = 'crypto';    // 'crypto' | 'geo'
let chartUnit = 'usd';     // 'usd' | 'pct'
let showLines = { live_25: true, shadow_100: true, shadow_1000: true };
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
    run: { run_number: 1, run_label: '#001', title: 'Strategy Discovery — Live Run #001', subtitle: 'From $5 to wherever discovery takes us.', first_fill_ts: null, milestone_24h_snapshot: null },
    metrics: { initial_capital_usd: 5.0, contributions_usd: 5.0, verified_equity_usd: 5.0, realized_net_usd: 0.0, unrealized_pnl_usd: null, return_pct_excl_deposits: 0.0, fees_usd: 0.0, closed_trades: 0, wins: 0, losses: 0, open_positions: 0 },
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
    { key: 'live_25', label: 'LIVE (actual)', color: '#34d399', init: 500 },
    { key: 'shadow_100', label: 'SHADOW $100 (sim)', color: '#38bdf8', init: 10000 },
    { key: 'shadow_1000', label: 'SHADOW $1,000 (sim)', color: '#f59e0b', init: 100000 },
  ];
  accounts.forEach(a => {
    const sp = lineSpecs.find(x => x.key === a.account_id);
    if (sp && a.initial_cents) sp.init = a.initial_cents;
  });
  const activeLines = lineSpecs.filter(sp => showLines[sp.key] && Array.isArray(seriesMap[sp.key]) && seriesMap[sp.key].length);
  if (!activeLines.length) {
    const series = snap?.bankroll_series || [];
    if (!series.length) {
      box.innerHTML = '<div class="muted">No exchange-confirmed or shadow bankroll events published yet. Chart updates automatically on fills &amp; settlements.</div>';
      return;
    }
    activeLines.push({ key: '__legacy__', label: 'LIVE', color: '#34d399', init: 500, ptsRaw: series.map(p => ({ ts: p.ts, equity_cents: Number(p.equity_usd || 5) * 100, pnl_cents: Number(p.pnl_usd || 0) * 100 })) });
  }
  const w = 520, h = 195, pad = 30;
  const allY = [];
  activeLines.forEach(sp => {
    const raw = sp.ptsRaw || seriesMap[sp.key] || [];
    sp.vals = raw.map(p => chartUnit === 'pct' ? ((Number(p.pnl_cents || 0) / Math.max(1, sp.init)) * 100) : (Number(p.equity_cents || sp.init) / 100));
    allY.push(...sp.vals);
  });
  const minV = Math.min(...allY), maxV = Math.max(...allY);
  const span = Math.max(chartUnit === 'pct' ? 1.0 : 1.0, maxV - minV);
  const paths = activeLines.map(sp => {
    const vals = sp.vals;
    const pts = vals.map((v, i) => ({
      x: pad + (vals.length === 1 ? (w - 2 * pad) / 2 : (i / (vals.length - 1)) * (w - 2 * pad)),
      y: h - pad - ((v - minV) / span) * (h - 2 * pad),
    }));
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const dots = pts.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="${sp.color}"><title>${sp.label}: ${chartUnit === 'pct' ? vals[i].toFixed(2) + '%' : '$' + vals[i].toFixed(2)}</title></circle>`).join('');
    return `<path d="${d}" fill="none" stroke="${sp.color}" stroke-width="2.1"/>${dots}`;
  }).join('');
  const unitLbl = chartUnit === 'pct' ? '%' : '$';
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:195px">${paths}<text x="${pad}" y="15" fill="#94a3b8" font-size="11">High ${unitLbl === '$' ? '$' : ''}${maxV.toFixed(2)}${unitLbl === '%' ? '%' : ''} · Low ${unitLbl === '$' ? '$' : ''}${minV.toFixed(2)}${unitLbl === '%' ? '%' : ''}</text></svg>`;
}

function renderThreeAccounts(snap) {
  const grid = $('three-accounts-grid');
  if (!grid) return;
  const accts = snap?.three_accounts?.accounts || [
    { account_id: 'live_25', label: 'LIVE $25', kind: 'REAL', initial_cents: 500, equity_cents: 500, realized_net_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, compounding_cycles: 0, max_drawdown_cents: 0, open_positions: 0, missed_bankroll_count: 0 },
    { account_id: 'shadow_100', label: 'SHADOW $100', kind: 'PAPER', initial_cents: 10000, equity_cents: 10000, realized_net_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, compounding_cycles: 0, max_drawdown_cents: 0, open_positions: 0, missed_bankroll_count: 0 },
    { account_id: 'shadow_1000', label: 'SHADOW $1,000', kind: 'PAPER', initial_cents: 100000, equity_cents: 100000, realized_net_cents: 0, return_pct: 0, fees_cents: 0, trades_count: 0, compounding_cycles: 0, max_drawdown_cents: 0, open_positions: 0, missed_bankroll_count: 0 },
  ];
  grid.innerHTML = accts.map(a => `
    <div class="kpi-card" style="padding:12px">
      <div class="kpi-head"><b>${a.label}</b><span class="tag ${a.kind === 'REAL' ? 'real' : 'info'}">${a.kind === 'REAL' ? 'REAL' : 'PAPER SIM'}</span></div>
      <div class="kpi-val mono">${fmtUsd((a.equity_cents || 0) / 100)}</div>
      <div class="kpi-sub">P&amp;L: ${fmtSignedUsd((a.realized_net_cents || 0) / 100)} (${Number(a.return_pct || 0) >= 0 ? '+' : ''}${Number(a.return_pct || 0).toFixed(2)}%)</div>
      <div class="muted" style="font-size:11px;margin-top:4px">Trades: ${a.trades_count ?? 0} · Fees: ${fmtUsd((a.fees_cents || 0) / 100)} · Cycles: ${a.compounding_cycles ?? 0}</div>
      <div class="muted" style="font-size:11px">Open: ${a.open_positions ?? 0} · Max DD: ${fmtUsd((a.max_drawdown_cents || 0) / 100)} · Missed Cap: ${a.missed_bankroll_count ?? 0}</div>
    </div>`).join('');
}

function renderMarketViz(snap) {
  const box = $('market-viz');
  if (vizMode === 'geo') {
    const pins = snap.geo_markets || [];
    if (!pins.length) {
      box.innerHTML = '<div class="muted">No location-based markets (e.g. Weather) active in Live Run #001 yet. Current scope is BTC/ETH; geographic pins appear only for genuinely location-based contracts.</div>';
      return;
    }
    box.innerHTML = `<svg viewBox="0 0 500 200" style="width:100%;height:190px"><rect x="10" y="15" width="480" height="170" rx="12" fill="rgba(56,189,248,0.05)" stroke="rgba(148,163,184,0.2)"/>${pins.map(p => `<circle cx="${p.x || 250}" cy="${p.y || 100}" r="6" fill="#38bdf8"><title>${p.label || p.ticker}</title></circle>`).join('')}</svg>`;
    return;
  }
  const cm = snap.crypto_markets || [];
  if (!cm.length) {
    box.innerHTML = '<div class="muted">Waiting for live BTC/ETH signal telemetry. Displays favorite proxy (&ge;0.88) vs. spread (&le;0.04) and 5m volatility (&le;0.01).</div>';
    return;
  }
  box.innerHTML = `<div style="width:100%;display:grid;gap:6px">${cm.slice(0, 5).map(m =>
    `<div style="display:flex;justify-content:space-between;font-size:12px;border-bottom:1px solid rgba(148,163,184,.12);padding:4px 0">
      <span class="mono"><b>${m.ticker}</b></span>
      <span class="muted">fav ${m.favorite_proxy != null ? Number(m.favorite_proxy).toFixed(3) : '–'} · spr ${m.spread != null ? Number(m.spread).toFixed(3) : '–'} · std ${m.mid_std_5m != null ? Number(m.mid_std_5m).toFixed(4) : '–'}</span>
    </div>`).join('')}</div>`;
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
  $('run-subtitle').textContent = run.subtitle || 'From $5 to wherever discovery takes us.';
  const authUsd = m.authorized_bankroll_usd ?? m.initial_capital_usd ?? 5.0;
  const walletTxt = m.verified_kalshi_wallet_usd != null ? fmtUsd(m.verified_kalshi_wallet_usd) : '–';
  const propTxt = m.proposed_allocation_usd != null ? `Pending Approval: ${fmtUsd(m.proposed_allocation_usd)}` : `Contributions: ${fmtUsd(m.contributions_usd)}`;
  $('kpi-init').textContent = fmtUsd(authUsd);
  $('kpi-contrib').textContent = `Kalshi Wallet: ${walletTxt} · ${propTxt}`;
  $('kpi-equity').textContent = fmtUsd(m.verified_equity_usd);
  $('kpi-return').textContent = `Return excl. deposits: ${Number(m.return_pct_excl_deposits || 0) >= 0 ? '+' : ''}${Number(m.return_pct_excl_deposits || 0).toFixed(2)}%`;
  $('kpi-pnl').textContent = fmtSignedUsd(m.realized_net_usd);
  $('kpi-pnl').style.color = Number(m.realized_net_usd || 0) >= 0 ? 'var(--pos)' : 'var(--neg)';
  $('kpi-unrealized').textContent = m.unrealized_pnl_usd == null ? 'Unrealized: Not Recorded' : `Unrealized: ${fmtSignedUsd(m.unrealized_pnl_usd)}`;
  $('kpi-record').textContent = `${m.wins ?? 0}W / ${m.losses ?? 0}L`;
  $('kpi-fees').textContent = `Total fees: ${fmtUsd(m.fees_usd)}`;
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
  } else {
    banner.textContent = `Barnacle status: ${snap.barnacle_status || 'STANDBY'} · Publisher: ${pubSt} · Delay: ${snap.publish_delay_s ?? 60}s · Verified Wallet: ${walletTxt} · Authorized XP Capital: ${fmtUsd(authUsd)}.`;
  }

  renderClock(run);
  renderThreeAccounts(snap);
  renderBankrollChart(snap);
  renderMarketViz(snap);

  // Bets
  const betsBox = $('bet-cards');
  const bets = snap.bets || [];
  betsBox.innerHTML = '';
  if (!bets.length) {
    betsBox.innerHTML = '<div class="muted">No real-money bets placed yet. Honest waiting state.</div>';
  } else {
    bets.forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bet-card';
      btn.innerHTML = `<div style="display:flex;justify-content:space-between"><b>${b.ticker}</b><span class="pill">${b.status}</span></div><div class="muted">${b.description} · Implied ${b.implied_odds_pct}%</div>`;
      btn.onclick = () => openBetModal(b);
      betsBox.append(btn);
    });
  }

  // Unified Chronological Feed (REAL vs PAPER) + clickable 3-account signal comparisons
  const feedBox = $('activity-feed');
  const unifiedFeed = (snap.three_accounts?.activity_feed || []).length
    ? snap.three_accounts.activity_feed
    : (snap.feed || []).map(f => ({ ...f, account: 'LIVE', kind: 'REAL', outcome: f.kind }));
  const comps = snap.three_accounts?.signal_comparisons || [];
  feedBox.innerHTML = unifiedFeed.length
    ? unifiedFeed.slice(0, 20).map(f => {
        const tag = `<span class="tag ${f.kind === 'REAL' ? 'real' : 'info'}" style="font-size:10px;margin-right:6px">${f.kind}</span>`;
        return `<div class="feed-item" style="cursor:pointer" data-sig="${f.ticker || ''}"><div style="display:flex;justify-content:space-between"><span>${tag}<b>${f.account || 'LIVE'} · ${f.ticker}</b></span><span class="muted">${fmtEt(f.ts)}</span></div><div class="muted">${f.outcome || f.kind} · ${f.reason}</div></div>`;
      }).join('')
    : '<div class="muted">No delayed public events received yet.</div>';
  feedBox.querySelectorAll('[data-sig]').forEach(el => {
    el.onclick = () => {
      const tk = el.getAttribute('data-sig');
      const cmp = comps.find(c => c.ticker === tk) || { ticker: tk, note: 'Single-account event' };
      openBetModal({ ticker: `3-Account Comparison: ${tk}`, description: 'Side-by-side LIVE vs SHADOW $100 vs SHADOW $1,000', ...cmp });
    };
  });

  // Explorer table
  const q = $('filter-q').value.trim().toLowerCase();
  const st = $('filter-status').value;
  const rows = bets.filter(b => (!q || b.ticker.toLowerCase().includes(q)) && (!st || b.status === st));
  $('explorer-body').innerHTML = rows.length
    ? rows.map(b => `<tr><td>${fmtEt(b.ts)}</td><td class="mono">${b.ticker}</td><td>${b.side}</td><td>${b.entry_cents}¢</td><td>${b.implied_odds_pct}%</td><td>${b.status}</td><td>$${Number(b.fee_usd || 0).toFixed(2)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No matching real-money trades recorded yet.</td></tr>';
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
$('unit-usd').onclick = () => { chartUnit = 'usd'; $('unit-usd').classList.add('active'); $('unit-pct').classList.remove('active'); renderBankrollChart(currentSnap); };
$('unit-pct').onclick = () => { chartUnit = 'pct'; $('unit-pct').classList.add('active'); $('unit-usd').classList.remove('active'); renderBankrollChart(currentSnap); };
$('line-live').onclick = () => { showLines.live_25 = !showLines.live_25; $('line-live').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('line-s100').onclick = () => { showLines.shadow_100 = !showLines.shadow_100; $('line-s100').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('line-s1000').onclick = () => { showLines.shadow_1000 = !showLines.shadow_1000; $('line-s1000').classList.toggle('active'); renderBankrollChart(currentSnap); };
$('viz-crypto').onclick = () => { vizMode = 'crypto'; $('viz-crypto').classList.add('active'); $('viz-geo').classList.remove('active'); renderMarketViz(currentSnap); };
$('viz-geo').onclick = () => { vizMode = 'geo'; $('viz-geo').classList.add('active'); $('viz-crypto').classList.remove('active'); renderMarketViz(currentSnap); };
$('filter-q').oninput = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('filter-status').onchange = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('modal-close').onclick = () => $('trace-modal').close();

renderAll(loadCached() || emptySnapshot(), 'WAITING');
connectStream();
