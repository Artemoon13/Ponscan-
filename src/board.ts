import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCard } from "./card.ts";
import { datasetAgeSec, loadModel, scoreOne, scoreRecent, type FeedOrder } from "./score.ts";
import { getMeta, openDb } from "./db.ts";
import { BLOCKS_PER_DAY } from "./config.ts";
import { CFG } from "./config.ts";

const here = dirname(fileURLToPath(import.meta.url));
const db = openDb();
let model = loadModel();

const SEC_PER_BLOCK = 86400 / BLOCKS_PER_DAY;

/**
 * How far behind the chain the data is, and how long since the watcher last said anything.
 *
 * A watcher that has died and a chain that has simply gone quiet look identical from the outside:
 * the list stops changing either way. Serving this makes the difference visible, which is the whole
 * point — a scanner that silently freezes is worse than one that says it is stuck, because the first
 * one still looks right.
 */
function health(): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const head = Number(getMeta(db, "live_head_block") ?? 0);
  const seenAt = Number(getMeta(db, "live_seen_at") ?? 0);
  const done = (db.prepare("SELECT coalesce(max(block), 0) b FROM launches").get() as { b: number }).b;

  const behindBlocks = head && done ? Math.max(0, head - done) : null;
  return {
    watcherSeenSecAgo: seenAt ? now - seenAt : null,
    behindBlocks,
    behindSec: behindBlocks === null ? null : Math.round(behindBlocks * SEC_PER_BLOCK),
    feedAgeSec: datasetAgeSec(),
    headBlock: head || null,
    indexedBlock: done || null,
  };
}

/**
 * Sixty requests a minute per address, counted in fixed windows.
 *
 * Crude on purpose: the feed is a public read of data anyone could gather themselves, so this exists
 * to stop one script making the board useless for everyone, not to guard a secret.
 */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, { n: number; until: number }>();
/** Only believe a forwarded address when this instance is knowingly behind a proxy. */
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function overLimit(req: import("node:http").IncomingMessage): boolean {
  const fwd = TRUST_PROXY ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  const who = fwd || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const seen = hits.get(who);
  if (!seen || now > seen.until) {
    if (hits.size > 10_000) hits.clear(); // bounded: an expired window costs nothing to forget
    hits.set(who, { n: 1, until: now + RATE_WINDOW_MS });
    return false;
  }
  seen.n++;
  return seen.n > RATE_LIMIT;
}

const json = (res: import("node:http").ServerResponse, body: unknown, code = 200): void => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${CFG.boardPort}`);

  if (url.pathname.startsWith("/api/") && overLimit(req)) {
    json(res, { error: "rate limited", limit: `${RATE_LIMIT}/min` }, 429);
    return;
  }

  if (url.pathname === "/api/health") { json(res, health()); return; }

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
      health: health(),
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

server.listen(CFG.boardPort, CFG.boardHost, () => {
  console.log(`ponscan board on http://${CFG.boardHost}:${CFG.boardPort}`);
  if (!model) console.log("no model yet — run: npm run train");
});
