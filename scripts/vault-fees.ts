// What the fee taker earned from one fund's treasury, day by day, split by who started each ride.
//   npx tsx scripts/vault-fees.ts [--treasury <pk>] [--fee-taker <pk>] [--initiator <pk>] [--out <dir>]
// Defaults: FOMC Vault's treasury, the trade-executor fee taker (ejBY…), the bot wallet 3DvJ….
// Uses RPC_URL if set, else the public mainnet RPC (slow but enough for a few thousand transactions).
//
// Revenue is what actually reached the fee taker's token accounts in each treasury transaction (swap fee,
// profit fee, and any tip when it ran the fill); a tip paid in a coin is valued at that fill's price.
// Volume is the USDC side of each execute_intent fill (buys and sells both count).
// Writes vault-fees.json and vault-fees.html (day-wise volume and revenue charts) to --out (default .).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BorshCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const TREASURY = new PublicKey(arg("treasury", "51nL6fj192Z9eUeNDR3vrGAkcXiEiuT9wsycGfk1uvjV"));
const FEE_TAKER = arg("fee-taker", "ejBYopijneorWAQ1rN6FiZMvmfXbcjcz4mELCNMRsPW");
const INITIATOR = arg("initiator", "3DvJWcHhtdhNLWMeBCh2Rma5chxyDWxoMmVvBFLihMZe");
const OUT = arg("out", ".");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRADE_EXECUTOR = "tRADeQ3SJVHnFXv1rpwZzVt5HE6DWDu4J6cH34Md6ZA";
const DEFAULT_PK = PublicKey.default.toBase58();

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

/** `caller` is the ride's creator: the closing (sell) fill's event names it; an opening (buy) fill gets it
 *  from the sell whose accounts include its intent. `accounts` is kept on sells for that link. */
type Fill = { intent: string; leg: "buy" | "sell"; usdc: number; usdPerOutputAtom: number | null; outputMint: string; caller: string | null; accounts: string[] };
type TxRow = { sig: string; time: number; fills: Fill[]; revenueUsd: number; swapFeeUsd: number; profitFeeUsd: number; unvalued: string[]; feeTakerSol: number };

