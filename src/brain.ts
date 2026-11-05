// The AI half of the brain: Claude picks one token and a window from the shortlist, or passes.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MODEL, TAKE_PROFIT, type WindowMin } from "./config";
import type { Candle, ListToken } from "./market";

export type Candidate = {
  token: ListToken;
  candles15m: Candle[];
  candles1h: Candle[];
  /** All-in round-trip swap cost at the call's size (0.004 = 0.4%). */
  roundTripCost: number;
};
export type Decision =
  | { action: "trade"; mint: string; symbol: string; durationSecs: number; reason: string }
  | { action: "pass"; reason: string };

const hours = (m: number) => (m % 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`);

function system(windows: WindowMin[]): string {
  return `You run a small autonomous trading experiment on Solana.
Each call buys one token with USDC, holds it for a fixed window (${windows.map(hours).join(", ")}), then sells it back to USDC.
Profit is only what comes back minus what went in. The call is closed early once it is up ${TAKE_PROFIT * 100}%; there is no stop-loss.
Swapping in and out costs money: each candidate shows its estimated round-trip cost. A call only wins if the price rises by more than that.
You get a shortlist of liquid tokens already filtered to established uptrends without a fresh 5-minute spike, with 15-minute and hourly candles.
Pick at most one token and the window that best fits its setup, or pass if none is likely to rise clearly more than its cost within the window.
Avoid tokens that already ran far above their recent range: buying near short-term tops lost the most in earlier calls.
Prefer a pullback or consolidation inside a trend that is still intact, with steady or rising volume.
Pick longer windows for slower trends; the price needs time to move well past the swap cost.`;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)}%`);
const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
const closes = (cs: Candle[]) => cs.map((c) => Number(c.c.toPrecision(5))).join(", ");
const vols = (cs: Candle[]) => cs.map((c) => Math.round(c.v)).join(", ");

export function describe(cands: Candidate[]): string {
  return cands
    .map(({ token: t, candles15m, candles1h, roundTripCost }, i) =>
      [
        `${i + 1}. ${t.symbol} — price $${t.price.toPrecision(5)}, liquidity ${usd(t.liquidity)}, 24h volume ${usd(t.volume24h)}, round-trip cost ~${(roundTripCost * 100).toFixed(2)}%`,
        `   change 5m ${pct(t.change5m)}, 1h ${pct(t.change1h)}, 6h ${pct(t.change6h)}, 24h ${pct(t.change24h)}`,
        `   last ${candles15m.length} 15m closes: ${closes(candles15m)}`,
        `   last ${candles15m.length} 15m volumes: ${vols(candles15m)}`,
        `   last ${candles1h.length} 1h closes: ${closes(candles1h)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export class Brain {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private windows: WindowMin[],
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(cands: Candidate[]): Promise<Decision> {
    if (!cands.length) return { action: "pass", reason: "empty shortlist" };
    const Pick = z.object({
      action: z.enum(["trade", "pass"]),
      symbol: z.string().describe("Ticker of the chosen token, exactly as listed. Empty string when passing."),
      window_minutes: z
        .enum(this.windows.map(String) as [string, ...string[]])
        .describe("Holding window for the call. Ignored when passing."),
      reason: z.string().describe("One or two sentences on why."),
    });
    const res = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(Pick) },
      system: system(this.windows),
      messages: [{ role: "user", content: `Time: ${new Date().toISOString()}\n\nShortlist:\n\n${describe(cands)}` }],
    });
    if (res.stop_reason === "refusal") return { action: "pass", reason: "model declined" };
    const pick = res.parsed_output;
    if (!pick) return { action: "pass", reason: "no parsable answer" };
    if (pick.action === "pass") return { action: "pass", reason: pick.reason };
    const chosen = cands.find((c) => c.token.symbol === pick.symbol);
    if (!chosen) return { action: "pass", reason: `picked ${pick.symbol}, not on the shortlist` };
    const minutes = Number(pick.window_minutes);
    if (!(this.windows as number[]).includes(minutes)) return { action: "pass", reason: `bad window ${pick.window_minutes}` };
    return { action: "trade", mint: chosen.token.mint, symbol: chosen.token.symbol, durationSecs: minutes * 60, reason: pick.reason };
  }
}
