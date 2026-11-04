// ride-api client: the public call API (see PORTFI_INTEGRATION.md).

import type { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { FUND } from "./config";

export type BuiltTx = { label: string; txB64: string; needsUserSig: boolean };
export type BuildOk = {
  approved: true;
  proposalPk: string;
  intentPk: string;
  expectedOutputAtoms: string;
  minOutputAtoms: string;
  txs: BuiltTx[];
};
export type BuildRejected = {
  approved: false;
  reasonCode: string;
  reasonHuman?: string;
  details?: { resetIdempotency?: boolean; [k: string]: unknown };
  httpStatus: number;
};

export type Limits = {
  velocityRemaining: number;
  dailyTokenRemaining: number;
  dailyFundRemaining: number;
  concurrentRemaining: number;
};

/** Rejections that mean "start over with a new key": the old intent can only revert. */
export const isReset = (r: BuildRejected) => r.reasonCode === "intent_expired" || r.details?.resetIdempotency === true;
/** Transient: worth retrying the same key shortly. */
export const isTransient = (r: BuildRejected) =>
  r.httpStatus === 429 || r.httpStatus === 503 || r.httpStatus === 500 || r.reasonCode === "retry_not_approved";

export class RideApi {
  constructor(private base: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
    const body = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, body };
  }

  /** Remaining capacity for the bot's wallet on this token (fund-wide numbers are shared with all callers). */
  async limits(wallet: string, mint: string): Promise<Limits | null> {
    const { status, body } = await this.json<{ limits?: Record<string, Limits> }>(
      `/api/funds/limits?wallet=${wallet}&mint=${mint}`,
    );
    return status === 200 ? (body.limits?.[FUND.key] ?? null) : null;
  }

  async buildTrade(args: {
    idempotencyKey: string;
    wallet: string;
    outputMint: string;
    usdcAmount: number;
    evaluationPeriodSecs: number;
    outputSymbol: string;
  }): Promise<BuildOk | BuildRejected> {
    const { status, body } = await this.json<Record<string, unknown>>("/api/build-trade", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": args.idempotencyKey },
      body: JSON.stringify({
        fund: FUND.key,
        outputMint: args.outputMint,
        usdcAmount: args.usdcAmount,
        walletPk: args.wallet,
        evaluationPeriodSecs: args.evaluationPeriodSecs,
        tradeMeta: { inputSymbol: "USDC", outputSymbol: args.outputSymbol },
      }),
    });
    if (body.approved === true) return body as unknown as BuildOk;
    return {
      approved: false,
      reasonCode: String(body.reasonCode ?? `http_${status}`),
      reasonHuman: body.reasonHuman as string | undefined,
      details: body.details as BuildRejected["details"],
      httpStatus: status,
    };
  }

  /** Queues an early close (the crank runs it only if the call is profitable on-chain). */
  async closeCall(kp: Keypair, proposalPk: string): Promise<{ ok: boolean; code?: string }> {
    const signedAt = Math.floor(Date.now() / 1000);
    const msg = new TextEncoder().encode(`ride.markets:close-call:${proposalPk}:${signedAt}`);
    const signature = Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("base64");
    const { body } = await this.json<{ ok?: boolean; code?: string }>("/api/close-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalPk, walletPk: kp.publicKey.toBase58(), signature, signedAt, authMethod: "message" }),
    });
    return { ok: body.ok === true, code: body.code };
  }

  /** Settled P&L, or null while the call is unresolved. */
  async realized(proposalPk: string): Promise<number | null> {
    const { status, body } = await this.json<{ realizedPnlUsd?: number | null }>(`/api/call-realized/${proposalPk}`);
    return status === 200 && typeof body.realizedPnlUsd === "number" ? body.realizedPnlUsd : null;
  }
}
