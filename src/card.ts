import { EXPLORER } from "./config.ts";
import { formatUnits, quoteFromCache } from "./quote.ts";
import { curveStats, peakMultiple, type CurveStats } from "./curve.ts";
import { capsFor, formatUsd, marketCapUsd, startingCapUsd } from "./prices.ts";
import { loadAthModel, predictAthFor } from "./ath-score.ts";
import type { DB } from "./db.ts";

/**
 * Everything collected about one launch, assembled for the detail card.
 *
 * The brief for this card is that a trader should be able to check the score rather than trust it,
 * so every fact carries the transaction it came from. Nothing here is inferred or scraped: each
 * field traces to a log or to the launch transaction's own calldata.
 */
export type Card = {
  token: string;
  tokenUrl: string;
  ponsUrl: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  socials: Record<string, string>;
  launch: {
    tx: string; txUrl: string; block: number; ts: number;
    creator: string | null; creatorUrl: string;
    calledBy: string; viaContract: boolean;
    selfBuy: string | null;
    quoteAsset: string; quoteSymbol: string; quoteDecimals: number; isEthQuoted: boolean;
    threshold: string;
    creatorTaxBps: number | null;
    buybackEnabled: boolean | null;
  };
  fees: {
    recipient: string | null; recipientUrl: string; redirected: boolean;
    changes: Array<{ prev: string; next: string; tx: string; txUrl: string; ts: number }>;
  };
  /**
   * What the second model expects this launch to reach, as a band rather than a figure.
   *
   * The point estimate barely beats a constant, so a single number would be a guess wearing a
   * precision it does not have. The band is measured: residual quantiles from launches the model
   * never saw, its coverage checked on a third slice. `coverage` is what that check found.
   */
  ath: {
    available: boolean;
    multiple: number | null; loMultiple: number | null; hiMultiple: number | null;
    pointUsd: string | null; loUsd: string | null; hiUsd: string | null;
    coverage: number | null; spearman: number | null;
  };
  /**
   * The name cluster this launch belongs to: other launches that used the same ticker.
   *
   * A news event produces one token and then a swarm of copies, and the swarm's shape matters more
   * than being first. `distinctCreators` is what separates the two cases that otherwise look
   * identical: a hundred launches from a hundred wallets is a live narrative, a hundred from one
   * wallet is one person spamming.
   */
  cluster: {
    key: string;
    total: number;
    before: number;
    after: number;
    graduated: number;
    distinctCreators: number;
    kind: "unique" | "swarm" | "repeat-spam";
    isFirstSeen: boolean;
    siblings: Array<{ token: string; symbol: string | null; ts: number; graduated: boolean; sameCreator: boolean; url: string }>;
  };
  exemptions: Array<{ address: string; url: string; seenInOtherLaunches: number }>;
  /**
   * Trading on the bonding curve. Empty until this token's curve has been indexed, which happens on
   * demand: curve events live on each curve's own address and there are tens of thousands a day, so
   * they are pulled when a card is opened rather than streamed continuously.
   */
  trading: {
    indexed: boolean;
    buys: number; sells: number;
    buyersFirstMinute: number; buyersTotal: number;
    coBuyers: Array<{ address: string; amount: string; url: string }>;
    snipers: Array<{ address: string; tax: string; bought: string; blocksAfterLaunch: number; onExemptList: boolean; url: string }>;
    snipeTaxTotal: string;
    /** Highest price the curve reached, as a multiple of its first trade. Observed, not forecast. */
    peakMultiple: number | null;
    /** Peak market cap in dollars, from the price snapshot. Null when the quote asset has no price. */
    peakUsd: string | null;
    topWallets: Array<{ address: string; inAmount: string; outAmount: string; multiple: number | null; url: string }>;
  };
  outcome: { phase: number; graduated: boolean; graduationTx: string | null; graduationTxUrl: string | null; secondsToGraduate: number | null };
  creatorHistory: {
    priorLaunches: number; priorGraduations: number;
    /** Best observed peak across every earlier launch whose curve has been read. Null if none have. */
    bestPeak: PastPeak | null;
    /** That creator's three highest-climbing launches, best first. */
    topPeaks: PastPeak[];
    /** How many of `recent` still have no curve data, so the card can say so instead of implying zero. */
    unread: number;
    recent: Array<{ token: string; symbol: string | null; ts: number; graduated: boolean; peakMultiple: number | null; peakUsd: string | null; read: boolean; url: string }>;
  };
};


