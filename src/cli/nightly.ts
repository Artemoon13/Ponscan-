import { spawnSync } from "node:child_process";

/**
 * The scheduled job: catch up on history, fill in the launch transactions, refit.
 *
 * Order matters. Enriching before backfilling would skip launches that are not in the database yet,
 * and training before enriching would fit on a window that is only partly covered.
 */
const steps: Array<[string, string[]]> = [
  ["backfill", ["--hours", "26"]],
  ["enrich-window", ["--hours", "20", "--workers", "6"]],
  ["train", []],
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
