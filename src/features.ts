import type { DB } from "./db.ts";

/**
 * The feature vector, computed strictly from what is knowable the instant the launch transaction
 * lands. Nothing here reads a trade, a price, or an outcome.
 *
 * The subtle trap is creator history. A creator's earlier launch may graduate *after* the launch we
 * are scoring, so counting "their prior graduations" by the earlier launch's own timestamp leaks the
 * future. History is therefore accumulated by graduation time, not launch time.
 */
export const FEATURES = [
  "calldata_decoded",
  "exempt_count",
  "exempt_is_zero",
  "log_initial_buy",
  "initial_buy_is_zero",
  "creator_tax_bps",
  "buyback_enabled",
  "socials_count",
  "has_twitter",
  "has_website",
  "fee_redirected",
  "via_contract",
  "is_eth_quoted",
  "log_threshold",
  "desc_len",
  "symbol_len",
  "dev_prior_launches",
  "dev_prior_graduations",
  "dev_prior_grad_rate",
  "dev_is_first_launch",
  "exempt_seen_before",
  "hour_utc",
  "launches_prior_hour",
] as const;

/**
 * Name-cluster counts are deliberately NOT features, despite looking like the strongest signal in
 * the data. Measured over a 9-hour window: a ticker already launched 30+ times graduates at 3.17x
 * the base rate, and one whose earlier copies already reached the pool at 3.35x.
 *
 * Adding them to the model made it worse. On the rows where a ticker is actually readable, held-out
 * ROC fell from 0.744 to 0.724 and top-decile lift from 4.19x to 3.87x across five folds. The
 * information is real but already carried by creator history and launch congestion, so five
 * correlated columns bought variance and nothing else.
 *
 * The counts stay in the product as facts on the card (see `clusterInfo` in card.ts), where a human
 * reading "this ticker has launched 30 times, two reached the pool" is genuinely better informed.
 */

export type FeatureName = (typeof FEATURES)[number];
export type Row = { token: string; ts: number; block: number; label: 0 | 1; x: Float64Array };

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const log1p = (v: number): number => Math.log1p(Math.max(0, v));

/**
 * Collapses a ticker or name to a comparison key: case, spacing, punctuation and emoji all vary
 * between a token and the copies that chase it, and none of that variation is meaningful.
 */
export const normaliseName = (s: string | null): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

type LaunchRow = {
  token: string; deployer: string; launch_sender: string | null; pair_token: string;
  graduation_threshold_eth: number; block: number; ts: number;
  creator_fee_recipient: string | null; creator_tax_bps: number | null; buyback_enabled: number | null;
  initial_buy_eth: number | null; exempt_count: number | null;
  /** Only lengths are ever features, so the text itself never leaves SQLite. On 170,000 launches
   *  pulling full descriptions costs more than every other column put together. */
  symbol_len: number; desc_len: number;
  socials_json: string | null; grad_ts: number | null;
};

/** The columns needed to carry history forward, for launches that will not become rows themselves. */
type SpineRow = { token: string; deployer: string; block: number; ts: number; grad_ts: number | null };

/**
 * Builds the training matrix in block order, carrying per-creator state forward as it goes so every
 * row sees only its own past. Returns rows sorted by time, which is what the temporal split needs.
 *
 * `since` limits which launches become rows — not which are walked. History has to be accumulated
 * over every launch regardless, or a creator's record would start at the window edge, but a launch
 * outside the window needs only three columns to contribute to it. Reading the full feature columns
 * for all 170,000 launches costs four times as much as reading three, and the board asks about six
 * hours, which is five thousand of them. Same rows out, a quarter of the work.
 */
