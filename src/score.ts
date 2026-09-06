import { existsSync, readFileSync } from "node:fs";
import { buildDataset, FEATURES } from "./features.ts";
import { deserialize, predict, type GbdtModel } from "./model/gbdt.ts";
import { explain, type Reason } from "./model/reasons.ts";
import type { DB } from "./db.ts";

export type Scored = {
  token: string;
  probability: number;
  /** Rank among launches from the last `windowHours`, 1 = most likely to graduate. */
  rank: number;
  of: number;
  percentile: number;
  reasons: Reason[];
};

export function loadModel(path = "./data/model.json"): GbdtModel | null {
  if (!existsSync(path)) return null;
  return deserialize(readFileSync(path, "utf8"));
}

/**
 * Scores every launch in a recent window and ranks them against each other.
 *
 * A bare probability is hard to act on when the base rate is 2.5%: "3.9%" means little until you
 * know it is the highest of the last two hundred launches. The rank is what makes the number usable,
 * so it is computed here rather than left to the caller.
 */
export function scoreRecent(db: DB, model: GbdtModel, windowHours = 6, limit = 200): Scored[] {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = buildDataset(db).filter((r) => r.ts >= cutoff);
  if (!rows.length) return [];

  const scored = rows
    .map((r) => ({ token: r.token, x: r.x, p: predict(model, r.x) }))
    .sort((a, b) => b.p - a.p);

  return scored.slice(0, limit).map((s, i) => ({
    token: s.token,
    probability: s.p,
    rank: i + 1,
    of: scored.length,
    percentile: 100 * (1 - i / Math.max(1, scored.length - 1)),
    reasons: explain(model, s.x, 3),
  }));
}

/** Scores one launch and places it against the same recent window. */
export function scoreOne(db: DB, model: GbdtModel, token: string, windowHours = 6): Scored | null {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = buildDataset(db);
  const me = rows.find((r) => r.token === token.toLowerCase());
  if (!me) return null;

  const peers = rows.filter((r) => r.ts >= cutoff).map((r) => predict(model, r.x));
  const p = predict(model, me.x);
  const better = peers.filter((q) => q > p).length;
  return {
    token: me.token,
    probability: p,
    rank: better + 1,
    of: Math.max(peers.length, 1),
    percentile: 100 * (1 - better / Math.max(1, peers.length - 1)),
    reasons: explain(model, me.x, 3),
  };
}

export { FEATURES };
