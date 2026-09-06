import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCard } from "./card.ts";
import { loadModel, scoreOne, scoreRecent, type FeedOrder } from "./score.ts";
import { openDb } from "./db.ts";
import { CFG } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb();
let model = loadModel();

const json = (res: import("node:http").ServerResponse, body: unknown, code = 200): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${CFG.boardPort}`);

  if (url.pathname === "/") {
    const html = readFileSync(join(here, "ui", "index.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/api/feed") {
    // Reloaded per request so a nightly retrain is picked up without restarting the board.
    model = loadModel();
    const hours = Number(url.searchParams.get("hours") ?? 6);
    const order: FeedOrder = url.searchParams.get("sort") === "new" ? "new" : "score";
    const rows = model ? scoreRecent(db, model, hours, 150, order) : [];
    const meta = db.prepare(`
      SELECT token, symbol, name, ts, exempt_count, initial_buy_eth, phase,
             (token IN (SELECT token FROM graduations)) AS graduated
      FROM launches WHERE ts >= ?`).all(Math.floor(Date.now() / 1000) - hours * 3600) as Array<Record<string, unknown>>;
    const byToken = new Map(meta.map((m) => [m.token as string, m]));

    json(res, {
      hasModel: model !== null,
      order,
      // The feed is capped, and a list that silently hides two thousand launches reads as if it
      // were the whole window. The UI says so out loud, so this has to come back with it.
      shown: rows.length,
      inWindow: rows.length ? rows[0].of : 0,
      counts: db.prepare(`
        SELECT (SELECT count(*) FROM launches) launches,
               (SELECT count(*) FROM graduations) graduations,
               (SELECT count(*) FROM launches WHERE enriched_at IS NOT NULL) enriched`).get(),
      items: rows.map((r) => ({ ...r, meta: byToken.get(r.token) ?? null })),
    });
    return;
  }

  if (url.pathname.startsWith("/api/token/")) {
    const token = url.pathname.slice("/api/token/".length).toLowerCase();
    const card = buildCard(db, token);
    if (!card) { json(res, { error: "unknown token" }, 404); return; }
    json(res, { card, score: model ? scoreOne(db, model, token) : null });
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(CFG.boardPort, () => {
  console.log(`ponscan board on http://localhost:${CFG.boardPort}`);
  if (!model) console.log("no model yet — run: npm run train");
});
