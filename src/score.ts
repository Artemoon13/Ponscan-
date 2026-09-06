import { existsSync, readFileSync } from "node:fs";
import { buildDataset, FEATURES, type Row } from "./features.ts";
import { deserialize, predict, type GbdtModel } from "./model/gbdt.ts";
import { explain, type Reason } from "./model/reasons.ts";
import type { DB } from "./db.ts";

export type Scored = {
  token: string;
  /** Launch time, so the caller can order by recency without a second query. */
  ts: number;
  probability: number;
  /** Rank among launches from the last `windowHours`, 1 = most likely to graduate. */
  rank: number;
  of: number;
  percentile: number;
  reasons: Reason[];
};

/**
 * One feature matrix, shared by the feed and every card.
 *
 * Rebuilding it costs about five seconds at 166,000 enriched launches, so who rebuilds it and when
 * is the difference between a board that answers instantly and one that takes fifteen seconds to
 * open a card.
 *
 * What makes a cache safe here: **rows for past launches never change**. Features are computed from
 * history strictly earlier than the launch's own timestamp, and a graduation happening now is later
 * than every launch already in the matrix, so it cannot alter one. A cached matrix is therefore
 * never wrong about what it holds — only ever incomplete. That turns the question from "is this
 * stale" into "is the row I need present", which has a cheap answer.
 *
 * So the two callers ask for different things. A card names one launch and is served from the cache
 * whenever that launch is in it. The feed wants whatever is newest and accepts being a few seconds
 * behind, which is what the staleness shown on the board is for.
 */
const REBUILD_AFTER_MS = 15_000;

let cached: { rows: Row[]; tokens: Set<string>; builtAt: number } | null = null;

function rebuild(db: DB): Row[] {
  const rows = buildDataset(db);
  cached = { rows, tokens: new Set(rows.map((r) => r.token)), builtAt: Date.now() };
  return rows;
}

/** How far behind the matrix is, in seconds. Surfaced so the board can say so out loud. */
export function datasetAgeSec(): number | null {
  return cached ? Math.round((Date.now() - cached.builtAt) / 1000) : null;
}

/** For the feed: newest rows matter, a few seconds behind is fine. */
export function dataset(db: DB): Row[] {
  if (!cached || Date.now() - cached.builtAt > REBUILD_AFTER_MS) return rebuild(db);
  return cached.rows;
}

/** For a card: rebuild only when this launch is one the matrix has never seen. */
export function datasetWith(db: DB, token: string): Row[] {
  if (!cached || !cached.tokens.has(token)) return rebuild(db);
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
export type FeedOrder = "score" | "new";

/**
 * Scores every launch in a recent window and ranks them against each other.
 *
 * A bare probability is hard to act on when the base rate is 2.2%: "3.9%" means little until you
 * know it is the highest of the last two thousand launches. The rank is what makes the number
 * usable, so it is computed here rather than left to the caller.
 *
 * `order` changes the reading order only. The rank is always by score, in both orders, because a
 * "#1" that meant "most recent" would be worthless — the point of showing a fresh launch is to see
 * where it lands against everything else, not to be told it is new.
 */
export function scoreRecent(
  db: DB, model: GbdtModel, windowHours = 6, limit = 200, order: FeedOrder = "score",
): Scored[] {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = dataset(db).filter((r) => r.ts >= cutoff);
  if (!rows.length) return [];

  const scored = rows
    .map((r) => ({ token: r.token, ts: r.ts, x: r.x, p: predict(model, r.x) }))
    .sort((a, b) => b.p - a.p);

  const ranked = scored.map((s, i) => ({
    token: s.token,
    ts: s.ts,
    x: s.x,
    probability: s.p,
    rank: i + 1,
    of: scored.length,
    percentile: 100 * (1 - i / Math.max(1, scored.length - 1)),
  }));

  const shown = order === "new"
    ? [...ranked].sort((a, b) => b.ts - a.ts || a.rank - b.rank).slice(0, limit)
    : ranked.slice(0, limit);

  return shown.map(({ x, ...rest }) => ({ ...rest, reasons: explain(model, x, 3) }));
}

/** Scores one launch and places it against the same recent window. */
export function scoreOne(db: DB, model: GbdtModel, token: string, windowHours = 6): Scored | null {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = datasetWith(db, token.toLowerCase());
  const me = rows.find((r) => r.token === token.toLowerCase());
  if (!me) return null;

  const peers = rows.filter((r) => r.ts >= cutoff).map((r) => predict(model, r.x));
  const p = predict(model, me.x);
  const better = peers.filter((q) => q > p).length;
  return {
    token: me.token,
    ts: me.ts,
    probability: p,
    rank: better + 1,
    of: Math.max(peers.length, 1),
    percentile: 100 * (1 - better / Math.max(1, peers.length - 1)),
    reasons: explain(model, me.x, 3),
  };
}

export { FEATURES };
