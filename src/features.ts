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
  initial_buy_eth: number | null; exempt_count: number | null; symbol: string | null;
  name: string | null; description: string | null; socials_json: string | null; grad_ts: number | null;
};

/**
 * Builds the training matrix in block order, carrying per-creator state forward as it goes so every
 * row sees only its own past. Returns rows sorted by time, which is what the temporal split needs.
 */
export function buildDataset(db: DB, opts: { labelHorizonSec?: number } = {}): Row[] {
  const horizon = opts.labelHorizonSec ?? 4 * 3600;

  const launches = db.prepare(`
    SELECT l.token, l.deployer, l.launch_sender, l.pair_token, l.graduation_threshold_eth, l.block, l.ts,
           l.creator_fee_recipient, l.creator_tax_bps, l.buyback_enabled, l.initial_buy_eth,
           l.exempt_count, l.symbol, l.name, l.description, l.socials_json, g.ts AS grad_ts
    FROM launches l LEFT JOIN graduations g USING(token)
    WHERE l.enriched_at IS NOT NULL
    ORDER BY l.block ASC, l.log_index ASC`).all() as LaunchRow[];

  const exemptsByToken = new Map<string, string[]>();
  for (const r of db.prepare("SELECT token, address FROM exemptions").all() as Array<{ token: string; address: string }>) {
    const list = exemptsByToken.get(r.token);
    if (list) list.push(r.address);
    else exemptsByToken.set(r.token, [r.address]);
  }

  // Graduations become visible history only once they happen, so they are applied on a time queue.
  // The same queue drives creator history and name-cluster history: a sibling launch sharing this
  // token's ticker can graduate after it, and counting that would be reading the future.
  const gradQueue = launches
    .filter((r) => r.grad_ts !== null)
    .map((r) => ({ ts: r.grad_ts as number, deployer: r.deployer, sym: normaliseName(r.symbol) }))
    .sort((a, b) => a.ts - b.ts);
  let gradCursor = 0;

  const devLaunches = new Map<string, number>();
  const devGraduations = new Map<string, number>();
  const seenExempt = new Set<string>();
  const recentLaunchTs: number[] = [];

  /**
   * Name-cluster state. A news event produces one token and then a swarm of copies, and the swarm
   * is what carries the signal: a ticker relaunched thirty times graduates at three times the base
   * rate, and one whose earlier copies already reached the pool at more than three times.
   *
   * Being *first* is deliberately not a feature. At launch time an unseen ticker and the original
   * of a future swarm are the same observation, and together they land exactly on the base rate.
   *
   * These counts see only launches whose calldata decoded, which is roughly half. They are a
   * consistent undercount of the true cluster, and they sharpen as enrichment coverage grows.
   */
  const symLaunchTs = new Map<string, number[]>();
  const symGraduations = new Map<string, number>();
  const nameLaunches = new Map<string, number>();

  const out: Row[] = [];
  for (const r of launches) {
    while (gradCursor < gradQueue.length && gradQueue[gradCursor].ts <= r.ts) {
      const q = gradQueue[gradCursor];
      devGraduations.set(q.deployer, (devGraduations.get(q.deployer) ?? 0) + 1);
      if (q.sym) symGraduations.set(q.sym, (symGraduations.get(q.sym) ?? 0) + 1);
      gradCursor++;
    }
    while (recentLaunchTs.length && recentLaunchTs[0] < r.ts - 3600) recentLaunchTs.shift();

    const symKey = normaliseName(r.symbol);
    const nameKey = normaliseName(r.name);
    const symPrior = symKey ? (symLaunchTs.get(symKey) ?? []) : [];

    const priorL = devLaunches.get(r.deployer) ?? 0;
    const priorG = devGraduations.get(r.deployer) ?? 0;
    const socials = (() => {
      try { return JSON.parse(r.socials_json ?? "{}") as Record<string, string>; } catch { return {}; }
    })();
    const socialVals = Object.values(socials).filter((v) => typeof v === "string" && v.length > 3);
    const exempts = exemptsByToken.get(r.token) ?? [];
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
    x[i++] = Math.min(500, (r.description ?? "").length);
    x[i++] = (r.symbol ?? "").length;
    x[i++] = priorL;
    x[i++] = priorG;
    x[i++] = priorL > 0 ? priorG / priorL : 0;
    x[i++] = priorL === 0 ? 1 : 0;
    x[i++] = overlap;
    x[i++] = new Date(r.ts * 1000).getUTCHours();
    x[i++] = recentLaunchTs.length;

    // A launch only counts as a settled negative once the horizon has elapsed; unresolved recent
    // launches are dropped by the caller via `ts`, so no right-censored row is mislabelled here.
    const label: 0 | 1 = r.grad_ts !== null && r.grad_ts - r.ts <= horizon ? 1 : 0;
    out.push({ token: r.token, ts: r.ts, block: r.block, label, x });

    devLaunches.set(r.deployer, priorL + 1);
    for (const a of exempts) seenExempt.add(a);
    recentLaunchTs.push(r.ts);
    if (symKey) symLaunchTs.set(symKey, [...symPrior, r.ts]);
    if (nameKey) nameLaunches.set(nameKey, (nameLaunches.get(nameKey) ?? 0) + 1);
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
