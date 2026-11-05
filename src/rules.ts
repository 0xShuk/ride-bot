// The rules half of the brain: narrow liquid tokens down to a few worth showing Claude.

import { MAX_PUMP_5M_PCT, MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, SKIP_MINTS } from "./config";
import type { ListToken } from "./market";

/** Down ~90%+ on every timeframe Birdeye reported: a rug, not a dip. */
const rugged = (t: ListToken) =>
  [t.change5m, t.change1h, t.change6h, t.change24h].every((c) => c !== null && c <= -90);

/**
 * Score for a 1- to 6-hour Up call: an established trend (1h, 6h, 24h) counts, a fresh
 * 5-minute jump counts against (the calls that bought right after one lost the most),
 * and activity (volume relative to liquidity) breaks ties. Big moves are damped, since
 * a token far above its range tends to give some back.
 */
export function score(t: ListToken): number {
  const c5 = t.change5m ?? 0;
  const c1h = t.change1h ?? 0;
  const c6h = t.change6h ?? 0;
  const c24h = t.change24h ?? 0;
  const damp = (x: number, cap: number) => (x > cap ? cap - (x - cap) * 0.5 : x);
  const turnover = t.liquidity > 0 ? Math.min(t.volume24h / t.liquidity, 50) : 0;
  return damp(c1h, 6) + 0.8 * damp(c6h, 20) + 0.3 * damp(c24h, 40) - 1.5 * Math.max(0, c5 - 0.5) + Math.log1p(turnover);
}

export function eligible(t: ListToken, verified: Map<string, number>): boolean {
  return (
    verified.has(t.mint) &&
    !SKIP_MINTS.has(t.mint) &&
    t.liquidity >= MIN_LIQUIDITY_USD &&
    t.volume24h >= MIN_VOLUME_24H_USD &&
    (t.change5m ?? 0) <= MAX_PUMP_5M_PCT &&
    !rugged(t)
  );
}

/** The best `size` eligible tokens by score, skipping any in `exclude` (e.g. at their limit). */
export function shortlist(
  tokens: ListToken[],
  verified: Map<string, number>,
  size: number,
  exclude: Set<string> = new Set(),
): ListToken[] {
  const seen = new Set<string>();
  return tokens
    .filter((t) => eligible(t, verified) && !exclude.has(t.mint) && !seen.has(t.mint) && seen.add(t.mint))
    .sort((a, b) => score(b) - score(a))
    .slice(0, size);
}
