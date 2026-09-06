import { logsClient, withRetry } from "./chain.ts";

/**
 * Wall-clock time for a block, without one eth_getBlockByNumber per log.
 *
 * At ~28,000 launches a day a timestamp-per-block backfill would be tens of thousands of extra
 * round trips against a rate-limited endpoint. Blocks here are sequencer-produced every ~0.1009 s,
 * so timestamps are close to linear in block number: this samples real anchors and interpolates
 * between them, refining an interval when a lookup lands in a gap wider than `maxGap`.
 *
 * Displayed times are therefore approximate to within a few seconds. Anything that must be exact
 * (feature windows, ordering, "who bought in the same block") uses block numbers, which are exact.
 */
export class BlockClock {
  #anchors = new Map<number, number>();
  #sorted: number[] = [];
  #maxGap: number;

  constructor(maxGap = 20_000) {
    this.#maxGap = maxGap;
  }

  async #fetch(block: number): Promise<number> {
    const b = (await withRetry(() =>
      logsClient.request({ method: "eth_getBlockByNumber", params: [`0x${block.toString(16)}`, false] } as never),
    )) as { timestamp: `0x${string}` } | null;
    if (!b) throw new Error(`block ${block} not found`);
    const ts = Number(BigInt(b.timestamp));
    this.#anchors.set(block, ts);
    this.#sorted = [...this.#anchors.keys()].sort((x, y) => x - y);
    return ts;
  }

  /** Pre-seeds anchors across a range so a backfill interpolates instead of fetching mid-loop. */
  async seed(from: number, to: number): Promise<void> {
    const step = Math.max(this.#maxGap, Math.ceil((to - from) / 64));
    const points = new Set<number>([from, to]);
    for (let b = from; b < to; b += step) points.add(b);
    for (const b of [...points].sort((x, y) => x - y)) {
      if (!this.#anchors.has(b)) await this.#fetch(b);
    }
  }

  async at(block: number): Promise<number> {
    const exact = this.#anchors.get(block);
    if (exact !== undefined) return exact;
    if (this.#sorted.length < 2) await this.#fetch(block);

    let lo = -1;
    let hi = -1;
    for (const b of this.#sorted) {
      if (b <= block) lo = b;
      else { hi = b; break; }
    }
    if (lo === -1 || hi === -1 || hi - lo > this.#maxGap) return this.#fetch(block);

    const tLo = this.#anchors.get(lo) as number;
    const tHi = this.#anchors.get(hi) as number;
    return Math.round(tLo + ((tHi - tLo) * (block - lo)) / (hi - lo));
  }

  /** A block number for a wall-clock instant, using the same anchors in reverse. */
  approxBlockAt(ts: number, latestBlock: number, latestTs: number): number {
    return Math.max(0, Math.round(latestBlock - (latestTs - ts) / 0.1009));
  }
}
