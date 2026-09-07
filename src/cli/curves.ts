import { logsClient, withRetry } from "../chain.ts";
import { openDb } from "../db.ts";
import { indexCurve } from "../curve.ts";

/**
 * Reads curve trades in bulk, so the peak a launch reached exists for more than the few tokens
 * somebody happened to open.
 *
 * A card indexes one curve on demand, which is right for browsing and useless for training: a model
 * that predicts a peak needs thousands of settled examples. This is the same read, run over a window
 * of launches, newest first.
 *
 * Only settled launches are worth reading. A curve from ten minutes ago has not finished doing
 * whatever it will do, and its peak so far is not the peak — recording that as the answer would
 * teach a model that recent launches peak low.
 *
 * poolitzer curves [--limit N] [--min-age-hours N] [--max-age-hours N]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};

const limit = arg("limit", 3000);
const minAge = arg("min-age-hours", 4);
const maxAge = arg("max-age-hours", 168);

const db = openDb();
const now = Math.floor(Date.now() / 1000);

const rows = db.prepare(`
  SELECT token, curve, block FROM launches
  WHERE ts <= ? AND ts >= ? AND token NOT IN (SELECT token FROM curve_indexed)
  ORDER BY ts DESC LIMIT ?`).all(now - minAge * 3600, now - maxAge * 3600, limit) as
  Array<{ token: string; curve: string; block: number }>;

const already = (db.prepare("SELECT count(*) c FROM curve_indexed").get() as { c: number }).c;
console.log(`${already} curves already read; reading ${rows.length} more`);
console.log(`window: launches between ${minAge}h and ${maxAge}h old, so each has had time to settle\n`);
if (!rows.length) { db.close(); process.exit(0); }

const head = Number(await withRetry(() => logsClient.getBlockNumber()));
const started = Date.now();
let done = 0, trades = 0, failed = 0, last = 0;

// Four at a time: the endpoint's own limiter is the ceiling, and this is a background job that must
// not starve the watcher or the board sharing it.
const queue = [...rows];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (;;) {
    const r = queue.shift();
    if (!r) return;
    try {
      const c = await indexCurve(db, r.token, r.curve, r.block, Math.min(head, r.block + 900_000));
      trades += c.buys + c.sells;
    } catch { failed++; }
    done++;
    if (Date.now() - last > 4000) {
      last = Date.now();
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(`\r  ${done}/${rows.length}  ${rate.toFixed(1)}/s  ${trades.toLocaleString()} trades  eta ${((rows.length - done) / Math.max(rate, .1) / 60).toFixed(1)}min  (${failed} failed)   `);
    }
  }
}));

console.log(`\n\ndone: ${done} curves, ${trades.toLocaleString()} trades, ${failed} failed, ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
const withPeak = (db.prepare(`
  SELECT count(*) c FROM (SELECT token FROM curve_trades WHERE side='buy' GROUP BY token HAVING count(*) >= 2)`,
).get() as { c: number }).c;
console.log(`tokens with a computable peak: ${withPeak.toLocaleString()}`);
db.close();
