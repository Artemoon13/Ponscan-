import { existsSync, readFileSync } from "node:fs";
import { buildDataset, FEATURES, type Row } from "./features.ts";
import { deserialize, predict, type GbdtModel } from "./model/gbdt.ts";
import { explain, type Reason } from "./model/reasons.ts";
import { applyLive, liveFor } from "./calibration.ts";
import { modelId } from "./track.ts";
import type { DB } from "./db.ts";

export type Scored = {
  token: string;
  /**
   * The model's own probability, before any live correction. The card shows `probability`; this is
   * what a refit must be fitted against, or a correction would be measured on top of itself.
   */
  rawProbability: number;
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
/** Rounding `since` keeps a clock that moves every second from invalidating the cache every second. */
const SINCE_BUCKET_SEC = 60;

let cached: { rows: Row[]; tokens: Set<string>; builtAt: number; since: number } | null = null;

function rebuild(db: DB, since: number): Row[] {
  const rows = buildDataset(db, { since });
  cached = { rows, tokens: new Set(rows.map((r) => r.token)), builtAt: Date.now(), since };
  return rows;
}

/** How far behind the matrix is, in seconds. Surfaced so the board can say so out loud. */
export function datasetAgeSec(): number | null {
  return cached ? Math.round((Date.now() - cached.builtAt) / 1000) : null;
}

/**
 * For the feed: rows back to `since`, newest data preferred, a few seconds behind is fine.
 *
 * A cache built for a longer reach answers a shorter question too, so it is only rebuilt when the
 * request needs history the cache does not carry.
 */
export function dataset(db: DB, since: number): Row[] {
  const want = Math.floor(since / SINCE_BUCKET_SEC) * SINCE_BUCKET_SEC;
  const stale = !cached || Date.now() - cached.builtAt > REBUILD_AFTER_MS;
  const tooNarrow = !cached || cached.since > want;
  if (stale || tooNarrow) return rebuild(db, want);
  return cached.rows;
}

/**
 * For a card: rebuild only when this launch is one the matrix has never seen.
 *
 * A launch older than the cached window is not in it and never will be, so that case falls back to
 * a full build rather than looping. It is rare — cards are opened from the feed — and slow, which is
 * the right trade against silently answering "unknown token" for a launch that exists.
 */
export function datasetWith(db: DB, token: string): Row[] {
  if (cached?.tokens.has(token)) return cached.rows;
  const rows = rebuild(db, cached?.since ?? Math.floor(Date.now() / 1000) - 6 * 3600);
  if (cached?.tokens.has(token)) return rows;
  return rebuild(db, 0);
}

/**
 * The correction fitted against the live prediction log, when one exists for the model in use.
 *
 * Read per call rather than cached: it is a tiny file, it changes at most a few times a day, and a
 * board that kept serving a stale correction after a retrain would be printing numbers the log can
 * no longer vouch for. `liveFor` already refuses a correction stamped with a different model.
 */
function live(): { a: number; b: number } | null {
  try {
    return liveFor(modelId());
  } catch {
    return null;
  }
}

/**
 * The probability as shown: the model's own, then the live correction if there is one.
 *
 * Not named `shown`: `scoreRecent` already binds that for its display ordering, and a module-level
 * function of the same name is shadowed by it throughout the function body — including above the
 * binding, where the local is still in its dead zone. That reads as a plain reference and throws at
 * runtime on the first feed request, which is to say in production and not in any test.
 */
export function corrected(p: number, c: { a: number; b: number } | null): number {
  return c ? applyLive(c, p) : p;
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
/**
 * One page of the feed, with the counts needed to describe it honestly.
 *
 * `total` is every launch in the window and `matched` is how many cleared the reader's threshold,
 * so a capped list can say "showing 150 of 300 that scored 5% or better, out of 4,665" instead of
 * implying the window holds only what fits on screen.
 */
export type FeedPage = { items: Scored[]; matched: number; total: number };

export function scoreRecent(
  db: DB, model: GbdtModel, windowHours = 6, limit = 200, order: FeedOrder = "score", minP = 0,
): FeedPage {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = dataset(db, cutoff).filter((r) => r.ts >= cutoff);
  if (!rows.length) return { items: [], matched: 0, total: 0 };

  const c = live();
  const scored = rows
    .map((r) => { const raw = predict(model, r.x); return { token: r.token, ts: r.ts, x: r.x, raw, p: corrected(raw, c) }; })
    .sort((a, b) => b.p - a.p);

  const ranked = scored.map((s, i) => ({
    token: s.token,
    ts: s.ts,
    x: s.x,
    rawProbability: s.raw,
    probability: s.p,
    rank: i + 1,
    of: scored.length,
    percentile: 100 * (1 - i / Math.max(1, scored.length - 1)),
  }));

  // Filtered after ranking, so a rank means the same thing whatever the reader has hidden: #264 of
  // 4,537 is its place among every launch in the window, not among the survivors of a threshold.
  // Filtered before the cap, though, so a threshold reaches the whole window rather than merely
  // thinning the first hundred and fifty rows.
  const kept = minP > 0 ? ranked.filter((r) => r.probability >= minP) : ranked;

  const shown = order === "new"
    ? [...kept].sort((a, b) => b.ts - a.ts || a.rank - b.rank).slice(0, limit)
    : kept.slice(0, limit);

  return {
    items: shown.map(({ x, ...rest }) => ({ ...rest, reasons: explain(model, x, 3) })),
    matched: kept.length,
    total: scored.length,
  };
}

/** Scores one launch and places it against the same recent window. */
export function scoreOne(db: DB, model: GbdtModel, token: string, windowHours = 6): Scored | null {
  const cutoff = Math.floor(Date.now() / 1000) - windowHours * 3600;
  const rows = datasetWith(db, token.toLowerCase());
  const me = rows.find((r) => r.token === token.toLowerCase());
  if (!me) return null;

  const c = live();
  const peers = rows.filter((r) => r.ts >= cutoff).map((r) => corrected(predict(model, r.x), c));
  const raw = predict(model, me.x);
  const p = corrected(raw, c);
  const better = peers.filter((q) => q > p).length;
  return {
    token: me.token,
    ts: me.ts,
    rawProbability: raw,
    probability: p,
    rank: better + 1,
    of: Math.max(peers.length, 1),
    percentile: 100 * (1 - better / Math.max(1, peers.length - 1)),
    reasons: explain(model, me.x, 3),
  };
}

export { FEATURES };
