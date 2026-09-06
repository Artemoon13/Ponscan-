# ponscan

New tokens launch on [pons](https://www.ponsfamily.com) faster than anyone can read them. Almost all
of them die. About **{{BASE_RATE}} in a hundred** make it off the bonding curve and into a real
Uniswap pool.

ponscan watches every launch as it happens and puts the ones worth a look at the top. It runs on your
own machine, needs no wallet and no key, and sends nothing anywhere.

## What you actually see

A list of recent launches, ordered by score rather than by clock. For each one:

- **A number** — the chance this launch reaches the pool, and where it sits against every other
  launch of the last six hours. `#3 of 412` is the useful half: on its own a figure like 4% means
  little, but "third-highest of the last four hundred" tells you whether to look now or never.
- **Three reasons** — plain sentences saying what moved that number. *"creator bought 0.185 ETH of
  their own launch"*, *"creator waived the opening tax for 4 wallets"*, *"this creator has launched
  31 tokens before, none reached the pool"*.
- **A card**, if you click through — everything known about the launch. Who really created it, how
  much they bought themselves, which wallets they let in before the 99% opening tax, where the
  creator fees are routed, how many times this exact ticker has been launched before and how those
  ended. Every line links to the transaction it came from, so you can check any of it.

The point is not to be told what to buy. The point is to not read four hundred launches by hand.

## Does it actually work?

Yes, a bit. Here is the honest version.

ponscan ranks every launch of the last six hours against the others — usually around eight hundred
of them. Call the top tenth of that ranking, roughly the **top eighty launches**, the shortlist.

**Out of a hundred launches picked at random, about {{BASE100_HITS}} reach the pool. Out of a hundred
taken from the shortlist, about {{TOP100_HITS}} do.**

So roughly **{{DECILE_LIFT}}x better than guessing**. That is worth having. It is also nowhere near
certainty — even on the shortlist, {{WRONG_PCT}} out of every hundred still go nowhere. Anyone who
tells you their model does better than this on launch data alone is selling something.

Why the top tenth and not the top ten? Because at these rates the top ten launches contain one or two
graduations on a good day, and any percentage computed from two events is noise. Eighty launches is
the smallest slice that is both near the top and large enough for the number to mean anything.

Two more things worth knowing before you lean on it:

- **You have about two minutes.** Half of all graduations happen within {{GRAD_P50}} of launch, 90%
  within {{GRAD_P90}}. A launch you read an hour later has already decided.
- **It stops working sometimes.** {{STABILITY_NOTE}} It is an edge across many launches, not a
  guarantee on any one of them.

These numbers come from {{EVAL_SPAN}} of real launches, tested the hard way: the model is only ever
scored on launches that happened *after* the ones it learned from, never on a random shuffle. You can
re-run that yourself in one command, and you should.

## Can I check any of this, or do I just trust you?

You can check it, and you should not trust it.

ponscan writes down every score it gives, at the moment it gives it, **before the outcome exists**.
Four hours later it looks up what actually happened and grades itself. `npm run scoreboard` shows you
that record. `npm run verify` dumps the whole log to a file and recomputes the numbers from the file
alone, so you can hand it to someone who does not trust the code at all.

Every row in that file names a token, the exact moment the score was written, and what happened. All
three are on-chain. You can verify any of it in a block explorer without this tool.

Two rules keep that log honest:

- **A launch older than five minutes is never recorded.** Half of graduations are decided by then, so
  scoring late would flatter the record with launches whose fate was already half-known.
- **A score cannot be edited afterwards.** The first thing ponscan says about a launch is the thing
  it gets graded on.

Live record so far: {{SCOREBOARD_SUMMARY}}

## Running it

You need [Node](https://nodejs.org) 22.6 or newer. Nothing else — no Python, no build step, no
database to install.

```bash
npm install
cp .env.example .env
npm run doctor
```

`doctor` checks it can reach the chain and that pons hasn't moved its contracts. If it fails, stop
there; nothing else will work.

Then collect some history and train on it:

```bash
npm run backfill -- --hours 168        # a week of launches — about five minutes
npm run enrich-window -- --hours 24    # read those launch transactions — about half an hour
npm run train                          # fit the model
```

And use it:

```bash
npm run board       # the list, at http://localhost:4663
npm run watch       # the same thing live in a terminal
npm run scoreboard  # how its past calls actually turned out
```

The first run is slow because it is reading a week of chain history a transaction at a time. After
that it keeps up on its own.

## Where it lets you down

- **You are wrong most of the time even when you follow it.** {{WRONG_PCT}} out of every hundred on
  the shortlist still go nowhere. If that ratio does not fit how you trade, this tool will not fix
  that.
- **The exact multipliers are shakier than they look.** The shortlist holds {{DECILE_HITS}}
  graduations in a typical test period — the direction holds up, the second decimal place is noise.
  `scoreboard` prints the raw hit counts next to every percentage for exactly this reason.
- **It has not lived through a regime change.** Launch tactics drift, and a scanner that works this
  month can quietly stop working next month. The live scoreboard is the thing that will tell you —
  watch it, not the numbers in this file.
- **It knows nothing about anything except pons v2 launches.** Not price, not safety, not whether a
  token is a scam. It answers one question and has no opinion on any other.
- **A public score invites gaming.** If enough people trade off the same signal, the signal changes.

---

# Under the hood

Everything below is for reading or changing the code. You do not need any of it to use the tool.

## The pipeline

```
factory logs  ──▶  SQLite  ──▶  features at T+0  ──▶  GBDT  ──▶  score + rank + reasons
   (live)          (local)       (leak-free)                          card (facts + tx links)
```

- **Ingest** (`src/ingest.ts`, `src/live.ts`) follows the pons v2 factory. The official RPC has no
  websocket, so a publicnode socket carries detection while the official endpoint serves the log
  reads. Every path funnels through the same catch-up read, so a dropped socket, a missed
  notification or a restart all recover by pulling the gap. Writes are upserts keyed on on-chain
  identifiers, so replaying a range is harmless.
- **Storage** (`src/db.ts`) is `node:sqlite`, which ships with Node — no native module to build.
  Amounts are stored twice: exact integers as strings, and floats for sorting.
- **Features** (`src/features.ts`) are computed strictly from what is knowable when the launch
  transaction lands. Nothing reads a trade, a price, or an outcome.
- **Model** (`src/model/gbdt.ts`) is gradient-boosted trees written out rather than pulled in, so the
  whole tool stays one runtime. Contributions decompose exactly, which is where the reasons come from.
- **Prediction log** (`src/track.ts`) records each live score before its outcome exists and grades it
  against the same label the model is trained on.

## Commands

```bash
npm run doctor         # endpoints, chain id, contract addresses against the factory's own getters
npm run backfill       # factory events: who launched, when, and what graduated
npm run enrich-window  # decode launch transactions across a contiguous span
npm run train          # fit, print held-out metrics, write data/model.json
npm run validate       # rolling-origin folds: does the signal repeat, or was that one lucky split?
npm run stats          # what is in the database
npm run board          # http://localhost:4663
npm run watch          # live feed, logging each score it prints
npm run scoreboard     # the live record, by model era
npm run verify         # export the log as JSONL, recompute from the file
npm run nightly        # backfill, enrich, retrain, in that order
npm test               # the parts that fail silently when broken
```

`backfill` covers a week in about five minutes. `enrich-window` is the slow part at roughly
{{ENRICH_RATE}} launches a second, because it reads every launch transaction; a full week is
{{ENRICH_HOURS}}. The two use different endpoints on purpose: only one public node serves
`eth_getLogs`, so enrichment deliberately reads transactions from the other one and leaves that
budget to the watcher.

## Why `enrich-window` and not `enrich`

Training needs an *unbiased* sample. Enriching "all the graduated ones plus a scattering of others"
is fine for asking whether a feature separates the classes, but a model fitted on it is calibrated to
a positive rate that does not exist, and the score reads far too high. `enrich-window` fills a
contiguous span completely, and `train` refuses to run on anything else — it finds the longest run of
hours with ≥98% coverage and uses only that.

## Four things that are easy to get wrong

Each of these silently produces a plausible, wrong answer:

1. **The docs list a stale factory.** `docs.ponsfamily.com` defaults to its v1 page, and the v1
   factory has been idle for weeks. v1 and v2 are different protocols: v1 has no curve and no
   migration, and its graduation rate is indistinguishable from zero. This tool targets v2 only, and
   `doctor` re-checks the addresses against the live factory's own getters.
2. **`deployer` is not the creator.** The `TokenLaunched` event reports whoever called the factory,
   which is often a batching contract — Multicall3 alone is the single largest "deployer" in a day.
   The human is the transaction sender, which is why the card reads `tx.from`.
3. **Roughly half of launches are not quoted in ETH**, and those quote assets are tokenised stocks
   and a 6-decimal stablecoin. Formatting their amounts as 18-decimal wei prints `0.0000` for real
   values, so the quote asset's decimals are resolved and cached (`src/quote.ts`).
4. **About half of launches do not go through the pons router**, so their calldata cannot be decoded
   and the creator's declared terms are simply unknown. Folding that into "bought nothing" would
   poison the strongest signal, so absence is its own feature.

## How the evaluation avoids lying to itself

- **Splits are by time, never at random.** Launch tactics drift day to day, so a random split lets
  the model see the same hour it is tested on and reports a number the live product never reaches.
- **Creator history accumulates by graduation time, not launch time.** A creator's earlier launch can
  graduate *after* the launch being scored; counting it by the earlier launch's own timestamp would
  read the future.
- **Unsettled launches are dropped.** A launch from ten minutes ago has not graduated *yet*, which is
  not the same as not graduating. Training on it as a negative teaches the model that recent launches
  fail.
- **Average precision is the headline, not ROC-AUC.** At a {{BASE_RATE_PCT}} positive rate, ROC-AUC
  flatters a model that is useless at the top of the ranking, and the top is the only part anyone
  looks at.
- **`validate` refits at several sequential cut points** and reports the spread. A single split on a
  rare class swings widely enough to either flatter a model with no signal or damn one that has some.

## Retraining

```bash
npm run nightly
```

Labels settle quickly — the 4-hour horizon captures 98.5% of graduations — so a nightly retrain
always has fresh, fully resolved labels. `board` reloads the model per request, so a retrain is
picked up without restarting anything, and `scoreboard` starts a new era rather than pooling the new
model's calls with the old one's.

## Tests

```bash
npm test
```

Deliberately narrow. They cover the two places where a bug produces no error and no log line, just
quietly wrong output: the block-timestamp interpolation (where wrongly spaced anchors turned a
five-minute backfill into a ten-hour one), the booster itself (where a subtle split-finding or
attribution bug still trains, still reports plausible metrics, and is worthless), and the prediction
log's two honesty rules.

## License

MIT.