/** Owner-and-mint token balance change (atoms) of a transaction, keyed `${owner}:${mint}`. */
function tokenDeltas(tx: VersionedTransactionResponse): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (b: { owner?: string; mint: string; uiTokenAmount: { amount: string } }, sign: bigint) => {
    if (!b.owner) return;
    const k = `${b.owner}:${b.mint}`;
    out.set(k, (out.get(k) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  for (const b of tx.meta?.preTokenBalances ?? []) add(b, -1n);
  for (const b of tx.meta?.postTokenBalances ?? []) add(b, 1n);
  return out;
}

function parseTx(sig: string, tx: VersionedTransactionResponse): TxRow {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const key = (i: number) => keys.get(i)!.toBase58();
  const deltas = tokenDeltas(tx);

  // Every execute_intent in the transaction, top level or CPI.
  const ixs: { programIdIndex: number; accounts: number[]; data: Buffer }[] = [
    ...tx.transaction.message.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: [...i.accountKeyIndexes], data: Buffer.from(i.data) })),
    ...(tx.meta?.innerInstructions ?? []).flatMap((g) =>
      g.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accounts, data: Buffer.from(bs58decode(i.data)) })),
    ),
  ];
  // Settlement events, by intent.
  const events = new Map<string, Record<string, unknown>>();
  for (const line of tx.meta?.logMessages ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const ev = coder.events.decode(line.slice("Program data: ".length));
    if (ev?.name === "IntentSettled") events.set(String((ev.data as Record<string, unknown>).intent), ev.data as Record<string, unknown>);
  }
  const num = (v: unknown) => Number(String(v ?? 0));

  const fills: Fill[] = [];
  let swapFee = 0;
  let profitFee = 0;
  for (const ix of ixs) {
    if (key(ix.programIdIndex) !== TRADE_EXECUTOR || !ix.data.subarray(0, 8).equals(EXEC_DISC)) continue;
    const acct = (i: number) => (i >= 0 && i < ix.accounts.length ? key(ix.accounts[i]) : null);
    const intent = acct(A.intent)!;
    const ev = events.get(intent);
    const totalOutput = num(ev?.total_output ?? ev?.totalOutput);
    const inputMint = acct(A.inputMint)!;
    const outputMint = acct(A.outputMint)!;
    if (outputMint === USDC) {
      const caller = String(ev?.caller ?? "");
      fills.push({ intent, leg: "sell", usdc: totalOutput / 1e6, usdPerOutputAtom: 1e-6, outputMint, caller: caller && caller !== DEFAULT_PK ? caller : null, accounts: ix.accounts.map(key) });
      swapFee += num(ev?.swap_fee ?? ev?.swapFee) / 1e6;
      profitFee += num(ev?.profit_fee ?? ev?.profitFee) / 1e6;
    } else if (inputMint === USDC) {
      const spent = Number(-(deltas.get(`${acct(A.vaultAuthority)}:${USDC}`) ?? 0n)) / 1e6;
      fills.push({ intent, leg: "buy", usdc: spent, usdPerOutputAtom: totalOutput > 0 ? spent / totalOutput : null, outputMint, caller: null, accounts: [] });
    }
  }

  // What reached the fee taker, valued in USD.
  let revenue = 0;
  const unvalued: string[] = [];
  for (const [k, d] of deltas) {
    const [owner, mint] = k.split(":");
    if (owner !== FEE_TAKER || d === 0n) continue;
    if (mint === USDC) revenue += Number(d) / 1e6;
    else {
      const f = fills.find((x) => x.outputMint === mint && x.usdPerOutputAtom !== null);
      if (f) revenue += Number(d) * f.usdPerOutputAtom!;
      else unvalued.push(`${d} atoms of ${mint}`);
    }
  }
  const fi = keys.staticAccountKeys.findIndex((k) => k.toBase58() === FEE_TAKER);
  const feeTakerSol = fi >= 0 && tx.meta ? (tx.meta.postBalances[fi] - tx.meta.preBalances[fi]) / 1e9 : 0;
  return { sig, time: tx.blockTime ?? 0, fills, revenueUsd: revenue, swapFeeUsd: swapFee, profitFeeUsd: profitFee, unvalued, feeTakerSol };
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

