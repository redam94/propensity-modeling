// Small statistics toolkit for the in-browser demonstrations.
// It mirrors what propensity_lift does (logistic propensity model, ATT/ATE/overlap weights,
// caliper matching, stratification, SMD, Kish ESS, OVL) at toy scale. It is for teaching, not analysis.

export function makeRng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const n = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let x, y, r;
    do {
      x = 2 * u() - 1;
      y = 2 * u() - 1;
      r = x * x + y * y;
    } while (r >= 1 || r === 0);
    const f = Math.sqrt((-2 * Math.log(r)) / r);
    spare = y * f;
    return x * f;
  };
  return { u, n, bern: (p) => (u() < p ? 1 : 0) };
}

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const logit = (p) => Math.log(p / (1 - p));
const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

function solve(A, b) {
  // Gaussian elimination with partial pivoting; A is d x d (array of arrays), b length d.
  const d = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const div = M[c][c] || 1e-12;
    for (let k = c; k <= d; k++) M[c][k] /= div;
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f === 0) continue;
      for (let k = c; k <= d; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[d]);
}

/** Logistic regression by IRLS. cols: array of feature arrays (no intercept). Returns fitted probabilities. */
export function fitLogistic(cols, y, { ridge = 1e-3, iters = 10 } = {}) {
  const n = y.length;
  const d = cols.length + 1;
  let beta = new Array(d).fill(0);
  const p = new Float64Array(n);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  beta[0] = logit(clampP(mean));
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0));
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      let eta = beta[0];
      for (let j = 1; j < d; j++) eta += beta[j] * cols[j - 1][i];
      const pi = sigmoid(eta);
      p[i] = pi;
      const w = pi * (1 - pi) + 1e-9;
      const r = y[i] - pi;
      g[0] += r;
      H[0][0] += w;
      for (let j = 1; j < d; j++) {
        const xj = cols[j - 1][i];
        g[j] += r * xj;
        H[0][j] += w * xj;
        for (let k = j; k < d; k++) H[j][k] += w * xj * cols[k - 1][i];
      }
    }
    for (let j = 0; j < d; j++) {
      for (let k = 0; k < j; k++) H[j][k] = H[k][j];
      if (j > 0) {
        H[j][j] += ridge;
        g[j] -= ridge * beta[j];
      }
    }
    const step = solve(H, g);
    let delta = 0;
    for (let j = 0; j < d; j++) {
      beta[j] += step[j];
      delta = Math.max(delta, Math.abs(step[j]));
    }
    if (delta < 1e-6) break;
  }
  for (let i = 0; i < n; i++) {
    let eta = beta[0];
    for (let j = 1; j < d; j++) eta += beta[j] * cols[j - 1][i];
    p[i] = clampP(sigmoid(eta));
  }
  return { beta, p };
}

/** Balancing weights. kind: "none" | "att" | "ate" | "overlap". */
export function balancingWeights(e, t, kind) {
  const w = new Float64Array(e.length);
  for (let i = 0; i < e.length; i++) {
    const ei = e[i];
    if (kind === "att") w[i] = t[i] ? 1 : ei / (1 - ei);
    else if (kind === "ate") w[i] = t[i] ? 1 / ei : 1 / (1 - ei);
    else if (kind === "overlap") w[i] = t[i] ? 1 - ei : ei;
    else w[i] = 1;
  }
  return w;
}

/** 1:1 nearest-neighbour matching on logit(PS) with replacement and a caliper in SDs of the logit. */
export function matchWeights(e, t, caliperSd = 0.2) {
  const n = e.length;
  const l = Float64Array.from(e, (v) => logit(clampP(v)));
  let m = 0, s = 0;
  for (let i = 0; i < n; i++) m += l[i];
  m /= n;
  for (let i = 0; i < n; i++) s += (l[i] - m) ** 2;
  const cal = caliperSd * Math.sqrt(s / Math.max(1, n - 1));
  const ctrl = [];
  for (let i = 0; i < n; i++) if (!t[i]) ctrl.push(i);
  ctrl.sort((a, b) => l[a] - l[b]);
  const w = new Float64Array(n);
  let unmatched = 0;
  for (let i = 0; i < n; i++) {
    if (!t[i]) continue;
    let lo = 0, hi = ctrl.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[ctrl[mid]] < l[i]) lo = mid + 1;
      else hi = mid;
    }
    let best = -1, bd = Infinity;
    for (const k of [lo - 1, lo]) {
      if (k < 0 || k >= ctrl.length) continue;
      const dist = Math.abs(l[ctrl[k]] - l[i]);
      if (dist < bd) {
        bd = dist;
        best = ctrl[k];
      }
    }
    if (best >= 0 && bd <= cal) {
      w[i] = 1;
      w[best] += 1;
    } else unmatched++;
  }
  return { w, unmatched };
}

