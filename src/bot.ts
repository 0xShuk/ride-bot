// The two loops: decide (every 15 min) and monitor open calls (every 30 s).

import { randomUUID } from "node:crypto";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { type Candidate, type OpenCall, Brain } from "./brain";
import { type Chain } from "./chain";
import {
  DECIDE_EVERY_MS,
  FUND,
  MAX_CALLS_PER_DAY,
  MAX_ROUND_TRIP_COST,
  MIN_HOURLY_RANGE,
  MIN_LIQUIDITY_USD,
  ROUND_TRIP_OVERHEAD,
  SHORTLIST_SIZE,
  SIZE_SHARE,
  SLOTS,
  STYLE,
  TAKE_PROFIT,
  TRAIL_FROM,
  USDC_MINT,
  type Env,
} from "./config";
import { exitStep } from "./exit";
import type { Candle, Market } from "./market";
import { type BuildOk, type RideApi, isReset, isTransient } from "./ride";
import { callSize, hourlyRange, shortlist, tier } from "./rules";
import type { CallRow, Store } from "./store";
import type { Telegram } from "./telegram";

const MIN_SOL = 0.02;
/** A call whose swap never ran is given up this long after its window would have ended. */
const STALE_AFTER_SECS = 3 * 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const mins = (secs: number) => (secs >= 3600 ? `${secs / 3600}h` : `${secs / 60}m`);

export class Bot {
  private lowBalanceAlertAt = 0;
  private lastRoundAt = 0;
  /** Per call: monitor checks in a row at or under its exit line. */
  private belowLine = new Map<number, number>();
  /** Per coin: typical 1-minute swing (mean high-low range / close), refreshed every 5 minutes. */
  private swings = new Map<string, { swing: number; at: number }>();

  constructor(
    private env: Env,
    private wallet: PublicKey,
    private kp: Keypair | null,
    private chain: Chain,
    private market: Market,
    private brain: Brain,
    private ride: RideApi,
    private store: Store,
    private tg: Telegram,
  ) {}

  // ---- deciding ----

