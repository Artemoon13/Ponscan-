import { openDb } from "../db.ts";
import { fetchLaunchDetail, saveLaunchDetail } from "../enrich.ts";
import { runLive } from "../live.ts";
import { loadModel, scoreOne } from "../score.ts";
import { EXPLORER } from "../config.ts";

const db = openDb();
const model = loadModel();
if (!model) console.log("no model at ./data/model.json — showing launches without a score (run: npm run train)\n");

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const colour = (p: number): string => (p >= 0.06 ? "\x1b[32m" : p >= 0.03 ? "\x1b[33m" : "\x1b[2m");

let seen = 0;

await runLive(db, {
  onStatus: (m) => console.log(dim(m)),
  onLaunch: async (token) => {
    seen++;
    const row = db.prepare("SELECT tx, symbol, name FROM launches WHERE token = ?").get(token) as
      | { tx: string; symbol: string | null; name: string | null } | undefined;
    if (!row) return;

    // The card needs the launch transaction, so enrich the moment it lands rather than in a batch.
    try { saveLaunchDetail(db, await fetchLaunchDetail(token, row.tx, false)); } catch { /* retried by the nightly pass */ }

    const meta = db.prepare("SELECT symbol, name, exempt_count, initial_buy_eth FROM launches WHERE token = ?").get(token) as
      { symbol: string | null; name: string | null; exempt_count: number | null; initial_buy_eth: number | null };

    const s = model ? scoreOne(db, model, token) : null;
    const head = s
      ? `${colour(s.probability)}${(100 * s.probability).toFixed(1).padStart(5)}%\x1b[0m  #${String(s.rank).padStart(3)}/${s.of}`
      : dim("   —      ");
    console.log(`${head}  ${bold((meta.symbol || "?").padEnd(10))} ${(meta.name || "").slice(0, 28).padEnd(28)} ${dim(EXPLORER.token(token))}`);
    if (s) for (const r of s.reasons) console.log(dim(`         ${r.direction === "up" ? "+" : "-"} ${r.text}`));
  },
  onGraduation: (token) => {
    const m = db.prepare("SELECT symbol FROM launches WHERE token = ?").get(token) as { symbol: string | null } | undefined;
    console.log(`\x1b[32m  GRADUATED\x1b[0m ${m?.symbol ?? token}  ${dim(EXPLORER.token(token))}`);
  },
});
