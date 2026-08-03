import { drawSparkline, drawPriceChart, corrColor } from './charts.js';
import * as risk from './risk.js';

const $ = s => document.querySelector(s);

const state = {
  meta: null,
  members: [],
  bySym: new Map(),
  sort: 'rank',
  watchlist: new Set(JSON.parse(localStorage.getItem('watchlist') || '[]')),
  histories: new Map(),      // symbol -> {dates, close}
  detail: null,              // symbol currently shown
  detailRange: 252,
  view: 'screen',
};

const fmt = {
  price: v => v >= 1000 ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(2),
  pct: v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
  pct1: v => `${(v * 100).toFixed(1)}%`,
  num: v => v.toFixed(2),
  date: iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  dateShort: iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
};

function saveWatchlist() {
  localStorage.setItem('watchlist', JSON.stringify([...state.watchlist]));
}

async function fetchHistory(sym) {
  if (!state.histories.has(sym)) {
    const r = await fetch(`data/history/${sym}.json`);
    state.histories.set(sym, await r.json());
  }
  return state.histories.get(sym);
}

/* ---------------- freshness ---------------- */

function renderFreshness() {
  const m = state.meta;
  $('#freshness').innerHTML =
    `List formed ${fmt.dateShort(m.lastScreen)}<br>Prices through ${fmt.dateShort(m.pricesThrough + 'T00:00:00')}` +
    (m.fake ? ' · <b>sample data</b>' : '');
}

/* ---------------- ranked list ---------------- */

function sortedMembers() {
  const ms = [...state.members];
  const k = state.sort;
  if (k === 'rank') ms.sort((a, b) => a.rank - b.rank);
  else if (k === 'chg1d') ms.sort((a, b) => b.chg1d - a.chg1d);
  else if (k === 'ret') ms.sort((a, b) => b.ret - a.ret);
  else if (k === 'vol') ms.sort((a, b) => a.vol - b.vol);
  return ms;
}

function rowHTML(m) {
  const dir = m.chg1d >= 0 ? 'up' : 'down';
  const starred = state.watchlist.has(m.symbol);
  return `
    <div class="row" data-sym="${m.symbol}">
      <div class="rank">${m.rank}</div>
      <div class="id">
        <div class="sym">${m.symbol}</div>
        <div class="name">${m.name}</div>
      </div>
      <canvas class="spark"></canvas>
      <div class="px">
        <div class="price">${fmt.price(m.price)}</div>
        <div class="chg ${dir}">${fmt.pct(m.chg1d)}</div>
      </div>
      <button class="star ${starred ? 'on' : ''}" data-star="${m.symbol}">${starred ? '★' : '☆'}</button>
    </div>`;
}

function renderList(container, members) {
  container.innerHTML = members.map(rowHTML).join('');
  requestAnimationFrame(() => {
    container.querySelectorAll('.row').forEach(rowEl => {
      const m = state.bySym.get(rowEl.dataset.sym);
      drawSparkline(rowEl.querySelector('canvas.spark'), m.spark);
    });
  });
}

function renderScreen() {
  renderList($('#screen-list'), sortedMembers());
}

/* ---------------- watchlist ---------------- */

