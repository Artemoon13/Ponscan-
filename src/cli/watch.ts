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

await runLive(db, {
  onStatus: (m) => console.log(dim(m)),
  onLaunch: async (token) => {
    seen++;
    const row = db.prepare("SELECT tx, symbol, name, ts FROM launches WHERE token = ?").get(token) as
      | { tx: string; symbol: string | null; name: string | null; ts: number } | undefined;
    if (!row) return;
    const launchTs = row.ts;

    // The card needs the launch transaction, so enrich the moment it lands rather than in a batch.
    try { saveLaunchDetail(db, await fetchLaunchDetail(token, row.tx, false)); } catch { /* retried by the nightly pass */ }

    const meta = db.prepare("SELECT symbol, name, exempt_count, initial_buy_eth FROM launches WHERE token = ?").get(token) as
      { symbol: string | null; name: string | null; exempt_count: number | null; initial_buy_eth: number | null };

    const s = model ? scoreOne(db, model, token) : null;
    // Written before the outcome exists, and only while the launch is fresh enough for the claim to
    // mean what this tool says it means. track.record decides that on age alone.
    const logged = s ? record(db, s, launchTs, MODEL_ID) : false;
    const head = s
      ? `${colour(s.probability)}${(100 * s.probability).toFixed(1).padStart(5)}%\x1b[0m  #${String(s.rank).padStart(3)}/${s.of}`
      : dim("   —      ");
    console.log(`${head}  ${bold((meta.symbol || "?").padEnd(10))} ${(meta.name || "").slice(0, 28).padEnd(28)} ${dim(EXPLORER.token(token))}`);
    if (s) for (const r of s.reasons) console.log(dim(`         ${r.direction === "up" ? "+" : "-"} ${r.text}`));
    if (s && !logged) console.log(dim("         (not logged: seen too late for the claim to count)"));
  },
  onGraduation: (token) => {
    const m = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(token) as { symbol: string | null } | undefined;
    console.log(`\x1b[32m  GRADUATED\x1b[0m ${m?.symbol ?? token}  ${dim(EXPLORER.token(token))}`);
  },
});
