import { openDb, type DB } from "../db.ts";
import { loadModel, scoreRecent } from "../score.ts";
import { alertText, HELP, statusText, tokenText, topText, type LaunchMeta } from "../tgtext.ts";

/**
 * gimlet telegram — the board's alerts, in a chat.
 *
 * This is the one part of the project that speaks to a third party, so it is worth being plain about
 * what that costs. Everything else here reads a public RPC and writes to a file on your disk; this
 * sends launch addresses and scores to Telegram's servers. All of it is public chain data plus a
 * number this machine computed, and none of it is a key, a seed, or anything about a wallet you
 * control. Still, it leaves the machine, which nothing else does, and that is why the bot is a
 * separate command you start on purpose rather than part of the watcher.
 *
 * The promises on the Telegram page are enforced here rather than merely stated. The bot never
 * messages a chat that has not sent /start, because a chat only enters `tg_subs` by doing so. It
 * never asks for a key or a seed, because there is no command that takes one. It holds nothing and
 * signs nothing: every reply is built from the same local database the board reads.
 *
 * gimlet telegram [--min N] [--window-hours N] [--interval-sec N] [--once]
 */

const argv = process.argv.slice(2);
const arg = (name: string, dflt: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const DEFAULT_MIN = arg("min", 8);
const WINDOW_HOURS = arg("window-hours", 1);
const INTERVAL_SEC = arg("interval-sec", 30);
const ONCE = has("once");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!TOKEN) {
  console.error(`no TELEGRAM_BOT_TOKEN set.

Create a bot with @BotFather in Telegram, then put the token it gives you in .env:

  TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here

.env is git-ignored, so the token stays on this machine. Do not paste it into a chat,
a commit, or an issue: anyone holding it controls the bot.`);
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

/**
 * One call to the Telegram API.
 *
 * Failures are returned rather than thrown. A bot that dies because Telegram had a bad minute is
 * worse than one that skips a message: the alert loop is the point, and it has to outlive the
 * network.
 */
async function tg<T = unknown>(method: string, body?: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(40_000),
    });
    const j = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!j.ok) {
      // 409 means another copy of this bot is already long-polling; that one is not survivable.
      if (j.description?.includes("terminated by other getUpdates")) {
        console.error("\nanother copy of this bot is already running; stop it first");
        process.exit(1);
      }
      return null;
    }
    return j.result ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function send(chatId: number, text: string): Promise<boolean> {
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  return r !== null;
}

const db: DB = openDb();

/**
 * Subscribes a chat, and treats everything already in the window as seen.
 *
 * Without that second half the first pass after /start delivers a burst: every launch currently
 * above the threshold is new to this chat, so up to twenty-five of them arrive at once, all of them
 * minutes old and none of them the thing the reader asked to be told about. Alerts are meant to say
 * "this just happened", so subscribing starts the clock rather than emptying the window into it.
 *
 * Lowering the threshold later does the same, and for the same reason: the launches it newly admits
 * are ones that were already there.
 */
