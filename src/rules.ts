// The rules half of the brain: narrow liquid tokens down to a few worth showing Claude.

import {
  LARGE_CAP_LIQUIDITY,
  MAX_PUMP_5M_PCT,
  MID_CAP_LIQUIDITY,
  MIN_LIQUIDITY_USD,
  MIN_MOVE_PCT,
  MIN_VOLUME_24H_USD,
  SKIP_MINTS,
  STYLE,
} from "./config";
import type { Candle, ListToken } from "./market";

/** Down ~90%+ on every timeframe Birdeye reported: a rug, not a dip. */
const rugged = (t: ListToken) =>
  [t.change5m, t.change1h, t.change6h, t.change24h].every((c) => c !== null && c <= -90);

/** Barely moved on every timeframe: a tokenized stock or pegged token, not a trade. */
const flat = (t: ListToken) => [t.change1h, t.change6h, t.change24h].every((c) => Math.abs(c ?? 0) < MIN_MOVE_PCT);

/** Down 10%+ on the 6h and down on the 24h: the -30% rides came from coins like this still falling. */
const bleeding = (t: ListToken) => (t.change6h ?? 0) <= -10 && (t.change24h ?? 0) < 0;

/** Shortlist score for the fund's style. */
export function score(t: ListToken): number {
  return STYLE === "swing" ? swingScore(t) : steadyScore(t);
}

/**
 * Score for a 1- to 2-day Up call chasing a big move: strong momentum on the 6h and 24h counts most,
 * with far more room before damping, and turnover shows real interest. A fresh 5-minute spike still
 * counts against.
 */
export function swingScore(t: ListToken): number {
  const c5 = t.change5m ?? 0;
  const c1h = t.change1h ?? 0;
  const c6h = t.change6h ?? 0;
  const c24h = t.change24h ?? 0;
  const damp = (x: number, cap: number) => (x > cap ? cap - (x - cap) * 0.5 : x);
  const turnover = t.liquidity > 0 ? Math.min(t.volume24h / t.liquidity, 50) : 0;
  return 0.5 * damp(c1h, 10) + damp(c6h, 40) + 0.6 * damp(c24h, 100) - Math.max(0, c5 - 2) + 2 * Math.log1p(turnover);
}

/**
 * Score for a 4- to 6-hour Up call: how much the coin is moving (the payouts come from coins that move
 * 8%+ an hour), tilted toward ones going up, with turnover for real interest. A fresh 5-minute jump
 * counts against (buying right after one lost the most), and so does a coin collapsing on the 6h.
 */
function steadyScore(t: ListToken): number {
  const c5 = t.change5m ?? 0;
  const c1h = t.change1h ?? 0;
  const c6h = t.change6h ?? 0;
  const c24h = t.change24h ?? 0;
  const moving = Math.abs(c1h) + 0.5 * Math.abs(c6h) + 0.2 * Math.abs(c24h);
  const up = 0.5 * c1h + 0.3 * c6h;
  const turnover = t.liquidity > 0 ? Math.min(t.volume24h / t.liquidity, 50) : 0;
  return moving + up - 1.5 * Math.max(0, c5 - 0.5) - Math.max(0, -c6h - 15) + 2 * Math.log1p(turnover);
}

export function eligible(t: ListToken, verified: Map<string, number>): boolean {
  return (
    verified.has(t.mint) &&
    !SKIP_MINTS.has(t.mint) &&
    t.liquidity >= MIN_LIQUIDITY_USD &&
    t.volume24h >= MIN_VOLUME_24H_USD &&
    (t.change5m ?? 0) <= MAX_PUMP_5M_PCT &&
    !rugged(t) &&
    !flat(t) &&
    !(STYLE === "steady" && bleeding(t))
  );
}

/** USDC for the next call. With `freeUsdc` of at least `slotsFrom`, an equal share of it across the
 *  slots the bot's `open` calls don't take yet (1/6 with 6 slots and nothing open); otherwise, or with
 *  `slots` null, `cap` of it. Never more than `cap`. */
export function callSize(freeUsdc: number, open: number, slots: number | null, cap: number, slotsFrom = 0): number {
  const share = slots === null || freeUsdc < slotsFrom ? cap : Math.min(cap, 1 / Math.max(1, slots - open));
  return Math.floor(freeUsdc * share);
}

export type Tier = "large" | "mid" | "small";
export const tier = (t: ListToken): Tier =>
  t.liquidity >= LARGE_CAP_LIQUIDITY ? "large" : t.liquidity >= MID_CAP_LIQUIDITY ? "mid" : "small";

/** Average hourly candle range (high - low over close): how far the coin typically moves in an hour. */
export const hourlyRange = (cs: Candle[]) => (cs.length ? cs.reduce((s, k) => s + (k.h - k.l) / k.c, 0) / cs.length : 0);

/**
 * Up to `size` eligible tokens, skipping any in `exclude` (already held, at their limit), taking the
 * best of each size tier in turn (large, mid, small caps) so the shortlist mixes risk instead of
 * being all one kind of coin.
 */
export function shortlist(
  tokens: ListToken[],
  verified: Map<string, number>,
  size: number,
  exclude: Set<string> = new Set(),
): ListToken[] {
  const seen = new Set<string>();
  const ranked = tokens
    .filter((t) => eligible(t, verified) && !exclude.has(t.mint) && !seen.has(t.mint) && seen.add(t.mint))
    .sort((a, b) => score(b) - score(a));
  const tiers = (["large", "mid", "small"] as const).map((k) => ranked.filter((t) => tier(t) === k));
  const out: ListToken[] = [];
  for (let i = 0; out.length < Math.min(size, ranked.length); i++) {
    for (const ts of tiers) if (ts[i] && out.length < size) out.push(ts[i]);
  }
  return out;
}
