import { buildDataset, FEATURES, type Row } from "../features.ts";
import { calibrate, predict, train, type GbdtModel } from "./gbdt.ts";
import type { DB } from "../db.ts";

/**
 * How high a launch climbs, predicted from what is knowable when it lands.
 *
 * A separate question from graduation and a separate model. Graduation is rare — about 2.3% — and
 * asks whether a launch clears one fixed bar. This asks how far it gets, which almost every launch
 * answers to some degree: measured over settled curves the peak runs from x1.03 at the tenth
 * percentile to x5.83 at the ninetieth, and 22% reach x3.
 *
 * The target is the peak as a **multiple of the launch price**, in logs. Not a market cap in
 * dollars: that needs the quote asset's price, half of launches are quoted against a tokenised
 * stock, and the ratio is what the model can actually learn — the dollar figure is the ratio times a
 * number the chain does not know. The card multiplies it back out for display.
 *
 * Only settled curves are trained on. A launch from ten minutes ago has not finished climbing, and
 * its peak-so-far is not its peak; feeding that in teaches the model that recent launches peak low.
 */

/** A launch this new has not finished climbing, so its peak is not yet its peak. */
export const SETTLE_SEC = 4 * 3600;
/** Below this many trades a "peak" is one buyer's slippage rather than a price the market reached. */
export const MIN_TRADES = 4;

export type AthRow = Row & { logPeak: number };

/**
 * Joins the feature matrix to the observed peak of each launch whose curve has been read.
 *
 * Coverage is the limit here, not the join: curves are read on demand and in bulk, so this returns
 * only the launches somebody has read. The caller reports how many that was, because a model fitted
 * on two hundred curves and one fitted on twenty thousand deserve to be trusted differently.
 */
export function buildAthDataset(db: DB, nowTs = Math.floor(Date.now() / 1000)): AthRow[] {
  const peaks = new Map<string, number>();
  const rows = db.prepare(`
    SELECT token, quote_wei, token_amt FROM curve_trades
    WHERE side = 'buy' ORDER BY token, block, log_index`).all() as
    Array<{ token: string; quote_wei: string; token_amt: string }>;

  let current = "";
  let first = 0;
  let peak = 0;
  let count = 0;
  const flush = (): void => {
    if (current && count >= MIN_TRADES && first > 0 && peak > 0) peaks.set(current, Math.log(peak / first));
  };
  for (const r of rows) {
    if (r.token !== current) { flush(); current = r.token; first = 0; peak = 0; count = 0; }
    const tokens = Number(r.token_amt);
    if (!(tokens > 0)) continue;
    const p = Number(r.quote_wei) / tokens;
    if (!(p > 0) || !Number.isFinite(p)) continue;
    if (first === 0) first = p;
    if (p > peak) peak = p;
    count++;
  }
  flush();

  const out: AthRow[] = [];
  for (const row of buildDataset(db)) {
    if (row.ts + SETTLE_SEC > nowTs) continue;
    const logPeak = peaks.get(row.token);
    if (logPeak === undefined) continue;
    out.push({ ...row, logPeak });
  }
  return out.sort((a, b) => a.ts - b.ts || a.block - b.block);
}

export type AthEvaluation = {
  n: number;
  medianPeak: number;
  /** Spearman rank correlation between predicted and observed peak. Rank, because the tail is long. */
  spearman: number;
  /** Median observed peak among the tenth the model rated highest, against the median overall. */
  topDecileMedian: number;
  topDecileLift: number;
  /** What a constant prediction would cost, so the model has something to beat. */
  maeModel: number;
  maeBaseline: number;
};

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, dbv = 0;
  for (let i = 0; i < n; i++) {
    const x = ra[i] - ma, y = rb[i] - mb;
    num += x * y; da += x * x; dbv += y * y;
  }
  return da && dbv ? num / Math.sqrt(da * dbv) : 0;
}

export function evaluateAth(model: GbdtModel, rows: AthRow[]): AthEvaluation {
  const pred = rows.map((r) => predict(model, r.x));
  const obs = rows.map((r) => r.logPeak);
  const n = rows.length;

  const sorted = [...obs].sort((a, b) => a - b);
  const medianLog = sorted[Math.floor(n / 2)];

  const order = pred.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
  const dec = order.slice(0, Math.max(1, Math.floor(n * 0.1))).map(([, i]) => obs[i]).sort((a, b) => a - b);
  const decMedian = dec[Math.floor(dec.length / 2)];

  const mae = (f: (i: number) => number): number => obs.reduce((s, o, i) => s + Math.abs(o - f(i)), 0) / n;

  return {
    n,
    medianPeak: Math.exp(medianLog),
    spearman: spearman(pred, obs),
    topDecileMedian: Math.exp(decMedian),
    topDecileLift: Math.exp(decMedian - medianLog),
    maeModel: mae((i) => pred[i]),
    maeBaseline: mae(() => medianLog),
  };
}

/** Rolling-origin folds, the same discipline the graduation model is held to. */
export function validateAth(rows: AthRow[], folds = 5): AthEvaluation[] {
  const out: AthEvaluation[] = [];
  for (let k = 0; k < folds; k++) {
    const trEnd = Math.floor(rows.length * (0.4 + (0.6 * k) / folds));
    const teEnd = Math.floor(rows.length * (0.4 + (0.6 * (k + 1)) / folds));
    const tr = rows.slice(0, trEnd);
    const te = rows.slice(trEnd, teEnd);
    if (tr.length < 100 || te.length < 40) continue;
    const m = train(tr.map((r) => r.x), tr.map((r) => r.logPeak), [...FEATURES],
      { objective: "squared", rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 });
    out.push(evaluateAth(m, te));
  }
  return out;
}

export function trainAth(rows: AthRow[]): GbdtModel {
  return train(rows.map((r) => r.x), rows.map((r) => r.logPeak), [...FEATURES],
    { objective: "squared", rounds: 200, learningRate: 0.05, maxDepth: 3, minChildHessian: 20 });
}

export { calibrate };
