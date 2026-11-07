import { describe, expect, it } from "vitest";
import { betDecidedFrom } from "./chain";

/** A bet account with only the fields betDecidedFrom reads set. */
function bet(o: { executedAt: boolean; cancelled: boolean; outcome: number }): Buffer {
  const d = Buffer.alloc(260);
  let i = 160;
  d[i++] = o.executedAt ? 1 : 0;
  if (o.executedAt) i += 8;
  d[i++] = o.cancelled ? 1 : 0;
  d[i] = o.outcome;
  return d;
}

describe("betDecidedFrom", () => {
  it("reads the outcome after an executed_at with or without a value", () => {
    expect(betDecidedFrom(bet({ executedAt: true, cancelled: false, outcome: 0 }))).toBe(false);
    expect(betDecidedFrom(bet({ executedAt: true, cancelled: false, outcome: 1 }))).toBe(true);
    expect(betDecidedFrom(bet({ executedAt: false, cancelled: false, outcome: 1 }))).toBe(true);
  });

  it("counts a cancelled bet as decided", () => {
    expect(betDecidedFrom(bet({ executedAt: true, cancelled: true, outcome: 0 }))).toBe(true);
  });
});
