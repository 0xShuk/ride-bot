# Ride Markets API — What's New (for Portfi)

_2026-08-28 · changes only. The full guide stays in `PORTFI_INTEGRATION.md`; this
is just the deltas so you can drop the hardcoded numbers._

---

## 1. Per-fund economics now on `GET /api/funds/markets`

Same call you already make — each fund now also carries these fields (all
**optional**, treat as `?? fallback`; all in **basis points**, `/100` for a %):

| Field | Meaning | Example |
|---|---|---|
| `callerPayoutBps` | Caller's profit share | `4000` = **40%** |
| `minEarlyProfitBps` | Min profit before early-close is allowed | `400` = **4%** |
| `treasuryCutBps` | Fund's cut | `100` = **1%** |
| `spendingLimit` | Per-call USDC cap (see below) | `{kind:"bps",bps:2000}` or `{kind:"absolute",usdcAtoms:"500000000"}` |

`spendingLimit` is one of:
- `{ "kind": "bps", "bps": 2000 }` → **20% of the fund's live treasury**, or
- `{ "kind": "absolute", "usdcAtoms": "500000000" }` → a **fixed $500** ceiling (`/1e6` for $).

This replaces your hardcoded 5% and the "you get a share of the profit"
placeholder — you can now show e.g. **"40% of profit, position up to $X"**.

```ts
const { funds } = await fetch(`${RIDE_API}/api/funds/markets`).then(r => r.json());
for (const f of funds) {
  const sharePct = (f.callerPayoutBps   ?? 0) / 100;   // 40
  const earlyPct = (f.minEarlyProfitBps ?? 0) / 100;   // 4
  const limit =
    f.spendingLimit?.kind === "absolute"
      ? `$${Number(f.spendingLimit.usdcAtoms) / 1e6}`           // "$500"
      : f.spendingLimit ? `${f.spendingLimit.bps / 100}% of treasury` // "20% of treasury"
      : "—";
}
```

Notes:
- **Optional** — a fund with no on-chain config (or an older response) omits these;
  always guard with `?? fallback`.
- **Cache hard** (~5 min) — the numbers are static (they change only via a
  governance action), and the endpoint is edge-cached anyway. No extra call.
- We expose **only these numbers** — never any authority or wallet key.

---

## 2. The dollar max — do you read the treasury yourself?

**For OPENING a call: no.** `build-trade` already clamps the position to the live
limit server-side — request what you want, you get back what's allowed.

**For DISPLAYING a $ max before opening: yes, for `bps` funds.** We serve the
static **%**, not a live $. The $ cap = `spendingLimit.bps / 10_000 ×
treasuryUsdc`, and the treasury balance moves — so read it live from chain (this
is exactly what our own UI does, ~1 min cache):

```ts
import { getNativeTreasuryAddress } from "@realms-today/sowell-governance";
const treasury = getNativeTreasuryAddress(SOWELL_GOV_PROGRAM_ID, governancePk);
const accs = await connection.getParsedTokenAccountsByOwner(treasury, { programId: TOKEN_PROGRAM_ID });
const treasuryUsdc = /* the USDC account's uiAmount from `accs` */;
const maxTradeUsd = treasuryUsdc * (f.spendingLimit.bps / 10_000);   // bps funds only
```

For an `absolute` limit there's **no treasury read** — the $ is just
`usdcAtoms / 1e6`.

---

## 3. Why `CreateIntent` failed — `0x237` and `604`

- **`0x237` = 567 `TokenOwnerRecordAlreadyExists`** — a **retry**. The first
  attempt already created the TokenOwnerRecord; the second hits "already exists"
  (that's why "accounts created but no"). Treat `567` as **"already done"** for
  that step — don't re-submit it.
- **`604` `SpendingLimitExceeded`** — the trade exceeded the fund's **spending
  limit**. It fails **before the bond is pulled**, so you only lose account rent
  (matches what you saw). **Fix: size the position under `spendingLimit` (§1)** —
  the field you now have. How the limit behaves depends on its kind:
  - **`absolute`** — a fixed USDC ceiling (e.g. $500). Keep the trade `≤ usdcAtoms`.
    Can't drift.
  - **`bps`** — the cap is a **% of the LIVE treasury**, which moves:
    `cap = bps/10_000 × treasuryUsdc` **at the moment the tx executes** (not when
    you build it). So even a correctly-sized trade can still `604` if the treasury
    dropped in between. Guard against it:
    - read the treasury balance **fresh, right before building** (§2) — don't size
      against a stale snapshot;
    - **leave headroom** (~90–95% of the cap);
    - **baskets / back-to-back calls**: each executed call spends treasury and
      lowers the cap for the next, so N calls sized against the **same** snapshot
      can `604` mid-basket — re-read treasury per call, or serialize;
    - if you rely on our `build-trade` clamp, a `604` means the treasury moved
      between build and submit (concurrent calls / a resubmitted stale tx) —
      **rebuild fresh, don't resubmit** the old tx.

---

## 4. Crank behaviors (reminder)

- **Rent** from failed / stuck intents is returned automatically (~1h).
- **Early-close** runs on our crank — one signed click, executes in ~a second.
- A crank also **finishes stuck intents** that match the rules.

---

_Base URL, co-signer pubkey, CORS origins — as before, coordinate with us._
