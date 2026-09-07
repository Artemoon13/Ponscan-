import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CFG } from "./config.ts";

/**
 * Money is stored twice on purpose: `*_wei` is the exact integer as a decimal string, `*_eth` is a
 * float for sorting and aggregation. SQLite integers are 64-bit and wei overflows them, so an exact
 * column that SQL can also ORDER BY does not exist. Reads that matter use the wei column.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS launches (
  token                    TEXT PRIMARY KEY,
  curve                    TEXT NOT NULL,
  deployer                 TEXT NOT NULL,
  pair_token               TEXT NOT NULL,
  launch_config_id         INTEGER NOT NULL,
  graduation_threshold_wei TEXT NOT NULL,
  graduation_threshold_eth REAL NOT NULL,
  block                    INTEGER NOT NULL,
  tx                       TEXT NOT NULL,
  log_index                INTEGER NOT NULL,
  ts                       INTEGER NOT NULL,
  launch_sender            TEXT,
  creator_fee_recipient    TEXT,
  creator_tax_bps          INTEGER,
  buyback_enabled          INTEGER,
  initial_buy_wei          TEXT,
  initial_buy_eth          REAL,
  initial_tokens           TEXT,
  exempt_count             INTEGER,
  name                     TEXT,
  symbol                   TEXT,
  description              TEXT,
  socials_json             TEXT,
  symbol_key               TEXT,
  phase                    INTEGER NOT NULL DEFAULT 0,
  enriched_at              INTEGER,
  first_seen_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_launches_deployer ON launches(deployer);
CREATE INDEX IF NOT EXISTS ix_launches_ts       ON launches(ts DESC);
CREATE INDEX IF NOT EXISTS ix_launches_block    ON launches(block);
CREATE INDEX IF NOT EXISTS ix_launches_phase    ON launches(phase);
-- Copies of a launch share its ticker under case, spacing and emoji differences; the normalised
-- key is what makes "how many times has this name been launched" a single indexed lookup.
CREATE INDEX IF NOT EXISTS ix_launches_symkey   ON launches(symbol_key, block);

-- Wallets the creator waived the 99% opening tax for. Declared in the launch tx input.
CREATE TABLE IF NOT EXISTS exemptions (
  token   TEXT NOT NULL,
  address TEXT NOT NULL,
  PRIMARY KEY (token, address)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_exempt_address ON exemptions(address);

CREATE TABLE IF NOT EXISTS graduations (
  token        TEXT PRIMARY KEY,
  block        INTEGER NOT NULL,
  tx           TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  position_id  TEXT NOT NULL,
  token_amount TEXT NOT NULL,
  pair_wei     TEXT NOT NULL,
  pair_eth     REAL NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS ix_grad_ts ON graduations(ts DESC);

CREATE TABLE IF NOT EXISTS sweeps (
  token     TEXT PRIMARY KEY,
  block     INTEGER NOT NULL,
  tx        TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  quote_wei TEXT NOT NULL,
  quote_eth REAL NOT NULL,
  token_out TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS curve_trades (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  side      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  recipient TEXT NOT NULL,
  quote_wei TEXT NOT NULL,
  quote_eth REAL NOT NULL,
  token_amt TEXT NOT NULL,
  fee_wei   TEXT NOT NULL,
  tax_wei   TEXT NOT NULL,
  tax_eth   REAL NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_trades_token ON curve_trades(token, block);
CREATE INDEX IF NOT EXISTS ix_trades_actor ON curve_trades(recipient);

-- Wallets that bought inside the 3-second opening window and were charged for it. Separate from
-- curve_trades because the tax field on CurveBuy is the creator's standing tax, identical on every
-- trade; only a racer appears here, and only a handful per launch do.
CREATE TABLE IF NOT EXISTS snipe_tax (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  payer     TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  block     INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_snipe_token ON snipe_tax(token);
CREATE INDEX IF NOT EXISTS ix_snipe_payer ON snipe_tax(payer);

-- Per-token indexing state: curve logs are fetched on demand, so we record how far each token got.
CREATE TABLE IF NOT EXISTS curve_indexed (
  token      TEXT PRIMARY KEY,
  to_block   INTEGER NOT NULL,
  trades     INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pools (
  token       TEXT PRIMARY KEY,
  pool_id     TEXT NOT NULL,
  currency0   TEXT NOT NULL,
  currency1   TEXT NOT NULL,
  token_is_c1 INTEGER NOT NULL,
  dec0        INTEGER NOT NULL,
  dec1        INTEGER NOT NULL,
  init_block  INTEGER NOT NULL,
  init_sqrt   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS pools_pool ON pools(pool_id);

CREATE TABLE IF NOT EXISTS pool_peaks (
  pool_id    TEXT PRIMARY KEY,
  min_sqrt   TEXT NOT NULL,
  max_sqrt   TEXT NOT NULL,
  min_block  INTEGER NOT NULL,
  max_block  INTEGER NOT NULL,
  last_sqrt  TEXT NOT NULL,
  last_block INTEGER NOT NULL,
  swaps      INTEGER NOT NULL,
  to_block   INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS fee_events (
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  recipient TEXT NOT NULL,
  depositor TEXT,
  amount_wei TEXT NOT NULL,
  amount_eth REAL NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_fee_recipient ON fee_events(recipient);

CREATE TABLE IF NOT EXISTS fee_recipient_changes (
  token     TEXT NOT NULL,
  tx        TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  prev      TEXT NOT NULL,
  next      TEXT NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_feechg_token ON fee_recipient_changes(token);

-- Not every launch is quoted in ETH: roughly half pair against another token, whose decimals
-- differ. Formatting those amounts as 1e18 wei silently prints 0.0000 for real, non-zero values.
CREATE TABLE IF NOT EXISTS quote_assets (
  address  TEXT PRIMARY KEY,
  symbol   TEXT,
  decimals INTEGER NOT NULL
) STRICT;

-- What the tool claimed, written before the outcome existed.
--
-- Offline validation answers "this would have worked on data we already had". Only a log written
-- ahead of the fact answers "this works", and only if it cannot be revised afterwards: the primary
-- key is the token and inserts never update, so the first claim made about a launch is the one that
-- gets graded. model_id fingerprints the model file, so a retrain starts a new era in the numbers
-- instead of quietly mixing into the old one.
CREATE TABLE IF NOT EXISTS predictions (
  token        TEXT PRIMARY KEY,
  launch_ts    INTEGER NOT NULL,
  scored_at    INTEGER NOT NULL,
  age_at_score INTEGER NOT NULL,
  probability  REAL NOT NULL,
  -- The model's own opinion, before any live correction. The probability column above is the claim
  -- as shown; this is what a refit is fitted against, so a correction is never measured on itself.
  raw_probability REAL,
  rank         INTEGER NOT NULL,
  of           INTEGER NOT NULL,
  model_id     TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  graded_at    INTEGER,
  label        INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS ix_pred_pending ON predictions(graded_at, launch_ts);
CREATE INDEX IF NOT EXISTS ix_pred_model   ON predictions(model_id, probability DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

export type DB = DatabaseSync;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing
 * database, so a new column never appears and any index over it fails the whole schema step. These
 * run before the schema, which keeps an old database openable instead of unopenable.
 */
const MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  { table: "launches", column: "symbol_key", ddl: "ALTER TABLE launches ADD COLUMN symbol_key TEXT" },
  // The model's own opinion, before any live correction was applied to it. `probability` stays the
  // number that was shown, because that is the claim; this is what the correction must be refitted
  // against, or each pass would correct an already-corrected score and drift downward unnoticed.
  { table: "predictions", column: "raw_probability", ddl: "ALTER TABLE predictions ADD COLUMN raw_probability REAL" },
];

/**
 * The project was renamed from ponscan to Poolitzer after databases already existed on disk. A
 * database is days of collected history, so the default path must not silently start over: if the
 * new file is absent and the old one is present, the old one is moved into place — together with
 * its WAL and shared-memory sidecars, which carry unflushed writes and must travel with it.
 */
function adoptLegacyDatabase(path: string): void {
  if (basename(path) !== "poolitzer.db" || existsSync(path)) return;
  const legacy = join(dirname(path), "ponscan.db");
  if (!existsSync(legacy)) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, path + suffix);
  }
}

export function openDb(path: string = CFG.dbPath): DB {
  mkdirSync(dirname(path), { recursive: true });
  adoptLegacyDatabase(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  for (const m of MIGRATIONS) {
    const exists = (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(m.table) as { c: number }).c > 0;
    if (!exists) continue;
    const cols = (db.prepare(`PRAGMA table_info(${m.table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(m.ddl);
  }

  db.exec(SCHEMA);
  return db;
}

export const getMeta = (db: DB, key: string): string | null => {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
};

export const setMeta = (db: DB, key: string, value: string): void => {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};

/** 1e18 wei to ETH as a float. Only ever used for sorting and display, never for exactness. */
export const toEth = (wei: bigint): number => Number(wei) / 1e18;

/**
 * Arbitrum Nitro can reorganise recent blocks before L1 finality. Ingest is idempotent by primary
 * key, so a replay overwrites rather than duplicates, but rows from an orphaned block must go.
 */
export function rollbackFrom(db: DB, block: number): void {
  for (const t of ["launches", "graduations", "sweeps", "curve_trades", "fee_events", "fee_recipient_changes"]) {
    db.prepare(`DELETE FROM ${t} WHERE block >= ?`).run(block);
  }
  db.prepare("DELETE FROM exemptions WHERE token NOT IN (SELECT token FROM launches)").run();
}
