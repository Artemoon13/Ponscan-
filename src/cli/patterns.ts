import { openDb } from "../db.ts";
import { coveredHours } from "../backtest.ts";
import { earlyFeatures, outcomes, type Early } from "../early.ts";
import {
  candidates, confirm, membership, permutationNull, search, show, TARGETS,
} from "../patterns.ts";

/**
 * Looks for a shape in the opening seconds after which launches run.
 *
 * gimlet patterns [--at 30] [--target x5] [--min-support 40] [--runs 100] [--coverage 0.98]
 *
 * `--at` is how many seconds of trading the pattern is allowed to see; `--target` what it is trying
 * to predict — `x3`, `x5`, `x10` for peaks, `grad` for graduation.
 *
 * The output has three columns for a reason. `found-on` is what a pattern did on the launches that
 * proposed it and is worth nothing on its own. `held-out` is what it did on later launches it never
 * saw. `noise` is the best lift the same search finds after the outcomes are shuffled — the score to
 * beat, because a search this wide always finds something.
 */
const argv = process.argv.slice(2);
const arg = <T>(n: string, d: T): T | string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const num = (n: string, d: number): number => Number(arg(n, d));

const atSec = num("at", 30);
const minSupport = num("min-support", 40);
const runs = num("runs", 100);
const coverage = num("coverage", 0.98);
const settleSec = num("settle-hours", 4) * 3600;
const targetKey = String(arg("target", "x5"));
const target = TARGETS[targetKey];
if (!target) {
  console.error(`unknown --target ${targetKey}; try one of ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}

const db = openDb();
const hours = new Set(coveredHours(db, coverage));
if (!hours.size) {
  console.error(`No hour has >=${(coverage * 100).toFixed(0)}% curve coverage — run \`npm run curves\` first.`);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const out = outcomes(db, atSec);
// peakAfter === 0 means the curve never printed after the observation window, so there is no forward
// move to measure. Counting those as "went nowhere" would pad the sample with launches whose answer
// is unknown rather than negative.
const eligible = new Set(
  [...out.values()]
    .filter((o) => hours.has(Math.floor(o.ts / 3600)) && o.ts <= now - settleSec && o.peakAfter > 0)
    .map((o) => o.token),
);

const early = earlyFeatures(db, atSec, eligible);
const rows: Early[] = [];
const ts: number[] = [];
for (const [token, e] of early) {
  const o = out.get(token);
  if (!o) continue;
  rows.push(e);
  ts.push(o.ts);
}

const pct = (v: number): string => `${(100 * v).toFixed(1)}%`;
console.log("\ngimlet patterns — what the opening seconds are worth\n");
console.log(`window     ${hours.size} covered hours, ${rows.length.toLocaleString()} launches with a price path`);
console.log(`sees       the first ${atSec}s of trading, and nothing after it`);
console.log(`measures   the peak reached AFTER those ${atSec}s, over the price at the end of them`);
console.log(`predicts   ${target.label}`);

if (rows.length < 4 * minSupport) {
  console.error(`\nOnly ${rows.length} launches — too few to search. Widen coverage with \`npm run curves\`.`);
  process.exit(1);
}

// Older launches propose; newer launches judge. Split on time rather than at random, because launch
// tactics drift and a random split lets a pattern learn the same hour it is tested on.
const order = rows.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
const cut = Math.floor(order.length / 2);
const discover = order.slice(0, cut).map((i) => rows[i]);
const holdout = order.slice(cut).map((i) => rows[i]);
const label = (set: Early[]): Float64Array =>
  Float64Array.from(set.map((e) => target.of(out.get(e.token) as never)));
const yDiscover = label(discover);
const yHoldout = label(holdout);

console.log(`split      ${discover.length.toLocaleString()} launches propose, ${holdout.length.toLocaleString()} later ones judge`);

const conds = candidates(discover);
const members = membership(discover, conds);
const found = search(discover, yDiscover, conds, members, minSupport);
const baseHold = yHoldout.reduce((s, v) => s + v, 0) / Math.max(1, yHoldout.length);

console.log(`base rate  ${pct(found.baseRate)} of proposing launches ${target.label}, ${pct(baseHold)} of judging ones`);
console.log(`tested     ${found.tested} conditions at a floor of ${minSupport} launches each`);

const noise = permutationNull(discover, yDiscover, conds, members, minSupport, runs);
console.log(`noise      the same search on shuffled outcomes finds ${noise.p95.toFixed(2)}x lift at the 95th percentile (${runs} shuffles, worst ${noise.max.toFixed(2)}x)`);

console.log("\npattern                                                        found-on   held-out");
console.log("                                                             n   lift      n   lift");
let survived = 0;
for (const v of found.verdicts.slice(0, 12)) {
  const c = confirm(v.pattern, holdout, yHoldout);
  const beatsNoise = v.lift > noise.p95;
  const holds = c.n >= minSupport / 2 && c.lift > 1.15;
  if (beatsNoise && holds) survived++;
  const mark = beatsNoise && holds ? " ok" : beatsNoise ? " --" : "  .";
  console.log(
    show(v.pattern).slice(0, 56).padEnd(57) +
    String(v.n).padStart(5) + `${v.lift.toFixed(2)}x`.padStart(7) +
    String(c.n).padStart(7) + `${c.lift.toFixed(2)}x`.padStart(7) + mark,
  );
}

console.log(
  "\n  ok = beat the noise line on the half that proposed it AND held up on the half that did not.\n" +
  "  -- = beat the noise line and then did not survive the held-out half.\n" +
  "   . = did not even beat what the same search finds on shuffled outcomes.",
);

if (!survived) {
  console.log(
    `\nNothing survived. That is a result: at ${atSec}s and this sample size, the opening seconds\n` +
    "do not carry a shape worth acting on, and every candidate above is what a wide search\n" +
    "returns from noise. Try a different --at, a different --target, or more coverage.",
  );
} else {
  console.log(`\n${survived} of the top 12 survived both tests.`);
}

db.close();
