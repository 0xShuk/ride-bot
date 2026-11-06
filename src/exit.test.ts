import { describe, expect, it } from "vitest";
import { exitStep } from "./exit";

const T = 1_000_000;

describe("exitStep", () => {
  it("asks Claude the first time the call reaches the take-profit, not before", () => {
    expect(exitStep(0.049, 0.049, null, T)).toEqual({ step: "none" });
    expect(exitStep(0.05, 0.05, null, T)).toEqual({ step: "review" });
  });

  it("while holding, closes at the floor or 2 points off the peak without asking", () => {
    expect(exitStep(0.045, 0.06, T, T + 30).step).toBe("close");
    expect(exitStep(0.09, 0.11, T, T + 30).step).toBe("close");
    expect(exitStep(0.095, 0.11, T, T + 30)).toEqual({ step: "none" });
  });

  it("while holding, asks again after 5 minutes", () => {
    expect(exitStep(0.07, 0.075, T, T + 299)).toEqual({ step: "none" });
    expect(exitStep(0.07, 0.075, T, T + 300)).toEqual({ step: "review" });
  });
});
