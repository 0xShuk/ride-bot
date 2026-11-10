import { describe, expect, it } from "vitest";
import { FUND, USDC_MINT } from "./config";
import type { ListToken } from "./market";
import { callSize, eligible, hourlyRange, score, shortlist, swingScore } from "./rules";

const tok = (mint: string, o: Partial<ListToken> = {}): ListToken => ({
  mint,
  symbol: mint.toUpperCase(),
  price: 1,
  liquidity: 500_000,
  volume24h: 5_000_000,
  change5m: 0,
  change1h: 0,
  change6h: 0,
  change24h: 5,
  trades24h: 1000,
  ...o,
});
const verified = new Map([
  ["a", 6],
  ["b", 6],
  ["c", 6],
  ["d", 6],
  [USDC_MINT, 6],
  [FUND.bondMint, 6],
]);

describe("eligible", () => {
  it("needs Jupiter-verified, liquidity, volume, not a stablecoin or the bond coin", () => {
    expect(eligible(tok("a"), verified)).toBe(true);
    expect(eligible(tok("zz"), verified)).toBe(false);
    expect(eligible(tok("a", { liquidity: 99_999 }), verified)).toBe(false);
    expect(eligible(tok("a", { volume24h: 149_999 }), verified)).toBe(false);
    expect(eligible(tok(USDC_MINT), verified)).toBe(false);
    expect(eligible(tok(FUND.bondMint), verified)).toBe(false);
  });

  it("drops a token that jumped more than 3% in the last 5 minutes", () => {
    expect(eligible(tok("a", { change5m: 3 }), verified)).toBe(true);
    expect(eligible(tok("a", { change5m: 3.4 }), verified)).toBe(false);
  });

  it("drops a rug (down 90%+ on every timeframe) but keeps a token with gaps in its data", () => {
    expect(eligible(tok("a", { change5m: -91, change1h: -95, change6h: -95, change24h: -99 }), verified)).toBe(false);
    expect(eligible(tok("a", { change5m: null, change1h: -95, change6h: -95, change24h: -99 }), verified)).toBe(true);
  });
});

describe("flat coins", () => {
  it("skips a coin that moved under 2% on 1h, 6h and 24h alike", () => {
    expect(eligible(tok("a", { change1h: 0.3, change6h: -1.2, change24h: 1.9 }), verified)).toBe(false);
    expect(eligible(tok("a", { change1h: 0.3, change6h: -1.2, change24h: -2.5 }), verified)).toBe(true);
    expect(eligible(tok("a", { change1h: null, change6h: null, change24h: null }), verified)).toBe(false);
  });
});

describe("score", () => {
  it("ranks a coin swinging hard above a quiet one", () => {
    expect(score(tok("a", { change1h: -6, change6h: 12, change24h: 30 }))).toBeGreaterThan(score(tok("b", { change1h: 1, change6h: 2 })));
  });


  it("ranks an established trend above flat", () => {
    expect(score(tok("a", { change1h: 2, change6h: 6, change24h: 10 }))).toBeGreaterThan(score(tok("b")));
  });

  it("counts a fresh 5-minute jump against a token", () => {
    const calm = tok("a", { change5m: 0.2, change1h: 3, change6h: 8 });
    const jumped = tok("b", { change5m: 2.5, change1h: 3, change6h: 8 });
    expect(score(calm)).toBeGreaterThan(score(jumped));
  });

  it("damps a parabolic 5m spike below a steady climb", () => {
    const spike = tok("a", { change5m: 30, change1h: 30 });
    const steady = tok("b", { change5m: 3, change1h: 10 });
    expect(score(steady)).toBeGreaterThan(score(spike));
  });
});

describe("shortlist", () => {
  it("returns the top N eligible, skips excluded mints and duplicates", () => {
    const list = [
      tok("a", { change1h: 1 }),
      tok("b", { change1h: 5 }),
      tok("b", { change1h: 5 }),
      tok("c", { change1h: 3 }),
      tok("d", { change1h: 4 }),
      tok("zz", { change1h: 5.5 }),
    ];
    expect(shortlist(list, verified, 2).map((t) => t.mint)).toEqual(["b", "d"]);
    expect(shortlist(list, verified, 2, new Set(["b"])).map((t) => t.mint)).toEqual(["d", "c"]);
  });
});

describe("shortlist mix", () => {
  it("takes the best of each size tier in turn", () => {
    const list = [
      tok("a", { liquidity: 9_000_000, change1h: 5 }),
      tok("b", { liquidity: 8_000_000, change1h: 4 }),
      tok("c", { liquidity: 2_000_000, change1h: 1 }),
      tok("d", { liquidity: 300_000, change1h: 0.5 }),
    ];
    expect(shortlist(list, verified, 4).map((t) => t.mint)).toEqual(["a", "c", "d", "b"]);
  });
});

describe("hourlyRange", () => {
  it("averages high-low over close", () => {
    const k = (h: number, l: number, c: number) => ({ t: 0, o: c, h, l, c, v: 0 });
    expect(hourlyRange([k(102, 100, 100), k(104, 100, 100)])).toBeCloseTo(0.03);
    expect(hourlyRange([])).toBe(0);
  });
});

describe("swingScore", () => {
  it("ranks a strong 6h/24h run above a quiet steady climb", () => {
    const base = { ...tok("A"), liquidity: 100_000, volume24h: 1_000_000 };
    const runner = { ...base, change5m: 0.5, change1h: 3, change6h: 25, change24h: 60 };
    const quiet = { ...base, change5m: 0.2, change1h: 1, change6h: 3, change24h: 5 };
    expect(swingScore(runner)).toBeGreaterThan(swingScore(quiet));
  });

  it("counts a fresh 5-minute spike against", () => {
    const base = { ...tok("A"), liquidity: 100_000, volume24h: 1_000_000, change1h: 3, change6h: 25, change24h: 60 };
    expect(swingScore({ ...base, change5m: 8 })).toBeLessThan(swingScore({ ...base, change5m: 1 }));
  });
});

describe("callSize", () => {
  it("splits the free USDC equally over the slots left, capped", () => {
    expect(callSize(1200, 0, 6, 0.2425)).toBe(200);
    expect(callSize(1000, 1, 6, 0.2425)).toBe(200);
    expect(callSize(400, 4, 6, 0.2425)).toBe(97); // 1/2 would be over the cap
    expect(callSize(300, 6, 6, 0.2425)).toBe(72); // all slots taken: the cap
  });

  it("without slots, is the cap", () => {
    expect(callSize(1000, 3, null, 0.194)).toBe(194);
  });
});