async function renderWatchlist() {
  const syms = [...state.watchlist].filter(s => state.bySym.has(s));
  const empty = syms.length === 0;
  $('#watchlist-empty').classList.toggle('hidden', !empty);
  $('#watchlist-body').classList.toggle('hidden', empty);
  if (empty) return;

  const members = syms.map(s => state.bySym.get(s)).sort((a, b) => a.rank - b.rank);
  renderList($('#watchlist-list'), members);

  const tiles = $('#risk-tiles');
  const hrpEl = $('#hrp-bars');
  const heatEl = $('#corr-heatmap');
  $('#corr-readout').innerHTML = '&nbsp;';

  if (syms.length < 2) {
    tiles.innerHTML = `<div class="tile" style="grid-column:1/-1"><div class="t-label">Add at least two names for correlation, ENB and HRP.</div></div>`;
    hrpEl.innerHTML = '';
    heatEl.innerHTML = '';
    return;
  }

  tiles.innerHTML = `<div class="loading" style="grid-column:1/-1">Crunching…</div>`;
  const histories = await Promise.all(syms.map(fetchHistory));
  const order = members.map(m => syms.indexOf(m.symbol));  // ranked order
  const ordered = order.map(i => histories[i]);
  const oSyms = members.map(m => m.symbol);

  const { rets } = risk.alignedReturns(ordered);
  const cov = risk.covMatrix(rets);
  const corr = risk.corrFromCov(cov);
  const { weights: w, order: clusterOrder } = risk.hrpWeights(cov, corr);
  const enbVal = risk.enb(corr);
  const avgC = risk.avgCorrelation(corr);
  const pVol = risk.portfolioVol(cov, w);

  tiles.innerHTML = `
    <div class="tile"><div class="t-label">Names</div><div class="t-value">${oSyms.length}</div></div>
    <div class="tile"><div class="t-label">Effective bets (ENB)</div><div class="t-value">${enbVal.toFixed(1)}</div></div>
    <div class="tile"><div class="t-label">Average correlation</div><div class="t-value">${fmt.num(avgC)}</div></div>
    <div class="tile"><div class="t-label">HRP portfolio volatility</div><div class="t-value">${fmt.pct1(pVol)}</div></div>`;

  // HRP weights, largest first
  const pairs = oSyms.map((s, i) => [s, w[i]]).sort((a, b) => b[1] - a[1]);
  const maxW = pairs[0][1];
  hrpEl.innerHTML = pairs.map(([s, wi]) => `
    <div class="hrp-row">
      <div class="hrp-sym">${s}</div>
      <div class="hrp-track"><div class="hrp-fill" style="width:${(wi / maxW * 100).toFixed(1)}%"></div></div>
      <div class="hrp-val">${fmt.pct1(wi)}</div>
    </div>`).join('');

  // correlation heatmap, rows/columns in dendrogram (cluster) order so
  // correlated groups appear as blocks along the diagonal
  const n = oSyms.length;
  const hSyms = clusterOrder.map(i => oSyms[i]);
  let cells = `<div class="corr-lab side"></div>` +
    hSyms.map(s => `<div class="corr-lab">${s.slice(0, 4)}</div>`).join('');
  for (let a = 0; a < n; a++) {
    cells += `<div class="corr-lab side">${hSyms[a].slice(0, 4)}</div>`;
    for (let b = 0; b < n; b++) {
      const v = corr[clusterOrder[a]][clusterOrder[b]];
      cells += `<div class="corr-cell" data-i="${clusterOrder[a]}" data-j="${clusterOrder[b]}" style="background:${corrColor(v)}"></div>`;
    }
  }
  heatEl.innerHTML = `<div class="corr-grid" style="grid-template-columns:44px repeat(${n},34px)">${cells}</div>`;
  heatEl.querySelectorAll('.corr-cell').forEach(c => {
    c.addEventListener('click', () => {
      heatEl.querySelectorAll('.corr-cell.sel').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
      const i = +c.dataset.i, j = +c.dataset.j;
      $('#corr-readout').textContent = `${oSyms[i]} × ${oSyms[j]}: ${corr[i][j].toFixed(2)}`;
    });
  });
}

/* ---------------- detail ---------------- */

let chartGeom = null;

async function openDetail(sym) {
  if (state.view !== 'detail') state.cameFrom = state.view;
  state.detail = sym;
  const m = state.bySym.get(sym);
  $('#d-sym').textContent = m.symbol;
  $('#d-name').textContent = `${m.name} · ${m.sector}`;
  $('#d-price').textContent = `$${fmt.price(m.price)}`;
  updateStarButton();
  showView('detail', m.symbol);
  $('#d-stats').innerHTML = `<div class="loading" style="grid-column:1/-1">Loading…</div>`;
  await fetchHistory(sym);
  renderDetailChart();
  renderDetailStats();
}

function detailSlice() {
  const h = state.histories.get(state.detail);
  const n = state.detailRange === 0 ? h.close.length : Math.min(state.detailRange + 1, h.close.length);
  return {
    dates: h.dates.slice(-n),
    closes: h.close.slice(-n),
  };
}

