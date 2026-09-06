import { openDb } from "../db.ts";
import { trainFromDb } from "../model/train.ts";
import { FEATURES } from "../features.ts";
import { contributions } from "../model/gbdt.ts";

const argv = process.argv.slice(2);
const i = argv.indexOf("--out");
const out = i >= 0 ? argv[i + 1] : "./data/model.json";

const db = openDb();
const started = Date.now();
const { model, evaluation: e, rows, window } = trainFromDb(db, { modelPath: out });

const pct = (v: number): string => `${(100 * v).toFixed(2)}%`;
console.log(`trained on ${rows} settled launches in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${out}\n`);
console.log("held-out (latest 20% by time)");
console.log(`  rows                  ${e.n}`);
console.log(`  graduated             ${e.positives}  (base rate ${pct(e.baseRate)})`);
console.log(`  PR-AUC                ${e.prAuc.toFixed(4)}   ${e.prAucLift.toFixed(2)}x base`);
console.log(`  ROC-AUC               ${e.rocAuc.toFixed(4)}`);
console.log(`  top decile precision  ${pct(e.topDecilePrecision)}   ${e.topDecileLift.toFixed(2)}x base`);
console.log(`  top 1% precision      ${pct(e.top1pctPrecision)}`);

console.log("\ncalibration (predicted vs actual, by score sextile)");
for (const c of e.calibration) {
  console.log(`  ${c.bucket}  n=${String(c.n).padStart(5)}  predicted ${pct(c.predicted).padStart(7)}  actual ${pct(c.actual).padStart(7)}`);
}

// Which features the model actually leans on, by mean absolute contribution.
const { buildDataset, dropCensored } = await import("../features.ts");
const sample = dropCensored(buildDataset(db), Math.floor(Date.now() / 1000)).slice(-2000);
const imp = new Float64Array(FEATURES.length);
for (const r of sample) {
  const { contribs } = contributions(model, r.x);
  for (let f = 0; f < FEATURES.length; f++) imp[f] += Math.abs(contribs[f]);
}
const ranked = [...FEATURES].map((name, f) => ({ name, v: imp[f] / Math.max(1, sample.length) }))
  .sort((a, b) => b.v - a.v).filter((r) => r.v > 0.0005);
console.log("\nfeature influence (mean |contribution| in logits)");
for (const r of ranked.slice(0, 12)) console.log(`  ${r.name.padEnd(24)} ${r.v.toFixed(4)}`);

db.close();
