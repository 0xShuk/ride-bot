// The AI half of the brain: Claude picks one token and a window from the shortlist, or passes.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { DURATIONS, MODEL, type Duration } from "./config";
import type { Candle, ListToken } from "./market";

export type Candidate = { token: ListToken; candles5m: Candle[]; candles1h: Candle[] };
export type Decision =
  | { action: "trade"; mint: string; symbol: string; durationSecs: Duration; reason: string }
  | { action: "pass"; reason: string };

const Pick = z.object({
  action: z.enum(["trade", "pass"]),
  symbol: z.string().describe("Ticker of the chosen token, exactly as listed. Empty string when passing."),
  duration_minutes: z.enum(["5", "30", "60"]).describe("Window for the call. Ignored when passing."),
  reason: z.string().describe("One or two sentences on why."),
});

const SYSTEM = `You run a small autonomous trading experiment on Solana.
Each call is a long (Up) position in one token, held for a fixed window of 5, 30 or 60 minutes, then sold.
A call is closed early once it is up 5%. A loss costs the position's drop in value.
You get a shortlist of liquid tokens ranked by short-term momentum, with recent candles.
Pick at most one token and the window that best fits its setup, or pass if nothing looks likely to rise within an hour.
Prefer clean, sustained moves with rising volume over single-candle spikes or tokens far above their recent range.
Match the window to the move: 5 minutes for a sharp fresh breakout, 30 for a steady trend, 60 for a slower grind.`;

const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)}%`);
const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
const closes = (cs: Candle[]) => cs.map((c) => Number(c.c.toPrecision(5))).join(", ");
const vols = (cs: Candle[]) => cs.map((c) => Math.round(c.v)).join(", ");

export function describe(cands: Candidate[]): string {
  return cands
    .map(({ token: t, candles5m, candles1h }, i) =>
      [
        `${i + 1}. ${t.symbol} — price $${t.price.toPrecision(5)}, liquidity ${usd(t.liquidity)}, 24h volume ${usd(t.volume24h)}`,
        `   change 5m ${pct(t.change5m)}, 1h ${pct(t.change1h)}, 6h ${pct(t.change6h)}, 24h ${pct(t.change24h)}`,
        `   last ${candles5m.length} 5m closes: ${closes(candles5m)}`,
        `   last ${candles5m.length} 5m volumes: ${vols(candles5m)}`,
        `   last ${candles1h.length} 1h closes: ${closes(candles1h)}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export class Brain {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(cands: Candidate[]): Promise<Decision> {
    if (!cands.length) return { action: "pass", reason: "empty shortlist" };
    const res = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(Pick) },
      system: SYSTEM,
      messages: [{ role: "user", content: `Time: ${new Date().toISOString()}\n\nShortlist:\n\n${describe(cands)}` }],
    });
    if (res.stop_reason === "refusal") return { action: "pass", reason: "model declined" };
    const pick = res.parsed_output;
    if (!pick) return { action: "pass", reason: "no parsable answer" };
    if (pick.action === "pass") return { action: "pass", reason: pick.reason };
    const chosen = cands.find((c) => c.token.symbol === pick.symbol);
    if (!chosen) return { action: "pass", reason: `picked ${pick.symbol}, not on the shortlist` };
    const durationSecs = (Number(pick.duration_minutes) * 60) as Duration;
    if (!DURATIONS.includes(durationSecs)) return { action: "pass", reason: `bad window ${pick.duration_minutes}` };
    return { action: "trade", mint: chosen.token.mint, symbol: chosen.token.symbol, durationSecs, reason: pick.reason };
  }
}
