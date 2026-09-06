import type { FeatureName } from "../features.ts";
import { FEATURES } from "../features.ts";
import { contributions, type GbdtModel } from "./gbdt.ts";

/**
 * Turns the model's per-feature contributions into the three lines shown under a score.
 *
 * The phrasing states the observed fact and the direction, never a recommendation. A reason is only
 * shown if the model actually used it for this launch, so a card never explains a score with
 * something that did not move it.
 */
export type Reason = { text: string; direction: "up" | "down"; weight: number; feature: FeatureName };

type Phrase = (v: number) => string | null;

/** One phrasing per feature. Returning null suppresses a reason that would read as noise. */
const PHRASE: Record<FeatureName, Phrase> = {
  calldata_decoded: (v) => (v === 0 ? "launched outside the pons router, so the creator's declared terms are unreadable" : null),
  exempt_count: (v) => (v > 0 ? `creator waived the opening tax for ${v} wallet${v === 1 ? "" : "s"}` : null),
  exempt_is_zero: (v) => (v === 1 ? "no wallets were exempted from the opening tax" : null),
  log_initial_buy: (v) => {
    const eth = (Math.expm1(v) / 1000);
    return eth > 0 ? `creator bought ${eth < 0.01 ? eth.toFixed(4) : eth.toFixed(3)} ETH of their own launch` : null;
  },
  initial_buy_is_zero: (v) => (v === 1 ? "creator bought none of their own launch" : null),
  creator_tax_bps: (v) => (v > 0 ? `creator set a ${(v / 100).toFixed(2)}% ongoing tax` : "creator set no ongoing tax"),
  buyback_enabled: (v) => (v === 1 ? "buyback is enabled" : null),
  socials_count: (v) => (v === 0 ? "no social links declared" : `${v} social link${v === 1 ? "" : "s"} declared`),
  has_twitter: (v) => (v === 1 ? "an X account is linked" : null),
  has_website: (v) => (v === 1 ? "a website is linked" : null),
  fee_redirected: (v) => (v === 1 ? "creator fees are routed to a different wallet than the launcher" : null),
  via_contract: (v) => (v === 1 ? "launched through a batching contract, not directly" : null),
  is_eth_quoted: (v) => (v === 1 ? "quoted in ETH" : "quoted in a token, not ETH"),
  log_threshold: (v) => `graduation needs ${Math.expm1(v).toFixed(2)} of the quote asset`,
  desc_len: (v) => (v === 0 ? "no description" : null),
  symbol_len: () => null,
  dev_prior_launches: (v) => (v > 0 ? `this creator has launched ${v} token${v === 1 ? "" : "s"} before` : null),
  dev_prior_graduations: (v) => (v > 0 ? `${v} of this creator's earlier launches graduated` : null),
  dev_prior_grad_rate: (v) => (v > 0 ? `this creator graduates ${(100 * v).toFixed(0)}% of their launches` : null),
  dev_is_first_launch: (v) => (v === 1 ? "first launch from this creator" : null),
  exempt_seen_before: (v) => (v > 0 ? `${v} exempted wallet${v === 1 ? " has" : "s have"} appeared in earlier launches` : null),
  hour_utc: () => null,
  launches_prior_hour: (v) => (v > 400 ? `busy hour: ${v} launches in the last 60 minutes` : null),
};

export function explain(model: GbdtModel, x: Float64Array, limit = 3): Reason[] {
  const { contribs } = contributions(model, x);
  const out: Reason[] = [];
  for (let i = 0; i < FEATURES.length; i++) {
    const w = contribs[i];
    if (Math.abs(w) < 0.01) continue;
    const text = PHRASE[FEATURES[i]](x[i]);
    if (!text) continue;
    out.push({ text, direction: w > 0 ? "up" : "down", weight: w, feature: FEATURES[i] });
  }
  return out.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, limit);
}
