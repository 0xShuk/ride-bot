// What to do with an open call this monitor tick: nothing, ask Claude (close or hold), or close now.

import { CONFIRM_CHECKS, HOLD_REVIEW_EVERY_SECS, LOCK_FLOOR, TAKE_PROFIT, TRAIL_FROM, TRAIL_KEEP, TRAIL_SWINGS } from "./config";

export type ExitStep = { step: "none" } | { step: "review" } | { step: "close"; why: string };

/** The gain at which a held call closes: the floor, until the peak reaches TRAIL_FROM; then whichever of
 *  "keep TRAIL_KEEP of the peak" and "peak minus TRAIL_SWINGS typical 1m swings" leaves more room. */
export function exitLine(peak: number, swing: number): number {
  if (peak < TRAIL_FROM) return LOCK_FLOOR;
  return Math.max(LOCK_FLOOR, Math.min(peak * TRAIL_KEEP, peak - TRAIL_SWINGS * swing));
}

/**
 * `pnl` and `peak` are gains by the sell quote. `lastReviewAt` is null until Claude first chooses to hold
 * past the take-profit. From then on the call closes once it has been at or under its exit line for
 * CONFIRM_CHECKS checks in a row (`below` counts the earlier ones; the result carries the new count),
 * and Claude is asked again every few minutes.
 */
export function exitStep(
  pnl: number,
  peak: number,
  lastReviewAt: number | null,
  now: number,
  swing: number,
  below: number,
): ExitStep & { below: number } {
  if (lastReviewAt === null) return { ...(pnl >= TAKE_PROFIT ? { step: "review" } : { step: "none" }), below: 0 };
  const line = exitLine(peak, swing);
  if (pnl <= line) {
    if (below + 1 >= CONFIRM_CHECKS) {
      const why = line === LOCK_FLOOR ? `stayed at the ${(LOCK_FLOOR * 100).toFixed(1)}% floor` : `stayed under ${(line * 100).toFixed(1)}%, trailing its ${(peak * 100).toFixed(1)}% peak`;
      return { step: "close", why, below: below + 1 };
    }
    return { step: "none", below: below + 1 };
  }
  if (now - lastReviewAt >= HOLD_REVIEW_EVERY_SECS) return { step: "review", below: 0 };
  return { step: "none", below: 0 };
}
