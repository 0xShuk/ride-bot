// Side-by-side of two callers' rides on one fund, read from chain, plus the bot's own decision log.
//   npm run compare -- [--hours 72] [--bot <wallet>] [--other <wallet>] [--treasury <pk>] [--out <dir>]
// Defaults: last 72h, the bot = BOT_WALLET, the other = Ff9hc…, FOMC Vault's treasury.
// .env: RPC_URL (else the slow public RPC), BIRDEYE_API_KEY (optional: how much each coin moved),
// DATABASE_URL (optional: the bot's rounds, passes and failed calls). Reads only; sends nothing.
//
// Per ride: in = USDC the buy spent, out = USDC the sale returned (before fees and payouts),
// vault = what the treasury got back minus what it spent, caller = the caller's profit share.
// Range = the coin's average 1h candle (high - low) over the 24h before the buy; best = the highest
// price during the ride vs the price at the buy.
// Writes compare.json to --out (default .).

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import pg from "pg";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const HOURS = Number(arg("hours", "72"));
const BOT = arg("bot", process.env.BOT_WALLET?.trim() ?? "");
const OTHER = arg("other", "Ff9hcK2Qt9KsseAQsbKWTaTJqoHVcqoHbqxgRZRHgs4c");
const TREASURY = new PublicKey(arg("treasury", "51nL6fj192Z9eUeNDR3vrGAkcXiEiuT9wsycGfk1uvjV"));
const OUT = arg("out", ".");
if (!BOT) throw new Error("set BOT_WALLET in .env or pass --bot <wallet>");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRADE_EXECUTOR = "tRADeQ3SJVHnFXv1rpwZzVt5HE6DWDu4J6cH34Md6ZA";
const MAX_WINDOW_SECS = 2 * 86400;

const idl = JSON.parse(readFileSync(new URL("../idl/trade-executor.json", import.meta.url), "utf8")) as Idl & {
  instructions: { name: string; discriminator: number[]; accounts: { name: string }[] }[];
};
const coder = new BorshCoder(idl);
const execIx = idl.instructions.find((i) => i.name === "execute_intent")!;
const EXEC_DISC = Buffer.from(execIx.discriminator);
const slot = (name: string) => execIx.accounts.findIndex((a) => a.name === name);
const A = { intent: slot("intent"), vaultAuthority: slot("vault_authority"), inputMint: slot("input_mint"), outputMint: slot("output_mint") };

const conn = new Connection(process.env.RPC_URL?.trim() || "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 6) throw new Error(`${what}: ${e instanceof Error ? e.message : e}`);
      await sleep(1000 * 2 ** i);
    }
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

type Buy = { intent: string; time: number; mint: string; usdc: number; signers: string[] };
type Sell = {
  time: number;
  mint: string;
  caller: string;
  out: number;
  callerPayout: number;
  treasuryAmount: number;
  earlyClose: boolean;
  accounts: string[];
};

function parseTx(tx: VersionedTransactionResponse): { buys: Buy[]; sells: Sell[] } {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number) => keys.get(i)!.toBase58();
  const signers = tx.transaction.message.staticAccountKeys.slice(0, tx.transaction.message.header.numRequiredSignatures).map((k) => k.toBase58());
  const allKeys = keys.staticAccountKeys.map((k) => k.toBase58());
  const ixs = [
    ...tx.transaction.message.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: [...i.accountKeyIndexes], data: Buffer.from(i.data) })),
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) =>
      g.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accounts, data: Buffer.from(bs58decode(i.data)) })),
    ),
  ];
  const events = new Map<string, Record<string, unknown>>();
  for (const line of tx.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const ev = coder.events.decode(line.slice("Program data: ".length));
    if (ev?.name === "IntentSettled") events.set(String((ev.data as Record<string, unknown>).intent), ev.data as Record<string, unknown>);
  }
  const num = (v: unknown) => Number(String(v ?? 0));
  const usdcDelta = (owner: string) => {
    let d = 0n;
    for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === owner && b.mint === USDC) d -= BigInt(b.uiTokenAmount.amount);
    for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === owner && b.mint === USDC) d += BigInt(b.uiTokenAmount.amount);
    return Number(d) / 1e6;
  };

  const buys: Buy[] = [];
  const sells: Sell[] = [];
  for (const ix of ixs) {
    if (key(ix.programIdIndex) !== TRADE_EXECUTOR || !ix.data.subarray(0, 8).equals(EXEC_DISC)) continue;
    const acct = (i: number) => key(ix.accounts[i]);
    const intent = acct(A.intent);
    const ev = events.get(intent);
    if (acct(A.outputMint) === USDC) {
      sells.push({
        time: tx.blockTime ?? 0,
        mint: acct(A.inputMint),
        caller: String(ev?.caller ?? ""),
        out: num(ev?.total_output ?? ev?.totalOutput) / 1e6,
        callerPayout: num(ev?.caller_payout ?? ev?.callerPayout) / 1e6,
        treasuryAmount: num(ev?.treasury_amount ?? ev?.treasuryAmount) / 1e6,
        earlyClose: Boolean(ev?.early_close ?? ev?.earlyClose),
        accounts: ix.accounts.map(key),
      });
    } else if (acct(A.inputMint) === USDC) {
      buys.push({ intent, time: tx.blockTime ?? 0, mint: acct(A.outputMint), usdc: -usdcDelta(acct(A.vaultAuthority)), signers: [...signers, ...allKeys] });
    }
  }
  return { buys, sells };
}

