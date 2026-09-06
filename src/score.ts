import { existsSync, readFileSync } from "node:fs";
import { buildDataset, FEATURES, type Row } from "./features.ts";
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

/**
 * The feed and every card rebuild the same feature matrix. At 112,000 enriched launches that is
 * three and a half seconds of work to answer a question about the last six hours, and it grows with
 * the database, so a dashboard left open spends most of its life recomputing history that did not
 * change.
 *
 * The key is the shape of the data the matrix is derived from, not a clock. A time-based cache would
 * eventually show a stale score for a launch that has already graduated, which is the one thing this
 * tool must never do; keying on the data means new rows land on the very next request and unchanged
 * data costs nothing.
 *
 * Graduations are part of the key because creator history is accumulated by graduation time: a
 * graduation that lands now changes the features of every later launch by the same creator.
 */
let cached: { key: string; rows: Row[] } | null = null;

export function dataset(db: DB): Row[] {
  const k = db.prepare(`
    SELECT (SELECT count(*) FROM launches WHERE enriched_at IS NOT NULL) enriched,
           (SELECT coalesce(max(block), 0) FROM launches WHERE enriched_at IS NOT NULL) block,
           (SELECT count(*) FROM graduations) graduated`).get() as
    { enriched: number; block: number; graduated: number };

  const key = `${k.enriched}:${k.block}:${k.graduated}`;
  if (cached?.key !== key) cached = { key, rows: buildDataset(db) };
  return cached.rows;
}

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
  const rows = dataset(db).filter((r) => r.ts >= cutoff);
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
  const rows = dataset(db);
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
