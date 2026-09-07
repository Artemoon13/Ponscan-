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
  "<b>Gimlet</b> — launch alerts from your own machine.",
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

/**
 * One launch, as an alert.
 *
 * Built from the full card rather than the score alone. An alert that says only "31.1%" makes the
 * reader open something else to decide anything, which defeats the point of pushing it: the numbers
 * that answer "is this worth a look" are the forecast peak, what the creator has done before, and
 * whether they put their own money in. Those are all a card read, and a card is a local query.
 *
 * Laid out in blocks with blank lines between, because these arrive in a stream. A wall of labelled
 * values is unreadable at the third one; four short stanzas can be skimmed.
 */
export function alertText(db: DB, s: Scored, m: LaunchMeta, now = Math.floor(Date.now() / 1000)): string {
  const pct = (s.probability * 100).toFixed(1);
  const card = buildCard(db, s.token);

  const head = [
    `<b>${esc(m.symbol ?? short(s.token))}</b>  <b>${pct}%</b> to reach the pool`,
    `rank #${s.rank} of ${s.of.toLocaleString()} · ${ago(now - s.ts)} old${card ? ` · ${esc(card.launch.quoteSymbol)}` : ""}`,
  ];

  const blocks: string[][] = [head];

  // The forecast, which is the reason to look at a launch at all. Shown as the band it was validated
  // as: the point estimate only beats a constant by a quarter, so leading with it would overstate it.
  // Only while the answer is still open. Once a launch has graduated and its pool peak is known,
  // printing a forecast beside the fact reads as the tool contradicting itself.
  if (card?.ath.available && card.ath.loUsd && card.ath.hiUsd && !card.outcome.graduated) {
    const a = card.ath;
    const peak = [`<b>peak</b> ${esc(a.loUsd)} – ${esc(a.hiUsd)}${a.pointUsd ? ` · around ${esc(a.pointUsd)}` : ""}`];
    // The measured hit rate, not the rate the band was built for. It is currently well under it, and
    // a range quoted without that reads as a promise the model does not keep.
    if (a.coverage !== null) peak.push(`<i>ranges like this have held ${(100 * a.coverage).toFixed(0)}% of the time</i>`);
    if (a.tailChance !== null) {
      const base = a.tailBase !== null && a.tailBase > 0 ? ` vs ${(100 * a.tailBase).toFixed(0)}% typical` : "";
      peak.push(`<b>×10 or more</b> ${(100 * a.tailChance).toFixed(0)}%${base}`);
    }
    blocks.push(peak);
  }

  if (card) {
    const H = card.creatorHistory;
    const L = card.launch;
    const who = [
      `<b>creator</b> ${H.priorLaunches} earlier launch${H.priorLaunches === 1 ? "" : "es"}, ${H.priorGraduations} graduated`,
    ];
    if (H.bestPeak) {
      who.push(`their best ever: ${H.bestPeak.usd ?? `×${H.bestPeak.multiple.toFixed(1)}`}${H.bestPeak.symbol ? ` (${esc(H.bestPeak.symbol)})` : ""}`);
    }
    blocks.push(who);

    const facts: string[] = [];
    if (L.selfBuy) facts.push(`self-buy ${esc(L.selfBuy)} ${esc(L.quoteSymbol)}`);
    if (L.creatorTaxBps !== null) facts.push(`tax ${(L.creatorTaxBps / 100).toFixed(2)}%`);
    if (card.exemptions.length) facts.push(`${card.exemptions.length} tax-exempt`);
    const line: string[] = [];
    if (facts.length) line.push(facts.join(" · "));
    if (card.trading.indexed && card.trading.buyersFirstMinute) {
      line.push(`${card.trading.buyersFirstMinute} buyer${card.trading.buyersFirstMinute === 1 ? "" : "s"} in the first minute`);
    }
    // A ticker dozens of launches share is the single loudest signal on a fresh launch, so it is
    // spelled out rather than left to the reason chips.
    if (card.cluster.total > 1) {
      line.push(`ticker shared by ${card.cluster.total} launches, ${card.cluster.graduated} graduated`);
    }
    if (line.length) blocks.push(line);
  }

  // Reasons carry a short label for exactly this: a chat line has less room than a card.
  blocks.push([
    s.reasons.slice(0, 3).map((r) => `${r.direction === "up" ? "+" : "−"} ${esc(r.short)}`).join("\n")
      // A launch can score on nothing in particular; the alert should still read as a sentence.
      || "no reason stood out",
  ]);

  blocks.push([
    `<code>${s.token}</code>`,
    `<a href="${EXPLORER.token(s.token)}">explorer</a>`,
  ]);

  return blocks.map((b) => b.join("\n")).join("\n\n");
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

  const L = card.launch;
  const blocks: string[][] = [[
    `<b>${esc(card.symbol ?? short(t))}</b>${card.name && card.name !== card.symbol ? ` · ${esc(card.name)}` : ""}`,
    s ? `<b>${(s.probability * 100).toFixed(1)}%</b> to reach the pool · rank #${s.rank} of ${s.of.toLocaleString()}`
      : "not scored, it is outside the model's window",
    `${ago(Math.floor(Date.now() / 1000) - L.ts)} old · ${esc(L.quoteSymbol)} · ${card.outcome.graduated ? "reached the pool" : ["on the curve", "swept", "in the pool", "rescued"][card.outcome.phase] ?? "?"}`,
  ]];

  // What it has actually done, in two acts. The curve stops at the graduation bar by construction,
  // so for a graduated token the pool line is the one carrying information.
  const done = [`<b>peak on the curve</b> ${card.trading.peakUsd ?? "—"}`];
  if (card.pool) {
    const p = card.pool;
    done.push(`<b>peak in the pool</b> ${p.tracked ? (p.peakUsd ?? "—") : "still reading"}${p.lastUsd ? ` · ${p.lastUsd} now` : ""}`);
  }
  blocks.push(done);

  if (card.ath.available && card.ath.loUsd && card.ath.hiUsd && !card.outcome.graduated) {
    const a = card.ath;
    const f = [`<b>predicted peak</b> ${esc(a.loUsd)} – ${esc(a.hiUsd)}${a.pointUsd ? ` · around ${esc(a.pointUsd)}` : ""}`];
    if (a.tailChance !== null) {
      const base = a.tailBase !== null && a.tailBase > 0 ? ` vs ${(100 * a.tailBase).toFixed(0)}% typical` : "";
      f.push(`<b>×10 or more</b> ${(100 * a.tailChance).toFixed(0)}%${base}`);
    }
    if (a.coverage !== null) f.push(`<i>ranges like this held for ${(100 * a.coverage).toFixed(0)}% of launches the model never saw</i>`);
    blocks.push(f);
  }

  const facts: string[] = [];
  if (L.selfBuy) facts.push(`self-buy ${esc(L.selfBuy)} ${esc(L.quoteSymbol)}`);
  if (L.creatorTaxBps !== null) facts.push(`tax ${(L.creatorTaxBps / 100).toFixed(2)}%`);
  if (card.exemptions.length) facts.push(`${card.exemptions.length} tax-exempt`);
  const detail: string[] = [];
  if (facts.length) detail.push(facts.join(" · "));
  if (card.trading.indexed) {
    detail.push(`${card.trading.buyersTotal} buyer${card.trading.buyersTotal === 1 ? "" : "s"} total, ${card.trading.buyersFirstMinute} in the first minute`);
  }
  if (card.cluster.total > 1) {
    detail.push(`ticker shared by ${card.cluster.total} launches, ${card.cluster.graduated} graduated`);
  }
  if (detail.length) blocks.push(detail);

  const who = [`<b>creator</b> ${H.priorLaunches} earlier launch${H.priorLaunches === 1 ? "" : "es"}, ${H.priorGraduations} graduated`];
  if (H.bestPeak) {
    who.push(`their best ever: ${H.bestPeak.usd ?? `×${H.bestPeak.multiple.toFixed(1)}`}${H.bestPeak.symbol ? ` (${esc(H.bestPeak.symbol)})` : ""}`);
  }
  for (const p of (H.topPeaks ?? []).slice(1, 3)) {
    who.push(`then ${p.usd ?? `×${p.multiple.toFixed(1)}`}${p.symbol ? ` (${esc(p.symbol)})` : ""}`);
  }
  blocks.push(who);

  blocks.push([`<code>${t}</code>`, `<a href="${EXPLORER.token(t)}">explorer</a>`]);
  return blocks.map((b) => b.join("\n")).join("\n\n");
}