function subscribe(chatId: number, min: number): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO tg_subs (chat_id, min_score, created_at, last_at) VALUES (?,?,?,0)
    ON CONFLICT(chat_id) DO UPDATE SET min_score = excluded.min_score`)
    .run(chatId, min, now);

  const model = loadModel();
  if (!model) return;
  const mark = db.prepare("INSERT INTO tg_sent (chat_id, token, sent_at) VALUES (?,?,?) ON CONFLICT DO NOTHING");
  for (const s of scoreRecent(db, model, WINDOW_HOURS, 200, "score", min / 100).items) {
    mark.run(chatId, s.token, now);
  }
}

/* ── commands ──────────────────────────────────────────────────────────── */

async function handle(chatId: number, text: string): Promise<void> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const name = cmd.toLowerCase().split("@")[0];

  switch (name) {
    case "/start":
    case "/help":
      subscribe(chatId, DEFAULT_MIN);
      await send(chatId, `${HELP}\n\nAlerts are on at <b>${DEFAULT_MIN}%</b>. Change it with /watch.`);
      return;
    case "/watch": {
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n < 0 || n > 99) {
        await send(chatId, "give a number between 0 and 99, e.g. <code>/watch 8</code>");
        return;
      }
      subscribe(chatId, n);
      await send(chatId, `alerting at <b>${n}%</b> and above.`);
      return;
    }
    case "/stop":
      db.prepare("DELETE FROM tg_subs WHERE chat_id = ?").run(chatId);
      db.prepare("DELETE FROM tg_sent WHERE chat_id = ?").run(chatId);
      await send(chatId, "stopped, and your record here is deleted. /start begins again.");
      return;
    case "/status":
      await send(chatId, statusText(db));
      return;
    case "/top":
      await send(chatId, topText(db, WINDOW_HOURS));
      return;
    case "/token":
      await send(chatId, rest[0] ? tokenText(db, rest[0]) : "give an address, e.g. <code>/token 0x…</code>");
      return;
    default:
      if (name.startsWith("/")) await send(chatId, HELP);
  }
}

/* ── the two loops ──────────────────────────────────────────────────────────── */

type Update = {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
};

async function pollCommands(): Promise<void> {
  let offset = 0;
  for (;;) {
    const ups = await tg<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    if (!ups) { await sleep(3000); continue; }
    for (const u of ups) {
      offset = u.update_id + 1;
      const chat = u.message?.chat?.id;
      const text = u.message?.text;
      if (chat !== undefined && text) {
        try { await handle(chat, text); } catch { /* one bad command must not end the loop */ }
      }
    }
  }
}

/**
 * Pushes launches that clear a subscriber's threshold, once each.
 *
 * Scored per subscriber rather than once for everybody, because the threshold is what the scoring
 * call filters on and thresholds differ. That is cheap: the matrix behind it is shared and cached,
 * and the number of subscribers on a machine somebody runs themselves is small.
 */
async function alertPass(): Promise<number> {
  const model = loadModel();
  if (!model) return 0;
  const subs = db.prepare("SELECT chat_id, min_score FROM tg_subs").all() as
    Array<{ chat_id: number; min_score: number }>;
  if (!subs.length) return 0;

  const already = db.prepare("SELECT 1 x FROM tg_sent WHERE chat_id = ? AND token = ?");
  const mark = db.prepare("INSERT INTO tg_sent (chat_id, token, sent_at) VALUES (?,?,?) ON CONFLICT DO NOTHING");
  const metaOf = db.prepare("SELECT symbol, name, deployer FROM launches WHERE token = ?");
  let sent = 0;

  for (const sub of subs) {
    const page = scoreRecent(db, model, WINDOW_HOURS, 25, "score", sub.min_score / 100);
    for (const s of page.items) {
      if (already.get(sub.chat_id, s.token)) continue;
      const m = metaOf.get(s.token) as LaunchMeta | undefined;
      if (!m) continue;
      // Marked before sending, not after: a message that fails is better skipped than repeated on
      // every pass, and Telegram gives no way to know a timeout did not arrive.
      mark.run(sub.chat_id, s.token, Math.floor(Date.now() / 1000));
      if (await send(sub.chat_id, alertText(db, s, m))) sent++;
      // Telegram allows about one message a second to a single chat.
      await sleep(1100);
    }
    db.prepare("UPDATE tg_subs SET last_at = ? WHERE chat_id = ?").run(Math.floor(Date.now() / 1000), sub.chat_id);
  }
  return sent;
}

/* ── run ────────────────────────────────────────────────────────────────────── */

const me = await tg<{ username: string }>("getMe");
if (!me) {
  console.error("Telegram refused the token. Check TELEGRAM_BOT_TOKEN in .env.");
  process.exit(1);
}
console.log(`gimlet telegram — @${me.username}`);
console.log(`  default threshold ${DEFAULT_MIN}%, window ${WINDOW_HOURS}h, checking every ${INTERVAL_SEC}s`);
console.log(`  ${(db.prepare("SELECT count(*) c FROM tg_subs").get() as { c: number }).c} chat(s) subscribed`);
console.log(`  send /start to @${me.username} to subscribe this machine's alerts to a chat\n`);

if (ONCE) {
  console.log(`sent ${await alertPass()} alert(s)`);
  db.close();
  process.exit(0);
}

process.on("SIGINT", () => { db.close(); process.exit(0); });

void pollCommands();
for (;;) {
  try {
    const n = await alertPass();
    if (n) console.log(`${new Date().toISOString().slice(11, 19)}  sent ${n} alert(s)`);
  } catch (e) {
    console.error(`alert pass failed: ${(e as Error).message}`);
  }
  await sleep(INTERVAL_SEC * 1000);
}
