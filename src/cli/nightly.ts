import { spawnSync } from "node:child_process";

/**
 * The scheduled job: catch up on history, fill in the launch transactions, refit.
 *
 * Order matters. Enriching before backfilling would skip launches that are not in the database yet,
 * and training before enriching would fit on a window that is only partly covered. Curves come
 * last before training because the peak model is fitted on them: it needs launches that have both
 * settled and been read, and reading is the step that lags. Its limit is deliberate rather than
 * unbounded, since the read is rate-limited at roughly 1.7 curves a second, which puts four
 * thousand of them at about forty minutes.
 *
 * `pools` follows the graduated ones past the curve. It is cheap next to the rest: the swap read is
 * chain-wide against Uniswap v4's singleton, so one pass covers every graduated token at once at
 * roughly 430 reads a day, against the curve indexer's 1.7 a second.
 */
const steps: Array<[string, string[]]> = [
  ["backfill", ["--hours", "26"]],
  ["enrich-window", ["--hours", "20", "--workers", "6"]],
  ["curves", ["--limit", "4000", "--min-age-hours", "4", "--max-age-hours", "168"]],
  ["pools", ["--max-blocks", "900000"]],
  // Before the retrain, so the fit is stamped with the model that actually produced the claims. The
  // model trained a minute later inherits it, which is the whole point: it faces the same market.
  ["recalibrate", []],
  ["train", []],
  // Housekeeping last, once the night's reading is in. Folding a curve costs its per-transaction
  // detail and nothing else: checked across every curve in the database, the summary reports the
  // same target its trades did and rebuilds the same cards.
  ["compact", ["--older-than-days", "2", "--vacuum"]],
];

for (const [script, args] of steps) {
  console.log(`\n=== ${script} ${args.join(" ")} ===`);
  const r = spawnSync("npm", ["run", "--silent", script, "--", ...args], { stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`${script} failed with code ${r.status}; stopping so a bad step does not feed the next one`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nnightly complete");
