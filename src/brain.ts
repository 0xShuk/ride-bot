// The AI half of the brain: Claude picks one token and a window from the shortlist, or passes.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  HOLD_REVIEW_EVERY_SECS,
  LOCK_FLOOR,
  MAX_CALLS_PER_DAY,
  PULLBACK_REVIEW,
  MODEL,
  STYLE,
  TAKE_PROFIT,
  TRAIL_FROM,
  TRAIL_KEEP,
  TRAIL_SWINGS,
  type WindowMin,
} from "./config";
import type { Candle, ListToken } from "./market";
import type { Tier } from "./rules";

/** Candles of one timeframe, oldest first, with the label Claude sees ("15m", "1h", ...). */
export type Chart = { label: string; candles: Candle[] };

export type Candidate = {
  token: ListToken;
  charts: Chart[];
  /** All-in round-trip swap cost at the call's size (0.004 = 0.4%). */
  roundTripCost: number;
  tier: Tier;
  /** Average hourly candle range over the last 24h (0.02 = 2%). */
  hourlyRange: number;
};
/** One of the bot's calls still inside its window; pnl from the market price, null if unpriced. */
export type OpenCall = { symbol: string; minutesLeft: number; pnl: number | null };
export type Decision =
  | { action: "trade"; mint: string; symbol: string; durationSecs: number; reason: string }
  | { action: "pass"; reason: string };

const hours = (m: number) =>
  m % 60 ? `${m} minutes` : m % 1440 === 0 ? `${m / 1440} day${m === 1440 ? "" : "s"}` : `${m / 60} hour${m === 60 ? "" : "s"}`;

function system(windows: WindowMin[]): string {
  return STYLE === "swing" ? swingSystem(windows) : steadySystem(windows);
}

function swingSystem(windows: WindowMin[]): string {
  return `You run a small, high-risk autonomous trading experiment on Solana.
Each call buys one token with USDC, holds it for a fixed window (${windows.map(hours).join(" or ")}), then sells it back to USDC.
Profit is only what comes back minus what went in; there is no stop-loss.
The goal is big moves: pick the candidate most likely to rise ${TAKE_PROFIT * 100}% or more within the window. A loss is acceptable when the upside was large.
The vault wants its ${MAX_CALLS_PER_DAY ?? "few"} calls a day used: call the best candidate most rounds. Pass only when every candidate is clearly broken: collapsing on every timeframe with no buyers, a likely rug, or a vertical spike sitting at its top on fading volume.
If a call is up ${TAKE_PROFIT * 100}% before the window ends, you are asked whether to close it early or keep holding.
You get a shortlist of liquid tokens with strong recent momentum, with hourly and 4-hour candles.
Look for momentum with room to run: a breakout from a long base or range, a strong trend making higher highs and higher lows, or a clean reclaim after a deep pullback, with rising volume behind it.
Avoid tokens that are already extended far above every recent range after a vertical move with fading volume, and tokens bleeding on every timeframe.
Pick 2 days when the move needs time to develop, 1 day when it is already under way. Each candidate shows its round-trip swap cost.
${MIX}`;
}

function steadySystem(windows: WindowMin[]): string {
  return `You run an autonomous caller on a community trading vault on Solana.
Each call buys one token with USDC, holds it for a fixed window (${windows.map(hours).join(" or ")}), then sells it back to USDC. There is no stop-loss.
Calls pay through the early close: once a call is up ${TAKE_PROFIT * 100}%, it can be closed early or held for more. In past calls, coins moving under 4% an hour almost never got there, while coins moving 8%+ an hour paid nearly all the profit, with some losses of 10% or more along the way.
So the shortlist holds only volatile coins (each shows its average hourly range), with no fresh 5-minute spike, mixing sizes where it can, with 15-minute and hourly candles and the round-trip swap cost.
The vault wants steady activity: calls are expected most rounds. Pick the coin most likely to swing up ${TAKE_PROFIT * 100}% or more inside the window, and the window that fits it. Pass only when every candidate is clearly broken: collapsing on every timeframe with no buyers, a likely rug, or a vertical spike sitting at its top on fading volume.
Prefer a coin bouncing off support or breaking out of a range with volume coming in over one already far above its range.
Pick the longer window when the move needs time to develop.
${MIX}`;
}

const MIX = `You also see the calls already open. Calls that move together win or lose together, so spread the risk: never pick a coin likely to move with an open call (same narrative or sector, or another wrapper of the same asset), and balance sizes, adding a mid or small cap when the open calls are large caps and the other way round. Every call should be a real opportunity, not a filler.`;

