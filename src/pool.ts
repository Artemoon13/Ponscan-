import { decodeEventLog, toEventSelector, type Log } from "viem";
import { ADDR } from "./config.ts";
import { logsClient, withRetry } from "./chain.ts";
import { marketCapUsd, SUPPLY } from "./prices.ts";
import type { DB } from "./db.ts";

/**
 * What a token does after it leaves the curve.
 *
 * The curve is only the first act. A launch that graduates has by definition reached the threshold,
 * so its curve peak is very nearly a constant: measured across graduated tokens it lands between
 * $45K and $59K because that is the bar it had to clear. Everything that distinguishes one graduated
 * token from another happens afterwards, in the pool, and until now none of it was recorded. On four
 * sampled tokens the pool peak ran between 2.2x and 50.6x the curve peak; SNOWBALL reached
 * $2,700,516 against the $53,357 the curve knew about.
 *
 * Uniswap v4 makes this cheaper to follow than the curves were. Every pool on the chain lives inside
 * one singleton contract, so a single log stream carries every graduated token at once, where curves
 * needed one read per token. And each `Swap` carries `sqrtPriceX96`, so the price is in the event
 * rather than something to reconstruct from reserves.
 *
 * Measured: a 2,000-block chunk returns about 8,400 logs in 1.7 s and covers 202 seconds of chain,
 * so keeping up with every graduated token costs roughly 430 reads a day. The curve indexer already
 * runs at 1.7 reads a second.
 */

export const TOPIC_POOL_INIT = toEventSelector(
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)",
);
export const TOPIC_POOL_SWAP = toEventSelector(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);

const initAbi = [{
  type: "event", name: "Initialize", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "currency0", type: "address", indexed: true },
    { name: "currency1", type: "address", indexed: true },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
  ],
}] as const;

const swapAbi = [{
  type: "event", name: "Swap", inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "sender", type: "address", indexed: true },
    { name: "amount0", type: "int128" },
    { name: "amount1", type: "int128" },
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "liquidity", type: "uint128" },
    { name: "tick", type: "int24" },
    { name: "fee", type: "uint24" },
  ],
}] as const;

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const Q96 = 2 ** 96;
/** Every token pons launches carries eighteen decimals, the same as the supply figure assumes. */
const TOKEN_DECIMALS = 18;

export type PoolRow = {
  token: string; pool_id: string; currency0: string; currency1: string;
  token_is_c1: number; dec0: number; dec1: number; init_block: number; init_sqrt: string;
};

/**
 * Finds the one pool that belongs to a graduated token, and rejects the ones that do not.
 *
 * A graduated token attracts impostors: sampled across six tokens, each had exactly one pool carrying
 * the pons hook and between four and seven others opened by strangers with `hooks` set to the zero
 * address and arbitrary fee tiers. Those pools trade, so they have prices, and a peak read out of one
 * would be a number somebody else chose. The hook is what makes the real pool identifiable, so it is
 * the filter rather than a detail.
 */
export async function resolvePool(
  db: DB, token: string, fromBlock: number, toBlock: number, quoteDecimals: number,
): Promise<PoolRow | null> {
  const padded = `0x${token.slice(2).padStart(64, "0")}` as `0x${string}`;

  // The token sorts to either side of the pair depending on its address, so both are asked for.
  for (const [isC1, topics] of [
    [1, [TOPIC_POOL_INIT, null, null, padded]],
    [0, [TOPIC_POOL_INIT, null, padded, null]],
  ] as const) {
    const logs = (await withRetry(() => logsClient.request({
      method: "eth_getLogs",
      params: [{
        address: ADDR.v4PoolManager,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics,
      }],
    } as never))) as RawLog[];

    for (const l of logs) {
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: initAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      if (String(a.hooks).toLowerCase() !== ADDR.hook.toLowerCase()) continue;

      const row: PoolRow = {
        token,
        pool_id: String(a.id),
        currency0: String(a.currency0).toLowerCase(),
        currency1: String(a.currency1).toLowerCase(),
        token_is_c1: isC1,
        dec0: isC1 ? quoteDecimals : TOKEN_DECIMALS,
        dec1: isC1 ? TOKEN_DECIMALS : quoteDecimals,
        init_block: Number(l.blockNumber),
        init_sqrt: (a.sqrtPriceX96 as bigint).toString(),
      };
      db.prepare(`
        INSERT INTO pools (token, pool_id, currency0, currency1, token_is_c1, dec0, dec1, init_block, init_sqrt)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(token) DO NOTHING`).run(
        row.token, row.pool_id, row.currency0, row.currency1, row.token_is_c1,
        row.dec0, row.dec1, row.init_block, row.init_sqrt,
      );
      return row;
    }
  }
  return null;
}

/**
 * Whole quote units per whole token, from a pool price.
 *
 * `sqrtPriceX96` squares to currency1 per currency0 in raw units, so which side the token sits on
 * decides whether the ratio is inverted, and the decimal gap between the two currencies has to be
 * put back either way.
 */
export function quotePerToken(sqrt: string | bigint, p: Pick<PoolRow, "token_is_c1" | "dec0" | "dec1">): number {
  const r = Number(sqrt) / Q96;
  const price = r * r;
  if (!(price > 0) || !Number.isFinite(price)) return 0;
  return p.token_is_c1 ? (1 / price) * 10 ** (p.dec1 - p.dec0) : price * 10 ** (p.dec0 - p.dec1);
}

/**
 * Reads pool swaps chain-wide and keeps only the extremes.
 *
 * Three and a half million swaps a day pass through the singleton, and storing them would buy
 * nothing: the card asks how high a token went, which is one number per pool. So each chunk updates
 * a running high and low per pool and is then discarded.
 *
 * Both ends are kept because the token is not always the same side of the pair. Where it is
 * currency1 the price rises as `sqrtPriceX96` falls, so its peak is the low; where it is currency0
 * the peak is the high. Storing one end would silently invert half the pools.
 */
