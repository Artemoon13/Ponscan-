import { decodeEventLog, decodeFunctionData } from "viem";
import { curveAbi, routerAbi, TOPIC } from "./abi.ts";
import { ADDR } from "./config.ts";
import { stateClient, withRetry } from "./chain.ts";
import { toEth, type DB } from "./db.ts";
import { normaliseName } from "./features.ts";

/**
 * Facts that only the launch transaction holds.
 *
 * The `TokenLaunched` event's `deployer` is whoever called the factory, which is frequently a
 * batching contract: Multicall3 alone accounts for the single largest "deployer" in a day. The
 * human behind a launch is the transaction sender, so the card reads `tx.from` and treats the
 * event's deployer as the calling contract.
 */
export type LaunchDetail = {
  token: string;
  sender: string;
  routedThroughRouter: boolean;
  name?: string;
  symbol?: string;
  description?: string;
  socials?: Record<string, string>;
  creatorFeeRecipient?: string;
  creatorTaxBps?: number;
  buybackEnabled?: boolean;
  initialBuyWei?: bigint;
  exemptions: string[];
  coBuyers: Array<{ recipient: string; quoteWei: bigint; taxWei: bigint }>;
};

export async function fetchLaunchDetail(token: string, txHash: string, deep = true): Promise<LaunchDetail> {
  // Both reads go to the state endpoint on purpose. Only the other endpoint serves eth_getLogs, and
  // an enrichment pass is tens of thousands of calls: sharing it starves the live watcher into 429s
  // and loses launches. publicnode serves transactions and receipts happily, and about three times
  // faster besides.
  const tx = await withRetry(() => stateClient.getTransaction({ hash: txHash as `0x${string}` }));
  const detail: LaunchDetail = {
    token: token.toLowerCase(),
    sender: tx.from.toLowerCase(),
    routedThroughRouter: (tx.to ?? "").toLowerCase() === ADDR.router.toLowerCase(),
    exemptions: [],
    coBuyers: [],
  };

  // Launches that go through the router carry the creator's declared intent in the calldata.
  // Launches that do not (batched through another contract) still give us the sender and the logs.
  try {
    const d = decodeFunctionData({ abi: routerAbi, data: tx.input });
    if (d.functionName === "launchAndBuy") {
      const [params, , , quoteIn, , , exemptions] = d.args as [
        { name: string; symbol: string; description: string; socials: Record<string, string>;
          creatorFeeRecipient: string; creatorTaxBps: number; buybackEnabled: boolean },
        bigint, string, bigint, bigint, string, readonly string[],
      ];
      detail.name = params.name;
      detail.symbol = params.symbol;
      detail.description = params.description;
      detail.socials = { ...params.socials };
      detail.creatorFeeRecipient = params.creatorFeeRecipient.toLowerCase();
      detail.creatorTaxBps = Number(params.creatorTaxBps);
      detail.buybackEnabled = Boolean(params.buybackEnabled);
      detail.initialBuyWei = quoteIn;
      detail.exemptions = exemptions.map((a) => a.toLowerCase());
    }
  } catch {
    // Not a router call we can decode; the sender and log-derived facts still stand.
  }

  if (deep) {
    const rc = await withRetry(() => stateClient.getTransactionReceipt({ hash: txHash as `0x${string}` }));
    for (const log of rc.logs) {
      if (log.topics[0] !== TOPIC.curveBuy) continue;
      try {
        const e = decodeEventLog({ abi: curveAbi, topics: log.topics, data: log.data });
        const a = e.args as { recipient: string; quoteIn: bigint; tax: bigint };
        detail.coBuyers.push({ recipient: a.recipient.toLowerCase(), quoteWei: a.quoteIn, taxWei: a.tax });
      } catch { /* not a curve buy we model */ }
    }
  }
  return detail;
}

export function saveLaunchDetail(db: DB, d: LaunchDetail): void {
  db.exec("BEGIN");
  try {
    db.prepare(`
      UPDATE launches SET
        launch_sender = ?, creator_fee_recipient = ?, creator_tax_bps = ?, buyback_enabled = ?,
        initial_buy_wei = ?, initial_buy_eth = ?, exempt_count = ?, name = ?, symbol = ?,
        symbol_key = ?, description = ?, socials_json = ?, enriched_at = ?
      WHERE token = ?`).run(
      d.sender,
      d.creatorFeeRecipient ?? null,
      d.creatorTaxBps ?? null,
      d.buybackEnabled === undefined ? null : d.buybackEnabled ? 1 : 0,
      d.initialBuyWei?.toString() ?? null,
      d.initialBuyWei === undefined ? null : toEth(d.initialBuyWei),
      d.exemptions.length,
      d.name ?? null,
      d.symbol ?? null,
      d.symbol ? normaliseName(d.symbol) || null : null,
      d.description ?? null,
      d.socials ? JSON.stringify(d.socials) : null,
      Math.floor(Date.now() / 1000),
      d.token,
    );
    const insEx = db.prepare("INSERT INTO exemptions(token,address) VALUES(?,?) ON CONFLICT DO NOTHING");
    for (const a of d.exemptions) insEx.run(d.token, a);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Enriches launches that have no detail yet, newest first. */
export async function enrichPending(
  db: DB, limit: number, deep = true, onEach?: (done: number, total: number) => void,
): Promise<number> {
  const rows = db.prepare(
    "SELECT token, tx FROM launches WHERE enriched_at IS NULL ORDER BY block DESC LIMIT ?",
  ).all(limit) as Array<{ token: string; tx: string }>;

  let done = 0;
  const workers = 4;
  const queue = [...rows];
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        try {
          saveLaunchDetail(db, await fetchLaunchDetail(row.token, row.tx, deep));
        } catch {
          // Leave enriched_at null so a later pass retries this launch.
        }
        onEach?.(++done, rows.length);
      }
    }),
  );
  return done;
}
