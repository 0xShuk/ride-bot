// The rules half of the brain: narrow liquid tokens down to a few worth showing Claude.

import { MIN_LIQUIDITY_USD, MIN_VOLUME_24H_USD, SKIP_MINTS } from "./config";
import type { ListToken } from "./market";

/** Down ~90%+ on every timeframe Birdeye reported: a rug, not a dip. */
const rugged = (t: ListToken) =>
  [t.change5m, t.change1h, t.change6h, t.change24h].every((c) => c !== null && c <= -90);

/**
 * Score for a 5-minute to 1-hour Up call: fresh momentum (5m, 1h) counts most,
 * a 6h trend helps, and activity (volume relative to liquidity) breaks ties.
 * Parabolic moves are damped, since they tend to give back inside an hour.
 */
export function score(t: ListToken): number {
  const c5 = t.change5m ?? 0;
  const c1h = t.change1h ?? 0;
  const c6h = t.change6h ?? 0;
  const damp = (x: number, cap: number) => (x > cap ? cap - (x - cap) * 0.5 : x);
  const turnover = t.liquidity > 0 ? Math.min(t.volume24h / t.liquidity, 50) : 0;
  return 2 * damp(c5, 4) + 1.5 * damp(c1h, 12) + 0.5 * damp(c6h, 30) + Math.log1p(turnover);
}

export function eligible(t: ListToken, verified: Map<string, number>): boolean {
  return (
    verified.has(t.mint) &&
    !SKIP_MINTS.has(t.mint) &&
    t.liquidity >= MIN_LIQUIDITY_USD &&
    t.volume24h >= MIN_VOLUME_24H_USD &&
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
