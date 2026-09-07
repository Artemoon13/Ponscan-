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

/* ── the second model: how high a launch climbs ── */
const { buildAthDataset, fitAthModel } = await import("../model/ath.ts");
const { writeFileSync: writeAth } = await import("node:fs");
const athRows = buildAthDataset(db);
console.log(`
how high it climbs — a second model, on ${athRows.length} settled launches with a readable curve`);
if (athRows.length < 300) {
  console.log(`  not enough yet. Curve trades are read per token; run: npm run curves`);
} else {
  const fitted = fitAthModel(athRows);
  if (!fitted) console.log("  not enough yet.");
  else {
    writeAth("./data/model-ath.json", JSON.stringify({
      model: fitted.model, lo: fitted.lo, hi: fitted.hi, coverage: fitted.coverage,
      trainedOn: fitted.trainedOn, spearman: fitted.spearman, topDecileLift: fitted.topDecileLift,
      at: Math.floor(Date.now() / 1000),
    }));
    console.log(`  fitted on ${fitted.trainedOn} launches -> ./data/model-ath.json`);
    console.log(`  ranks:  Spearman ${fitted.spearman.toFixed(3)} · top decile peaks ${fitted.topDecileLift.toFixed(2)}x the median`);
    console.log(`  sizes:  80% band covers ${(100 * fitted.coverage).toFixed(0)}% of unseen launches`);
    console.log(`  the band is the output; the point estimate on its own is barely better than a constant.`);
  }
}

db.close();