export async function indexPoolSwaps(
  db: DB, fromBlock: number, toBlock: number, chunk = 2000,
): Promise<{ swaps: number; matched: number; chunks: number }> {
  const known = new Set<string>(
    (db.prepare("SELECT pool_id FROM pools").all() as Array<{ pool_id: string }>).map((r) => r.pool_id),
  );
  if (!known.size) return { swaps: 0, matched: 0, chunks: 0 };

  const upsert = db.prepare(`
    INSERT INTO pool_peaks (pool_id, min_sqrt, max_sqrt, min_block, max_block, last_sqrt, last_block, swaps, to_block)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(pool_id) DO UPDATE SET
      min_sqrt  = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_sqrt ELSE pool_peaks.min_sqrt END,
      min_block = CASE WHEN CAST(excluded.min_sqrt AS REAL) < CAST(pool_peaks.min_sqrt AS REAL) THEN excluded.min_block ELSE pool_peaks.min_block END,
      max_sqrt  = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_sqrt ELSE pool_peaks.max_sqrt END,
      max_block = CASE WHEN CAST(excluded.max_sqrt AS REAL) > CAST(pool_peaks.max_sqrt AS REAL) THEN excluded.max_block ELSE pool_peaks.max_block END,
      last_sqrt = excluded.last_sqrt,
      last_block = excluded.last_block,
      swaps     = pool_peaks.swaps + excluded.swaps,
      to_block  = excluded.to_block`);

  let swaps = 0, matched = 0, chunks = 0;
  let from = fromBlock;
  let width = chunk;

  while (from <= toBlock) {
    const to = Math.min(toBlock, from + width - 1);
    let logs: RawLog[];
    try {
      logs = (await withRetry(() => logsClient.request({
        method: "eth_getLogs",
        params: [{
          address: ADDR.v4PoolManager,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: [TOPIC_POOL_SWAP],
        }],
      } as never))) as RawLog[];
    } catch (e) {
      // The endpoint caps a response at 10,000 logs, and pool activity is bursty enough that a width
      // which fit an hour ago can stop fitting. Halving and retrying costs one wasted read.
      if (width > 125) { width = Math.floor(width / 2); continue; }
      throw e;
    }
    chunks++;
    swaps += logs.length;

    // Folded in memory first: one row per pool per chunk instead of one write per swap.
    const agg = new Map<string, { lo: bigint; hi: bigint; loB: number; hiB: number; last: bigint; lastB: number; n: number }>();
    for (const l of logs) {
      const id = l.topics[1];
      if (!id || !known.has(id)) continue;
      let a: Record<string, unknown>;
      try {
        a = decodeEventLog({ abi: swapAbi, topics: l.topics, data: l.data }).args as Record<string, unknown>;
      } catch {
        continue;
      }
      const sqrt = a.sqrtPriceX96 as bigint;
      if (sqrt <= 0n) continue;
      const blk = Number(l.blockNumber);
      const cur = agg.get(id);
      matched++;
      if (!cur) {
        agg.set(id, { lo: sqrt, hi: sqrt, loB: blk, hiB: blk, last: sqrt, lastB: blk, n: 1 });
        continue;
      }
      if (sqrt < cur.lo) { cur.lo = sqrt; cur.loB = blk; }
      if (sqrt > cur.hi) { cur.hi = sqrt; cur.hiB = blk; }
      cur.last = sqrt; cur.lastB = blk; cur.n++;
    }

    if (agg.size) {
      db.exec("BEGIN");
      try {
        for (const [id, v] of agg) {
          upsert.run(id, v.lo.toString(), v.hi.toString(), v.loB, v.hiB, v.last.toString(), v.lastB, v.n, to);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
    from = to + 1;
  }
  return { swaps, matched, chunks };
}

export type PoolCaps = {
  poolId: string;
  openUsd: number | null;
  peakUsd: number | null;
  lastUsd: number | null;
  peakBlock: number | null;
  swaps: number;
};

/** What a token reached in the pool, in dollars, or null when its pool has not been read. */
export function poolCaps(db: DB, token: string, quoteSymbol: string | null): PoolCaps | null {
  const p = db.prepare("SELECT * FROM pools WHERE token = ?").get(token) as PoolRow | undefined;
  if (!p) return null;
  const k = db.prepare("SELECT * FROM pool_peaks WHERE pool_id = ?").get(p.pool_id) as
    | { min_sqrt: string; max_sqrt: string; min_block: number; max_block: number; last_sqrt: string; swaps: number }
    | undefined;

  const cap = (sqrt: string): number | null => marketCapUsd(quotePerToken(sqrt, p), quoteSymbol);
  if (!k) return { poolId: p.pool_id, openUsd: cap(p.init_sqrt), peakUsd: null, lastUsd: null, peakBlock: null, swaps: 0 };

  // The token's price peaks where its own side of the pair is dearest, which is the low end of the
  // ratio when it is currency1 and the high end when it is currency0.
  const peakSqrt = p.token_is_c1 ? k.min_sqrt : k.max_sqrt;
  const peakBlock = p.token_is_c1 ? k.min_block : k.max_block;
  const open = cap(p.init_sqrt);
  const peak = cap(peakSqrt);

  return {
    poolId: p.pool_id,
    openUsd: open,
    // The pool opens at the price the curve ended on, so that opening is itself a candidate peak for
    // a token nobody bought afterwards.
    peakUsd: peak === null ? open : open === null ? peak : Math.max(peak, open),
    lastUsd: cap(k.last_sqrt),
    peakBlock,
    swaps: k.swaps,
  };
}

export { SUPPLY };
