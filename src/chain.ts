// On-chain reads and transaction sending.

import { readFileSync } from "node:fs";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { FUND, PROGRAMS, USDC_MINT } from "./config";

const idl = JSON.parse(readFileSync(new URL("../idl/trade-executor.json", import.meta.url), "utf8")) as Idl;
const coder = new BorshCoder(idl);

/** The fund's native treasury: the governance PDA that holds its USDC. */
export const TREASURY = PublicKey.findProgramAddressSync(
  [Buffer.from("native-treasury"), new PublicKey(FUND.governance).toBuffer()],
  new PublicKey(PROGRAMS.sowellGov),
)[0];

/** BOT_KEYPAIR as a JSON byte array (solana-keygen file contents) or a base58 secret key. */
export function parseKeypair(secret: string): Keypair {
  const s = secret.trim();
  return Keypair.fromSecretKey(s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s));
}

export class Chain {
  readonly connection: Connection;
  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  /** Whole-unit balance of `mint` across `owner`'s token accounts. */
  async tokenBalance(owner: PublicKey, mint: string): Promise<number> {
    const r = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    return r.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  }

  treasuryUsdc(): Promise<number> {
    return this.tokenBalance(TREASURY, USDC_MINT);
  }

  async solBalance(owner: PublicKey): Promise<number> {
    return (await this.connection.getBalance(owner)) / 1e9;
  }

  /** The call's swap as it ran: USDC spent and output atoms received (0/0 until executed). */
  async intentFill(intentPk: string): Promise<{ inputAtoms: bigint; outputAtoms: bigint; executedAt: number } | null> {
    const info = await this.connection.getAccountInfo(new PublicKey(intentPk));
    if (!info) return null;
    const i = coder.accounts.decode("Intent", info.data) as {
      total_input_spent: { toString(): string };
      total_output_received: { toString(): string };
      last_executed_at: { toString(): string };
    };
    return {
      inputAtoms: BigInt(i.total_input_spent.toString()),
      outputAtoms: BigInt(i.total_output_received.toString()),
      executedAt: Number(i.last_executed_at.toString()),
    };
  }

  /** The call's bet is cancelled or already has an outcome: an early close went through, by anyone. */
  async betDecided(proposalPk: string): Promise<boolean> {
    const bet = PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), new PublicKey(proposalPk).toBuffer()],
      new PublicKey(PROGRAMS.sowellGov),
    )[0];
    const info = await this.connection.getAccountInfo(bet);
    if (!info) return false;
    return betDecidedFrom(info.data);
  }

  /**
   * Sign each transaction (keeping ride-api's co-signature) and send them in order,
   * waiting for each to confirm before the next. Throws with the failing label.
   */
  async signAndSendInOrder(kp: Keypair, txs: { label: string; txB64: string; needsUserSig: boolean }[]): Promise<string[]> {
    const sigs: string[] = [];
    for (const [i, t] of txs.entries()) {
      const tx = VersionedTransaction.deserialize(Buffer.from(t.txB64, "base64"));
      if (t.needsUserSig) tx.sign([kp]);
      const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: i > 0, maxRetries: 3 });
      const err = await this.waitFor(sig);
      if (err) throw new Error(`${t.label} failed: ${JSON.stringify(err)}`);
      sigs.push(sig);
    }
    return sigs;
  }

  /** Polls until the signature confirms (returns its error, or null) or ~90 s pass (the blockhash is dead by then). */
  private async waitFor(sig: string): Promise<unknown> {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const { value } = await this.connection.getSignatureStatuses([sig], { searchTransactionHistory: false });
      const s = value[0];
      if (s?.err) return s.err;
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return null;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`timed out waiting for ${sig}`);
  }
}

/**
 * Bet layout (sowell-gov sdk `accounts/bet.ts`): account type u8, proposal, governance, creator,
 * bet/yes/no amounts u64, yes/no weights u128, evaluation period u32, treasury cut u16, executed bool,
 * executed_at Option<i64>, cancelled bool, outcome u8 (0 = pending).
 */
export function betDecidedFrom(d: Buffer): boolean {
  let o = 1 + 32 * 3 + 8 * 3 + 16 * 2 + 4 + 2 + 1;
  o += d[o] === 1 ? 9 : 1;
  return d[o] === 1 || d[o + 1] !== 0;
}