  async decideRound(): Promise<void> {
    // One round per 15 minutes, counted from the last round this process ran and, across
    // restarts (e.g. each deploy), from the last decision in the database.
    const last = Math.max(this.lastRoundAt, (await this.store.lastDecisionAt()) ?? 0);
    if (Date.now() - last < DECIDE_EVERY_MS - 30_000) return;
    this.lastRoundAt = Date.now();
    if (this.env.killSwitch) {
      console.log("[decide] kill switch on: no new calls");
      return;
    }
    if (!(await this.balancesOk())) return;
    if (MAX_CALLS_PER_DAY !== null) {
      const made = await this.store.callsSince(Date.now() - 24 * 3600_000);
      if (made >= MAX_CALLS_PER_DAY) {
        console.log(`[decide] ${made} calls in the last 24h, the bot's cap is ${MAX_CALLS_PER_DAY}: skipping round`);
        return;
      }
    }

    const active = await this.store.activeCalls();
    // Calls whose USDC is still out (an early-closed one comes back within minutes).
    const open = active.filter((c) => c.status === "building" || c.status === "open").length;
    const usdc = callSize(await this.chain.treasuryUsdc(), open, SLOTS, SIZE_SHARE);
    if (usdc < 5) {
      console.log(`[decide] treasury too small for a call ($${usdc})`);
      return;
    }

    const [byVolume, movers, verified, stocks] = await Promise.all([
      this.market.topTokens(MIN_LIQUIDITY_USD),
      this.market.movers(MIN_LIQUIDITY_USD).catch((e) => {
        console.log(`[decide] movers list failed: ${e instanceof Error ? e.message : e}`);
        return [];
      }),
      this.market.verifiedMints(),
      this.market.stockMints(),
    ]);
    const tokens = [...byVolume, ...movers]; // shortlist() drops the repeats
    // One open call per coin (calls on the same coin win or lose together), and no tokenized stocks.
    const skip = new Set([...active.map((c) => c.mint), ...stocks]);
    // Six times the shortlist, then keep the ones with room under the fund's limits,
    // enough movement to reach the take-profit, and a cheap enough round trip at this call's size.
    const ranked = shortlist(tokens, verified, SHORTLIST_SIZE * 6, skip);
    const kept: { token: (typeof ranked)[number]; roundTripCost: number; hourly: Candle[] }[] = [];
    const skipped: string[] = [];
    const quiet: string[] = [];
    for (const t of ranked) {
      const l = await this.ride.limits(this.wallet.toBase58(), t.mint);
      if (l && (l.dailyFundRemaining <= 0 || l.velocityRemaining <= 0)) {
        console.log(`[decide] fund limit reached (daily ${l.dailyFundRemaining}, hourly ${l.velocityRemaining}): skipping round`);
        return;
      }
      if (l && (l.dailyTokenRemaining <= 0 || l.concurrentRemaining <= 0)) continue;
      const hourly = await this.market.candles(t.mint, "1H", STYLE === "swing" ? 48 : 24).catch(() => []);
      const range = hourlyRange(hourly.slice(-24));
      if (range < MIN_HOURLY_RANGE) {
        quiet.push(`${t.symbol} ${(range * 100).toFixed(2)}%`);
        continue;
      }
      const quoted = await this.market.roundTripCost(t.mint, usdc, this.wallet.toBase58(), USDC_MINT).catch(() => null);
      const cost = quoted === null ? null : quoted + ROUND_TRIP_OVERHEAD;
      if (cost === null || cost > MAX_ROUND_TRIP_COST) {
        skipped.push(`${t.symbol} ${cost === null ? "no quote" : `${(cost * 100).toFixed(2)}%`}`);
        continue;
      }
      kept.push({ token: t, roundTripCost: cost, hourly });
      if (kept.length === SHORTLIST_SIZE) break;
    }
    if (quiet.length) console.log(`[decide] moves too little (average hourly range): ${quiet.join(", ")}`);
    if (skipped.length) console.log(`[decide] too costly to trade at $${usdc}: ${skipped.join(", ")}`);
    if (!kept.length) {
      console.log("[decide] no eligible token with room and a cheap round trip");
      return;
    }

    const cands: Candidate[] = await Promise.all(
      kept.map(async ({ token, roundTripCost, hourly }) => ({
        token,
        roundTripCost,
        tier: tier(token),
        hourlyRange: hourlyRange(hourly.slice(-24)),
        charts:
          STYLE === "swing"
            ? [
                { label: "1h", candles: hourly },
                { label: "4h", candles: await this.market.candles(token.mint, "4H", 42).catch(() => []) },
              ]
            : [
                { label: "15m", candles: await this.market.candles(token.mint, "15m", 24).catch(() => []) },
                { label: "1h", candles: hourly },
              ],
      })),
    );
    const names = kept.map((k) => k.token.symbol);
    const d = await this.brain.decide(cands, await this.openBook(active));
    await this.store.logDecision({
      action: d.action,
      symbol: d.action === "trade" ? d.symbol : null,
      reason: d.reason,
      shortlist: names,
    });
    console.log(`[decide] shortlist ${names.join(", ")} → ${d.action === "trade" ? `${d.symbol} ${mins(d.durationSecs)}` : "pass"}: ${d.reason}`);
    if (d.action === "pass") return;

    if (this.env.dryRun) {
      await this.tg.send(`[dry run] would open ${d.symbol} Up for ${mins(d.durationSecs)}, ${money(usdc)}\n${d.reason}`);
      return;
    }
    await this.open({
      mint: d.mint,
      symbol: d.symbol,
      durationSecs: d.durationSecs,
      usdc,
      reason: d.reason,
      decimals: verified.get(d.mint) ?? 0,
    });
  }

