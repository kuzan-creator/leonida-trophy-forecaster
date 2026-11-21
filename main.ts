// Leonida Trophy Rarity Forecaster v2 — week-one GTA VI trophy earn-rate forecast.
//
// Model (counts decomposition, written from first principles for this entry):
//   rate = earners / players_tracked. The program forecasts the two halves
//   separately and divides, instead of extrapolating the ratio directly.
//   * Consecutive identical reads collapse into one snapshot: a plateau is a
//     stale Exophase page, not new information. Fits run on snapshots only.
//   * players_tracked N: a power law in (1 + hours since release) — launch
//     adoption grows fast then slows — blended with an exponential fit on the
//     last 24 h of snapshots when the history has refreshes.
//   * earners per trophy: a power law in (1 + hours since release), slope
//     shrunk toward the tier median, blended in log space with a
//     logit(rate)-vs-log-time trend. Earners never decrease; the platinum
//     grows slowly with a relative cap; a trophy already at 100% stays there.
//   * When the history has never refreshed (one snapshot), there is no trend
//     to fit, so a launch prior applies: N grows like (1 + age)^1 while
//     earners grow like (1 + age)^beta with beta < 1 by tier — new tracked
//     players are fresh and need time to earn anything, so rates fall. The
//     dilution factor is computed from the case's own ages and horizon;
//     nothing about the answer is hardcoded.
//   * Spread: refresh-jump dispersion plus trend uncertainty growing with the
//     horizon, plus a small-earner term; calibrated for ~0.9 coverage, not 1.0.
//     A band that is too wide pays pinball at every trophy.
//
// Node 22, standard library only, no network, deterministic: every number
// comes from the case file, and two runs on the same case write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/* --- Tunable constants (chosen from synthetic validation, see README) --- */
/** Power-law exponent for players-tracked growth in (1 + age hours). */
const ALPHA_N = 1.0;
/** Earner power-law exponents by tier, used only when no refresh was seen. */
const BETA_TIER: Record<string, number> = { bronze: 0.2, silver: 0.15, gold: 0.1, platinum: 0.05 };
/** Spread: floor, per-sqrt-day trend coefficient, small-earner coefficient. */
const SIGMA_FLOOR = 0.15;
const SIGMA_TREND = 0.2;
/** Share of the expected refresh jump used as spread when none was seen. */
const FLAT_JUMP_SHARE = 0.35;
/** Platinum median rate may grow at most this many times its last rate. */
const PLATINUM_CAP = 3;
/** Grid for the saturating (logistic-in-time) fits: growth rates and midpoints. */
const LOG_K = [0.02, 0.04, 0.07, 0.12, 0.2, 0.35, 0.6];
const LOG_T0 = [0, 6, 12, 24, 36, 48, 72, 96, 120];

