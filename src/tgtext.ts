import { buildCard } from "./card.ts";
import { EXPLORER } from "./config.ts";
import { getMeta, type DB } from "./db.ts";
import { graduationCapUsd, graduationMultiple } from "./pool.ts";
import { formatUsd, startingCapUsd } from "./prices.ts";
import { quoteFromCache } from "./quote.ts";
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

/**
 * The forecast, written so it can be read without knowing how the model works.
 *
 * A range on its own says nothing. "$4.2K to $7.4K" only means something once the reader knows a
 * launch opens near $4K and that graduating takes about $47K, at which point the same three numbers
 * say something plain: this one is not expected to make it. Both anchors are measured from this
 * database rather than asserted, and both are near-constants, which is what lets them sit in every
 * message: the opening cap is fixed by the curve, and a pool opens at the price the curve ended on,
 * so across 3,497 pools the graduation cap runs $39.4K to $51.9K with a median of $47.0K.
 *
 * Where the quote asset has no dollar price the same forecast is given as a multiple, with a
 * price-free anchor: graduation sits at a median of x10.9 of the opening price across 174 graduated
 * tokens, tenth to ninetieth x7.7 to x11.8. That is a protocol constant, not a market one.
 *
 * The band is labelled with the share of unseen launches it actually caught, not the share it was
 * built for. Those differ right now, and a range printed bare would claim a confidence the model has
 * not earned.
 */
function forecastLines(db: DB, card: NonNullable<ReturnType<typeof buildCard>>): string[] {
  const a = card.ath;
  if (!a.available || a.multiple === null) return [];

  const L = card.launch;
  const dollars = a.pointUsd !== null && a.loUsd !== null && a.hiUsd !== null;

  // Dollars need a price for the quote asset, and the price book does not cover every asset a launch
  // can be quoted against: 9.7% of a week's launches are quoted in something it has no price for.
  // Those used to lose the forecast entirely, which was the worst of the options, since the multiple
  // is what the model predicts and the dollar figure is only that multiple times a price we happen
  // to know. So the same forecast is given in whichever unit is available.
  const times = (v: number | null): string => (v === null ? "—" : `×${v < 10 ? v.toFixed(1) : Math.round(v)}`);

  const anchors: string[] = [];
  if (dollars) {
    const opens = startingCapUsd(db, L.quoteSymbol, L.quoteDecimals);
    const grad = graduationCapUsd(
      db,
      (pt) => quoteFromCache(db, pt).decimals,
      (pt) => quoteFromCache(db, pt).symbol,
    );
    if (opens !== null) anchors.push(`opens at ${formatUsd(opens)}`);
    if (grad !== null) anchors.push(`graduates near ${formatUsd(grad)}`);
  } else {
    // The price-free anchor. A protocol constant rather than a market one, so it holds for any asset.
    const gm = graduationMultiple(db);
    if (gm !== null) anchors.push(`graduating takes about ${times(gm)}`);
  }
  const tail = anchors.length ? `  (${anchors.join(" · ")})` : "";

  const point = dollars ? esc(a.pointUsd as string) : `${times(a.multiple)} of its opening price`;
  const lo = dollars ? esc(a.loUsd as string) : times(a.loMultiple);
  const hi = dollars ? esc(a.hiUsd as string) : times(a.hiMultiple);

  const out = [`<b>peak market cap</b> around ${point}${tail}`];
  out.push(a.coverage === null
    ? `usually between ${lo} and ${hi}`
    : `usually between ${lo} and ${hi}, where the real peak landed ${(100 * a.coverage).toFixed(0)}% of the time`);
  if (a.tailChance !== null) {
    const base = a.tailBase !== null && a.tailBase > 0
      ? `, against ${(100 * a.tailBase).toFixed(0)}% for a typical launch` : "";
    out.push(`chance of ×10 or better: ${(100 * a.tailChance).toFixed(0)}%${base}`);
  }
  if (!dollars) {
    out.push(`<i>no dollar price on record for ${esc(L.quoteSymbol)}, so this is a multiple rather than a cap</i>`);
  }
  return out;
}

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

  // Only while the answer is still open. Once a launch has graduated and its pool peak is known,
  // printing a forecast beside the fact reads as the tool contradicting itself.
  if (card && !card.outcome.graduated) {
    const f = forecastLines(db, card);
    if (f.length) blocks.push(f);
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

  if (!card.outcome.graduated) {
    const f = forecastLines(db, card);
    if (f.length) blocks.push(f);
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
