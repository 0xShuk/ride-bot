// What to do with an open call this monitor tick: nothing, ask Claude (close or hold), or close now.

import { HOLD_REVIEW_EVERY_SECS, LOCK_FLOOR, TAKE_PROFIT, TRAIL_POINTS } from "./config";

export type ExitStep = { step: "none" } | { step: "review" } | { step: "close"; why: string };

/**
 * `lastReviewAt` is null until Claude first chooses to hold past the take-profit. From then on the
 * floor and the trail close the call without asking, and Claude is asked again every few minutes.
 */
export function exitStep(pnl: number, peak: number, lastReviewAt: number | null, now: number): ExitStep {
  if (lastReviewAt === null) return pnl >= TAKE_PROFIT ? { step: "review" } : { step: "none" };
  if (pnl <= LOCK_FLOOR) return { step: "close", why: `fell to ${(LOCK_FLOOR * 100).toFixed(1)}% floor` };
  if (pnl <= peak - TRAIL_POINTS) return { step: "close", why: `${(TRAIL_POINTS * 100).toFixed(0)} points off its ${(peak * 100).toFixed(1)}% peak` };
  if (now - lastReviewAt >= HOLD_REVIEW_EVERY_SECS) return { step: "review" };
  return { step: "none" };
}
