// Read-only breakdown of the bot's settled calls into: the price move while held, the cost of the
// buy swap, and the cost of the sell swap. Sends nothing, writes nothing.
// Usage: npm run analyze   (.env needs DATABASE_URL, BIRDEYE_API_KEY, RPC_URL)
//
// Buy leg   USDC in vs the market value of the coins received, at the minute the buy executed
//           (amounts and time from the call's on-chain intent, as the bot stored them).
// Sell leg  USDC out vs the market value of the same coins at the minute the sale executed.
//           The sale is found on chain: the swap that paid the call's USDC back into the fund
//           treasury (matched on amount after the fund's 0.7% cut, from the window end on).
// Held      market price at the sale vs market price at the buy.
// Market price = Birdeye 1-minute candle midpoint ((open + close) / 2) of that minute; the candle's
// high-low range is shown, since a leg's cost can't be measured more precisely than that.

import pg from "pg";
import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TREASURY } from "../src/chain";
import { USDC_MINT } from "../src/config";
import type { Candle } from "../src/market";

const db = process.env.DATABASE_URL;
const birdeye = process.env.BIRDEYE_API_KEY;
const rpc = process.env.RPC_URL;
const rideApi = (process.env.RIDE_API_URL ?? "https://ride-api.fly.dev").replace(/\/+$/, "");
if (!db || !birdeye || !rpc) throw new Error("set DATABASE_URL, BIRDEYE_API_KEY and RPC_URL");
const connection = new Connection(rpc, "confirmed");

type Row = {
  id: number;
  symbol: string;
  mint: string;
  duration_secs: number;
  input_usd: string | null;
  output_atoms: string | null;
  output_decimals: number;
  executed_at: string | null;
  proposal_pk: string | null;
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ata = (owner: PublicKey, mint: string) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()], ATA_PROGRAM)[0];
const TREASURY_USDC = ata(TREASURY, USDC_MINT).toBase58();

const pct = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "    n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`.padStart(7);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1m candles between two unix times, oldest first. */
async function candlesBetween(mint: string, from: number, to: number): Promise<Candle[]> {
  const q = new URLSearchParams({ address: mint, type: "1m", time_from: String(from), time_to: String(to) });
  const res = await fetch(`https://public-api.birdeye.so/defi/ohlcv?${q}`, {
    headers: { "X-API-KEY": birdeye!, "x-chain": "solana" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`birdeye ${res.status}`);
  const json = (await res.json()) as { data?: { items?: { unixTime: number; o: number; h: number; l: number; c: number; v: number }[] } };
  return (json.data?.items ?? []).map((i) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c, v: i.v })).sort((a, b) => a.t - b.t);
}

/** The market price in the minute containing `t`: candle midpoint, plus its high-low range as a share of it. */
async function marketAt(mint: string, t: number): Promise<{ price: number; range: number } | null> {
  const cs = await candlesBetween(mint, t - 180, t + 60).catch(() => [] as Candle[]);
  const c = [...cs].reverse().find((x) => x.t <= t) ?? cs[0];
  if (!c) return null;
  const price = (c.o + c.c) / 2;
  return { price, range: (c.h - c.l) / price };
}

/** USDC the fund treasury received in this transaction (whole units), or 0. */
function treasuryUsdcIn(tx: ParsedTransactionWithMeta): number {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const idx = keys.indexOf(TREASURY_USDC);
  if (idx < 0 || !tx.meta) return 0;
  const amt = (list: typeof tx.meta.preTokenBalances) =>
    Number(list?.find((b) => b.accountIndex === idx)?.uiTokenAmount.uiAmount ?? 0);
  return amt(tx.meta.postTokenBalances) - amt(tx.meta.preTokenBalances);
}

/** Share of a call's USDC out that reaches the treasury: the fund takes 0.7% of the proceeds after the trade. */
const AFTER_CUT = 0.993;

/**
 * The sale: the earliest swap (ExecuteIntent) from 5 minutes before the window end on that paid the
 * treasury's USDC account `usdcOut` after the 0.7% cut (±0.3%). Pages back through that account's
 * history until it reaches the buy.
 */