/** ATT stratification weights on quantiles of the exposed group's propensity scores. */
export function strataWeights(e, t, k = 5) {
  const n = e.length;
  const ex = [];
  for (let i = 0; i < n; i++) if (t[i]) ex.push(e[i]);
  ex.sort((a, b) => a - b);
  const cuts = [];
  for (let q = 1; q < k; q++) cuts.push(ex[Math.floor((q * ex.length) / k)]);
  const bin = (v) => {
    let b = 0;
    while (b < cuts.length && v > cuts[b]) b++;
    return b;
  };
  const ne = new Array(k).fill(0), nc = new Array(k).fill(0);
  for (let i = 0; i < n; i++) (t[i] ? ne : nc)[bin(e[i])]++;
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bin(e[i]);
    w[i] = t[i] ? 1 : nc[b] ? ne[b] / nc[b] : 0;
  }
  return w;
}

export function wmean(x, w, t, group) {
  let s = 0, sw = 0;
  for (let i = 0; i < x.length; i++) {
    if (t[i] !== group) continue;
    s += w[i] * x[i];
    sw += w[i];
  }
  return sw ? s / sw : NaN;
}

/** Weighted (Hajek) difference in means, exposed minus control. */
export function diffMeans(y, t, w) {
  return wmean(y, w, t, 1) - wmean(y, w, t, 0);
}

/** Standardised mean difference; denominator is the unweighted pooled SD so before/after are comparable. */
export function smd(x, t, w) {
  const ones = new Float64Array(x.length).fill(1);
  const variance = (g) => {
    const mu = wmean(x, ones, t, g);
    let s = 0, c = 0;
    for (let i = 0; i < x.length; i++) if (t[i] === g) { s += (x[i] - mu) ** 2; c++; }
    return c > 1 ? s / (c - 1) : 0;
  };
  const sd = Math.sqrt((variance(1) + variance(0)) / 2) || 1;
  return (wmean(x, w || ones, t, 1) - wmean(x, w || ones, t, 0)) / sd;
}

/** Kish effective sample size of one group. */
export function ess(w, t, group) {
  let s = 0, s2 = 0;
  for (let i = 0; i < w.length; i++) {
    if (t[i] !== group) continue;
    s += w[i];
    s2 += w[i] * w[i];
  }
  return s2 ? (s * s) / s2 : 0;
}

export function auc(score, t) {
  const idx = Array.from(score.keys()).sort((a, b) => score[a] - score[b]);
  let rankSum = 0, n1 = 0;
  for (let r = 0; r < idx.length; ) {
    let r2 = r;
    while (r2 + 1 < idx.length && score[idx[r2 + 1]] === score[idx[r]]) r2++;
    const avg = (r + r2) / 2 + 1;
    for (let k = r; k <= r2; k++) if (t[idx[k]]) { rankSum += avg; n1++; }
    r = r2 + 1;
  }
  const n0 = idx.length - n1;
  return n1 && n0 ? (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0) : NaN;
}

/** Shared-bin histogram of the propensity score, as the share of each (weighted) group per bin. */
export function psHistogram(e, t, w, bins = 30) {
  const exposed = new Array(bins).fill(0), control = new Array(bins).fill(0);
  let se = 0, sc = 0;
  for (let i = 0; i < e.length; i++) {
    const b = Math.min(bins - 1, Math.floor(e[i] * bins));
    const wi = w ? w[i] : 1;
    if (t[i]) { exposed[b] += wi; se += wi; } else { control[b] += wi; sc += wi; }
  }
  const edges = Array.from({ length: bins + 1 }, (_, i) => i / bins);
  return { edges, exposed: exposed.map((v) => (se ? v / se : 0)), control: control.map((v) => (sc ? v / sc : 0)) };
}

/** Overlap coefficient: the shared area of the two histograms (1 = identical, 0 = disjoint). */
export function ovl(hist) {
  let s = 0;
  for (let i = 0; i < hist.exposed.length; i++) s += Math.min(hist.exposed[i], hist.control[i]);
  return s;
}

export function commonSupport(e, t) {
  let minE = 1, maxE = 0, minC = 1, maxC = 0;
  for (let i = 0; i < e.length; i++) {
    if (t[i]) { minE = Math.min(minE, e[i]); maxE = Math.max(maxE, e[i]); }
    else { minC = Math.min(minC, e[i]); maxC = Math.max(maxC, e[i]); }
  }
  return [Math.max(minE, minC), Math.min(maxE, maxC)];
}

export const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export const sd = (a) => {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
};
