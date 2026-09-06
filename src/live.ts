import type { Log } from "viem";
import { TOPIC } from "./abi.ts";
import { ADDR, CFG } from "./config.ts";
import { logsClient, sleep, stateClient, withRetry, wsClient } from "./chain.ts";
import { getMeta, setMeta, type DB } from "./db.ts";
import { writeFactoryLogs } from "./ingest.ts";

type RawLog = Log & { topics: [`0x${string}`, ...`0x${string}`[]]; data: `0x${string}` };

const FACTORY_TOPICS = [
  [TOPIC.tokenLaunched, TOPIC.poolGraduated, TOPIC.launchSwept, TOPIC.creatorFeeRecipientUpdated],
];

export type LiveEvents = {
  onLaunch?: (token: string, block: number) => void | Promise<void>;
  onGraduation?: (token: string, block: number) => void | Promise<void>;
  onStatus?: (msg: string) => void;
};

/**
 * Follows the factory in real time.
 *
 * Half of all graduations happen within two minutes of launch, so a launch seen late is a launch not
 * worth seeing. Detection uses a websocket push where one is available; the official RPC has none,
 * so publicnode carries the subscription while the official endpoint serves the log reads.
 *
 * Every path funnels through the same catch-up read rather than trusting the socket to be complete:
 * a dropped connection, a missed notification or a restart all recover by pulling the gap between
 * the last stored block and the head. Writes are upserts, so re-reading a block is harmless.
 */
export async function runLive(db: DB, ev: LiveEvents = {}): Promise<void> {
  const status = ev.onStatus ?? ((m: string) => console.log(m));
  /**
   * Head polling goes to the state endpoint. It is the more generous of the two, and the log
   * endpoint's budget is better spent on the reads only it can serve; sharing it with a heartbeat
   * is how a concurrent enrichment run starves the watcher into a 429.
   */
  const head = async (): Promise<number> => {
    try {
      return Number(await withRetry(() => stateClient.getBlockNumber()));
    } catch {
      return Number(await withRetry(() => logsClient.getBlockNumber()));
    }
  };

  let cursor = Number(getMeta(db, "live_cursor_block") ?? 0);
  if (!cursor) cursor = Number(getMeta(db, "backfill_to_block") ?? 0) || (await head());
  let busy = false;

  const catchUp = async (head: number): Promise<void> => {
    if (busy || head <= cursor) return;
    busy = true;
    try {
      // A restart after a long pause must not ask for a million blocks in one call.
      const from = Math.max(cursor + 1, head - 200_000);
      if (from > cursor + 1) status(`  skipping ${from - cursor - 1} blocks: gap too wide, run backfill to fill it`);

      const logs = (await withRetry(() =>
        logsClient.request({
          method: "eth_getLogs",
          params: [{ address: ADDR.factory, topics: FACTORY_TOPICS, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${head.toString(16)}` }],
        } as never),
      )) as RawLog[];

      if (logs.length) {
        const tsOf = new Map<number, number>();
        const now = Math.floor(Date.now() / 1000);
        for (const l of logs) tsOf.set(Number(BigInt(l.blockNumber as string)), now);
        writeFactoryLogs(db, logs, tsOf);

        for (const l of logs) {
          const token = `0x${l.topics[1].slice(26)}`.toLowerCase();
          const block = Number(BigInt(l.blockNumber as string));
          if (l.topics[0] === TOPIC.tokenLaunched) await ev.onLaunch?.(token, block);
          else if (l.topics[0] === TOPIC.poolGraduated) await ev.onGraduation?.(token, block);
        }
      }
      cursor = head;
      setMeta(db, "live_cursor_block", String(cursor));
    } catch (err) {
      status(`  catch-up failed, will retry: ${(err as Error).message.slice(0, 80)}`);
    } finally {
      busy = false;
    }
  };

  if (wsClient) {
    status(`watching ${CFG.wsUrl} (push), reading logs from ${CFG.httpUrl}`);
    wsClient.watchBlockNumber({
      emitOnBegin: true,
      onBlockNumber: (bn) => { void catchUp(Number(bn)); },
      onError: (e) => status(`  websocket error: ${e.message.slice(0, 80)}`),
    });
    // The socket can go quiet without erroring; this floor guarantees progress regardless.
    // A failed heartbeat is logged and slept off: the watcher is meant to run for days, so a public
    // endpoint having a bad minute must never end the process.
    for (;;) {
      await sleep(5000);
      try {
        await catchUp(await head());
      } catch (err) {
        status(`  head poll failed, retrying: ${(err as Error).message.slice(0, 80)}`);
        await sleep(5000);
      }
    }
  }

  status(`websocket disabled, polling every ${CFG.pollMs}ms`);
  for (;;) {
    try {
      await catchUp(await head());
    } catch (err) {
      status(`  head poll failed, retrying: ${(err as Error).message.slice(0, 80)}`);
      await sleep(2000);
    }
    await sleep(CFG.pollMs);
  }
}