  /** The bot's open calls as Claude sees them when picking the next one. */
  private async openBook(active: CallRow[]): Promise<OpenCall[]> {
    const now = Math.floor(Date.now() / 1000);
    const live = active.filter((c) => c.executedAt !== null && now < c.executedAt + c.durationSecs);
    const prices = await this.market.prices([...new Set(live.map((c) => c.mint))]).catch(() => new Map<string, number>());
    return live.map((c) => {
      const price = prices.get(c.mint);
      return {
        symbol: c.symbol,
        minutesLeft: (c.executedAt! + c.durationSecs - now) / 60,
        pnl: price && c.inputUsd && c.outputAtoms ? ((Number(c.outputAtoms) / 10 ** c.outputDecimals) * price) / c.inputUsd - 1 : null,
      };
    });
  }

  private async balancesOk(): Promise<boolean> {
    const [bondCoins, sol] = await Promise.all([
      this.chain.tokenBalance(this.wallet, FUND.bondMint),
      this.chain.solBalance(this.wallet),
    ]);
    const bond = Number(FUND.bondAtoms / 1_000_000n);
    if (bondCoins >= bond && sol >= MIN_SOL) return true;
    const msg = `Low balance: ${bondCoins.toLocaleString()} ${FUND.symbol} (need ${bond.toLocaleString()}), ${sol.toFixed(4)} SOL (need ${MIN_SOL}). No new calls.`;
    console.log(`[decide] ${msg}`);
    if (Date.now() - this.lowBalanceAlertAt > 6 * 3600_000) {
      this.lowBalanceAlertAt = Date.now();
      await this.tg.send(msg);
    }
    return false;
  }

  private async open(c: { mint: string; symbol: string; durationSecs: number; usdc: number; reason: string; decimals: number }) {
    const kp = this.kp!;
    const row = await this.store.createCall({
      idempotencyKey: `ridebot:${randomUUID()}`,
      mint: c.mint,
      symbol: c.symbol,
      durationSecs: c.durationSecs,
      usdcRequested: c.usdc,
      reason: c.reason,
      outputDecimals: c.decimals,
    });
    let built: BuildOk | null = null;
    let lastError = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const r = await this.ride.buildTrade({
        idempotencyKey: row.idempotencyKey,
        wallet: kp.publicKey.toBase58(),
        outputMint: c.mint,
        usdcAmount: c.usdc,
        evaluationPeriodSecs: c.durationSecs,
        outputSymbol: c.symbol,
      });
      if (!r.approved) {
        lastError = `${r.reasonCode}${r.reasonHuman ? `: ${r.reasonHuman}` : ""}`;
        if (isTransient(r) && !isReset(r)) {
          await sleep(3000 * attempt);
          continue;
        }
        break; // permanent, capacity or reset: give up on this call
      }
      built = r;
      await this.store.updateCall(row.id, { proposalPk: r.proposalPk, intentPk: r.intentPk });
      // A resume returns only the transactions not yet landed; an empty set means all are done.
      if (!r.txs.length) break;
      try {
        await this.chain.signAndSendInOrder(kp, r.txs);
        lastError = "";
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        console.error(`[open] ${c.symbol} attempt ${attempt}: ${lastError}`);
        await sleep(2000);
      }
    }

