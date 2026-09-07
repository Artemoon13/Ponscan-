import { openDb } from "../db.ts";
import { summariseCurve } from "../curve.ts";

/**
 * Folds old curves into summaries and drops their trades.
 *
 * Storing every trade forever is what does not scale here, and it is disk rather than the chain
 * that binds: reading is free and comfortable, while a trade costs about 490 bytes with its
 * indexes, a read curve carries 65 of them, and 26,000 launches happen a day. Keeping every row of
 * every curve would be roughly 830 MB a day.
 *
 * What is dropped is the per-transaction detail of launches nobody is looking at any more. What
 * survives is everything computed from it, stored whole rather than recomputed later, so a card
 * from last month still shows its peak, its buyers, its taxes and its top wallets. Only the links
 * to individual transactions go, and for a launch this old those are the least-read thing on it.
 *
 * Curves are summarised before anything is deleted, and each token is one transaction, so an
 * interrupted run leaves summaries without their trades gone rather than trades gone without a
 * summary.
 *
 * poolitzer compact [--older-than-days N] [--limit N] [--dry-run] [--vacuum]
 */
const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const days = arg("older-than-days", 7);
const hours = arg("older-than-hours", days * 24);
const limit = arg("limit", 20_000);
const dry = argv.includes("--dry-run");
const vacuum = argv.includes("--vacuum");

const db = openDb();
const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;

const targets = db.prepare(`
  SELECT l.token, l.block, l.ts
  FROM curve_indexed c
  JOIN launches l USING(token)
  WHERE l.ts < ?
    AND l.token NOT IN (SELECT token FROM curve_summary)
    AND EXISTS (SELECT 1 FROM curve_trades t WHERE t.token = l.token)
  ORDER BY l.ts LIMIT ?`).all(cutoff, limit) as Array<{ token: string; block: number; ts: number }>;

const rowsBefore = (db.prepare("SELECT count(*) c FROM curve_trades").get() as { c: number }).c;
console.log(`curves read: ${(db.prepare("SELECT count(*) c FROM curve_indexed").get() as { c: number }).c}`);
console.log(`already summarised: ${(db.prepare("SELECT count(*) c FROM curve_summary").get() as { c: number }).c}`);
console.log(`older than ${hours}h and still holding trades: ${targets.length}`);
if (!targets.length) { console.log("\nnothing to compact"); db.close(); process.exit(0); }
if (dry) {
  const n = db.prepare(`
    SELECT count(*) c FROM curve_trades WHERE token IN (SELECT l.token FROM curve_indexed c
    JOIN launches l USING(token) WHERE l.ts < ?)`).get(cutoff) as { c: number };
  console.log(`\ndry run: ${n.c.toLocaleString()} trade rows would be folded and dropped`);
  db.close();
  process.exit(0);
}

const del = db.prepare("DELETE FROM curve_trades WHERE token = ?");
let done = 0, skipped = 0, dropped = 0;
for (const t of targets) {
  // One token per transaction: the summary and the deletion land together or not at all, so an
  // interruption can leave a summary that still has its rows but never rows without a summary.
  db.exec("BEGIN");
  try {
    if (!summariseCurve(db, t.token, t.block)) { db.exec("ROLLBACK"); skipped++; continue; }
    dropped += Number(del.run(t.token).changes);
    db.exec("COMMIT");
    done++;
  } catch (e) {
    db.exec("ROLLBACK");
    skipped++;
  }
  if (done % 500 === 0) process.stdout.write(`\r  ${done} folded, ${dropped.toLocaleString()} rows dropped  `);
}

const rowsAfter = (db.prepare("SELECT count(*) c FROM curve_trades").get() as { c: number }).c;
console.log(`\r  ${done} curves folded, ${skipped} skipped, ${dropped.toLocaleString()} trade rows dropped${" ".repeat(20)}`);
console.log(`  curve_trades: ${rowsBefore.toLocaleString()} -> ${rowsAfter.toLocaleString()}`);
// Deleting rows frees pages inside the file without shrinking the file, so the saving stays
// invisible until the database is rewritten. VACUUM takes an exclusive lock and needs room for a
// second copy, which is why it is asked for rather than assumed: the nightly job wants it, a run
// beside a live board does not.
if (vacuum && dropped) {
  const t = Date.now();
  db.exec("VACUUM");
  console.log(`  vacuumed in ${((Date.now() - t) / 1000).toFixed(1)}s`);
} else if (dropped) {
  console.log(`
Pass --vacuum to hand the freed pages back to the filesystem; SQLite keeps them otherwise.`);
}
db.close();
