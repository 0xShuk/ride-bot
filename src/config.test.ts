import { describe, expect, it, vi } from "vitest";
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

describe("fund profiles", () => {
  it("defaults to fomcvault and loads ridor from FUND_KEY", async () => {
    vi.resetModules();
    vi.stubEnv("FUND_KEY", "ridor");
    const c = await import("./config");
    expect(c.FUND.key).toBe("ridor");
    expect(c.FUND.bondAtoms).toBe(2_500_000n * 1_000_000n);
    expect(c.STYLE).toBe("swing");
    expect(c.MAX_CALLS_PER_DAY).toBe(5);
    expect(c.SKIP_MINTS.has("12nord6GuoXXzjuCanmu6RGDgd4LatVbzPBQep5rride")).toBe(true);
    expect(c.parseWindows("1440,2880")).toEqual([1440, 2880]);
    vi.unstubAllEnvs();
    vi.resetModules();
    expect((await import("./config")).FUND.key).toBe("fomcvault");
  });

  it("rejects an unknown fund", async () => {
    vi.resetModules();
    vi.stubEnv("FUND_KEY", "nope");
    await expect(import("./config")).rejects.toThrow(/FUND_KEY/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