/**
 * A creator's highest-climbing launches, across everything of theirs that has been read.
 *
 * The card lists the ten most recent launches, and for a while the "best peak" was taken from that
 * list — which for a wallet with sixty-five launches meant "best of the last ten" under a label that
 * promised all-time. On the busiest creator in this database the honest scan finds x11.30 where the
 * recent-ten scan found nothing near it.
 *
 * One pass rather than a query per launch: a window function picks each curve's first trade and its
 * highest, and the ratio falls out of the group. Measured at 2 ms for a creator with 65 launches and
 * 22 ms for one with 2,541, which is affordable on the request path where sixty-five separate reads
 * would not have been.
 *
 * "Read" is the limit, not "launched". Curves are pulled on demand, so this ranks what is known, and
 * the card reports separately how many of the creator's curves nobody has looked at yet.
 */
export type PastPeak = { token: string; symbol: string | null; multiple: number; usd: string | null; url: string };

function topPeaks(db: DB, deployer: string, beforeBlock: number, limit: number): PastPeak[] {
  const rows = db.prepare(`
    WITH p AS (
      SELECT c.token, CAST(c.quote_wei AS REAL) / CAST(c.token_amt AS REAL) px,
             row_number() OVER (PARTITION BY c.token ORDER BY c.block, c.log_index) rn
      FROM curve_trades c
      WHERE c.token IN (SELECT token FROM launches WHERE deployer = ? AND block < ?)
        AND CAST(c.token_amt AS REAL) > 0 AND CAST(c.quote_wei AS REAL) > 0
    )
    SELECT p.token, l.symbol, l.pair_token,
           max(p.px) peak, max(CASE WHEN p.rn = 1 THEN p.px END) first
    FROM p JOIN launches l ON l.token = p.token
    GROUP BY p.token`).all(deployer, beforeBlock) as
    Array<{ token: string; symbol: string | null; pair_token: string; peak: number; first: number }>;

  return rows
    .filter((r) => r.first > 0 && r.peak > 0 && Number.isFinite(r.peak / r.first))
    .map((r) => {
      const q = quoteFromCache(db, r.pair_token);
      // Raw prices are quote units per token unit; this lifts them to whole quote per whole token.
      const usd = marketCapUsd(r.peak * (1e18 / 10 ** q.decimals), q.symbol);
      return {
        token: r.token, symbol: r.symbol, multiple: r.peak / r.first,
        usd: usd === null ? null : formatUsd(usd), url: EXPLORER.token(r.token),
      };
    })
    .sort((a, b) => b.multiple - a.multiple)
    .slice(0, limit);
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function buildCard(db: DB, token: string): Card | null {
  const t = token.toLowerCase();
  const l = db.prepare("SELECT * FROM launches WHERE token = ?").get(t) as Record<string, unknown> | undefined;
  if (!l) return null;

  const grad = db.prepare("SELECT * FROM graduations WHERE token = ?").get(t) as
    | { tx: string; ts: number } | undefined;

  const exemptRows = db.prepare("SELECT address FROM exemptions WHERE token = ?").all(t) as Array<{ address: string }>;
  const otherCount = db.prepare("SELECT count(*) c FROM exemptions WHERE address = ? AND token != ?");

  const changes = db.prepare(
    "SELECT prev, next, tx, ts FROM fee_recipient_changes WHERE token = ? ORDER BY block",
  ).all(t) as Array<{ prev: string; next: string; tx: string; ts: number }>;

  const deployer = String(l.deployer);
  const sender = (l.launch_sender as string | null) ?? null;

  // History is "before this launch", the same rule the model's features follow, so the card and the
  // score never disagree about what was known at the time.
  const prior = db.prepare(
    "SELECT count(*) c FROM launches WHERE deployer = ? AND block < ?",
  ).get(deployer, l.block) as { c: number };
  const priorGrad = db.prepare(`
    SELECT count(*) c FROM launches x JOIN graduations g USING(token)
    WHERE x.deployer = ? AND g.ts < ?`).get(deployer, l.ts) as { c: number };

  const recent = db.prepare(`
    SELECT x.token, x.symbol, x.ts, x.pair_token, (g.token IS NOT NULL) AS graduated
    FROM launches x LEFT JOIN graduations g USING(token)
    WHERE x.deployer = ? AND x.token != ? ORDER BY x.block DESC LIMIT 10`).all(deployer, t) as
    Array<{ token: string; symbol: string | null; ts: number; pair_token: string; graduated: number }>;

  const socials = (() => {
    try { return JSON.parse((l.socials_json as string) ?? "{}") as Record<string, string>; } catch { return {}; }
  })();

  const symKey = (l.symbol_key as string | null) ?? null;
  const clusterRows = symKey
    ? (db.prepare(`
        SELECT x.token, x.symbol, x.ts, x.block, x.deployer, (g.token IS NOT NULL) AS graduated
        FROM launches x LEFT JOIN graduations g USING(token)
        WHERE x.symbol_key = ? ORDER BY x.block`).all(symKey) as Array<{
          token: string; symbol: string | null; ts: number; block: number; deployer: string; graduated: number }>)
    : [];
  const before = clusterRows.filter((c) => c.block < Number(l.block)).length;
  const creators = new Set(clusterRows.map((c) => c.deployer)).size;
  // One wallet relaunching the same ticker is spam; many wallets on one ticker is a narrative.
  const kind: Card["cluster"]["kind"] =
    clusterRows.length <= 1 ? "unique" : creators <= Math.max(1, Math.floor(clusterRows.length / 10)) ? "repeat-spam" : "swarm";

  const feeRecipient = (l.creator_fee_recipient as string | null) ?? null;
  // Amounts are denominated in the launch's quote asset, which is often a 6-decimal stablecoin or a
  // tokenised stock rather than ETH. Formatting them all as 1e18 prints 0.0000 for real values.
  const quote = quoteFromCache(db, String(l.pair_token));
  const cs: CurveStats = curveStats(db, t, Number(l.block));
  const ownCaps = capsFor(db, t, quote.symbol, quote.decimals);

  /**
   * Peaks for the creator's earlier launches.
   *
   * Each is priced in *its own* quote asset, not this card's. A creator launching once against ETH
   * and once against USDG is ordinary, and using this token's decimals for both would misprice the
   * other by a factor of a trillion — the same decimals bug that once printed "0.0000" on the card.
   *
   * Curves are read per token on demand, so an earlier launch nobody has opened yet has no peak
   * rather than a peak of zero; the card counts those separately and says so.
   */
  const wasRead = db.prepare("SELECT 1 x FROM curve_indexed WHERE token = ?");
  const history = recent.map((r) => {
    const q = quoteFromCache(db, r.pair_token);
    const caps = capsFor(db, r.token, q.symbol, q.decimals);
    return {
      token: r.token, symbol: r.symbol, ts: r.ts, graduated: Boolean(r.graduated),
      peakMultiple: caps.peakMultiple, peakUsd: caps.peakUsd === null ? null : formatUsd(caps.peakUsd),
      // Whether anyone has pulled this curve yet. Without it a blank peak is ambiguous: it reads the
      // same whether the curve is still being fetched or was fetched and found no trades at all.
      read: Boolean(wasRead.get(r.token)),
      url: EXPLORER.token(r.token),
    };
  });

  // The multiple is what the model predicts; dollars come from the near-constant starting cap, so a
  // launch with no trades yet still gets a figure instead of only a ratio.
  const best = topPeaks(db, deployer, Number(l.block), 3);

  const athModel = loadAthModel();
  const athRaw = athModel ? predictAthFor(db, athModel, t) : null;
  const startCap = startingCapUsd(db, quote.symbol, quote.decimals);
  const asUsd = (m: number | null): string | null =>
    m === null || startCap === null ? null : formatUsd(m * startCap);
  const fq = (wei: string): string => formatUnits(BigInt(wei), quote.decimals);

  return {
    token: t,
    /** The contract itself. What a trader reaches for first, so it does not get buried. */
    tokenUrl: EXPLORER.token(t),
    ponsUrl: EXPLORER.pons(t),
    name: (l.name as string | null) ?? null,
    symbol: (l.symbol as string | null) ?? null,
    description: (l.description as string | null) ?? null,
    socials: Object.fromEntries(Object.entries(socials).filter(([, v]) => typeof v === "string" && v.length > 3)),
    launch: {
      tx: String(l.tx), txUrl: EXPLORER.tx(String(l.tx)), block: Number(l.block), ts: Number(l.ts),
      creator: sender, creatorUrl: EXPLORER.address(sender ?? deployer),
      calledBy: deployer, viaContract: Boolean(sender && sender !== deployer),
      selfBuy: l.initial_buy_wei === null ? null : formatUnits(BigInt(l.initial_buy_wei as string), quote.decimals),
      quoteAsset: String(l.pair_token), quoteSymbol: quote.symbol, quoteDecimals: quote.decimals,
      isEthQuoted: String(l.pair_token) === ZERO,
      threshold: formatUnits(BigInt(l.graduation_threshold_wei as string), quote.decimals),
      creatorTaxBps: (l.creator_tax_bps as number | null) ?? null,
      buybackEnabled: l.buyback_enabled === null ? null : Boolean(l.buyback_enabled),
    },
    fees: {
      recipient: feeRecipient, recipientUrl: EXPLORER.address(feeRecipient ?? ZERO),
      redirected: Boolean(feeRecipient && sender && feeRecipient !== sender),
      changes: changes.map((c) => ({ ...c, txUrl: EXPLORER.tx(c.tx) })),
    },
    cluster: {
      key: symKey ?? "",
      total: clusterRows.length,
      before,
      after: Math.max(0, clusterRows.length - before - 1),
      graduated: clusterRows.filter((c) => c.graduated).length,
      distinctCreators: creators,
      kind,
      isFirstSeen: before === 0,
      siblings: clusterRows
        .filter((c) => c.token !== t)
        .slice(-12)
        .reverse()
        .map((c) => ({
          token: c.token, symbol: c.symbol, ts: c.ts,
          graduated: Boolean(c.graduated), sameCreator: c.deployer === deployer,
          url: EXPLORER.token(c.token),
        })),
    },
    trading: {
      indexed: cs.indexed,
      buys: cs.buys, sells: cs.sells,
      buyersFirstMinute: cs.buyersFirstMinute, buyersTotal: cs.buyersTotal,
      coBuyers: cs.coBuyersInLaunchTx.map((b) => ({ address: b.address, amount: fq(b.quoteWei), url: EXPLORER.address(b.address) })),
      snipers: cs.snipers.map((x) => ({
        address: x.address, tax: fq(x.taxWei), bought: fq(x.boughtWei),
        blocksAfterLaunch: x.blocksAfterLaunch, onExemptList: x.wasExempt, url: EXPLORER.address(x.address),
      })),
      snipeTaxTotal: fq(cs.snipeTaxTotalWei),
      peakMultiple: cs.peakMultiple,
      peakUsd: ownCaps.peakUsd === null ? null : formatUsd(ownCaps.peakUsd),
      topWallets: cs.positions.slice(0, 10).map((p) => ({
        address: p.address, inAmount: fq(p.boughtWei), outAmount: fq(p.soldWei),
        multiple: p.multiple, url: EXPLORER.address(p.address),
      })),
    },
    ath: {
      available: athRaw !== null,
      multiple: athRaw?.multiple ?? null,
      loMultiple: athRaw?.lo ?? null,
      hiMultiple: athRaw?.hi ?? null,
      pointUsd: asUsd(athRaw?.multiple ?? null),
      loUsd: asUsd(athRaw?.lo ?? null),
      hiUsd: asUsd(athRaw?.hi ?? null),
      coverage: athModel?.coverage ?? null,
      spearman: athModel?.spearman ?? null,
    },
    exemptions: exemptRows.map((e) => ({
      address: e.address,
      url: EXPLORER.address(e.address),
      seenInOtherLaunches: (otherCount.get(e.address, t) as { c: number }).c,
    })),
    outcome: {
      phase: Number(l.phase),
      graduated: Boolean(grad),
      graduationTx: grad?.tx ?? null,
      graduationTxUrl: grad ? EXPLORER.tx(grad.tx) : null,
      secondsToGraduate: grad ? grad.ts - Number(l.ts) : null,
    },
    creatorHistory: {
      priorLaunches: prior.c,
      priorGraduations: priorGrad.c,
      bestPeak: best[0] ?? null,
      topPeaks: best,
      unread: (db.prepare(`SELECT count(*) c FROM launches WHERE deployer = ? AND block < ?
        AND token NOT IN (SELECT token FROM curve_indexed)`).get(deployer, l.block) as { c: number }).c,
      recent: history,
    },
  };
}
