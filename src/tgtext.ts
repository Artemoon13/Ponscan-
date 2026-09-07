import { buildCard } from "./card.ts";
import { EXPLORER } from "./config.ts";
import { getMeta, type DB } from "./db.ts";
import { loadModel, scoreOne, scoreRecent, type Scored } from "./score.ts";
import { modelId } from "./track.ts";

/**
 * What the bot says, kept apart from how it says it.
 *
 * Every function here is a pure read of the local database returning a string, which is the whole
 * reason they are not in the command loop: a message that misreads a card or crashes on a token with
 * no history is a bug you want to find without a bot token and without messaging anybody. The loop
 * owns the network; this owns the words.
 */

/** Telegram renders a small HTML subset; these three characters are what breaks it. */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const ago = (sec: number): string =>
  sec < 90 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;

export const HELP = [
  "<b>Poolitzer</b> — launch alerts from your own machine.",
  "",
  "/watch <i>n</i> — alert me at or above n% (e.g. <code>/watch 8</code>)",
  "/stop — stop alerts and delete my record",
  "/status — is the watcher alive, how old is the model",
  "/top — the highest scoring launches right now",
  "/token <i>0x…</i> — the card for one launch",
  "",
  "<i>This bot never asks for a key, a seed or an approval, holds no funds and signs nothing. "
  + "No command here takes a private key: anything claiming to be this bot and asking for one is not.</i>",
].join("\n");

export type LaunchMeta = { symbol: string | null; name: string | null; deployer: string };

/** One launch, as an alert. */
export function alertText(db: DB, s: Scored, m: LaunchMeta, now = Math.floor(Date.now() / 1000)): string {
  const pct = (s.probability * 100).toFixed(1);
  // Reasons carry a short label for exactly this: a chat line has less room than a card.
  const why = s.reasons.slice(0, 3)
    .map((r) => `${r.direction === "up" ? "+" : "−"} ${esc(r.short)}`).join("\n")
    // A launch can score on nothing in particular; the alert should still read as a sentence.
    || "no reason stood out";

  const dev = db.prepare("SELECT count(*) c FROM launches WHERE deployer = ?").get(m.deployer) as { c: number };
  const devGrad = db.prepare(
    "SELECT count(*) c FROM launches x JOIN graduations g USING(token) WHERE x.deployer = ?",
  ).get(m.deployer) as { c: number };

  return [
    `<b>${esc(m.symbol ?? short(s.token))}</b>  <b>${pct}%</b>`,
    `rank #${s.rank} of ${s.of.toLocaleString()} · ${ago(now - s.ts)} old`,
    "",
    why,
    "",
    `creator: ${dev.c} launch${dev.c === 1 ? "" : "es"}, ${devGrad.c} graduated`,
    `<code>${s.token}</code>`,
    `<a href="${EXPLORER.token(s.token)}">explorer</a>`,
  ].join("\n");
}

export function statusText(db: DB, now = Math.floor(Date.now() / 1000)): string {
  const seen = Number(getMeta(db, "live_seen_at") ?? 0);
  const head = Number(getMeta(db, "live_head_block") ?? 0);
  const done = (db.prepare("SELECT coalesce(max(block),0) b FROM launches").get() as { b: number }).b;
  const total = (db.prepare("SELECT count(*) c FROM launches").get() as { c: number }).c;

  return [
    `<b>watcher</b> ${seen ? `last spoke ${ago(now - seen)} ago` : "never reported in"}`,
    `<b>behind</b> ${head && done ? `${Math.max(0, head - done).toLocaleString()} blocks` : "unknown"}`,
    `<b>launches</b> ${total.toLocaleString()} on record`,
    `<b>model</b> ${loadModel() ? modelId() : "none. Run: npm run train"}`,
  ].join("\n");
}

export function topText(db: DB, windowHours: number, limit = 5): string {
  const model = loadModel();
  if (!model) return "no model yet. Run: npm run train";
  const page = scoreRecent(db, model, windowHours, limit, "score", 0);
  if (!page.items.length) return `nothing scored in the last ${windowHours}h`;

  const nameOf = db.prepare("SELECT symbol FROM launches WHERE token = ?");
  const lines = page.items.map((s) => {
    const m = nameOf.get(s.token) as { symbol: string | null } | undefined;
    return `<b>${(s.probability * 100).toFixed(1)}%</b>  ${esc(m?.symbol ?? short(s.token))}  <code>${short(s.token)}</code>`;
  });
  return [`Top ${lines.length} of ${page.total.toLocaleString()} in the last ${windowHours}h`, "", ...lines].join("\n");
}

/** One launch, in full, for a direct question. */
export function tokenText(db: DB, raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(t)) return "that does not look like a token address";
  const card = buildCard(db, t);
  if (!card) return "not in the database. It may predate the backfill, or not be a pons launch.";

  const model = loadModel();
  const s = model ? scoreOne(db, model, t) : null;
  const H = card.creatorHistory;

  const lines = [
    `<b>${esc(card.symbol ?? short(t))}</b>${card.name && card.name !== card.symbol ? ` · ${esc(card.name)}` : ""}`,
    s ? `<b>${(s.probability * 100).toFixed(1)}%</b> to reach the pool · rank #${s.rank} of ${s.of.toLocaleString()}`
      : "not scored — outside the model's window",
    "",
    `peak on the curve: ${card.trading.peakUsd ?? "—"}`,
  ];
  // The pool figure only exists for a launch that graduated, and only once its swaps are read.
  if (card.pool) {
    const p = card.pool;
    lines.push(`peak in the pool: ${p.tracked ? (p.peakUsd ?? "—") : "still reading"}${p.lastUsd ? ` · ${p.lastUsd} now` : ""}`);
  }
  lines.push(
    "",
    `creator: ${H.priorLaunches} earlier launch${H.priorLaunches === 1 ? "" : "es"}, ${H.priorGraduations} graduated`,
  );
  if (H.bestPeak) {
    lines.push(`their best: ${H.bestPeak.usd ?? `×${H.bestPeak.multiple.toFixed(1)}`}${H.bestPeak.symbol ? ` · ${esc(H.bestPeak.symbol)}` : ""}`);
  }
  lines.push("", `<a href="${EXPLORER.token(t)}">explorer</a>`);
  return lines.join("\n");
}
