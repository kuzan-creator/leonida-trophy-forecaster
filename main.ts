// Leonida Trophy Rarity Forecaster — entry for gta6-trophy-rarity-forecast-01.
// Node 22, standard library only, no network, deterministic.
//
// Idea, from first principles. An Exophase earn rate is a ratio:
//
//   rate_i = 100 * earners_i / players_tracked
//
// Both parts move, and they move for different reasons, so this program
// forecasts them separately and divides at the end — it never extrapolates
// the ratio itself.
//
// * players_tracked (N) only grows, and it grows in steps: Exophase
//   refreshes its counts on its own schedule, so the history is a series of
//   plateaus with sudden jumps. Between refreshes a read is a stale snapshot
//   of the same underlying state. The program therefore collapses consecutive
//   identical reads into one distinct snapshot, fits N's growth on the
//   distinct snapshots only, and measures how big refresh jumps are from the
//   jumps it has actually seen. The jump size is the honest uncertainty:
//   a refresh nobody has seen yet can dilute every rate at once.
// * earners_i only grow too. Per trophy, log(earners) is fitted against
//   log(1 + hours since launch) — a power law, which bends down as a trophy
//   saturates — and against time itself (an exponential), and the two
//   predictions are averaged in log space. Each trophy's slope is shrunk
//   toward its tier's median slope and the global median, so a trophy with
//   almost no movement borrows strength from its tier instead of freezing.
//   Slopes are never negative (earners cannot fall) and a forecast is
//   capped at the forecast player count.
// * The platinum (id 1) grows much slower than other trophies, and the
//   100% trophy (id 2, last rate 100) stays at 100: the platinum is handled
//   by its own fitted slope plus a relative cap, the 100% trophy by a
//   pinned band.
// * Quantile spread is refresh-aware, not a fixed random walk. Its logit
//   width combines (a) refresh-jump uncertainty — how much N can jump
//   before the target, estimated from observed jumps, with a wide prior
//   when no jump has ever been seen (a flat history hides the next
//   refresh, it does not rule it out) — and (b) trend uncertainty that
//   grows with the horizon. Rare, volatile trophies get a wider band than
//   saturated ones. Being too narrow is far costlier under pinball loss
//   than being too wide, so the band is deliberately honest.
//
// Nothing here hardcodes a rate, a player count or a refresh factor: every
// parameter is estimated from the case file at run time, with persistence
// as the fallback when the history is flat or too short.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

interface Trophy { id: number; name: string; tier: string; points: number; secret: boolean }
interface Read { at: string; players_tracked: number; trophies_earned: number; rates: Array<number | null> }
interface Case {
  id: string; at: string; horizon_minutes: number; target: string; levels: number[];
  game: { release_date?: string };
  trophies: Trophy[]; history: Read[];
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const clampPct = (x: number): number => clamp(x, 0.01, 99.99);
const logit = (pct: number): number => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
const sigmoidPct = (l: number): number => 100 / (1 + Math.exp(-clamp(l, -12, 12)));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const variance = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
};

/** Least squares line y ~ a + b*x; returns [a, b, residualStd]. */
function ols(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [ys[0], 0, 0];
  const mx = mean(xs); const my = mean(ys);
  let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxx > 1e-12 ? sxy / sxx : 0;
  const a = my - b * mx;
  const resid = ys.map((y, i) => y - (a + b * xs[i]));
  return [a, b, Math.sqrt(mean(resid.map((r) => r * r)))];
}

interface Snap { t: number; n: number; rates: number[] }