    if (built && !lastError) {
      await this.store.updateCall(row.id, { status: "open" });
      await this.tg.send(`Opened ${c.symbol} Up · ${mins(c.durationSecs)} · ${money(c.usdc)}\n${c.reason}\nhttps://www.ride.markets/funds/${FUND.key}/proposal/${built.proposalPk}`);
    } else if (built) {
      // The bond may already be locked: ride-api's backstop can still finish the swap, so keep watching it.
      await this.store.updateCall(row.id, { status: "open", error: lastError });
      await this.tg.send(`Opening ${c.symbol} hit an error after the build; watching it in case it completes.\n${lastError}`);
    } else {
      await this.store.updateCall(row.id, { status: "failed", error: lastError });
      await this.tg.send(`Could not open ${c.symbol}: ${lastError}`);
    }
  }

  /**
   * After a restart: a call left mid-open is watched if it got as far as a build
   * (its bond may be locked and ride-api's backstop can finish the swap), else dropped.
   */
  async recover(): Promise<void> {
    for (const c of await this.store.activeCalls()) {
      if (c.status !== "building") continue;
      if (c.proposalPk) {
        await this.store.updateCall(c.id, { status: "open", error: c.error ?? "restarted mid-open" });
        await this.tg.send(`Restarted while opening ${c.symbol}; watching it in case it completed.`);
      } else {
        await this.store.updateCall(c.id, { status: "failed", error: "restarted before build" });
      }
    }
  }

  // ---- monitoring ----

  async monitorRound(): Promise<void> {
    const calls = (await this.store.activeCalls()).filter((c) => c.status === "open" || c.status === "close_requested");
    if (!calls.length) return;
    const now = Math.floor(Date.now() / 1000);

    for (const c of calls) {
      if (c.executedAt === null && c.intentPk) {
        const fill = await this.chain.intentFill(c.intentPk).catch(() => null);
        if (fill && fill.outputAtoms > 0n) {
          c.inputUsd = Number(fill.inputAtoms) / 1e6;
          c.outputAtoms = fill.outputAtoms.toString();
          c.executedAt = fill.executedAt;
          await this.store.updateCall(c.id, { inputUsd: c.inputUsd, outputAtoms: c.outputAtoms, executedAt: c.executedAt });
        }
      }
      const start = c.executedAt ?? Math.floor(c.createdAt / 1000);
      if (c.executedAt === null && now > start + c.durationSecs + STALE_AFTER_SECS) {
        await this.store.updateCall(c.id, { status: "failed", error: c.error ?? "swap never ran" });
        await this.tg.send(`${c.symbol} call never executed; giving up on it.`);
      }
    }

    // Take profit on calls still inside their window: at +5% Claude decides close or hold;
    // while holding, the floor and the trail close without asking (see exit.ts). The market price only
    // tells when to look; the gain itself comes from a quote for selling the whole position.
    const live = calls.filter((c) => c.status === "open" && c.executedAt !== null && now < c.executedAt + c.durationSecs);
    if (live.length) {
      const prices = await this.market.prices([...new Set(live.map((c) => c.mint))]).catch(() => new Map<string, number>());
      for (const c of live) {
        const price = prices.get(c.mint);
        if (!price || !c.inputUsd || !c.outputAtoms || !this.kp || !c.proposalPk) continue;
        const marketPnl = (Number(c.outputAtoms) / 10 ** c.outputDecimals) * price / c.inputUsd - 1;
        if (c.lastReviewAt === null && marketPnl < TAKE_PROFIT) continue;
        const back = await this.market.sellQuote(c.mint, BigInt(c.outputAtoms), this.wallet.toBase58(), USDC_MINT).catch((e) => {
          console.log(`[monitor] sell quote ${c.symbol} failed: ${e instanceof Error ? e.message : e}`);
          return null;
        });
        if (back === null) continue;
        const pnl = Number(back) / 1e6 / c.inputUsd - 1;
        const peak = Math.max(c.peakPnlPct ?? pnl, pnl);
        if (c.peakPnlPct === null || pnl > c.peakPnlPct) await this.store.updateCall(c.id, { peakPnlPct: pnl });

        const swing = peak >= TRAIL_FROM ? await this.swing(c.mint) : 0;
        const next = exitStep(pnl, peak, c.lastReviewAt, now, swing, this.belowLine.get(c.id) ?? 0);
        this.belowLine.set(c.id, next.below);
        if (next.step === "none") continue;
        if (next.step === "close") {
          await this.requestClose(c, pnl, next.why);
          continue;
        }
        if (await this.closedElsewhere(c)) continue;
        const minutesLeft = (c.executedAt! + c.durationSecs - now) / 60;
        const verdict = await this.brain
          .reviewHold({
            symbol: c.symbol,
            pnl,
            peakPnl: peak,
            minutesLeft,
            charts:
              STYLE === "swing"
                ? [
                    { label: "15m", candles: await this.market.candles(c.mint, "15m", 32).catch(() => []) },
                    { label: "1h", candles: await this.market.candles(c.mint, "1H", 48).catch(() => []) },
                  ]
                : [
                    { label: "1m", candles: await this.market.candles(c.mint, "1m", 30).catch(() => []) },
                    { label: "15m", candles: await this.market.candles(c.mint, "15m", 16).catch(() => []) },
                  ],
          })
          .catch((e) => ({ action: "close" as const, reason: `review failed (${e instanceof Error ? e.message : e}), locking the gain` }));
        if (verdict.action === "close") {
          await this.requestClose(c, pnl, verdict.reason);
        } else {
          await this.store.updateCall(c.id, { lastReviewAt: now });
          await this.tg.send(
            `Holding ${c.symbol} at +${(pnl * 100).toFixed(1)}% (peak ${(peak * 100).toFixed(1)}%, ${Math.round(minutesLeft)}m left): ${verdict.reason}`,
          );
        }
      }
    }

    // Results once the window is over (or after an early close).
    for (const c of calls) {
      if (!c.proposalPk || c.executedAt === null) continue;
      if (c.status === "open" && now < c.executedAt + c.durationSecs) continue;
      const pnl = await this.ride.realized(c.proposalPk).catch(() => null);
      if (pnl === null) continue;
      await this.store.updateCall(c.id, { status: "resolved", realizedPnlUsd: pnl });
      await this.tg.send(`${c.symbol} settled: ${money(pnl)}${c.inputUsd ? ` (${((pnl / c.inputUsd) * 100).toFixed(1)}%)` : ""}`);
    }
  }

  private async swing(mint: string): Promise<number> {
    const hit = this.swings.get(mint);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.swing;
    const cs = await this.market.candles(mint, "1m", 30).catch(() => []);
    const swing = cs.length ? cs.reduce((s, k) => s + (k.h - k.l) / k.c, 0) / cs.length : (hit?.swing ?? 0);
    this.swings.set(mint, { swing, at: Date.now() });
    return swing;
  }

  /**
   * Before asking Claude: an early close queued from the website, or one that already went through,
   * means there is nothing left to decide. The call then just waits for its result.
   */
  private async closedElsewhere(c: CallRow): Promise<boolean> {
    const [status, decided] = await Promise.all([
      this.ride.closeStatus(c.proposalPk!).catch(() => null),
      this.chain.betDecided(c.proposalPk!).catch(() => false),
    ]);
    if (!decided && status !== "queued" && status !== "blocked_below_threshold") return false;
    await this.store.updateCall(c.id, { status: "close_requested" });
    await this.tg.send(`${c.symbol}: an early close is already ${decided ? "done" : "queued"} (not by the bot). No longer watching it.`);
    return true;
  }

  private async requestClose(c: CallRow, pnl: number, why: string): Promise<void> {
    const r = await this.ride.closeCall(this.kp!, c.proposalPk!);
    if (r.ok) {
      await this.store.updateCall(c.id, { status: "close_requested" });
      await this.tg.send(`Early close requested on ${c.symbol}: up ${(pnl * 100).toFixed(1)}%. ${why}`);
    } else if (r.code === "not_closable") {
      // Usually already closed early from the website: nothing left to watch either way.
      await this.store.updateCall(c.id, { status: "close_requested" });
      await this.tg.send(`${c.symbol} can no longer be closed early (most likely closed from the website). No longer watching it.`);
    } else {
      console.log(`[monitor] close-call ${c.symbol} refused: ${r.code}`);
    }
  }

  async dailySummary(): Promise<void> {
    const rows: CallRow[] = await this.store.resolvedSince(Date.now() - 24 * 3600_000);
    const total = rows.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0);
    const wins = rows.filter((r) => (r.realizedPnlUsd ?? 0) > 0).length;
    await this.tg.send(`Last 24h: ${rows.length} calls settled, ${wins} in profit, total ${money(total)}`);
  }
}
