// Barnacle Public Display-Only Terminal — Strategy Discovery — Live Run #001
const STORAGE_KEY = 'barnacle_live_run_001_snapshot';
const params = new URLSearchParams(location.search);
const RELAY_URL = (params.get('relay') || '').replace(/\/$/, '');

const $ = (id) => document.getElementById(id);
let viewMode = 'lifetime'; // 'first_24h' | 'lifetime'
let vizMode = 'crypto';    // 'crypto' | 'geo'
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

function renderBankrollChart(series) {
  const box = $('bankroll-chart');
  if (!series || !series.length) {
    box.innerHTML = '<div class="muted">No exchange-confirmed bankroll events published yet. Chart updates automatically on real fills &amp; deposits.</div>';
    return;
  }
  const w = 520, h = 190, pad = 28;
  const vals = series.map(p => Number(p.equity_usd || 5));
  const minV = Math.min(...vals, 4.5), maxV = Math.max(...vals, 5.5);
  const span = Math.max(0.5, maxV - minV);
  const pts = vals.map((v, i) => {
    const x = pad + (series.length === 1 ? (w - 2 * pad) / 2 : (i / (series.length - 1)) * (w - 2 * pad));
    const y = h - pad - ((v - minV) / span) * (h - 2 * pad);
    return { x, y, raw: series[i] };
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const dots = pts.map(p => {
    const col = p.raw.event === 'deposit' ? '#38bdf8' : (Number(p.raw.pnl_usd || 0) >= 0 ? '#34d399' : '#f87171');
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" fill="${col}"><title>${p.raw.event}: $${Number(p.raw.equity_usd).toFixed(2)} (${fmtEt(p.raw.ts)})</title></circle>`;
  }).join('');
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:190px"><path d="${d}" fill="none" stroke="#34d399" stroke-width="2.2"/>${dots}<text x="${pad}" y="16" fill="#94a3b8" font-size="11">High $${maxV.toFixed(2)} · Low $${minV.toFixed(2)}</text></svg>`;
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
  $('kpi-init').textContent = fmtUsd(m.initial_capital_usd);
  $('kpi-contrib').textContent = `Contributions: ${fmtUsd(m.contributions_usd)}`;
  $('kpi-equity').textContent = fmtUsd(m.verified_equity_usd);
  $('kpi-return').textContent = `Return excl. deposits: ${Number(m.return_pct_excl_deposits || 0) >= 0 ? '+' : ''}${Number(m.return_pct_excl_deposits || 0).toFixed(2)}%`;
  $('kpi-pnl').textContent = fmtSignedUsd(m.realized_net_usd);
  $('kpi-pnl').style.color = Number(m.realized_net_usd || 0) >= 0 ? 'var(--pos)' : 'var(--neg)';
  $('kpi-unrealized').textContent = m.unrealized_pnl_usd == null ? 'Unrealized: Not Recorded' : `Unrealized: ${fmtSignedUsd(m.unrealized_pnl_usd)}`;
  $('kpi-record').textContent = `${m.wins ?? 0}W / ${m.losses ?? 0}L`;
  $('kpi-fees').textContent = `Total fees: ${fmtUsd(m.fees_usd)}`;
  $('feed-delay').textContent = `Public delay: ${snap.publish_delay_s ?? 60}s`;
  $('chart-asof').textContent = snap.published_at_utc ? `As of ${snap.published_at_utc}` : 'Awaiting live feed';
  $('last-verified').textContent = `Last verified update: ${snap.published_at_utc || 'None yet (display standby)'}`;

  const pill = $('conn-pill');
  if (connState === 'LIVE') { pill.textContent = '● LIVE STREAM'; pill.className = 'pill ok'; }
  else if (connState === 'OFFLINE') { pill.textContent = '● OFFLINE'; pill.className = 'pill bad'; }
  else { pill.textContent = '● WAITING FOR FIRST FILL'; pill.className = 'pill warn'; }

  const banner = $('truth-banner');
  if (viewMode === 'first_24h' && !m24) {
    banner.textContent = 'First 24 Hours milestone has not completed yet — the 24-hour clock starts on the first exchange-confirmed real fill. Showing standby state.';
  } else if (!RELAY_URL) {
    banner.textContent = 'Display-only public terminal ready. Outbound live publishing from Barnacle is disabled by default until approved; no demo trades are fabricated.';
  } else if (connState === 'OFFLINE') {
    banner.textContent = `Barnacle relay offline or unreachable. Showing last verified snapshot (${snap.published_at_utc || 'none'}).`;
  } else {
    banner.textContent = `Barnacle status: ${snap.barnacle_status || 'STANDBY'} · Public signal delay: ${snap.publish_delay_s ?? 60}s · Real-money results only.`;
  }

  renderClock(run);
  renderBankrollChart(snap.bankroll_series);
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

  // Feed
  const feedBox = $('activity-feed');
  const feed = snap.feed || [];
  feedBox.innerHTML = feed.length
    ? feed.map(f => `<div class="feed-item"><div style="display:flex;justify-content:space-between"><b>${f.ticker}</b><span class="muted">${fmtEt(f.ts)}</span></div><div class="muted">${f.kind} · ${f.reason}</div></div>`).join('')
    : '<div class="muted">No delayed public events received yet.</div>';

  // Explorer table
  const q = $('filter-q').value.trim().toLowerCase();
  const st = $('filter-status').value;
  const rows = bets.filter(b => (!q || b.ticker.toLowerCase().includes(q)) && (!st || b.status === st));
  $('explorer-body').innerHTML = rows.length
    ? rows.map(b => `<tr><td>${fmtEt(b.ts)}</td><td class="mono">${b.ticker}</td><td>${b.side}</td><td>${b.entry_cents}¢</td><td>${b.implied_odds_pct}%</td><td>${b.status}</td><td>$${Number(b.fee_usd || 0).toFixed(2)}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No matching real-money trades recorded yet.</td></tr>';
}

function connectStream() {
  if (!RELAY_URL) return;
  try {
    if (es) es.close();
    es = new EventSource(`${RELAY_URL}/events`);
    es.onmessage = (ev) => {
      retryMs = 2000;
      const snap = JSON.parse(ev.data);
      saveCached(snap);
      renderAll(snap, 'LIVE');
    };
    es.onerror = () => {
      renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
      es.close();
      setTimeout(connectStream, retryMs);
      retryMs = Math.min(30000, retryMs * 2);
    };
  } catch {
    renderAll(currentSnap || loadCached() || emptySnapshot(), 'OFFLINE');
  }
}

$('btn-24h').onclick = () => { viewMode = 'first_24h'; $('btn-24h').classList.add('active'); $('btn-life').classList.remove('active'); renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING'); };
$('btn-life').onclick = () => { viewMode = 'lifetime'; $('btn-life').classList.add('active'); $('btn-24h').classList.remove('active'); renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING'); };
$('viz-crypto').onclick = () => { vizMode = 'crypto'; $('viz-crypto').classList.add('active'); $('viz-geo').classList.remove('active'); renderMarketViz(currentSnap); };
$('viz-geo').onclick = () => { vizMode = 'geo'; $('viz-geo').classList.add('active'); $('viz-crypto').classList.remove('active'); renderMarketViz(currentSnap); };
$('filter-q').oninput = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('filter-status').onchange = () => renderAll(currentSnap, RELAY_URL ? 'LIVE' : 'WAITING');
$('modal-close').onclick = () => $('trace-modal').close();

renderAll(loadCached() || emptySnapshot(), 'WAITING');
connectStream();