function renderDetailChart(scrubIndex = null) {
  const { dates, closes } = detailSlice();
  chartGeom = drawPriceChart($('#d-chart'), dates, closes, { scrubIndex });

  const i = scrubIndex == null ? closes.length - 1 : scrubIndex;
  const delta = closes[i] / closes[0] - 1;
  const el = $('#d-delta');
  el.textContent = `${fmt.pct(delta)} ${labelForRange(state.detailRange)}`;
  el.className = `hero-delta ${delta >= 0 ? 'up' : 'down'}`;
  $('#d-price').textContent = `$${fmt.price(closes[i])}`;

  const tip = $('#d-tip');
  if (scrubIndex == null) {
    tip.classList.add('hidden');
  } else {
    tip.classList.remove('hidden');
    tip.innerHTML = `<span class="tip-date">${fmt.date(dates[i])}</span>$${fmt.price(closes[i])}`;
    const wrap = $('.chart-wrap').getBoundingClientRect();
    const px = chartGeom.xAt(i);
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half + 4, Math.min(wrap.width - half - 4, px))}px`;
  }
}

function labelForRange(r) {
  return { 21: 'past month', 63: 'past 3 months', 126: 'past 6 months', 252: 'past year', 0: 'past 5 years' }[r];
}

function renderDetailStats() {
  const m = state.bySym.get(state.detail);
  const h = state.histories.get(state.detail);
  const yr = h.close.slice(-253);
  const stats = [
    ['Momentum rank', `#${m.rank}`],
    ['Score (ret ÷ vol)', fmt.num(m.score)],
    ['Window return', fmt.pct(m.ret)],
    ['Window volatility', fmt.pct1(m.vol)],
    ['52-week high', `$${fmt.price(Math.max(...yr))}`],
    ['52-week low', `$${fmt.price(Math.min(...yr))}`],
    ['1Y volatility', fmt.pct1(risk.annualizedVol(yr))],
    ['1Y max drawdown', fmt.pct(risk.maxDrawdown(yr))],
  ];
  $('#d-stats').innerHTML = stats.map(([l, v]) =>
    `<div class="tile"><div class="t-label">${l}</div><div class="t-value small">${v}</div></div>`).join('');
}

function updateStarButton() {
  const on = state.watchlist.has(state.detail);
  const b = $('#detail-star');
  b.textContent = on ? '★' : '☆';
  b.classList.toggle('on', on);
}

/* ---------------- navigation ---------------- */

function showView(view, title) {
  state.view = view;
  for (const v of ['screen', 'watchlist', 'detail']) {
    $(`#view-${v}`).classList.toggle('hidden', v !== view);
  }
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view));
  $('#view-title').textContent =
    title || (view === 'screen' ? 'Screen' : 'Watchlist');
  window.scrollTo(0, 0);
}

function toggleStar(sym) {
  if (state.watchlist.has(sym)) state.watchlist.delete(sym);
  else state.watchlist.add(sym);
  saveWatchlist();
  if (state.view === 'screen') renderScreen();
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'detail') updateStarButton();
}

/* ---------------- events ---------------- */

function wireEvents() {
  $('#sort-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.sort = chip.dataset.sort;
    document.querySelectorAll('#sort-chips .chip').forEach(c =>
      c.classList.toggle('active', c === chip));
    renderScreen();
  });

  for (const listSel of ['#screen-list', '#watchlist-list']) {
    $(listSel).addEventListener('click', e => {
      const star = e.target.closest('[data-star]');
      if (star) { toggleStar(star.dataset.star); return; }
      const row = e.target.closest('.row');
      if (row) openDetail(row.dataset.sym);
    });
  }

  document.querySelector('.tabbar').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    showView(tab.dataset.view);
    if (tab.dataset.view === 'screen') renderScreen();
    else renderWatchlist();
  });

  $('#detail-back').addEventListener('click', () => {
    const back = state.cameFrom === 'watchlist' ? 'watchlist' : 'screen';
    showView(back);
    if (back === 'screen') renderScreen(); else renderWatchlist();
  });

  $('#detail-star').addEventListener('click', () => toggleStar(state.detail));

  $('#range-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.detailRange = +chip.dataset.range;
    document.querySelectorAll('#range-chips .chip').forEach(c =>
      c.classList.toggle('active', c === chip));
    renderDetailChart();
  });

  // touch/mouse scrubbing on the price chart
  const chart = $('#d-chart');
  const scrub = clientX => renderDetailChart(chartGeom.indexAt(clientX));
  const end = () => renderDetailChart(null);
  chart.addEventListener('touchstart', e => scrub(e.touches[0].clientX), { passive: true });
  chart.addEventListener('touchmove', e => scrub(e.touches[0].clientX), { passive: true });
  chart.addEventListener('touchend', end);
  chart.addEventListener('mousedown', e => {
    scrub(e.clientX);
    const move = ev => scrub(ev.clientX);
    const up = () => { end(); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  window.addEventListener('resize', () => {
    if (state.view === 'screen') renderScreen();
    else if (state.view === 'watchlist') renderWatchlist();
    else if (state.view === 'detail' && state.histories.has(state.detail)) renderDetailChart();
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  $('#screen-list').innerHTML = `<div class="loading">Loading…</div>`;
  const [meta, screen] = await Promise.all([
    fetch('data/meta.json').then(r => r.json()),
    fetch('data/screen.json').then(r => r.json()),
  ]);
  state.meta = meta;
  state.members = screen.members;
  state.members.forEach(m => state.bySym.set(m.symbol, m));
  renderFreshness();
  wireEvents();
  renderScreen();
}

boot();