async function findSale(buyTime: number, windowEnd: number, usdcOut: number): Promise<{ time: number; sig: string } | null> {
  const expect = usdcOut * AFTER_CUT;
  let before: string | undefined;
  const hits: { time: number; sig: string }[] = [];
  for (let page = 0; page < 20; page++) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(TREASURY_USDC), { before, limit: 100 });
    if (!sigs.length) break;
    for (const s of sigs) {
      if (s.err || !s.blockTime || s.blockTime < windowEnd - 300) continue;
      const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      await sleep(80);
      if (!tx?.meta?.logMessages?.some((l) => l.includes("Instruction: ExecuteIntent"))) continue;
      const got = treasuryUsdcIn(tx);
      if (got > 0 && Math.abs(got - expect) / expect < 0.003) hits.push({ time: s.blockTime, sig: s.signature });
    }
    if ((sigs[sigs.length - 1].blockTime ?? 0) < buyTime) break;
    before = sigs[sigs.length - 1].signature;
  }
  return hits.sort((a, b) => a.time - b.time)[0] ?? null;
}

(async () => {
  const pool = new pg.Pool({ connectionString: db, ssl: db.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  const { rows } = await pool.query<Row>("select * from ridebot.calls where status = 'resolved' order by id");
  await pool.end();
  if (!rows.length) return console.log("No settled calls yet.");

  const agg = { buy: [] as number[], sell: [] as number[], held: [] as number[], realized: [] as number[], noise: [] as number[] };
  console.log("id  token      window    in$     out$   realized    held   buy cost  sell cost  candle range  sold vs window end");
  for (const r of rows) {
    const label = `${String(r.id).padEnd(3)} ${r.symbol.slice(0, 9).padEnd(9)} ${`${r.duration_secs / 60}m`.padStart(6)}`;
    const rr = r.proposal_pk
      ? ((await fetch(`${rideApi}/api/call-realized/${r.proposal_pk}`).then((x) => x.json()).catch(() => ({}))) as {
          forwardUsdcIn?: number | null;
          reverseUsdcOut?: number | null;
        })
      : {};
    const usdcIn = rr.forwardUsdcIn ?? (r.input_usd === null ? null : Number(r.input_usd));
    const usdcOut = rr.reverseUsdcOut ?? null;
    if (!usdcIn || !usdcOut || !r.output_atoms || !r.executed_at) {
      console.log(`${label}  missing data (in ${usdcIn}, out ${usdcOut}, coins ${r.output_atoms}, executed ${r.executed_at})`);
      continue;
    }
    const coins = Number(r.output_atoms) / 10 ** r.output_decimals;
    const buyTime = Number(r.executed_at);
    const sale = await findSale(buyTime, buyTime + r.duration_secs, usdcOut);
    const [atBuy, atSell] = await Promise.all([marketAt(r.mint, buyTime), sale ? marketAt(r.mint, sale.time) : null]);

    const realized = usdcOut / usdcIn - 1;
    // Cost = what the swap gave vs what the coins were worth at that minute's market price.
    const buyCost = atBuy ? (coins * atBuy.price) / usdcIn - 1 : null;
    const sellCost = atSell ? usdcOut / (coins * atSell.price) - 1 : null;
    const held = atBuy && atSell ? atSell.price / atBuy.price - 1 : null;
    const range = Math.max(atBuy?.range ?? 0, atSell?.range ?? 0);
    const late = sale ? `${Math.round((sale.time - (buyTime + r.duration_secs)) / 60)} min` : "sale not found";

    agg.realized.push(realized);
    if (buyCost !== null) agg.buy.push(buyCost);
    if (sellCost !== null) agg.sell.push(sellCost);
    if (held !== null) agg.held.push(held);
    agg.noise.push(range);
    console.log(
      `${label}  ${`$${usdcIn.toFixed(0)}`.padStart(6)} ${`$${usdcOut.toFixed(0)}`.padStart(6)}  ${pct(realized)}  ${pct(held)}  ${pct(buyCost)}   ${pct(sellCost)}    ±${(range * 50).toFixed(2)}%       ${late}`,
    );
    if (sale) console.log(`      sale tx ${sale.sig}`);
  }

  console.log(`\nAverages over ${agg.realized.length} calls (realized ≈ held + buy cost + sell cost)`);
  console.log(`  realized:  ${pct(mean(agg.realized))}`);
  console.log(`  held move: ${pct(mean(agg.held))}`);
  console.log(`  buy cost:  ${pct(mean(agg.buy))}`);
  console.log(`  sell cost: ${pct(mean(agg.sell))}`);
  console.log(`  candle range (measurement noise per leg): ±${(mean(agg.noise) * 50).toFixed(2)}%`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
