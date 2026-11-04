// The two loops: decide (every 15 min) and monitor open calls (every 30 s).

import { randomUUID } from "node:crypto";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { type Candidate, Brain } from "./brain";
import { type Chain } from "./chain";
import { FUND, MIN_LIQUIDITY_USD, SHORTLIST_SIZE, SIZE_SHARE, TAKE_PROFIT, type Env } from "./config";
import type { Market } from "./market";
import { type BuildOk, type RideApi, isReset, isTransient } from "./ride";
import { shortlist } from "./rules";
import type { CallRow, Store } from "./store";
import type { Telegram } from "./telegram";

const MIN_SOL = 0.02;
/** A call whose swap never ran is given up this long after its window would have ended. */
const STALE_AFTER_SECS = 3 * 3600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const mins = (secs: number) => `${secs / 60}m`;

export class Bot {
  private lowBalanceAlertAt = 0;

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
    if (this.env.killSwitch) {
      console.log("[decide] kill switch on: no new calls");
      return;
    }
    if (!(await this.balancesOk())) return;

    const [tokens, verified] = await Promise.all([this.market.topTokens(MIN_LIQUIDITY_USD), this.market.verifiedMints()]);
    // Twice the shortlist, then keep the ones with room under the fund's limits.
    const ranked = shortlist(tokens, verified, SHORTLIST_SIZE * 2);
    const roomy = [];
    for (const t of ranked) {
      const l = await this.ride.limits(this.wallet.toBase58(), t.mint);
      if (l && (l.dailyFundRemaining <= 0 || l.velocityRemaining <= 0)) {
        console.log(`[decide] fund limit reached (daily ${l.dailyFundRemaining}, hourly ${l.velocityRemaining}): skipping round`);
        return;
      }
      if (!l || (l.dailyTokenRemaining > 0 && l.concurrentRemaining > 0)) roomy.push(t);
      if (roomy.length === SHORTLIST_SIZE) break;
    }
    if (!roomy.length) {
      console.log("[decide] no eligible token with room");
      return;
    }

    const cands: Candidate[] = await Promise.all(
      roomy.map(async (token) => ({
        token,
        candles5m: await this.market.candles(token.mint, "5m", 24).catch(() => []),
        candles1h: await this.market.candles(token.mint, "1H", 12).catch(() => []),
      })),
    );
    const d = await this.brain.decide(cands);
    await this.store.logDecision({
      action: d.action,
      symbol: d.action === "trade" ? d.symbol : null,
      reason: d.reason,
      shortlist: roomy.map((t) => t.symbol),
    });
    console.log(`[decide] shortlist ${roomy.map((t) => t.symbol).join(", ")} → ${d.action === "trade" ? `${d.symbol} ${mins(d.durationSecs)}` : "pass"}: ${d.reason}`);
    if (d.action === "pass") return;

    const usdc = Math.floor((await this.chain.treasuryUsdc()) * SIZE_SHARE);
    if (usdc < 5) {
      console.log(`[decide] treasury too small for a call ($${usdc})`);
      return;
    }
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

  private async balancesOk(): Promise<boolean> {
    const [fomc, sol] = await Promise.all([
      this.chain.tokenBalance(this.wallet, FUND.bondMint),
      this.chain.solBalance(this.wallet),
    ]);
    const bond = Number(FUND.bondAtoms / 1_000_000n);
    if (fomc >= bond && sol >= MIN_SOL) return true;
    const msg = `Low balance: ${fomc.toLocaleString()} FOMC (need ${bond.toLocaleString()}), ${sol.toFixed(4)} SOL (need ${MIN_SOL}). No new calls.`;
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

    // Take profit on calls still inside their window.
    const live = calls.filter((c) => c.status === "open" && c.executedAt !== null && now < c.executedAt + c.durationSecs);
    if (live.length) {
      const prices = await this.market.prices([...new Set(live.map((c) => c.mint))]).catch(() => new Map<string, number>());
      for (const c of live) {
        const price = prices.get(c.mint);
        if (!price || !c.inputUsd || !c.outputAtoms) continue;
        const value = (Number(c.outputAtoms) / 10 ** c.outputDecimals) * price;
        const pnl = value / c.inputUsd - 1;
        if (c.peakPnlPct === null || pnl > c.peakPnlPct) await this.store.updateCall(c.id, { peakPnlPct: pnl });
        if (pnl >= TAKE_PROFIT && this.kp && c.proposalPk) {
          const r = await this.ride.closeCall(this.kp, c.proposalPk);
          if (r.ok) {
            await this.store.updateCall(c.id, { status: "close_requested" });
            await this.tg.send(`Early close requested on ${c.symbol}: up ${(pnl * 100).toFixed(1)}%`);
          } else {
            console.log(`[monitor] close-call ${c.symbol} refused: ${r.code}`);
          }
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

  async dailySummary(): Promise<void> {
    const rows: CallRow[] = await this.store.resolvedSince(Date.now() - 24 * 3600_000);
    const total = rows.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0);
    const wins = rows.filter((r) => (r.realizedPnlUsd ?? 0) > 0).length;
    await this.tg.send(`Last 24h: ${rows.length} calls settled, ${wins} in profit, total ${money(total)}`);
  }
}