const pct = (x: number | null) => (x === null ? "n/a" : `${x.toFixed(2)}%`);
const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);
const closes = (cs: Candle[]) => cs.map((c) => Number(c.c.toPrecision(5))).join(", ");
const vols = (cs: Candle[]) => cs.map((c) => Math.round(c.v)).join(", ");

/** The first chart with closes and volumes, the rest with closes only. */
const chartLines = (charts: Chart[], indent: string) =>
  charts.flatMap(({ label, candles }, i) => [
    `${indent}last ${candles.length} ${label} closes: ${closes(candles)}`,
    ...(i === 0 ? [`${indent}last ${candles.length} ${label} volumes: ${vols(candles)}`] : []),
  ]);

export function describe(cands: Candidate[]): string {
  return cands
    .map(({ token: t, charts, roundTripCost, tier, hourlyRange }, i) =>
      [
        `${i + 1}. ${t.symbol} (${tier} cap) — price $${t.price.toPrecision(5)}, liquidity ${usd(t.liquidity)}, 24h volume ${usd(t.volume24h)}, round-trip cost ~${(roundTripCost * 100).toFixed(2)}%, average hourly range ${(hourlyRange * 100).toFixed(1)}%`,
        `   change 5m ${pct(t.change5m)}, 1h ${pct(t.change1h)}, 6h ${pct(t.change6h)}, 24h ${pct(t.change24h)}`,
        ...chartLines(charts, "   "),
      ].join("\n"),
    )
    .join("\n\n");
}

export function describeOpen(open: OpenCall[]): string {
  if (!open.length) return "Open calls: none.";
  const line = (o: OpenCall) =>
    `- ${o.symbol}: ${o.pnl === null ? "price n/a" : `${o.pnl >= 0 ? "+" : ""}${(o.pnl * 100).toFixed(1)}%`}, ${Math.round(o.minutesLeft)} minutes left`;
  return ["Open calls:", ...open.map(line)].join("\n");
}

export type HoldReview = {
  symbol: string;
  pnl: number;
  peakPnl: number;
  minutesLeft: number;
  charts: Chart[];
};

const REVIEW_SYSTEM = `You manage one open call in a small autonomous trading experiment on Solana: a token bought with USDC, sold back automatically when its window ends.
Gains are what selling the whole position would return now, after swap costs. It is up at least ${TAKE_PROFIT * 100}%. Decide whether to close it now and lock the gain, or keep holding for a higher price.
If you hold, you are asked again in ${HOLD_REVIEW_EVERY_SECS / 60} minutes, or at once if the gain falls ${PULLBACK_REVIEW * 100} points below where it is now (or below any higher point it reaches). Meanwhile the call is closed automatically if its gain stays at ${LOCK_FLOOR * 100}% or below for a minute.
Once its peak reaches ${TRAIL_FROM * 100}%, it is also closed if the gain stays for a minute below ${TRAIL_KEEP * 100}% of the peak (or ${TRAIL_SWINGS} typical 1-minute swings under it, whichever is lower).
An early close is only possible while the gain is above 4%; once it falls below, the call can only be sold at the end of its window, at whatever the price is then.
${STYLE === "swing" ? "This is a high-risk vault chasing big moves: pullbacks of several points are normal, and a strong trend is worth holding for a much larger gain. " : "Small pullbacks after a move are normal. "}Hold when the trend is still up (higher lows, steady or rising volume, no sharp rejection from the high). Close when the move is stalling, reversing, or spiking on fading volume, or when little time is left.`;

export class Brain {
  private client: Anthropic;
  constructor(
    apiKey: string,
    private windows: WindowMin[],
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async decide(cands: Candidate[], open: OpenCall[]): Promise<Decision> {
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
      messages: [{ role: "user", content: `Time: ${new Date().toISOString()}\n\n${describeOpen(open)}\n\nShortlist:\n\n${describe(cands)}` }],
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

  /** Past the take-profit: close now or keep holding. Throws on an API error; the caller closes then. */
  async reviewHold(r: HoldReview): Promise<{ action: "close" | "hold"; reason: string }> {
    const Verdict = z.object({
      action: z.enum(["close", "hold"]),
      reason: z.string().describe("One or two sentences on why."),
    });
    const res = await this.client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(Verdict) },
      system: REVIEW_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Time: ${new Date().toISOString()}`,
            `${r.symbol}: up ${(r.pnl * 100).toFixed(2)}% now, peak ${(r.peakPnl * 100).toFixed(2)}%, ${Math.round(r.minutesLeft)} minutes left in the window.`,
            ...chartLines(r.charts, ""),
          ].join("\n"),
        },
      ],
    });
    const v = res.parsed_output;
    if (res.stop_reason === "refusal" || !v) return { action: "close", reason: "no usable answer, locking the gain" };
    return v;
  }
}