export function buildDataset(db: DB, opts: { labelHorizonSec?: number; since?: number } = {}): Row[] {
  const horizon = opts.labelHorizonSec ?? 4 * 3600;
  const since = opts.since ?? 0;

  const spine = db.prepare(`
    SELECT l.token, l.deployer, l.block, l.ts, g.ts AS grad_ts
    FROM launches l LEFT JOIN graduations g USING(token)
    WHERE l.enriched_at IS NOT NULL
    ORDER BY l.block ASC, l.log_index ASC`).all() as SpineRow[];

  const detail = new Map<string, LaunchRow>();
  for (const d of db.prepare(`
    SELECT l.token, l.deployer, l.launch_sender, l.pair_token, l.graduation_threshold_eth, l.block, l.ts,
           l.creator_fee_recipient, l.creator_tax_bps, l.buyback_enabled, l.initial_buy_eth,
           l.exempt_count, l.socials_json, g.ts AS grad_ts,
           coalesce(length(l.symbol), 0)      AS symbol_len,
           coalesce(length(l.description), 0) AS desc_len
    FROM launches l LEFT JOIN graduations g USING(token)
    WHERE l.enriched_at IS NOT NULL AND l.ts >= ?
    ORDER BY l.block ASC, l.log_index ASC`).all(since) as LaunchRow[]) detail.set(d.token, d);

  const exemptsByToken = new Map<string, string[]>();
  for (const r of db.prepare("SELECT token, address FROM exemptions").all() as Array<{ token: string; address: string }>) {
    const list = exemptsByToken.get(r.token);
    if (list) list.push(r.address);
    else exemptsByToken.set(r.token, [r.address]);
  }

  // Graduations become visible history only once they happen, so they are applied on a time queue.
  // The same queue drives creator history and name-cluster history: a sibling launch sharing this
  // token's ticker can graduate after it, and counting that would be reading the future.
  const gradQueue = spine
    .filter((r) => r.grad_ts !== null)
    .map((r) => ({ ts: r.grad_ts as number, deployer: r.deployer }))
    .sort((a, b) => a.ts - b.ts);
  let gradCursor = 0;

  const devLaunches = new Map<string, number>();
  const devGraduations = new Map<string, number>();
  const seenExempt = new Set<string>();
  /**
   * Launches of the trailing hour, as a queue read through a moving head rather than shifted.
   * Array.shift copies the whole array, and this one holds about a thousand entries while the loop
   * runs a hundred and seventy thousand times: shifting turned a linear pass into a quadratic one
   * and cost more than every SQL query in this function put together.
   */
  const recentLaunchTs: number[] = [];
  let recentHead = 0;

  const out: Row[] = [];
  for (const sp of spine) {
    const r = detail.get(sp.token);
    while (gradCursor < gradQueue.length && gradQueue[gradCursor].ts <= sp.ts) {
      const q = gradQueue[gradCursor];
      devGraduations.set(q.deployer, (devGraduations.get(q.deployer) ?? 0) + 1);
      gradCursor++;
    }
    while (recentHead < recentLaunchTs.length && recentLaunchTs[recentHead] < sp.ts - 3600) recentHead++;

    const priorL = devLaunches.get(sp.deployer) ?? 0;
    const priorG = devGraduations.get(sp.deployer) ?? 0;
    const exempts = exemptsByToken.get(sp.token) ?? [];

    // History advances for every launch; only launches inside the window become rows. Nothing above
    // this point may touch `r`, which is absent for launches outside the window — reading through it
    // inside a try/catch turns every skipped launch into a thrown exception, and at a hundred and
    // sixty thousand of them that costs more than the rest of this function combined.
    if (!r) {
      devLaunches.set(sp.deployer, priorL + 1);
      for (const a of exempts) seenExempt.add(a);
      recentLaunchTs.push(sp.ts);
      continue;
    }

    const socials = (() => {
      try { return JSON.parse(r.socials_json ?? "{}") as Record<string, string>; } catch { return {}; }
    })();
    const socialVals = Object.values(socials).filter((v) => typeof v === "string" && v.length > 3);
    const overlap = exempts.filter((a) => seenExempt.has(a)).length;

    // Roughly half of launches do not go through the router, so their calldata cannot be decoded and
    // the creator's declared intent is simply unknown. Folding that into "bought nothing" and
    // "exempted nobody" would poison the two strongest signals, so absence is its own feature and
    // the derived flags only fire when the value was actually observed.
    const decoded = r.initial_buy_eth !== null;
    const buy = r.initial_buy_eth ?? 0;
    const x = new Float64Array(FEATURES.length);
    let i = 0;
    x[i++] = decoded ? 1 : 0;
    x[i++] = r.exempt_count ?? 0;
    x[i++] = decoded && (r.exempt_count ?? 0) === 0 ? 1 : 0;
    x[i++] = decoded ? log1p(buy * 1000) : 0;
    x[i++] = decoded && buy === 0 ? 1 : 0;
    x[i++] = r.creator_tax_bps ?? 0;
    x[i++] = r.buyback_enabled ?? 0;
    x[i++] = socialVals.length;
    x[i++] = socials.twitter && socials.twitter.length > 3 ? 1 : 0;
    x[i++] = socials.website && socials.website.length > 3 ? 1 : 0;
    x[i++] = r.creator_fee_recipient && r.launch_sender && r.creator_fee_recipient !== r.launch_sender ? 1 : 0;
    x[i++] = r.launch_sender && r.launch_sender !== r.deployer ? 1 : 0;
    x[i++] = r.pair_token === ZERO_ADDR ? 1 : 0;
    x[i++] = log1p(r.graduation_threshold_eth);
    x[i++] = Math.min(500, r.desc_len);
    x[i++] = r.symbol_len;
    x[i++] = priorL;
    x[i++] = priorG;
    x[i++] = priorL > 0 ? priorG / priorL : 0;
    x[i++] = priorL === 0 ? 1 : 0;
    x[i++] = overlap;
    x[i++] = new Date(r.ts * 1000).getUTCHours();
    x[i++] = recentLaunchTs.length - recentHead;

    // A launch only counts as a settled negative once the horizon has elapsed; unresolved recent
    // launches are dropped by the caller via `ts`, so no right-censored row is mislabelled here.
    const label: 0 | 1 = r.grad_ts !== null && r.grad_ts - r.ts <= horizon ? 1 : 0;
    out.push({ token: r.token, ts: r.ts, block: r.block, label, x });

    devLaunches.set(sp.deployer, priorL + 1);
    for (const a of exempts) seenExempt.add(a);
    recentLaunchTs.push(sp.ts);
  }
  return out;
}

/**
 * Drops rows whose outcome is not yet settled. A launch from ten minutes ago has not graduated
 * *yet*, which is not the same as not graduating: training on it as a negative teaches the model
 * that recent launches fail.
 */
export function dropCensored(rows: Row[], nowTs: number, horizonSec = 4 * 3600): Row[] {
  return rows.filter((r) => r.label === 1 || r.ts + horizonSec <= nowTs);
}