type Ride = {
  who: "bot" | "other" | "someone else";
  symbol: string;
  mint: string;
  openedAt: string;
  heldHours: number | null;
  in: number;
  out: number | null;
  movePct: number | null;
  vault: number | null;
  callerPayout: number | null;
  earlyClose: boolean | null;
  rangePct: number | null;
  bestPct: number | null;
};

const symbols = new Map<string, string>();
async function symbol(mint: string): Promise<string> {
  if (!symbols.has(mint)) {
    const s = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`)
      .then((r) => r.json() as Promise<{ symbol?: string }[]>)
      .then((j) => j[0]?.symbol ?? mint.slice(0, 6))
      .catch(() => mint.slice(0, 6));
    symbols.set(mint, s);
  }
  return symbols.get(mint)!;
}

/** Average 1h range over the 24h before `t`, and the best price in [t, end] vs the price at t. */
async function moves(mint: string, t: number, end: number): Promise<{ range: number | null; best: number | null }> {
  const key = process.env.BIRDEYE_API_KEY?.trim();
  if (!key) return { range: null, best: null };
  const get = async (type: string, from: number, to: number) => {
    const url = `https://public-api.birdeye.so/defi/ohlcv?${new URLSearchParams({ address: mint, type, time_from: String(from), time_to: String(to) })}`;
    const res = await fetch(url, { headers: { "X-API-KEY": key, "x-chain": "solana", accept: "application/json" } });
    if (!res.ok) return [];
    const j = (await res.json()) as { data?: { items?: { unixTime: number; h: number; l: number; c: number; o: number }[] } };
    return j.data?.items ?? [];
  };
  const before = await get("1H", t - 86400, t);
  const during = await get("5m", t - 300, end);
  const range = before.length ? before.reduce((s, k) => s + (k.h - k.l) / k.c, 0) / before.length : null;
  const entry = during[0]?.o;
  const best = entry && during.length ? Math.max(...during.map((k) => k.h)) / entry - 1 : null;
  return { range, best };
}

async function decisionLog() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  const since = new Date(Date.now() - HOURS * 3600_000);
  const rounds = await pool.query(
    "select fund, action, count(*)::int as n from ridebot.decisions where at >= $1 group by fund, action order by fund, action",
    [since],
  );
  const recent = await pool.query(
    "select fund, at, action, symbol, reason, shortlist from ridebot.decisions where at >= $1 order by at desc limit 40",
    [since],
  );
  const calls = await pool.query(
    `select fund, symbol, duration_secs, status, input_usd, peak_pnl_pct, realized_pnl_usd, error, created_at
     from ridebot.calls where created_at >= $1 order by created_at`,
    [since.getTime()],
  );
  await pool.end();
  return { rounds: rounds.rows, recent: recent.rows, calls: calls.rows };
}