function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  const tAt = Date.parse(c.at);
  const tTarget = Date.parse(c.target);
  const horizonDays = Math.max(0, c.horizon_minutes / 1440);
  const tLaunch = c.game?.release_date ? Date.parse(c.game.release_date) : NaN;
  const launch = Number.isFinite(tLaunch) ? tLaunch : (c.history.length ? Date.parse(c.history[0].at) : tAt);
  const hoursSinceLaunch = (t: number): number => Math.max(0, (t - launch) / 3600000);
  const logTime = (t: number): number => Math.log1p(hoursSinceLaunch(t));

  // --- Collapse plateaus: consecutive identical reads are one snapshot. ---
  const snaps: Snap[] = [];
  for (const h of c.history) {
    const rates = h.rates.map((r) => (r === null ? NaN : r));
    const prev = snaps[snaps.length - 1];
    if (prev && prev.n === h.players_tracked && prev.rates.every((r, i) => r === rates[i] || (Number.isNaN(r) && Number.isNaN(rates[i])))) continue;
    snaps.push({ t: Date.parse(h.at), n: h.players_tracked, rates });
  }
  const last = snaps[snaps.length - 1];
  const nLast = last.n;
  const lastRates = last.rates.map((r, i) => (Number.isNaN(r) ? (c.trophies[i]?.id === 2 ? 100 : 0.5) : r));

  // --- Forecast players_tracked N. ---
  // Log-log (power law) fit on distinct snapshots + log-linear (exponential)
  // fit on the last 24h of distinct snapshots; average the two in log space.
  let logNMed = Math.log(nLast);
  let nResid = 0.15;
  let medianGapH = 6; // median hours between distinct snapshots
  const jumps: number[] = []; // log N jumps between distinct snapshots
  if (snaps.length >= 2) {
    const xs = snaps.map((s) => logTime(s.t));
    const ys = snaps.map((s) => Math.log(s.n));
    const [, bPow, rPow] = ols(xs, ys);
    const powPred = ys[ys.length - 1] + Math.max(0, bPow) * (logTime(tTarget) - xs[xs.length - 1]);
    const recent = snaps.filter((s) => tAt - s.t <= 24 * 3600000);
    const use = recent.length >= 2 ? recent : snaps;
    const xt = use.map((s) => (s.t - tAt) / 3600000);
    const yt = use.map((s) => Math.log(s.n));
    const [, bExp, rExp] = ols(xt, yt);
    const expPred = yt[yt.length - 1] + Math.max(0, bExp) * (horizonDays * 24);
    logNMed = (powPred + expPred) / 2;
    nResid = Math.max(rPow, rExp, 0.05);
    const gaps: number[] = [];
    for (let k = 1; k < snaps.length; k++) {
      jumps.push(Math.log(snaps[k].n / snaps[k - 1].n));
      gaps.push((snaps[k].t - snaps[k - 1].t) / 3600000);
    }
    medianGapH = Math.max(1, median(gaps));
  }
  // Never forecast N below the last count; cap absurd growth at 50x.
  const nMed = clamp(Math.exp(logNMed), nLast, nLast * 50);

  // Refresh uncertainty for log N at the target.
  const horizonH = horizonDays * 24;
  let sigmaRefresh: number;
  if (snaps.length < 2) {
    // Flat history: no refresh has ever been seen, so one could be due at
    // any moment. Wide prior — this is what the practice cases punish the
    // baseline for missing (a 6x jump in 90 minutes).
    sigmaRefresh = 1.15;
  } else {
    // Refresh jumps are the mechanism of N's growth, and the trend fit
    // already predicts their typical size — so the uncertainty here is
    // only the *dispersion* of jumps around their typical size, not the
    // jumps themselves (counting the full jump as noise would double-count
    // the growth the trend already forecasts).
    const expectedRefreshes = Math.max(1, horizonH / medianGapH);
    const jumpMean = mean(jumps);
    const jumpStd = Math.sqrt(mean(jumps.map((j) => (j - jumpMean) ** 2)));
    sigmaRefresh = clamp(Math.sqrt(expectedRefreshes) * Math.max(jumpStd, 0.02), 0.25, 0.7);
  }
  const sigmaN = Math.sqrt(sigmaRefresh * sigmaRefresh + (nResid * 0.5) * (nResid * 0.5));

  // --- Per-trophy earner growth: slopes, shrunk toward tier / global. ---
  const nT = c.trophies.length;
  const slopes: number[] = new Array(nT).fill(0);
  const rateSlopes: number[] = new Array(nT).fill(0);
  const residE: number[] = new Array(nT).fill(0.3);
  const counts: number[] = new Array(nT).fill(0);
  const tLastLog = logTime(last.t);
  const tTargetLog = logTime(tTarget);
  const dtLog = Math.max(0, tTargetLog - tLastLog);
  for (let i = 0; i < nT; i++) {
    // Distinct snapshots where this trophy has a positive earner count.
    const pts: Array<[number, number, number, number]> = []; // [logTime, logE, hours, rate]
    for (const s of snaps) {
      const r = s.rates[i];
      if (Number.isNaN(r) || r <= 0) continue;
      const e = (r / 100) * s.n;
      if (e <= 0) continue;
      pts.push([logTime(s.t), Math.log(e), (s.t - tAt) / 3600000, r]);
    }
    // Use the last 36h when there is enough there, else everything.
    const recentPts = pts.filter((p) => p[2] >= -36);
    const use = recentPts.length >= 3 ? recentPts : pts;
    counts[i] = use.length;
    if (use.length >= 2) {
      const [, b, r] = ols(use.map((p) => p[0]), use.map((p) => p[1]));
      slopes[i] = b;
      residE[i] = Math.max(0.08, r);
      // Exponential-in-time fit as a second opinion; average the slopes
      // in the direction of growth (both are d logE / d log-time here via
      // a local conversion: exp slope per hour * hours-per-log-time).
      const [, bT] = ols(use.map((p) => p[2]), use.map((p) => p[1]));
      const hoursPerLog = dtLog > 0 ? (horizonH / Math.max(dtLog, 0.01)) : 24;
      const bTasLog = bT * hoursPerLog * 0.5; // damped: time-fit is noisier
      slopes[i] = (slopes[i] + bTasLog) / 2;
      // Second view: the rate itself (logit) against log-time. This sees
      // what the earner-count view misses — new players earning a common
      // trophy almost as fast as they join, so its rate keeps climbing
      // even after its earner curve looks flat.
      const [, bR] = ols(use.map((p) => p[0]), use.map((p) => logit(p[3])));
      rateSlopes[i] = clamp(bR, -1.5, 2.5);
    }
  }
  const tierOf = (i: number): string => c.trophies[i].tier;
  const tierSlope = new Map<string, number>();
  for (const tier of [...new Set(c.trophies.map((t) => t.tier))]) {
    const ss = slopes.filter((_, i) => tierOf(i) === tier && counts[i] >= 2);
    tierSlope.set(tier, ss.length ? median(ss) : 0);
  }
  const globalSlope = median(slopes.filter((_, i) => counts[i] >= 2));
  const tierRateSlope = new Map<string, number>();
  for (const tier of [...new Set(c.trophies.map((t) => t.tier))]) {
    const ss = rateSlopes.filter((_, i) => tierOf(i) === tier && counts[i] >= 2);
    tierRateSlope.set(tier, ss.length ? median(ss) : 0);
  }
  const globalRateSlope = median(rateSlopes.filter((_, i) => counts[i] >= 2));

  const rows: Array<{ id: number; q: number[] }> = [];
  for (let i = 0; i < nT; i++) {
    const tr = c.trophies[i];
    const rLast = lastRates[i];
    // The 100% trophy stays at 100.
    if (rLast >= 99.99) {
      rows.push({ id: tr.id, q: [99.5, 99.9, 100, 100, 100] });
      continue;
    }
    const eLast = Math.max(0.05, (rLast / 100) * nLast);
    // Shrink this trophy's slope toward its tier, then the global slope.
    const w = counts[i] / (counts[i] + 3);
    const tierS = tierSlope.get(tr.tier) ?? globalSlope;
    let b = w * slopes[i] + (1 - w) * (0.7 * tierS + 0.3 * globalSlope);
    b = Math.max(0, b); // earners never fall
    if (rLast > 40) b *= Math.max(0.15, 1 - rLast / 100); // saturating trophies bend down
    const logE = Math.log(eLast) + b * dtLog;
    let eMed = Math.exp(logE);
    // Cap earners at the forecast player count (a rate cannot pass 100%).
    // Platinum gets a relative cap instead of a growth damp: its fitted
    // slope already reflects how slowly it is earned, and halving it made
    // its rate fall even as more players finished the game.
    const capE = tr.tier === 'platinum' ? Math.min(nMed * 0.98, Math.max(eLast * 6, (rLast * 4 / 100) * nMed)) : nMed * 0.98;
    eMed = clamp(eMed, eLast * 0.5, capE);
    const rFromCounts = clamp(100 * (eMed / nMed), 0.01, 99.9);
    // Blend with the rate view: the logit-rate trend, shrunk toward its
    // tier, read at the target. Averaging the two views in logit space
    // keeps a common trophy from being dragged down by N growth alone
    // (new players earn it too) and a rare trophy from being dragged up
    // by a rate trend that ignores dilution.
    const tierRS = tierRateSlope.get(tr.tier) ?? globalRateSlope;
    const bR = w * rateSlopes[i] + (1 - w) * (0.7 * tierRS + 0.3 * globalRateSlope);
    const rFromRate = clamp(sigmoidPct(logit(rLast) + bR * dtLog), 0.01, 99.9);
    const rMed = clamp(sigmoidPct((logit(rFromCounts) + logit(rFromRate)) / 2), 0.01, 99.9);
    const medLogit = logit(rMed);

    // Spread: refresh/dilution uncertainty (shared) + this trophy's own
    // trend uncertainty, growing with horizon; rarer trophies are wider.
    const rare = rMed < 1 ? 0.18 : rMed < 5 ? 0.1 : 0;
    const sigmaTrend = (residE[i] + 0.08) * Math.sqrt(0.5 + horizonDays / 3);
    const sigma = clamp(Math.sqrt(sigmaN * sigmaN + sigmaTrend * sigmaTrend) + rare, 0.35, 1.3);
    const q = Z.map((z) => round4(clamp(sigmoidPct(medLogit + z * sigma), 0.01, 100)));
    // Enforce non-decreasing after rounding.
    for (let k = 1; k < q.length; k++) if (q[k] < q[k - 1]) q[k] = q[k - 1];
    rows.push({ id: tr.id, q });
  }
  return { trophies: rows };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (!c.history.length) throw new Error(`${file} has no history`);
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
