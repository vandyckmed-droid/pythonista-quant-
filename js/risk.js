// Risk math for the watchlist: correlation, ENB, HRP.
// All inputs are plain arrays; sizes here are small (a watchlist), so O(n^3) is fine.

// Align histories on dates present in every series, return log-return matrix
// rets[i][t] for symbol i.
export function alignedReturns(histories) {
  const sets = histories.map(h => new Set(h.dates));
  const common = histories[0].dates.filter(d => sets.every(s => s.has(d)));
  const idx = histories.map(h => {
    const m = new Map();
    h.dates.forEach((d, i) => m.set(d, i));
    return m;
  });
  const rets = histories.map((h, i) => {
    const closes = common.map(d => h.close[idx[i].get(d)]);
    const r = new Array(closes.length - 1);
    for (let t = 1; t < closes.length; t++) r[t - 1] = Math.log(closes[t] / closes[t - 1]);
    return r;
  });
  return { rets, dates: common.slice(1) };
}

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

export function covMatrix(rets) {
  const n = rets.length, T = rets[0].length;
  const mu = rets.map(mean);
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (rets[i][t] - mu[i]) * (rets[j][t] - mu[j]);
      C[i][j] = C[j][i] = s / (T - 1);
    }
  }
  return C;
}

export function corrFromCov(C) {
  const n = C.length;
  const sd = C.map((row, i) => Math.sqrt(row[i]));
  return C.map((row, i) => row.map((v, j) => v / (sd[i] * sd[j])));
}

// Eigenvalues of a symmetric matrix via cyclic Jacobi rotations.
export function symEigenvalues(M) {
  const n = M.length;
  const A = M.map(r => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] * A[i][j];
    if (off < 1e-14) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((r, i) => Math.max(r[i], 0));
}

// Effective number of bets: exponential of the entropy of the normalized
// eigenvalue spectrum of the correlation matrix. n identical assets -> 1,
// n uncorrelated assets -> n.
export function enb(corr) {
  const ev = symEigenvalues(corr);
  const tot = ev.reduce((s, x) => s + x, 0);
  let H = 0;
  for (const l of ev) {
    const p = l / tot;
    if (p > 1e-12) H -= p * Math.log(p);
  }
  return Math.exp(H);
}

// Hierarchical Risk Parity (Lopez de Prado): correlation-distance single-linkage
// clustering -> quasi-diagonal ordering -> recursive bisection with
// inverse-variance allocation. Returns {weights, order}; `order` is the
// dendrogram leaf order, which also cluster-sorts a correlation heatmap.
export function hrpWeights(cov, corr) {
  const n = cov.length;
  if (n === 1) return { weights: [1], order: [0] };

  const dist = corr.map(row => row.map(c => Math.sqrt(Math.max(0, 0.5 * (1 - c)))));

  // single-linkage agglomerative clustering
  let clusters = Array.from({ length: n }, (_, i) => ({ items: [i] }));
  const linkDist = (a, b) => {
    let m = Infinity;
    for (const i of a.items) for (const j of b.items) m = Math.min(m, dist[i][j]);
    return m;
  };
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = linkDist(clusters[i], clusters[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    const merged = { left: clusters[bi], right: clusters[bj],
                     items: clusters[bi].items.concat(clusters[bj].items) };
    clusters = clusters.filter((_, k) => k !== bi && k !== bj);
    clusters.push(merged);
  }

  // quasi-diagonal order = leaf order of the dendrogram
  const order = [];
  (function walk(c) {
    if (!c.left) { order.push(c.items[0]); return; }
    walk(c.left); walk(c.right);
  })(clusters[0]);

  // recursive bisection
  const w = new Array(n).fill(1);
  const clusterVar = (items) => {
    const iv = items.map(i => 1 / cov[i][i]);
    const s = iv.reduce((a, b) => a + b, 0);
    const cw = iv.map(x => x / s);
    let v = 0;
    for (let a = 0; a < items.length; a++)
      for (let b = 0; b < items.length; b++)
        v += cw[a] * cw[b] * cov[items[a]][items[b]];
    return v;
  };
  const stack = [order];
  while (stack.length) {
    const items = stack.pop();
    if (items.length < 2) continue;
    const mid = Math.floor(items.length / 2);
    const left = items.slice(0, mid), right = items.slice(mid);
    const vl = clusterVar(left), vr = clusterVar(right);
    const alpha = 1 - vl / (vl + vr);
    for (const i of left) w[i] *= alpha;
    for (const i of right) w[i] *= 1 - alpha;
    stack.push(left, right);
  }
  const s = w.reduce((a, b) => a + b, 0);
  return { weights: w.map(x => x / s), order };
}

export function portfolioVol(cov, w, annualize = 252) {
  let v = 0;
  const n = w.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) v += w[i] * w[j] * cov[i][j];
  return Math.sqrt(v * annualize);
}

export function avgCorrelation(corr) {
  const n = corr.length;
  if (n < 2) return 0;
  let s = 0, c = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { s += corr[i][j]; c++; }
  return s / c;
}

// --- precomputed-matrix helpers (data/risk.json) -------------------------
// These let the app answer "does this name add anything?" for all 150
// candidates instantly, without loading a single history file.

export function subCorr(R, syms) {
  const ix = syms.map(s => R.index.get(s));
  return ix.map(i => ix.map(j => R.corr[i][j]));
}

// Effective bets for a set of symbols, straight from the stored matrix.
export function enbOf(R, syms) {
  const known = syms.filter(s => R.index.has(s));
  if (known.length < 2) return known.length;
  return enb(subCorr(R, known));
}

// How much each candidate would add to the effective bets of `held`.
// Returns {gain: Map symbol -> value, unit: 'bets' | 'independence'}.
// With fewer than two names held there is no meaningful "extra bet" to measure,
// so candidates are ranked by how little they resemble the universe at large.
export function diversificationGain(R, held) {
  const gain = new Map();
  if (held.length < 2) {
    const n = R.symbols.length;
    for (let i = 0; i < n; i++) {
      const s = R.symbols[i];
      if (held.includes(s)) continue;
      let sum = 0;
      for (let j = 0; j < n; j++) if (j !== i) sum += R.corr[i][j];
      gain.set(s, 1 - sum / (n - 1));
    }
    return { gain, unit: 'independence' };
  }
  const base = enbOf(R, held);
  for (const s of R.symbols) {
    if (held.includes(s)) continue;
    gain.set(s, enbOf(R, [...held, s]) - base);
  }
  return { gain, unit: 'bets' };
}

// Closest already-held name, for the redundancy flag.
export function nearestHeld(R, sym, held) {
  if (!R.index.has(sym)) return null;
  let best = null;
  for (const h of held) {
    if (h === sym || !R.index.has(h)) continue;
    const v = R.corr[R.index.get(sym)][R.index.get(h)];
    if (!best || v > best.corr) best = { symbol: h, corr: v };
  }
  return best;
}

export function maxDrawdown(closes) {
  let peak = closes[0], mdd = 0;
  for (const p of closes) {
    if (p > peak) peak = p;
    mdd = Math.min(mdd, p / peak - 1);
  }
  return mdd;
}

export function annualizedVol(closes) {
  const r = [];
  for (let t = 1; t < closes.length; t++) r.push(Math.log(closes[t] / closes[t - 1]));
  const mu = mean(r);
  const v = r.reduce((s, x) => s + (x - mu) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}