async function main() {
  const sigs: { signature: string; err: unknown }[] = [];
  for (let before: string | undefined; ; ) {
    const page = await retry("signatures", () => conn.getSignaturesForAddress(TREASURY, { before, limit: 1000 }));
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err);
  console.error(`${ok.length} successful treasury transactions (${sigs.length - ok.length} failed, skipped)`);

  const rows: TxRow[] = [];
  for (const [i, s] of ok.entries()) {
    const tx = await retry(`tx ${s.signature}`, () => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    if (tx) rows.push(parseTx(s.signature, tx));
    if ((i + 1) % 100 === 0) console.error(`  ${i + 1}/${ok.length}`);
    if (!process.env.RPC_URL) await sleep(120);
  }

  // Creator for every buy: the sell of the same ride lists the buy's (forward) intent among its accounts.
  const buyIntents = new Set(rows.flatMap((r) => r.fills.filter((f) => f.leg === "buy").map((f) => f.intent)));
  const callerOfIntent = new Map<string, string>();
  for (const r of rows)
    for (const f of r.fills)
      if (f.leg === "sell" && f.caller) for (const a of f.accounts) if (buyIntents.has(a)) callerOfIntent.set(a, f.caller);
  for (const r of rows) for (const f of r.fills) if (f.leg === "buy") f.caller = callerOfIntent.get(f.intent) ?? null;
  const open = [...buyIntents].filter((i) => !callerOfIntent.has(i)).length;
  if (open) console.error(`${open} opening fills have no closing fill yet (rides still open): counted as unattributed`);
  const group = (caller: string | null) => (!caller ? "unattributed" : caller === INITIATOR ? "initiator" : "others");

  type Agg = { volume: number; revenue: number; swapFee: number; profitFee: number; fills: number };
  const zero = (): Agg => ({ volume: 0, revenue: 0, swapFee: 0, profitFee: 0, fills: 0 });
  const days = new Map<string, Record<string, Agg>>();
  const totals: Record<string, Agg> = {};
  let sol = 0;
  const unvalued: string[] = [];
  for (const r of rows) {
    sol += r.feeTakerSol;
    unvalued.push(...r.unvalued.map((u) => `${r.sig}: ${u}`));
    const day = new Date(r.time * 1000).toISOString().slice(0, 10);
    const d = days.get(day) ?? {};
    days.set(day, d);
    // Revenue goes to the ride of the transaction's fill (one per transaction in practice).
    const g = group(r.fills[0]?.caller ?? null);
    const add = (k: string, f: (a: Agg) => void) => {
      f((d[k] ??= zero()));
      f((totals[k] ??= zero()));
    };
    add(g, (a) => {
      a.revenue += r.revenueUsd;
      a.swapFee += r.swapFeeUsd;
      a.profitFee += r.profitFeeUsd;
    });
    for (const f of r.fills)
      add(group(f.caller), (a) => {
        a.volume += f.usdc;
        a.fills += 1;
      });
  }

  const report = {
    treasury: TREASURY.toBase58(),
    feeTaker: FEE_TAKER,
    initiator: INITIATOR,
    transactions: rows.length,
    feeTakerSolChange: sol,
    totals,
    days: Object.fromEntries([...days].sort(([a], [b]) => a.localeCompare(b))),
    unvalued,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "vault-fees.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, "vault-fees.html"), html(report));

  const usd = (n: number) => `$${n.toFixed(2)}`;
  console.log(`\nFee taker ${FEE_TAKER} from treasury ${TREASURY.toBase58()}`);
  console.log("group          fills   volume        revenue   (swap fee / profit fee / tips+other)");
  for (const [g, a] of Object.entries(totals))
    console.log(`${label(g).padEnd(14)} ${String(a.fills).padStart(5)}   ${usd(a.volume).padStart(11)}   ${usd(a.revenue).padStart(9)}   (${usd(a.swapFee)} / ${usd(a.profitFee)} / ${usd(a.revenue - a.swapFee - a.profitFee)})`);
  const all = Object.values(totals).reduce((s, a) => ({ v: s.v + a.volume, r: s.r + a.revenue }), { v: 0, r: 0 });
  console.log(`${"total".padEnd(14)}         ${usd(all.v).padStart(11)}   ${usd(all.r).padStart(9)}`);
  console.log(`fee taker SOL change in these transactions: ${sol.toFixed(4)} SOL (gas and rent it paid as executor)`);
  if (unvalued.length) console.log(`not valued (no fill price in the same transaction): ${unvalued.length}, listed in vault-fees.json`);
  console.log(`\nwrote ${join(OUT, "vault-fees.json")} and ${join(OUT, "vault-fees.html")}`);
}

const label = (g: string) => (g === "initiator" ? `${INITIATOR.slice(0, 4)}… rides` : g === "others" ? "other wallets" : "unattributed");

function html(r: { days: Record<string, Record<string, { volume: number; revenue: number }>>; totals: Record<string, { volume: number; revenue: number }> }): string {
  const groups = ["initiator", "others", "unattributed"].filter((g) => r.totals[g]);
  const data = Object.entries(r.days).map(([day, g]) => ({ day, ...Object.fromEntries(groups.map((k) => [k, { v: g[k]?.volume ?? 0, r: g[k]?.revenue ?? 0 }])) }));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vault Fee Revenue</title>
<style>
:root{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--grid:#e6e5e1;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--tip:#ffffff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#383835;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--tip:#262624}}
:root[data-theme=dark]{--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--grid:#383835;--s1:#3987e5;--s2:#d95926;--s3:#199e70;--tip:#262624}
body{margin:0;background:var(--surface);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}p{color:var(--ink2);margin:0}
.legend{display:flex;gap:16px;margin:12px 0;color:var(--ink2);flex-wrap:wrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg{width:100%;height:auto;display:block;overflow:visible}text{fill:var(--ink2);font-size:11px}
.tt{position:fixed;pointer-events:none;background:var(--tip);color:var(--ink);border:1px solid var(--grid);border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px #0002;display:none;white-space:nowrap}
table{border-collapse:collapse;width:100%;margin-top:8px;font-variant-numeric:tabular-nums}th,td{padding:4px 8px;border-bottom:1px solid var(--grid);text-align:right}th:first-child,td:first-child{text-align:left}
.wrap{overflow-x:auto}
</style></head><body><main>
<h1>Fee revenue from the vault</h1>
<p>Day-wise volume (USDC side of each fill) and what reached the fee taker, by who started the ride. UTC days.</p>
<div class="legend">${groups.map((g, i) => `<span><i style="background:var(--s${i + 1})"></i>${label(g)}</span>`).join("")}</div>
<h2>Volume</h2><div id="v"></div>
<h2>Revenue</h2><div id="r"></div>
<h2>Table</h2><div class="wrap"><table><thead><tr><th>Day</th>${groups.map((g) => `<th>${label(g)} volume</th><th>${label(g)} revenue</th>`).join("")}</tr></thead><tbody>
${data.map((d) => `<tr><td>${d.day}</td>${groups.map((g) => { const x = (d as unknown as Record<string, { v: number; r: number }>)[g]; return `<td>$${x.v.toFixed(2)}</td><td>$${x.r.toFixed(2)}</td>`; }).join("")}</tr>`).join("\n")}
</tbody></table></div>
<div class="tt" id="tt"></div>
<script>
const groups=${JSON.stringify(groups)},labels=${JSON.stringify(Object.fromEntries(groups.map((g) => [g, label(g)])))},data=${JSON.stringify(data)};
const tt=document.getElementById('tt'),fmt=n=>'$'+n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
function chart(el,key){
  const W=880,H=260,L=64,B=28,T=8,n=data.length,bw=Math.max(6,Math.min(48,(W-L)/n*0.6));
  const max=Math.max(1e-9,...data.map(d=>groups.reduce((s,g)=>s+d[g][key],0)));
  const step=Math.pow(10,Math.floor(Math.log10(max/4))),nice=Math.ceil(max/4/step)*step,top=nice*4;
  const y=v=>T+(H-T-B)*(1-v/top),x=i=>L+(W-L)*(i+0.5)/n;
  let s='<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+key+' by day">';
  for(let k=0;k<=4;k++){const v=nice*k;s+='<line x1="'+L+'" x2="'+W+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--grid)"/><text x="'+(L-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+fmt(v).replace('.00','')+'</text>'}
  data.forEach((d,i)=>{let base=0;const segs=groups.map((g,gi)=>({g,gi,v:d[g][key]})).filter(q=>q.v>0);
    segs.forEach((q,si)=>{const y0=y(base),y1=y(base+q.v),h=Math.max(0,y0-y1-(si?2:0)),last=si===segs.length-1;
      s+='<path data-i="'+i+'" d="M'+(x(i)-bw/2)+','+(y0-(si?2:0))+'V'+(y1+(last?4:0))+(last?'q0,-4 4,-4H'+(x(i)+bw/2-4)+'q4,0 4,4':'H'+(x(i)+bw/2))+'V'+(y0-(si?2:0))+'Z" fill="var(--s'+(q.gi+1)+')"/>';base+=q.v});
    s+='<rect data-i="'+i+'" x="'+(x(i)-(W-L)/n/2)+'" y="'+T+'" width="'+((W-L)/n)+'" height="'+(H-T-B)+'" fill="transparent"/>';
    if(n<=16||i%Math.ceil(n/12)===0)s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle">'+d.day.slice(5)+'</text>'});
  el.innerHTML=s+'</svg>';
  el.querySelectorAll('[data-i]').forEach(r=>{r.addEventListener('mousemove',e=>{const d=data[r.dataset.i];
    tt.innerHTML='<b>'+d.day+'</b><br>'+groups.map(g=>labels[g]+': '+fmt(d[g][key])).join('<br>')+'<br>Total: '+fmt(groups.reduce((s,g)=>s+d[g][key],0));
    tt.style.display='block';tt.style.left=Math.min(e.clientX+12,innerWidth-tt.offsetWidth-8)+'px';tt.style.top=(e.clientY+12)+'px'});
    r.addEventListener('mouseleave',()=>tt.style.display='none')});
}
chart(document.getElementById('v'),'v');chart(document.getElementById('r'),'r');
</script></main></body></html>`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
