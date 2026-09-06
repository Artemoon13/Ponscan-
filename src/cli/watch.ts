import { openDb } from "../db.ts";
import { fetchLaunchDetail, saveLaunchDetail } from "../enrich.ts";
import { runLive } from "../live.ts";
import { loadModel, scoreOne } from "../score.ts";
import { EXPLORER } from "../config.ts";
import { grade, modelId, record } from "../track.ts";

const db = openDb();
const model = loadModel();
const MODEL_ID = modelId();
if (!model) console.log("no model at ./data/model.json — showing launches without a score (run: npm run train)\n");
else console.log(dimEarly(`model ${MODEL_ID} — every score shown is logged before its outcome exists (npm run scoreboard)\n`));

// Claims settle four hours out, so a watcher left running grades its own backlog as it goes.
setInterval(() => { try { grade(db); } catch { /* a locked write retries on the next tick */ } }, 60_000).unref();

function dimEarly(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const colour = (p: number): string => (p >= 0.06 ? "\x1b[32m" : p >= 0.03 ? "\x1b[33m" : "\x1b[2m");

let seen = 0;

/**
 * Launches are handled in batches, and the reason is not throughput.
 *
 * Scoring one launch needs the feature matrix, and a launch this new is by definition not in it, so
 * a per-launch score rebuilds the whole matrix — five seconds each, against roughly seventeen
 * arrivals a minute. The watcher falls behind, every launch reaches the log already older than the
 * age cut, and the prediction log silently stays empty. The symptom is a slow feed; the real damage
 * is losing the only number that is written before its outcome.
 *
 * Enriching the batch first and scoring it after means one rebuild for the whole batch, and it also
 * lets onLaunch return immediately so the ingest cursor keeps advancing while this work happens.
 */
const BATCH_MS = 3000;
const queue: string[] = [];
let draining = false;

async function drain(): Promise<void> {
  if (draining || queue.length === 0) return;
  draining = true;
  const batch = queue.splice(0, queue.length);

  try {
    const rows = batch
      .map((token) => db.prepare("SELECT token, tx, ts FROM launches WHERE token = ?").get(token) as
        { token: string; tx: string; ts: number } | undefined)
      .filter((r): r is { token: string; tx: string; ts: number } => r !== undefined);

    // The card needs the launch transaction, so enrich before scoring rather than on a later pass.
    await Promise.all(rows.map(async (r) => {
      try { saveLaunchDetail(db, await fetchLaunchDetail(r.token, r.tx, false)); }
      catch { /* left for the nightly pass to retry */ }
    }));

    for (const r of rows) {
      const meta = db.prepare("SELECT symbol, name FROM launches WHERE token = ?").get(r.token) as
        { symbol: string | null; name: string | null };
      const s = model ? scoreOne(db, model, r.token) : null;
      // Written before the outcome exists, and only while the launch is fresh enough for the claim
      // to mean what this tool says it means. track.record decides that on age alone.
      const logged = s ? record(db, s, r.ts, MODEL_ID) : false;
      const head = s
        ? `${colour(s.probability)}${(100 * s.probability).toFixed(1).padStart(5)}%\x1b[0m  #${String(s.rank).padStart(4)}/${s.of}`
        : dim("   —       ");
      console.log(`${head}  ${bold((meta.symbol || "?").padEnd(10))} ${(meta.name || "").slice(0, 28).padEnd(28)} ${dim(EXPLORER.token(r.token))}`);
      if (s) for (const x of s.reasons) console.log(dim(`         ${x.direction === "up" ? "+" : "-"} ${x.text}`));
      if (s && !logged) console.log(dim("         (not logged: seen too late for the claim to count)"));
    }
  } finally {
    draining = false;
  }
}

setInterval(() => { void drain(); }, BATCH_MS).unref();

await runLive(db, {
  onStatus: (m) => console.log(dim(m)),
  onLaunch: (token) => {
    seen++;
    queue.push(token);
  },
  onGraduation: (token) => {
    const m = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(token) as { symbol: string | null } | undefined;
    console.log(`\x1b[32m  GRADUATED\x1b[0m ${m?.symbol ?? token}  ${dim(EXPLORER.token(token))}`);
  },
});