const pct = (x: number | null) => (x === null ? "-" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => (x === null ? "-" : `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`);

async function main() {
  const cutoff = Math.floor(Date.now() / 1000) - HOURS * 3600;
  // Back to the cutoff, plus the longest window, so rides closed in range still find their buy.
  const sigs: { signature: string; err: unknown; blockTime?: number | null }[] = [];
  for (let before: string | undefined; ; ) {
    const page = await retry("signatures", () => conn.getSignaturesForAddress(TREASURY, { before, limit: 1000 }));
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if ((page[page.length - 1].blockTime ?? 0) < cutoff - MAX_WINDOW_SECS) break;
  }
  const ok = sigs.filter((s) => !s.err && (s.blockTime ?? 0) >= cutoff - MAX_WINDOW_SECS);
  console.error(`${ok.length} treasury transactions to read`);

  const buys: Buy[] = [];
  const sells: Sell[] = [];
  for (const [i, s] of ok.entries()) {
    const tx = await retry(`tx ${s.signature}`, () => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    if (tx) {
      const p = parseTx(tx);
      buys.push(...p.buys);
      sells.push(...p.sells);
    }
    if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${ok.length}`);
    if (!process.env.RPC_URL) await sleep(120);
  }

  const whoOf = (wallet: string | undefined): Ride["who"] => (wallet === BOT ? "bot" : wallet === OTHER ? "other" : "someone else");
  const rides: Ride[] = [];
  const matched = new Set<string>();
  for (const s of sells) {
    const b = buys.find((x) => s.accounts.includes(x.intent));
    if (!b || b.time < cutoff) continue;
    matched.add(b.intent);
    const m = await moves(b.mint, b.time, s.time);
    rides.push({
      who: whoOf(s.caller),
      symbol: await symbol(b.mint),
      mint: b.mint,
      openedAt: new Date(b.time * 1000).toISOString().slice(5, 16).replace("T", " "),
      heldHours: (s.time - b.time) / 3600,
      in: b.usdc,
      out: s.out,
      movePct: s.out / b.usdc - 1,
      vault: s.treasuryAmount - b.usdc,
      callerPayout: s.callerPayout,
      earlyClose: s.earlyClose,
      rangePct: m.range,
      bestPct: m.best,
    });
  }
  // Still open: the caller is whichever of the two wallets is in the buy transaction.
  for (const b of buys) {
    if (matched.has(b.intent) || b.time < cutoff) continue;
    const m = await moves(b.mint, b.time, Math.floor(Date.now() / 1000));
    rides.push({
      who: whoOf(b.signers.find((k) => k === BOT || k === OTHER)),
      symbol: await symbol(b.mint),
      mint: b.mint,
      openedAt: new Date(b.time * 1000).toISOString().slice(5, 16).replace("T", " "),
      heldHours: null,
      in: b.usdc,
      out: null,
      movePct: null,
      vault: null,
      callerPayout: null,
      earlyClose: null,
      rangePct: m.range,
      bestPct: m.best,
    });
  }
  rides.sort((a, b) => a.openedAt.localeCompare(b.openedAt));

  console.log(`\nFund treasury ${TREASURY.toBase58()}, last ${HOURS}h. bot = ${BOT}, other = ${OTHER}\n`);
  for (const who of ["bot", "other"] as const) {
    const rs = rides.filter((r) => r.who === who);
    const done = rs.filter((r) => r.out !== null);
    const sum = (f: (r: Ride) => number | null) => done.reduce((s, r) => s + (f(r) ?? 0), 0);
    const avg = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x !== null);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
    };
    console.log(`== ${who.toUpperCase()}: ${rs.length} rides (${rs.length - done.length} open)`);
    console.log(
      `   wins ${done.filter((r) => (r.movePct ?? 0) > 0).length}/${done.length}, early closes ${done.filter((r) => r.earlyClose).length}, ` +
        `volume ${usd(sum((r) => r.in) + sum((r) => r.out))}, vault ${usd(sum((r) => r.vault))}, caller earned ${usd(sum((r) => r.callerPayout))}`,
    );
    console.log(
      `   avg move ${pct(avg(done.map((r) => r.movePct)))}, avg size ${usd(avg(rs.map((r) => r.in)))}, avg held ${avg(done.map((r) => r.heldHours))?.toFixed(1) ?? "-"}h, ` +
        `avg coin range ${pct(avg(rs.map((r) => r.rangePct)))}/h, avg best during ride ${pct(avg(rs.map((r) => r.bestPct)))}`,
    );
    console.log("   opened       coin         held   in        out       move     vault     caller   range/h  best");
    for (const r of rs)
      console.log(
        `   ${r.openedAt}  ${r.symbol.slice(0, 11).padEnd(11)}  ${(r.heldHours === null ? "open" : `${r.heldHours.toFixed(1)}h`).padEnd(5)}  ` +
          `${usd(r.in).padEnd(8)}  ${usd(r.out).padEnd(8)}  ${pct(r.movePct).padEnd(7)}  ${usd(r.vault).padEnd(8)}  ${usd(r.callerPayout).padEnd(7)}  ` +
          `${pct(r.rangePct).padEnd(7)}  ${pct(r.bestPct)}${r.earlyClose ? "  early close" : ""}`,
      );
    console.log("");
  }
  const others = rides.filter((r) => r.who === "someone else");
  console.log(`(${others.length} rides by other callers left out)\n`);

  const log = await decisionLog().catch((e) => {
    console.error(`decision log: ${e instanceof Error ? e.message : e}`);
    return null;
  });
  if (log) {
    console.log("== BOT ROUNDS (database)");
    for (const r of log.rounds) console.log(`   ${r.fund} ${r.action}: ${r.n}`);
    console.log("   calls:");
    for (const c of log.calls)
      console.log(
        `   ${c.fund} ${new Date(Number(c.created_at)).toISOString().slice(5, 16)} ${c.symbol} ${c.duration_secs / 60}m ${c.status} ` +
          `in ${c.input_usd ?? "-"} peak ${c.peak_pnl_pct === null ? "-" : pct(Number(c.peak_pnl_pct))} pnl ${c.realized_pnl_usd ?? "-"}${c.error ? ` error: ${c.error}` : ""}`,
      );
    console.log("   last decisions:");
    for (const d of log.recent)
      console.log(`   ${d.fund} ${new Date(d.at).toISOString().slice(5, 16)} [${(d.shortlist as string[]).join(", ")}] → ${d.action}${d.symbol ? ` ${d.symbol}` : ""}: ${d.reason}`);
  } else {
    console.log("(no DATABASE_URL: bot rounds and passes not shown)");
  }

  const file = join(OUT, "compare.json");
  writeFileSync(file, JSON.stringify({ hours: HOURS, bot: BOT, other: OTHER, rides, log }, null, 2));
  console.error(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
