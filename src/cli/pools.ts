import { logsClient, withRetry } from "../chain.ts";
import { getMeta, openDb, setMeta } from "../db.ts";
import { indexPoolSwaps, resolvePool } from "../pool.ts";
import { quoteFromCache } from "../quote.ts";

/**
 * Follows graduated tokens into the pool.
 *
 * Two jobs, in order. First every graduated token that has no pool on record gets one, by finding
 * its `Initialize` and keeping only the pool carrying the pons hook. Then the swap stream is read
 * chain-wide from wherever it left off, which covers every known pool in the same pass.
 *
 * The order matters: a pool discovered after the stream has already passed its blocks would have no
 * history, so resolution runs first and the stream starts no later than the oldest pool it must
 * cover.
 *
 * poolitzer pools [--limit N] [--chunk N] [--max-blocks N]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};

const limit = arg("limit", 400);
const chunk = arg("chunk", 2000);
const maxBlocks = arg("max-blocks", 60_000);

const db = openDb();
const head = Number(await withRetry(() => logsClient.getBlockNumber()));

/* ── 1. give every graduated token its pool ─────────────────────────────────── */

const pending = db.prepare(`
  SELECT l.token, l.block, l.pair_token, l.symbol
  FROM graduations g JOIN launches l USING(token)
  WHERE l.token NOT IN (SELECT token FROM pools)
  ORDER BY l.block DESC LIMIT ?`).all(limit) as
  Array<{ token: string; block: number; pair_token: string; symbol: string | null }>;

console.log(`${(db.prepare("SELECT count(*) c FROM pools").get() as { c: number }).c} pools known; resolving up to ${pending.length} more\n`);

let resolved = 0, missing = 0;
for (const r of pending) {
  const q = quoteFromCache(db, r.pair_token);
  try {
    // A pool is opened within a few minutes of graduating; the window is generous rather than tight
    // so a slow sweep does not read as a missing pool.
    const row = await resolvePool(db, r.token, r.block, Math.min(head, r.block + 40_000), q.decimals);
    if (row) resolved++;
    else missing++;
  } catch {
    missing++;
  }
  if ((resolved + missing) % 25 === 0) {
    process.stdout.write(`\r  ${resolved} resolved, ${missing} without a pons pool  `);
  }
}
console.log(`\r  ${resolved} resolved, ${missing} without a pons pool${" ".repeat(20)}`);

/* ── 2. read the swap stream ────────────────────────────────────────────────── */

const oldest = db.prepare("SELECT min(init_block) b FROM pools").get() as { b: number | null };
if (oldest.b === null) { console.log("\nno pools to follow yet"); db.close(); process.exit(0); }

const saved = Number(getMeta(db, "pool_swaps_to_block") ?? 0);
// Never start later than the oldest pool, or the tokens resolved in this run would begin life
// already past their own history.
const from = saved > 0 ? Math.min(saved + 1, oldest.b) : oldest.b;
const to = Math.min(head, from + maxBlocks - 1);

console.log(`\nreading pool swaps, blocks ${from.toLocaleString()}..${to.toLocaleString()} (head ${head.toLocaleString()}, ${(head - to).toLocaleString()} behind)`);
const t0 = Date.now();
const r = await indexPoolSwaps(db, from, to, chunk);
const secs = (Date.now() - t0) / 1000;

setMeta(db, "pool_swaps_to_block", String(to));
console.log(`  ${r.swaps.toLocaleString()} swaps seen, ${r.matched.toLocaleString()} in tracked pools, ${r.chunks} reads, ${secs.toFixed(1)}s`);
console.log(`  ${(db.prepare("SELECT count(*) c FROM pool_peaks").get() as { c: number }).c} pools now have a recorded peak`);
if (to < head) console.log(`\n  still ${(head - to).toLocaleString()} blocks behind; run again to continue`);

db.close();
