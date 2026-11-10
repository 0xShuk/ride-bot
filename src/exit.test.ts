import { describe, expect, it } from "vitest";
import { exitLine, exitStep } from "./exit";

const T = 1_000_000;

describe("exitLine", () => {
  it("is the floor until the peak reaches 6%", () => {
    expect(exitLine(0.059, 0)).toBe(0.044);
  });

  it("then keeps 60% of the peak, or more room for a jumpy coin, never under the floor", () => {
    expect(exitLine(0.1, 0.002)).toBeCloseTo(0.06);
    expect(exitLine(0.1, 0.025)).toBeCloseTo(0.05);
    expect(exitLine(0.1, 0.04)).toBe(0.044);
  });
});

describe("exitStep", () => {
  it("asks Claude the first time the call reaches the take-profit, not before", () => {
    expect(exitStep(0.049, 0.049, null, T, 0, 0).step).toBe("none");
    expect(exitStep(0.05, 0.05, null, T, 0, 0).step).toBe("review");
  });

  it("while holding, rides out a dip between 5% and the floor", () => {
    expect(exitStep(0.045, 0.055, T, T + 30, 0, 0, 0.055)).toEqual({ step: "none", below: 0 });
  });

  it("closes only after two checks in a row at or under the line", () => {
    const first = exitStep(0.044, 0.055, T, T + 30, 0, 0);
    expect(first).toEqual({ step: "none", below: 1 });
    expect(exitStep(0.046, 0.055, T, T + 60, 0, first.below).below).toBe(0);
    expect(exitStep(0.043, 0.055, T, T + 60, 0, first.below).step).toBe("close");
    expect(exitStep(0.059, 0.1, T, T + 60, 0.002, 1).step).toBe("close");
  });

  it("while holding, asks again after 5 minutes", () => {
    expect(exitStep(0.07, 0.075, T, T + 299, 0, 0).step).toBe("none");
    expect(exitStep(0.07, 0.075, T, T + 300, 0, 0).step).toBe("review");
  });

  it("while holding, asks again at once after a pullback from the high since the last hold", () => {
    expect(exitStep(0.071, 0.085, T, T + 30, 0, 0, 0.085).step).toBe("none");
    expect(exitStep(0.07, 0.085, T, T + 30, 0, 0, 0.085).step).toBe("review");
  });
});