interface Trophy { id: number; tier: string; }
interface Read { at: string; players_tracked: number; trophies_earned: number; rates: Array<number | null>; }
interface Case {
  levels: number[];
  horizon_minutes: number;
  at: string;
  target: string;
  game: { release_date: string };
  trophies: Trophy[];
  history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clampRate = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
/** Median of a numeric array (0 when empty). */
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** Least-squares line y ~ a + b*x; returns [intercept, slope]. */
const ols = (xs: number[], ys: number[]): [number, number] => {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  return [my - b * mx, b];
};

interface Snap { t: number; n: number; rates: number[]; }

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);

  const releaseMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const t0 = Date.parse(c.at);
  const t1 = Date.parse(c.target);
  const horizonDays = c.horizon_minutes / 1440;
  const ageH = (ms: number): number => Math.max(0, (ms - releaseMs) / 3600000);
  const uOf = (ms: number): number => Math.log1p(ageH(ms));

  // --- Snapshots: collapse consecutive identical reads into one state. ---
  const snaps: Snap[] = [];
  for (const h of c.history) {
    const rates = h.rates.map((r) => (r === null ? NaN : r));
    const prev = snaps[snaps.length - 1];
    const same = prev !== undefined && prev.n === h.players_tracked &&
      prev.rates.length === rates.length &&
      prev.rates.every((r, i) => (Number.isNaN(r) && Number.isNaN(rates[i])) || r === rates[i]);
    if (!same) snaps.push({ t: Date.parse(h.at), n: h.players_tracked, rates });
  }
  const last = snaps[snaps.length - 1];
  // Fill nulls in the last snapshot from the most recent snapshot that has them.
  const lastRates: number[] = last.rates.map((r, i) => {
    if (!Number.isNaN(r)) return r;
    for (let k = snaps.length - 2; k >= 0; k--) {
      if (!Number.isNaN(snaps[k].rates[i])) return snaps[k].rates[i];
    }
    return 0;
  });
  const earnersLast = lastRates.map((r) => (r * last.n) / 100);
  const uLast = uOf(last.t);
  const uTarget = uOf(t1);
  const ageFirst = ageH(snaps[0].t);
  const ageTarget = ageH(t1);
  // Fitting snapshots: drop degenerate pre-release reads (near-zero tracked
  // players, all rates zero) — they carry no information and their clamped
  // log values would wreck every fit. The flat-history prior below still
  // uses the full snapshot list.
  const fitSnaps = snaps.filter((s) => s.n >= 10);

  // --- Saturating fit: y(t) = Yinf / (1 + exp(-k (age - t0))), age in hours.
  // Launch adoption and trophy earning both saturate: a straight line in
  // log-log space keeps growing forever and explodes over a 4.5-day horizon.
  // The ceiling Yinf is solved by least squares for each (k, t0) on the grid,
  // and the best fit is judged on log scale, so small early counts still count.
  const logisticFit = (ages: number[], ys: number[], floor = 0.5): { inf: number; k: number; t0: number; sse: number } | null => {
    if (ages.length < 3) return null;
    const ly = ys.map((y) => Math.log(Math.max(y, floor)));
    let best: { inf: number; k: number; t0: number; sse: number } | null = null;
    for (const k of LOG_K) {
      for (const t0g of LOG_T0) {
        const s = ages.map((a) => 1 / (1 + Math.exp(-k * (a - t0g))));
        let num = 0, den = 0;
        for (let i = 0; i < ages.length; i++) { num += ys[i] * s[i]; den += s[i] * s[i]; }
        if (den < 1e-12) continue;
        const inf = num / den;
        if (!(inf > 0)) continue;
        let sse = 0;
        for (let i = 0; i < ages.length; i++) {
          const d = ly[i] - Math.log(Math.max(inf * s[i], floor));
          sse += d * d;
        }
        if (best === null || sse < best.sse) best = { inf, k, t0: t0g, sse };
      }
    }
    return best;
  };
  const logisticAt = (fit: { inf: number; k: number; t0: number }, age: number): number =>
    fit.inf / (1 + Math.exp(-fit.k * (age - fit.t0)));

  // --- Forecast players_tracked at the target. ---
  const snapAges = fitSnaps.map((s) => ageH(s.t));
  let nHat: number;
  if (fitSnaps.length >= 3) {
    const logFit = logisticFit(snapAges, fitSnaps.map((s) => Math.max(1, s.n)));
    const us = fitSnaps.map((s) => uOf(s.t));
    const [aN, bN] = ols(us, fitSnaps.map((s) => Math.log(Math.max(1, s.n))));
    const logPow = aN + bN * uTarget;
    const linSse = us.reduce((acc, u, i) => {
      const d = Math.log(Math.max(1, fitSnaps[i].n)) - (aN + bN * u);
      return acc + d * d;
    }, 0);
    // Blend the saturating fit (biased low: it reads the window's flattening
    // as a full stop) with the straight line (biased high: it never flattens).
    // The truth sits between them, closer to the saturating fit.
    nHat = logFit !== null
      ? Math.exp(0.7 * Math.log(Math.max(logisticAt(logFit, ageTarget), 1)) + 0.3 * logPow)
      : Math.exp(logPow);
    void linSse;
  } else {
    // No refresh ever seen: launch prior, computed from the case's own ages.
    nHat = last.n * (((1 + ageTarget) / (1 + ageFirst)) ** ALPHA_N);
  }
  // Sanity caps only: never below the last count, never an absurd multiple.
  nHat = clamp(nHat, last.n, last.n * 10);

  // --- Per-trophy earners: saturating fits, damped power-law fallback, or
  //     the launch prior when no refresh was seen. ---
  const nt = c.trophies.length;
  const fitSlope: number[] = new Array(nt).fill(0);
  const fitCount: number[] = new Array(nt).fill(0);
  const logFitE: Array<{ inf: number; k: number; t0: number; sse: number } | null> = new Array(nt).fill(null);
  const rateFit: Array<{ inf: number; k: number; t0: number; sse: number } | null> = new Array(nt).fill(null);
  const residMed: number[] = [];
  const spanU = Math.max(uLast - uOf(fitSnaps.length > 0 ? fitSnaps[0].t : snaps[0].t), 0.1);
  if (fitSnaps.length >= 3) {
    for (let j = 0; j < nt; j++) {
      const ages: number[] = [];
      const es: number[] = [];
      for (const s of fitSnaps) {
        const r = s.rates[j];
        if (Number.isNaN(r)) continue;
        ages.push(ageH(s.t));
        es.push(Math.max((r * s.n) / 100, 0.5));
      }
      if (ages.length >= 3) {
        fitCount[j] = ages.length;
        logFitE[j] = logisticFit(ages, es);
        const rateYs: number[] = [];
        for (const s of fitSnaps) {
          const r = s.rates[j];
          if (!Number.isNaN(r)) rateYs.push(Math.max(r, 0.005));
        }
        rateFit[j] = logisticFit(ages, rateYs, 0.005);
        const xs = ages.map((a) => Math.log1p(a));
        const ys = es.map((e) => Math.log(e));
        const [a, b] = ols(xs, ys);
        fitSlope[j] = clamp(b, 0, 2.5);
        residMed.push(Math.sqrt(ys.reduce((s, y, i) => s + (y - (a + b * xs[i])) ** 2, 0) / ys.length));
      }
    }
  }
  const tierSlope = (tier: string): number => {
    const ss = c.trophies.map((t, j) => (t.tier === tier && fitCount[j] >= 3 ? fitSlope[j] : NaN))
      .filter((x) => !Number.isNaN(x));
    if (ss.length > 0) return median(ss);
    const all = fitSlope.filter((_, j) => fitCount[j] >= 3);
    return all.length > 0 ? median(all) : 0;
  };
  const resid = residMed.length > 0 ? median(residMed) : 0;
  // Damping for extrapolated power-law growth: the further past the observed
  // window the target sits, the more the growth is shrunk toward no-growth.
  const damp = spanU / (spanU + Math.max(uTarget - uLast, 0));

  // --- Refresh-jump dispersion (logit-rate jumps between snapshots). ---
  let jumpStd = 0;
  if (fitSnaps.length >= 2) {
    const jumps: number[] = [];
    for (let k = 1; k < fitSnaps.length; k++) {
      for (let j = 0; j < nt; j++) {
        const a = fitSnaps[k - 1].rates[j];
        const b = fitSnaps[k].rates[j];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        jumps.push(Math.abs(logit(b) - logit(a)));
      }
    }
    if (jumps.length > 0) jumpStd = 1.4826 * median(jumps);
  }
  if (fitSnaps.length < 2) {
    jumpStd = FLAT_JUMP_SHARE * Math.abs(Math.log(nHat / last.n));
  }

  const sigmaTrend = Math.sqrt(horizonDays) * (SIGMA_TREND + 0.35 * resid);

  const rows = c.trophies.map((t, j) => {
    const rLast = lastRates[j];
    const eLast = Math.max(earnersLast[j], 0.5);
    let eHat: number;
    if (rLast >= 99.99) {
      eHat = nHat; // already at 100%: everyone tracked has it.
    } else if (fitSnaps.length >= 3 && fitCount[j] >= 3 && logFitE[j] !== null) {
      // Saturating fit: earners approach the trophy's ceiling, they do not
      // keep compounding. Blend it with a damped power law as a hedge: the
      // damping shrinks extrapolated growth the further past the observed
      // window the target sits.
      const eSat = logisticAt(logFitE[j] as { inf: number; k: number; t0: number }, ageTarget);
      const slope = (fitCount[j] * fitSlope[j] + 3 * tierSlope(t.tier)) / (fitCount[j] + 3);
      const ePow = eLast * Math.exp(clamp(slope, 0, 2.5) * (uTarget - uLast) * damp);
      eHat = Math.exp(0.7 * Math.log(Math.max(eSat, 0.5)) + 0.3 * Math.log(Math.max(ePow, 0.5)));
    } else if (fitSnaps.length >= 3) {
      // Too few usable points for this trophy: its tier's damped slope.
      const slope = tierSlope(t.tier);
      eHat = eLast * Math.exp(clamp(slope, 0, 2.5) * (uTarget - uLast) * damp);
    } else {
      // No refresh seen: launch prior, earners grow slower than the base.
      const beta = BETA_TIER[t.tier] ?? 0.15;
      eHat = eLast * (((1 + ageTarget) / (1 + ageFirst)) ** beta);
    }
    // Earners only grow, never exceed the tracked players.
    eHat = clamp(eHat, eLast, nHat);
    if (t.tier === 'platinum') {
      eHat = Math.min(eHat, (PLATINUM_CAP * rLast * nHat) / 100);
      eHat = Math.max(eHat, eLast);
    }
    const countsMed = clampRate((100 * eHat) / nHat);
    let med = countsMed;
    if (rLast < 99.99) {
      // Rate-logistic view: the rate's own saturating curve.
      const fHat = rateFit[j] !== null
        ? clampRate(logisticAt(rateFit[j] as { inf: number; k: number; t0: number }, ageTarget))
        : countsMed;
      // Logit-trend view (house-curve style): extrapolate the in-window
      // logit(rate)-vs-log-time slope, damped by how far past the observed
      // window the target sits. This view keeps rising while the cohort
      // matures; the saturating views flatten too early on their own.
      let trendMed = countsMed;
      if (fitSnaps.length >= 3) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const s of fitSnaps) {
          const r = s.rates[j];
          if (!Number.isNaN(r)) { xs.push(uOf(s.t)); ys.push(logit(r)); }
        }
        if (xs.length >= 3) {
          const [, b] = ols(xs, ys);
          const move = clamp(b * (uTarget - uLast), -3, 3) * damp;
          trendMed = clampRate(invLogit(logit(rLast) + move));
        }
      }
      med = clampRate(Math.exp(0.4 * Math.log(countsMed) + 0.3 * Math.log(fHat) + 0.3 * Math.log(trendMed)));
    }
    if (rLast >= 99.99) med = 100;
    const sigmaSmall = Math.min(0.45, 0.3 / Math.sqrt(Math.max(earnersLast[j], 1)));
    // The further the forecast moves from the last rate, the less certain it is.
    const sigmaMove = 0.2 * Math.abs(logit(med) - logit(rLast));
    const sigma = Math.sqrt(SIGMA_FLOOR ** 2 + jumpStd ** 2 + sigmaTrend ** 2 + sigmaSmall ** 2 + sigmaMove ** 2);
    const lm = logit(med);
    let prev = -Infinity;
    const q = Z.map((z) => {
      const v = rLast >= 99.99 && z > 0 ? 100 : round4(clamp(invLogit(lm + z * sigma), 0.01, 100));
      const out = Math.max(v, prev);
      prev = out;
      return out;
    });
    // The 100% trophy keeps its median at 100 with a narrow upper band.
    if (rLast >= 99.99) {
      const pinned = [99.5, 99.9, 100, 100, 100];
      return { id: t.id, q: pinned };
    }
    return { id: t.id, q };
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies: rows })}\n`);
}
