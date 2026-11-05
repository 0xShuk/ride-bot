import { describe, expect, it } from "vitest";
import { parseWindows } from "./config";

describe("parseWindows", () => {
  it("keeps supported windows, sorted and unique", () => {
    expect(parseWindows("360, 60,240,60")).toEqual([60, 240, 360]);
    expect(parseWindows("60")).toEqual([60]);
  });

  it("drops unsupported values and rejects an empty result", () => {
    expect(parseWindows("30,60")).toEqual([60]);
    expect(() => parseWindows("30")).toThrow();
  });
});
