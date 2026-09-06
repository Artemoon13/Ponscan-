import { EXPLORER } from "./config.ts";
import { formatUnits, quoteFromCache } from "./quote.ts";
import { curveStats, type CurveStats } from "./curve.ts";
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
    topWallets: Array<{ address: string; inAmount: string; outAmount: string; multiple: number | null; url: string }>;
  };
  outcome: { phase: number; graduated: boolean; graduationTx: string | null; graduationTxUrl: string | null; secondsToGraduate: number | null };
  creatorHistory: {
    priorLaunches: number; priorGraduations: number;
    recent: Array<{ token: string; symbol: string | null; ts: number; graduated: boolean; url: string }>;
  };
};

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
    SELECT x.token, x.symbol, x.ts, (g.token IS NOT NULL) AS graduated
    FROM launches x LEFT JOIN graduations g USING(token)
    WHERE x.deployer = ? AND x.token != ? ORDER BY x.block DESC LIMIT 10`).all(deployer, t) as
    Array<{ token: string; symbol: string | null; ts: number; graduated: number }>;

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
      topWallets: cs.positions.slice(0, 10).map((p) => ({
        address: p.address, inAmount: fq(p.boughtWei), outAmount: fq(p.soldWei),
        multiple: p.multiple, url: EXPLORER.address(p.address),
      })),
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
      recent: recent.map((r) => ({
        token: r.token, symbol: r.symbol, ts: r.ts,
        graduated: Boolean(r.graduated), url: EXPLORER.token(r.token),
      })),
    },
  };
}
