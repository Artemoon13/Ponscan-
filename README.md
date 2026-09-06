# ponscan

A local scanner for [pons](https://www.ponsfamily.com) v2 launches on Robinhood Chain.

It watches every new token the moment it launches and shows one number: the chance that launch
reaches its graduation threshold, its rank among recent launches, and three reasons. Click a launch
and you get everything collected about it — who created it, how much they bought themselves, which
wallets they waived the opening tax for, where the creator fees go, what that creator launched before
and how it ended. Every line links to the transaction it came from.

The score comes from a gradient-boosted model trained on launches this tool collected itself and
retrained on a schedule you control. No wallet key is needed, and nothing leaves your machine.

## What the number means

Exactly one thing: **will this launch reach its graduation threshold**. On pons v2 a token opens on a
bonding curve and moves to a Uniswap v4 pool once enough of the quote asset is paired. That is the
event being predicted, and it is rare — about **2.5%** of launches graduate.

It is not a safety rating, not a price forecast, and not advice. It exists so you do not have to read
every launch, and the card exists so you can check it rather than trust it.

Two numbers worth knowing before you rely on the score:

- **Half of all graduations happen within 108 seconds of launch.** 90% within an hour. If you are
  reading a launch an hour late, the outcome is usually already decided.
- Across six rolling-origin folds on a 9-hour window (13,894 launches, 358 graduations), the top
  decile of the score graduated at **2.61x the base rate on average** (sd 0.79, worst fold 1.83x),
  with a mean ROC-AUC of 0.657. That is a useful edge, not a crystal ball. Most launches at the top
  of the list still do not graduate.
- **In one of those six folds the model was no better than chance** (ROC 0.516). It works on average
  and stops working in some stretches. Run `npm run validate` yourself rather than trusting a single
  split, and re-run it after every retrain.

## Install

Requires Node 22.6 or newer (it runs the TypeScript directly, so there is no build step).

```bash
npm install
cp .env.example .env
npm run doctor
```

`doctor` verifies both RPC endpoints, the chain id, and that the factory's own getters still match
the addresses in `src/config.ts`. Run it first; if it fails, nothing downstream will work.

## Use

```bash
npm run backfill -- --hours 24    # pull launch and graduation history
npm run enrich-window -- --hours 10   # decode the launch transactions in a contiguous window
npm run train                     # fit the model, print held-out metrics
npm run validate                  # rolling-origin folds: does the signal repeat?
npm run board                     # http://localhost:4663
npm run watch                     # live feed in the terminal
```

`backfill` is fast (a day of history in about 30 seconds). `enrich-window` is the slow part, roughly
six launches a second, because it reads each launch transaction to recover the creator's declared
terms. Run it for as many hours as you have patience for; the model gets better with more.

### Why `enrich-window` and not `enrich`

Training needs an *unbiased* sample. Enriching "all the graduated ones plus a scattering of others"
is fine for asking whether a feature separates the classes, but a model fitted on it is calibrated to
a positive rate that does not exist, and the score reads far too high. `enrich-window` fills a
contiguous span completely, and `train` refuses to run on anything else — it finds the longest run of
hours with ≥98% coverage and uses only that.

## How it works

```
factory logs  ──▶  SQLite  ──▶  features at T+0  ──▶  GBDT  ──▶  score + rank + reasons
   (poll)          (local)       (leak-free)                          card (facts + tx links)
```

- **Ingest** (`src/ingest.ts`, `src/live.ts`) follows the pons v2 factory. The official RPC has no
  websocket, so a publicnode socket carries detection while the official endpoint serves the log
  reads. Every path funnels through the same catch-up read, so a dropped socket, a missed
  notification or a restart all recover by pulling the gap. Writes are upserts keyed on on-chain
  identifiers, so replaying a range is harmless.
- **Storage** (`src/db.ts`) is `node:sqlite`, which ships with Node — no native module to build on
  Windows. Amounts are stored twice: exact integers as strings, and floats for sorting.
- **Features** (`src/features.ts`) are computed strictly from what is knowable when the launch
  transaction lands. Nothing reads a trade, a price, or an outcome.
- **Model** (`src/model/gbdt.ts`) is gradient-boosted trees written out rather than pulled in, so the
  whole tool stays one runtime. Contributions decompose exactly, which is where the reasons come from.

### The three things that are easy to get wrong

These are documented because each one silently produces a plausible, wrong answer:

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

A fourth, in the model rather than the data: about half of launches do not go through the pons
router, so their calldata cannot be decoded and the creator's declared terms are simply unknown.
Folding that into "bought nothing" would poison the strongest signal, so absence is its own feature.

## Retraining

```bash
npm run nightly    # backfill, enrich, retrain, in that order
```

Point Windows Task Scheduler at it. `board` reloads the model per request, so a retrain is picked up
without restarting anything.

Labels settle quickly — the 4-hour horizon captures 98.5% of graduations — so a nightly retrain
always has fresh, fully resolved labels to learn from.

## Limits

- **The model is not stable over time.** One fold in six scored at chance, and no feature ablation
  recovered it — removing the congestion features, the time-of-day feature, or the whole creator
  history block all left that stretch at ROC ~0.50. Some periods are simply not predictable from what
  is knowable at launch. Treat the score as an average edge, not a per-launch guarantee.
- Each fold rests on 30-45 positive examples. The direction is solid and repeats; the exact
  multipliers are noisy. Collect more days before leaning on them.
- Launch tactics drift, and a public score invites gaming. Retrain, and watch whether the top decile's
  realised rate holds.
- Evaluation so far covers a single 9-hour window. Nothing here has been tested across days, weekends,
  or a market-wide regime change.
- The public endpoints rate-limit. `.env` ships with polite defaults; raise them if you bring your own
  provider.

## License

MIT.
