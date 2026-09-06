import { parseAbi } from "viem";
import { stateClient, withRetry } from "./chain.ts";
import type { DB } from "./db.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const erc20 = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export type QuoteAsset = { address: string; symbol: string; decimals: number };

/**
 * Decimals for a launch's quote asset.
 *
 * Around half of pons launches are quoted in a token rather than ETH, and those tokens do not all
 * use 18 decimals. Formatting their amounts as if they did turns a real threshold into "0.0000",
 * which is worse than showing nothing: the card would be quietly lying about the number a trader is
 * checking. Results are cached because the set of quote assets is small and changes rarely.
 */
export async function resolveQuote(db: DB, address: string): Promise<QuoteAsset> {
  const a = address.toLowerCase();
  if (a === ZERO) return { address: a, symbol: "ETH", decimals: 18 };

  const hit = db.prepare("SELECT address, symbol, decimals FROM quote_assets WHERE address = ?").get(a) as
    | QuoteAsset | undefined;
  if (hit) return hit;

  let symbol = "?";
  let decimals = 18;
  try {
    const [s, d] = await Promise.all([
      withRetry(() => stateClient.readContract({ address: a as `0x${string}`, abi: erc20, functionName: "symbol" })),
      withRetry(() => stateClient.readContract({ address: a as `0x${string}`, abi: erc20, functionName: "decimals" })),
    ]);
    symbol = String(s).slice(0, 32);
    decimals = Number(d);
  } catch {
    // An unreadable quote token stays at 18 decimals, but the card marks the amount as unverified.
  }
  db.prepare("INSERT INTO quote_assets(address,symbol,decimals) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET symbol=excluded.symbol, decimals=excluded.decimals")
    .run(a, symbol, decimals);
  return { address: a, symbol, decimals };
}

export function quoteFromCache(db: DB, address: string): QuoteAsset {
  const a = address.toLowerCase();
  if (a === ZERO) return { address: a, symbol: "ETH", decimals: 18 };
  const hit = db.prepare("SELECT address, symbol, decimals FROM quote_assets WHERE address = ?").get(a) as
    | QuoteAsset | undefined;
  return hit ?? { address: a, symbol: "?", decimals: 18 };
}

/** Exact wei-to-decimal formatting; no float rounding on the number a trader is checking. */
export function formatUnits(wei: bigint, decimals: number, places = 4): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Fills the cache for every quote asset seen in the database. */
export async function backfillQuoteAssets(db: DB): Promise<number> {
  const rows = db.prepare(
    "SELECT DISTINCT pair_token a FROM launches WHERE pair_token NOT IN (SELECT address FROM quote_assets)",
  ).all() as Array<{ a: string }>;
  for (const r of rows) await resolveQuote(db, r.a);
  return rows.length;
}
