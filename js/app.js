import { drawBarSeries, drawPriceChart, corrColor, CORR_BUCKETS } from './charts.js';
import * as risk from './risk.js';

const $ = s => document.querySelector(s);

// eight validated categorical hues, one per behaviour family
const FAMILY_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500',
                       '#d55181', '#008300', '#9085e9', '#e66767'];

const state = {
  meta: null,
  members: [],
  bySym: new Map(),
  risk: null,        // {symbols, corr, index, cluster, clusterNames}
  gain: null,        // symbol -> diversification gain, recomputed on change
  sort: 'rank',
  watchlist: new Set(JSON.parse(localStorage.getItem('watchlist') || '[]')),
  ewTilt: Number(localStorage.getItem('ewTilt') ?? 50),   // % equal weight mixed in
  wl: null,          // {syms, cov, wHRP} for the current watchlist
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

// always revalidate data with the server — home-screen apps cache hard
const FRESH = { cache: 'no-cache' };

async function fetchHistory(sym) {
  if (!state.histories.has(sym)) {
    const r = await fetch(`data/history/${sym}.json`, FRESH);
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
  if (k === 'ret') ms.sort((a, b) => b.ret - a.ret);
  else if (k === 'vol') ms.sort((a, b) => a.vol - b.vol);
  else if (k === 'diversify') {
    const g = state.gain;
    ms.sort((a, b) => (g?.get(b.symbol) ?? -1) - (g?.get(a.symbol) ?? -1)
                      || a.rank - b.rank);
  } else if (k === 'family') {
    const cid = m => state.risk?.cluster?.[m.symbol];
    ms.sort((a, b) => {
      const ca = cid(a), cb = cid(b);
      if (ca === undefined && cb === undefined) return a.rank - b.rank;
      if (ca === undefined) return 1;    // unclassified names sink to the end
      if (cb === undefined) return -1;
      return ca - cb || a.rank - b.rank;
    });
  } else ms.sort((a, b) => a.rank - b.rank);
  return ms;
}

// what each candidate would add to the effective bets of the current watchlist
function refreshGains() {
  if (!state.risk) { state.gain = null; return; }
  const held = [...state.watchlist].filter(s => state.risk.index.has(s));
  const { gain, unit } = risk.diversificationGain(state.risk, held);
  state.gain = gain;
  state.gainUnit = unit;
}

function familyDot(sym) {
  const R = state.risk;
  if (!R || !(sym in R.cluster)) return '';
  const c = R.cluster[sym];
  return `<span class="fam-dot" style="background:${FAMILY_COLORS[c % 8]}" ` +
         `title="${R.clusterNames[c]}"></span>`;
}

// "≈ MU 0.75" when a name closely tracks something already held
function redundancyTag(sym) {
  if (!state.risk || state.watchlist.has(sym)) return '';
  const near = risk.nearestHeld(state.risk, sym, [...state.watchlist]);
  if (!near || near.corr < 0.6) return '';
  return `<div class="dupe">≈ ${near.symbol} ${near.corr.toFixed(2)}</div>`;
}

function rowHTML(m, showVol = false) {
  const starred = state.watchlist.has(m.symbol);
  const gain = state.sort === 'diversify' && state.gainUnit === 'bets'
      && state.gain?.has(m.symbol)
    ? `<div class="gain">+${state.gain.get(m.symbol).toFixed(2)} bets</div>`
    : '';
  const series = m.scoreSeries || [];
  const latest = [...series].reverse().find(v => v != null);
  const dir = latest == null ? '' : latest >= 0 ? 'up' : 'down';
  return `
    <div class="row" data-sym="${m.symbol}">
      <div class="rank">${m.rank}</div>
      <div class="id">
        <div class="sym">${familyDot(m.symbol)}${m.symbol}</div>
        <div class="name">${m.name}</div>
        ${gain || redundancyTag(m.symbol)
          || (showVol ? `<div class="volline">vol ${fmt.pct1(m.vol)}</div>` : '')}
      </div>
      <div class="spark-wrap">
        <div class="spark-head">
          <span class="spark-label">200–20D</span>
          <span class="spark-now ${dir}">${latest == null ? '—' : latest.toFixed(2)}</span>
        </div>
        <canvas class="spark"></canvas>
      </div>
      <button class="star ${starred ? 'on' : ''}" data-star="${m.symbol}">${starred ? '★' : '☆'}</button>
    </div>`;
}

function drawRowSparklines(container) {
  requestAnimationFrame(() => {
    container.querySelectorAll('.row').forEach(rowEl => {
      const m = state.bySym.get(rowEl.dataset.sym);
      drawBarSeries(rowEl.querySelector('canvas.spark'),
                    m.scoreSeries || [], state.scoreScale,
                    { signed: state.scoreSigned });
    });
  });
}

function renderList(container, members, showVol = false) {
  container.innerHTML = members.map(m => rowHTML(m, showVol)).join('');
  drawRowSparklines(container);
}

// same as renderList, but with a header dividing each behaviour family
function renderGroupedList(container, members) {
  const R = state.risk;
  let html = '', lastC;
  for (const m of members) {
    const c = R.cluster[m.symbol];
    if (c !== lastC) {
      html += c === undefined
        ? `<div class="fam-group-header">Not enough history to classify</div>`
        : `<div class="fam-group-header"><span class="fam-dot" ` +
          `style="background:${FAMILY_COLORS[c % 8]}"></span>${R.clusterNames[c]}</div>`;
      lastC = c;
    }
    html += rowHTML(m);
  }
  container.innerHTML = html;
  drawRowSparklines(container);
}

function renderScreen() {
  const ms = sortedMembers();
  if (state.sort === 'family' && state.risk) renderGroupedList($('#screen-list'), ms);
  else renderList($('#screen-list'), ms);
}

/* ---------------- watchlist ---------------- */

async function renderWatchlist() {
  const syms = [...state.watchlist].filter(s => state.bySym.has(s));
  const empty = syms.length === 0;
  $('#watchlist-empty').classList.toggle('hidden', !empty);
  $('#watchlist-body').classList.toggle('hidden', empty);
  if (empty) return;

  const members = syms.map(s => state.bySym.get(s)).sort((a, b) => a.rank - b.rank);
  renderList($('#watchlist-list'), members, true);
  renderFamilyCoverage(syms);

  const tiles = $('#risk-tiles');
  const hrpEl = $('#hrp-bars');
  const heatEl = $('#corr-heatmap');
  $('#corr-readout').innerHTML = '&nbsp;';

  if (syms.length < 2) {
    tiles.innerHTML = `<div class="tile" style="grid-column:1/-1"><div class="t-label">Add at least two names for correlation, ENB and HRP.</div></div>`;
    hrpEl.innerHTML = '';
    heatEl.innerHTML = '';
    $('#corr-pairs').innerHTML = '';
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
    <div class="tile"><div class="t-label">Portfolio volatility</div><div class="t-value" id="tile-vol">${fmt.pct1(pVol)}</div></div>
    <div class="tile"><div class="t-label">Beta vs ${state.risk?.benchmark || 'market'}</div><div class="t-value" id="tile-beta">—</div></div>
    <div class="tile"><div class="t-label">Largest weight</div><div class="t-value" id="tile-maxw">—</div></div>`;

  // keep the inputs so the tilt slider can re-weight without refetching
  state.wl = { syms: oSyms, cov, wHRP: w };
  renderWeights();

  // correlation heatmap, rows/columns in dendrogram (cluster) order so
  // correlated groups appear as blocks along the diagonal. Lower triangle
  // only; each column's label rides the staircase, just above its diagonal.
  const n = oSyms.length;
  const hSyms = clusterOrder.map(i => oSyms[i]);
  let cells = `<div class="corr-lab side"></div><div class="corr-lab">${hSyms[0].slice(0, 4)}</div>` +
    '<div></div>'.repeat(n - 1);
  for (let a = 0; a < n; a++) {
    cells += `<div class="corr-lab side">${hSyms[a].slice(0, 4)}</div>`;
    for (let b = 0; b < n; b++) {
      if (b > a) {
        cells += b === a + 1 ? `<div class="corr-lab">${hSyms[b].slice(0, 4)}</div>` : `<div></div>`;
        continue;
      }
      const v = corr[clusterOrder[a]][clusterOrder[b]];
      cells += `<div class="corr-cell" data-i="${clusterOrder[a]}" data-j="${clusterOrder[b]}" style="background:${corrColor(v)}"></div>`;
    }
  }
  const legend = CORR_BUCKETS.map(b =>
    `<span class="corr-key"><span class="corr-swatch" style="background:${b.color}"></span>${b.label}</span>`).join('');
  heatEl.innerHTML = `<div class="corr-grid" style="grid-template-columns:44px repeat(${n},34px)">${cells}</div>` +
    `<div class="corr-legend">${legend}</div>`;
  // every pair ranked, most to least correlated
  const pairsRanked = [];
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      pairsRanked.push({ a: oSyms[i], b: oSyms[j], v: corr[i][j] });
  pairsRanked.sort((x, y) => y.v - x.v);
  const pairRow = p => `
    <div class="pair-row">
      <span class="corr-swatch" style="background:${corrColor(p.v)}"></span>
      <span class="pair-syms">${p.a} × ${p.b}</span>
      <span class="pair-val">${p.v.toFixed(2)}</span>
    </div>`;
  const pairsEl = $('#corr-pairs');
  const SHOW = 12;
  const renderPairs = all => {
    pairsEl.innerHTML =
      (all ? pairsRanked : pairsRanked.slice(0, SHOW)).map(pairRow).join('') +
      (pairsRanked.length > SHOW
        ? `<button class="chip pairs-more">${all ? 'Show fewer' : `Show all ${pairsRanked.length}`}</button>`
        : '');
    const btn = pairsEl.querySelector('.pairs-more');
    if (btn) btn.addEventListener('click', () => renderPairs(!all));
  };
  renderPairs(false);

  heatEl.querySelectorAll('.corr-cell').forEach(c => {
    c.addEventListener('click', () => {
      heatEl.querySelectorAll('.corr-cell.sel').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
      const i = +c.dataset.i, j = +c.dataset.j;
      $('#corr-readout').textContent = `${oSyms[i]} × ${oSyms[j]}: ${corr[i][j].toFixed(2)}`;
    });
  });
}

// Blend HRP with equal weight. HRP concentrates wherever the estimates favour
// a name, and those estimates are noisy — equal weight is the humble baseline
// that's famously hard to beat out of sample. tilt = how much of it to mix in.
function blendedWeights() {
  const { syms, wHRP } = state.wl;
  const t = state.ewTilt / 100;
  const eq = 1 / syms.length;
  return wHRP.map(x => (1 - t) * x + t * eq);
}

function renderWeights() {
  if (!state.wl) return;
  const { syms, cov } = state.wl;
  const w = blendedWeights();
  const vol = risk.portfolioVol(cov, w);

  const pairs = syms.map((s, i) => [s, w[i]]).sort((a, b) => b[1] - a[1]);
  const maxW = pairs[0][1];
  $('#hrp-bars').innerHTML = pairs.map(([s, wi]) => `
    <div class="hrp-row">
      <div class="hrp-sym">${s}</div>
      <div class="hrp-track"><div class="hrp-fill" style="width:${(wi / maxW * 100).toFixed(1)}%"></div></div>
      <div class="hrp-val">${fmt.pct1(wi)}</div>
    </div>`).join('');

  const volEl = $('#tile-vol');
  if (volEl) volEl.textContent = fmt.pct1(vol);
  const maxEl = $('#tile-maxw');
  if (maxEl) maxEl.textContent = fmt.pct1(maxW);
  const betaEl = $('#tile-beta');
  if (betaEl) {
    const B = state.risk?.beta;
    const known = B ? syms.filter(s => s in B) : [];
    betaEl.textContent = known.length === syms.length
      ? syms.reduce((a, s, i) => a + w[i] * B[s], 0).toFixed(2)
      : '—';
  }
  $('#ew-tilt-label').innerHTML = state.ewTilt === 0
    ? `Pure HRP · largest ${fmt.pct1(maxW)}`
    : state.ewTilt === 100
      ? `Equal weight · every name ${fmt.pct1(maxW)}`
      : `${state.ewTilt}% equal weight · largest ${fmt.pct1(maxW)}`;
}

function renderFamilyCoverage(syms) {
  const R = state.risk;
  const el = $('#family-coverage');
  if (!R) { el.innerHTML = ''; return; }
  const held = new Map();
  for (const s of syms) {
    const c = R.cluster[s];
    if (c === undefined) continue;
    held.set(c, (held.get(c) || 0) + 1);
  }
  el.innerHTML = R.clusterNames.map((nm, c) => {
    const n = held.get(c) || 0;
    return `<div class="fam-row ${n ? '' : 'uncovered'}">
      <span class="fam-dot" style="background:${FAMILY_COLORS[c % 8]}"></span>
      <span class="fam-name">${nm}</span>
      <span class="fam-count">${n || '—'}</span>
    </div>`;
  }).join('');
  const covered = held.size;
  el.insertAdjacentHTML('afterbegin',
    `<div class="fam-head">${covered} of ${R.clusterNames.length} families</div>`);
  const sub = $('#families-sub');
  if (sub) sub.textContent =
    `The ${state.members.length} names group into ${R.clusterNames.length} ` +
    `behaviour families. Spreading across them is what lowers risk.`;
}

// add the single name that most improves effective bets — one tap, reversible
function suggestOne(btn) {
  if (!state.risk) return;
  refreshGains();
  let best = null;
  for (const [sym, g] of state.gain) {
    if (!state.bySym.has(sym)) continue;
    if (!best || g > best.g) best = { sym, g };
  }
  if (!best) return;
  const unit = state.gainUnit;
  state.watchlist.add(best.sym);
  saveWatchlist();
  refreshGains();
  renderWatchlist();
  const el = document.querySelector('#watchlist-body .suggest-btn') || btn;
  el.textContent = unit === 'bets'
    ? `Added ${best.sym} (+${best.g.toFixed(2)} bets)`
    : `Added ${best.sym}`;
  setTimeout(() => { el.textContent = '＋ Suggest a name'; }, 2600);
}

// tap once to arm, tap again within a few seconds to actually clear —
// no native confirm() dialog, but still a deliberate second action
function wireClearWatchlist() {
  const btn = $('#clear-watchlist');
  let armed = false, timer = null;
  const reset = () => {
    armed = false;
    btn.textContent = 'Clear watchlist';
    btn.classList.remove('confirm');
  };
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Tap again to clear';
      btn.classList.add('confirm');
      clearTimeout(timer);
      timer = setTimeout(reset, 3000);
      return;
    }
    clearTimeout(timer);
    reset();
    state.watchlist.clear();
    saveWatchlist();
    refreshGains();
    renderWatchlist();
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
  const beta = state.risk?.beta?.[m.symbol];
  const fam = state.risk && m.symbol in (state.risk.cluster || {})
    ? state.risk.clusterNames[state.risk.cluster[m.symbol]] : null;
  const stats = [
    ['Momentum rank', `#${m.rank}`],
    ['Score (ret ÷ vol)', fmt.num(m.score)],
    ...(beta === undefined ? [] :
        [[`Beta vs ${state.risk.benchmark || 'market'}`, beta.toFixed(2)]]),
    ...(fam ? [['Family', fam]] : []),
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
  refreshGains();   // redundancy flags and gains are relative to what's held
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
    if (state.sort === 'diversify') refreshGains();
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
  document.querySelectorAll('.suggest-btn').forEach(b =>
    b.addEventListener('click', () => suggestOne(b)));
  wireClearWatchlist();

  const tilt = $('#ew-tilt');
  tilt.value = state.ewTilt;
  tilt.addEventListener('input', () => {
    state.ewTilt = Number(tilt.value);
    localStorage.setItem('ewTilt', state.ewTilt);
    renderWeights();
  });

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

// One fixed axis for every rolling-score chart in the app, so bar heights are
// directly comparable card to card. A pure max would let a single extreme
// name flatten every other card, and offers no protection if a future one is
// more extreme still — so the scale is the 90th percentile of each member's
// own widest score, rounded up to a clean step. The rare name beyond that
// draws clipped, with a chevron marking it as capped rather than understated.
function scoreScale(members) {
  const maxAbsPerMember = members
    .map(m => (m.scoreSeries || []).filter(v => v != null).map(Math.abs))
    .filter(a => a.length)
    .map(a => Math.max(...a));
  if (!maxAbsPerMember.length) return 1;
  maxAbsPerMember.sort((a, b) => a - b);
  const p90 = maxAbsPerMember[Math.floor(maxAbsPerMember.length * 0.9)] ?? 0;
  return Math.max(0.5, Math.ceil(p90 * 2) / 2);
}

/* ---------------- boot ---------------- */

async function boot() {
  $('#screen-list').innerHTML = `<div class="loading">Loading…</div>`;
  const [meta, screen, riskData] = await Promise.all([
    fetch('data/meta.json', FRESH).then(r => r.json()),
    fetch('data/screen.json', FRESH).then(r => r.json()),
    fetch('data/risk.json', FRESH).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  state.meta = meta;
  state.members = screen.members;
  state.members.forEach(m => state.bySym.set(m.symbol, m));
  state.scoreScale = scoreScale(state.members);
  state.scoreSigned = state.members.some(
    m => (m.scoreSeries || []).some(v => v != null && v < 0));
  if (riskData) {
    riskData.index = new Map(riskData.symbols.map((s, i) => [s, i]));
    state.risk = riskData;
    refreshGains();
  } else {
    document.querySelector('[data-sort="diversify"]')?.remove();
    document.querySelector('[data-sort="family"]')?.remove();
  }
  renderFreshness();
  wireEvents();
  renderScreen();
}

// Keep the app current without a refresh button: check both for newer data
// AND for a newer published build (UI-only changes don't touch meta.json).
const runningBuild = document.querySelector('meta[name="build"]')?.content || '';

async function checkForUpdates() {
  try {
    const [ver, m] = await Promise.all([
      fetch('version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      state.meta
        ? fetch('data/meta.json', { cache: 'no-store' }).then(r => r.json()).catch(() => null)
        : null,
    ]);
    const newBuild = ver && runningBuild && ver.build !== runningBuild;
    const newData = m && state.meta &&
      (m.lastUpdate !== state.meta.lastUpdate || m.lastScreen !== state.meta.lastScreen);
    if (!newBuild && !newData) return;
    // Only auto-reload once per target version — a stubbornly cached index.html
    // would otherwise reload forever without ever picking up the new build.
    const target = `${ver?.build || ''}|${m?.lastUpdate || ''}`;
    if (sessionStorage.getItem('reloadedFor') === target) return;
    sessionStorage.setItem('reloadedFor', target);
    location.reload();
  } catch { /* offline — keep showing what we have */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdates();
});

boot().then(() => checkForUpdates());
