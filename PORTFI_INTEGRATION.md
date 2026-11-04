# Ride Markets — Spot Calls API (Integration Guide)

How to open, track, and close **backed single-asset "calls"** on Ride Markets
programmatically, and compose them into baskets — using our **existing funds**.
No API key: every fund-moving action is authorized by the end user's own wallet
signature.

---

## Before you start (front-load these — they're async on our side)

1. Get the **base URL** + our **co-signer pubkey** from us.
2. Send us your browser **origin(s)** for the CORS allowlist (server-to-server
   calls need none).
3. Fund your **test wallet**: the bond coin for the fund you'll use (see the fund
   table) + ~0.03 SOL.
4. Examples here are **`@solana/web3.js` v1.x**.

---

## The model (30 seconds)

- A **call** is a backed directional trade on one token. The **position is funded
  from the fund's treasury** — the caller does **not** put up the position size.
- The caller posts a **bond** (in the fund's own coin). **The bond is the entire
  downside — there is no liquidation.** Worst case the caller loses the bond; if
  the trade profits, the caller earns their share of the PnL (net of fund fees).
- Each call runs for a **KPI window** the caller chooses (per-fund bounds below).
  At window end our internal crank **resolves** it on realized PnL vs entry. The
  caller can also **take profit early** (a **10% early-close fee** applies).
- Because downside is bounded and there's no liquidation, a small call is playable
  at a **daily cadence** — which is what makes a basket-of-the-day work.

---

## Funding: what the caller's wallet must hold

Before the first `open()`, the caller's wallet needs **two** things (the position
USDC is NOT one of them — the treasury funds that):

1. **The fund's bond coin — at least the bond amount.** The bond is pulled from
   the caller's own token account at the first tx (`cpwt`). Users must **already
   hold the fund coin** (no auto-swap in this integration — users acquire the coin
   themselves). See the fund table for each fund's coin mint + bond size.
   Bond values in the table are **whole-coin (UI) units**, and **every current
   fund coin is 6-decimal** → atoms = `bond × 10⁶` (e.g. 5,000,000 BRERO =
   `5_000_000_000_000` atoms).
   ⚠️ **`build-trade` does NOT check the bond-coin balance** — it returns a
   signable tx set even if the wallet can't cover the bond, and the shortfall only
   surfaces as an on-chain **`cpwt` revert mid-sequence, after fees are spent.**
   **Read the wallet's SPL balance of the bond mint yourself and gate the open
   before calling `build-trade`.**
2. **SOL for fees** — the caller is fee-payer and on-chain executor. Budget
   **~0.02–0.05 SOL**: tx fees on 3–4 txs, a one-time ~0.002 SOL account-rent on a
   wallet's first-ever call, and an occasional ~0.006 SOL prefund some AMM routes
   transfer. A near-zero-SOL wallet fails mid-sequence.

You also need **your own Solana mainnet RPC** to submit + confirm the returned
transactions. Bond amounts are on-chain governance minimums (rarely change) — the
table is a snapshot; coordinate with us for the authoritative value.

### Working funds (bond coin, bond, KPI window, restrictions)

| Fund | Bond coin (mint) | Bond | KPI window | Restriction |
|---|---|---|---|---|
| **bandito** | BRERO `BPid8556dtzzJ577gKJYJBySPAacin6dTuANKNEfRdAo` | 5,000,000 | 1h–3d | **open** |
| **cyrene** | CYAI `6Tph3SxbAW12BSJdCevVV9Zujh97X69d5MJ4XjwKmray` | 300,000 | 1h–3d | **open** |
| **unicorn** | UNICORN `iVLbbvimcTpgPJhHByiEGEZyd6dYcnxEsa89s7dEASY` | 1,000,000 | 1h–3d | **open** |
| **islandvault** | ISLAND `Ds52CDgqdWbTWsua1hgT3AuSSy4FNx2Ezge1br3jQ14a` | 60,000 | 1h–3d | **open** |
| **alphaszn** | ALPHASZN `H3QuB4onrJVBgWvMU1f4oBuijPuBt57qsiCbR69Zpump` | 1,000,000 | 1h–3d | **open** |
| hyperilliquid | HILL `B2jUxihUH3QdmHi4ENnngonfqiGG5UwbWLctGZacBgnR` | 10 | 1h–3d | open · forces **50× position** |
| ownershipfund | OWNED `oWnEDLYA4AEDgEZDBs1XCEgbvycjUZzfFF6S6Xmcxwo` | 2,400,000 | 1h–14d | **curated asset list** only |
| shotgun | USDC | 5 | **5m–30m** | open · window too short for 24h |
| solariansvault | USDC | 30 | 1h–3d | **NFT-gated** (Solarians) + curated |
| monkedao | USDC | 50 | 1h–3d | **NFT-gated** (SMB Gen 2/3) |
| ablockchaindao | USDC | 20 | 1h–3d | **wallet-allowlist** |

**For a general 24h basket, use the *open* funds — `bandito`, `cyrene`,
`unicorn`, `islandvault`, `alphaszn`.** Any wallet can call them; the user just
needs to hold that fund's coin for the bond. (`shotgun`'s window maxes at 30 min;
the USDC-bond funds are NFT- or wallet-gated; `ownershipfund` only allows a
curated asset list.)

**Restriction types:** `open` (any wallet, any Jupiter-verified asset) · `NFT-gated`
(caller must hold an NFT from the named collection — check
`GET /api/funds/nft-access?wallet=`) · `wallet-allowlist` (only approved wallets)
· `curated` (only the fund's `allowedMints`). Bond values are as of 2026-08-24 —
they're on-chain governance minimums and rarely change, but confirm with us if a
number looks off.

---

## Auth model — no keys to hand over

- **Open** endpoints (all read-only lookups **and** build-a-call) — called
  directly, like our own web app does. No API key, no bearer token.
- **User-signed** — open + early-close are authorized by the **user's own wallet
  signature**. You never hold a Ride credential.

**CORS:** browser callers must be on our allowlist — send us your origin(s).
Server-to-server calls send no `Origin` and aren't subject to CORS. Per-IP +
global rate limits apply (429 `rate_limited` / `rate_limited_global`, honor
`Retry-After`).

**Base URL:** `<API_BASE>` (we'll give you the host + our co-signer pubkey
privately). All paths are relative to it.

---

## Lifecycle

1. **Open** — `POST /api/build-trade` → a set of transactions (one already
   co-signed by us). The user signs the rest; you submit them **in order**.
2. **Track** — you don't get live PnL over REST (see "Live position" below);
   poll `GET /api/call-realized/:proposalPk` for the settled number.
3. **Resolve** — the crank resolves at the KPI window end automatically.
4. **Take profit early (optional)** — `POST /api/close-call` with the user's
   signature (10% fee).

---

## Endpoints

### 1. Open a call — `POST /api/build-trade`  (open, no key)

**Headers:** `Content-Type: application/json` · `Idempotency-Key: <unique>`
(send it — a retry with the same key returns the **same** call, never a second
bond; printable ASCII 1–128 chars).

**Body**

| field | type | req | notes |
|---|---|---|---|
| `fund` | string | ✓ | fund key (table above) |
| `outputMint` | string | ✓ | base58 mint of the asset to call |
| `usdcAmount` | number | ✓ | **treasury-funded** position size, in **whole USDC** — `100` = $100 (NOT atoms). `> 0`, `≤ 1_000_000`. The caller does **not** hold this |
| `walletPk` | string | ✓ | caller's wallet — signs, is the executor, and holds the bond coin + SOL |
| `evaluationPeriodSecs` | number | ✓ | KPI window in seconds. Must be within the fund's window (table) — e.g. `86400` (24h) works on bandito/cyrene/unicorn/islandvault/alphaszn |
| `ref` | string | – | referral code |
| `tradeMeta` | object | – | display metadata `{ inputSymbol?, outputSymbol?, targetRate?, proposalName? }` |
| `platformFeeUsd` | number | – | `0…5`. ⚠️ charged as a USDC transfer **from the caller's wallet** — if you set it the wallet must also hold that many USDC (+ a USDC ATA). Leave unset/`0` to keep the no-USDC-needed property |

> Don't set `amplify`, `combo`, or `autoSwap` — not part of this flow.

**Max position size:** your `usdcAmount` is clamped server-side to the fund's
on-chain **spending limit against its current treasury** (roughly
`min(treasury × fundRule, cap)`, and never `> $1M`) — the same live cap the UI
shows. It moves with the treasury; if you request more, the built trade is smaller
than requested (size your accounting off the returned value, not the request).

**Success (HTTP 200)**
```json
{
  "approved": true,
  "tier": 2,
  "proposalPk": "<your call's ID — keep it>",
  "intentPk": "<trade-executor intent PDA>",
  "expectedOutputAtoms": "123456789",
  "minOutputAtoms": "120000000",
  "txs": [
    { "label": "cpwt",               "txB64": "…", "needsUserSig": true },
    { "label": "executeTransaction", "txB64": "…", "needsUserSig": true },
    { "label": "executeIntent",      "txB64": "…", "needsUserSig": true, "alreadySignedBy": ["<our co-signer>"] }
  ]
}
```
`*Atoms` are decimal strings. Examples use **`@solana/web3.js` v1.x** (legacy) —
`VersionedTransaction` + `signAllTransactions`. On `@solana/kit` (v2) you must
decode the base64 wire tx and add the user signature **without touching existing
signatures**. The blob set can vary — a `setup` blob prepends on a wallet's
first-ever call; `alreadySignedBy` on `executeIntent` is advisory (present on the
enforced funds in this guide) — just sign+submit whatever `needsUserSig` blobs
come back, in order.

**Submitting the transactions (exactly what our UI does):**
1. **Deserialize** each blob: `VersionedTransaction.deserialize(Buffer.from(txB64,'base64'))`.
2. **Sign** all `needsUserSig` blobs in **one** `wallet.signAllTransactions(...)`
   call. For `executeIntent`, the user signature is **added** to the already
   co-signed tx — do **not** re-serialize/rebuild it or our co-signature is lost.
   (A `signTransaction`-only wallet must sign each blob individually, same rule.)
3. **Send + confirm each in order, one before the next** (`cpwt` →
   `executeTransaction` → `executeIntent`) — they're dependent on-chain
   (`skipPreflight: true` after the first is fine).
4. All blobs **share one blockhash** (~60–90s life). Keep the loop tight; confirm
   each tx against **its own** blockhash (not a fresh one) or you'll dead-wait.
   On **any** mid-sequence failure (expired blockhash, revert, `OutputBelowMin` on
   `executeIntent` from a stale Jupiter route): re-`POST /api/build-trade` with the
   **same `Idempotency-Key`** and resume — the response returns only the
   **remaining** (un-landed) blobs, already-confirmed steps are skipped, no second
   bond. **EXCEPTION:** if that rebuild rejects with `intent_expired` (or
   `details.resetIdempotency === true`), **stop** — drop the key and open a fresh
   call (see the reason-code section).

Once `executeIntent` confirms, the position is live. **The KPI window starts at
`executeIntent` confirmation** (on-chain `executedAt`, an approximation of your
client confirm time), not at build time — anchor your resolve estimate to that +
`evaluationPeriodSecs`.

**Worked example — open a $50 call on `cyrene`:**
```bash
curl -X POST $API_BASE/api/build-trade \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: basket7:cyrene:<mint>' \
  -d '{"fund":"cyrene","outputMint":"<VERIFIED_MINT>","usdcAmount":50,
       "walletPk":"<USER_WALLET>","evaluationPeriodSecs":86400}'
# -> { "approved": true, "proposalPk":"…", "txs":[ {label:"cpwt",…}, {label:"executeTransaction",…}, {label:"executeIntent",…,"alreadySignedBy":[…]} ] }
```
```ts
import { VersionedTransaction } from "@solana/web3.js"; // v1.x
const decoded = res.txs.map(t => VersionedTransaction.deserialize(Buffer.from(t.txB64, "base64")));
const signed  = await wallet.signAllTransactions(decoded); // one approval; keeps our co-sig on executeIntent
for (let i = 0; i < signed.length; i++) {
  const sig = await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: i > 0 });
  await connection.confirmTransaction({ signature: sig, blockhash: signed[i].message.recentBlockhash,
    lastValidBlockHeight }, "confirmed"); // confirm against the tx's OWN blockhash
}
// on mid-sequence failure: re-POST build-trade with the SAME Idempotency-Key → it returns only the remaining blobs.
// UNLESS reasonCode === "intent_expired" → drop the key, open fresh.
```

**Rejection** — body `{ approved:false, reasonCode, reasonHuman, details }`,
returned across **HTTP 200 / 429 / 500 / 503**. **Parse the body regardless of
status.** Handle by category (**catch-all rule:** any unlisted `reasonCode` at
HTTP 200 = permanent-skip; at 429/503 = transient-retry):

- **Permanent — skip this asset/leg:** `not_jupiter_verified`, `tier_rejected`,
  `unknown_fund`, `fund_retired`, `fund_disabled`, `fund_halted`,
  `wallet_blocked`, `invalid_output`, `mint_not_allowlisted`, `mint_denylisted`,
  `nft_gate_required`. **Resize-and-retry:** `route_too_large` /
  `price_impact_too_high` (leg too big or too illiquid — send a smaller
  `usdcAmount` or a more liquid token; there's no hard min beyond a few USDC).
- **Fix the window:** `eval_period_out_of_bounds` — your window is outside the
  fund's bounds; the rejection's `details.minKpiSecs`/`details.maxKpiSecs` give
  the valid range.
- **STOP and start fresh (do NOT resume):** `intent_expired`, or **any** rejection
  with `details.resetIdempotency === true`. **Discard the Idempotency-Key for that
  leg and open a brand-new call** — a stale intent can only keep reverting, and
  the locked bond reclaims automatically. (This is the one case that inverts the
  "same key → resume" rule below.)
- **Capacity — do NOT tight-retry** (these clear on *hours*, not seconds — move
  the leg to another **open** fund, or defer it to the next cycle):
  `velocity_cap_reached` (5/hr per fund+wallet; the window **slides forward on
  each successful call**, so a 6th on the same fund is impossible until ~1h after
  your last success), `concurrent_cap_per_token` (clears only when an existing
  call on that fund+token resolves — up to the eval window), `daily_cap_per_token`
  (~24h), `daily_cap_per_fund` (~30h fixed).
- **Transient — retry after ~1–5s with backoff:** 429 `rate_limited` /
  `rate_limited_global` (honor `Retry-After`); 503 `oracle_unavailable` /
  `verified_list_unavailable` / `state_unavailable` / `build_failed` /
  `route_too_complex`; 500 `policy_load_failed`; and `retry_not_approved` on a
  resume that's too fast (back off, then re-resume — don't abort).

### 2. Take profit early — `POST /api/close-call`

The user signs the message `ride.markets:close-call:<proposalPk>:<signedAt>`
(`signedAt` = unix **seconds**, within ±5 min):
```js
const signedAt = Math.floor(Date.now()/1000);
const msg = new TextEncoder().encode(`ride.markets:close-call:${proposalPk}:${signedAt}`);
const sig = base64(await wallet.signMessage(msg));   // ed25519 over the raw bytes
```
**Body:** `{ proposalPk, walletPk, signature (base64), signedAt, authMethod? ("message"|"transaction"), signedTx? }`.
`walletPk` must be the original caller (signature + on-chain `Bet.creator` check).
Use `authMethod:"transaction"` only for Ledger (a memo-tx carrying the same
payload); `signature` stays required either way.

**Response:** `{ ok:true }` (queued only) / `{ ok:false, code, human }` (`not_caller`,
`not_closable`, `window_elapsed`, `stale_signature`, `bad_signature`, …). Success
only **queues** it; the crank runs the reverse only if it's provably profitable
on-chain. There is **no pre-flight profitability check** — expect
`close-call/status` to read `blocked_below_threshold` when not yet profitable.
A queued close that never clears the profit gate is **not** a dead end — the leg
just **resolves normally at window end**, so keep polling `call-realized`
regardless of `close-call/status`. A **10% early-close fee** applies (already
reflected in the realized number).

### 3. Read settled PnL — `GET /api/call-realized/:proposalPk`
- **Unresolved:** body is exactly `{ "realizedPnlUsd": null }` — the other fields
  are **omitted**.
- **Resolved** (window-end *or* early-close, same shape): `{ realizedPnlUsd, forwardUsdcIn, reverseUsdcOut, writtenAt }`.
  Gate on `realizedPnlUsd !== null`; treat each field as possibly null.
- `realizedPnlUsd !== null` is the **terminal signal** for a leg. The API does not
  distinguish an early-closed leg from a window-resolved one — track that yourself.

### 4. Early-close status — `GET /api/close-call/status?proposalPk=…`
`{ status: "none"|"queued"|"blocked_below_threshold", requestedAt?, creations }`.
In-flight only; returns to `none` once settled — **not** a completion signal (use
call-realized for that).

### 5. Callable assets — `GET /api/funds/markets`
`{ funds: [ { fundKey, open, allowedMints, bypassMints, perpEnabled, perpOpen, allowedPerpMarkets } ] }`.
Callable = **(fund.open OR mint ∈ allowedMints) AND (mint is Jupiter-verified OR
mint ∈ bypassMints)**. `allowedMints` is an *exclusive* whitelist (closed fund),
not "extra tokens." ⚠️ Retired/disabled funds may still appear here — a fund in
the list can still reject `fund_retired`/`fund_disabled`; use the funds table
above as the source of truth for what's live.

### 6. Access check — `GET /api/funds/nft-access?wallet=<pk>`
For NFT-gated funds (solariansvault, monkedao), confirm the caller holds the
required NFT before offering the fund.

### 7. Remaining budget — `GET /api/funds/limits?wallet=<pk>&mint=<outputMint>`
`{ limits: { <fundKey>: { velocityRemaining, dailyTokenRemaining, dailyFundRemaining, remaining, concurrentCap, concurrentRemaining } } }`.
**Pass `&mint=`** or the per-token/concurrent fields report the full cap. Only
`velocityRemaining` is per-wallet; the daily + concurrent numbers are **fund-wide
across all callers**. Advisory (fail-open); the real gate runs at open time.

---

## Limits

| Limit | Default | Scope |
|---|---|---|
| Verification | Jupiter-verified (unless in `bypassMints`) | output mint |
| Velocity | **5 / hour** | per (fund, **wallet**) — counter resets to a full hour on each successful call |
| Concurrent | **3 open** | per (fund, token) — **fund-wide** |
| Daily / token | **4 / 24h** | per (fund, token) — **fund-wide** |
| Daily / fund | **12 / 30h fixed window** | per (fund) — **fund-wide** |
| KPI window | per-fund (table) | per call |
| Position size | ≤ fund spending limit vs live treasury, ≤ $1M | per call |

Concurrent + daily are **shared across all callers** — a leg can be rejected
because other users filled the fund/token budget, independent of your usage.

---

## Live position (there is no live-PnL endpoint)

`call-realized` is **null until settlement** — you cannot read live/unrealized PnL
over REST. To show a moving basket value during the window, **mark-to-market
yourself**: the entry is the trade's input USDC vs `expectedOutputAtoms` from the
open response; multiply the current output-mint price (your own price feed, e.g.
Jupiter) by the held atoms and subtract the entry cost. Sum across open (marked) +
resolved (`call-realized`) legs for a blended basket PnL. Or treat positions as
opaque until `call-realized` flips non-null.

---

## Basket pattern (N calls as one)

No atomic on-chain basket — it's **N independent single-asset calls** you compose
and aggregate; each settles on its own.

1. Pick the theme's assets + weights. Filter to callable mints per §5 (+ §6 for a
   gated fund).
2. Split `usdcAmount` (position size) across legs by weight. **The user's real
   per-leg cost is the BOND**, in the fund's coin — for an N-leg basket on one
   fund the wallet must hold ≥ N × bond of that coin.
3. `POST /api/build-trade` per leg with a fund-valid `evaluationPeriodSecs` and a
   **distinct** `Idempotency-Key` (e.g. `<basketId>:<fund>:<mint>`). User signs +
   submits each (§1). *(The same key on two different funds is safe — we bind the
   fund into the on-chain identity — but include the fund to keep keys unambiguous.)*
4. **Partial fills are normal** (non-atomic). The **commit boundary is `cpwt`**
   (the first user tx, where the bond locks):
   - A leg rejected by `/build-trade` (`approved:false`) pulled **no bond** and
     costs the user nothing → safe to **redistribute or drop**.
   - A leg whose **`cpwt` confirmed** has its bond **locked and the position WILL
     open** even if a later tx fails — our backstop finishes the swap. Do **not**
     treat it as failed: **resume** it (same key) and count it as **opened**.
   So: refund/redistribute a leg only if `cpwt` never confirmed. Retry
   capacity/transient legs per §1's categories, and show "K of N opened."
5. **>5-asset baskets:** the velocity cap is 5/hr/(fund,wallet) and its window
   resets on each call — you **cannot** stagger a 6th onto the same fund within
   the hour. Split extra legs across **other open funds** (caps are per-fund) —
   but each fund needs its own bond in its own coin, so pre-fund all target funds.
6. Aggregate `realizedPnlUsd` across the legs' `proposalPk`s for basket PnL.
7. **Closing the whole basket early = N separate signed early-closes** (N wallet
   approvals), each queued and each executed only if that leg is individually
   profitable — so it's inherently a partial close. Poll `close-call/status` per
   leg and show "K of N closed."

---

## Retry / polling

Backoff only where §1 says "transient" (429 → honor `Retry-After`; 503 → ~1–5s +
jitter, ≤2 concurrent). **Never** tight-retry a capacity reject — move the leg to
another open fund or defer it (§1). Poll `call-realized` no more than every
~15–30s and only after `evaluationPeriodSecs` has elapsed (or after queuing an
early-close). Token metadata (output symbol/decimals/logo) isn't served by Ride —
fetch it from the Jupiter token list (the same source that drives the verified
gate).

---

## Testing

There is **no devnet/staging** here (coordinate with us if you need one) — it's
**mainnet, real funds**. The smallest safe end-to-end: pick one open fund, hold
just over its bond coin + ~0.03 SOL, open a single ~$5–$10 call on a liquid
verified asset (e.g. SOL/JUP), let it resolve or early-close, read `call-realized`.
Worst case if something goes wrong = you lose one bond. Don't run integration
tests with more than a couple of live calls.

---

## Suggested first integration

**One open fund (e.g. `cyrene`), 2–3 Jupiter-verified assets, a fund-valid window,
small size.** Ensure the test wallet holds ≥ the fund's bond coin + ~0.03 SOL.
Open → let one resolve (or early-close it) → read `call-realized` → confirm your
aggregated basket PnL. Then widen catalogue + size within the caps.

---

## Out of scope / coordinate with us

- **Perp / "Down" positions** — separate, credentialed path.
- **A dedicated Portfi fund** (raised caps, USDC bond, custom catalogue) — the
  clean long-term path if the shared-fund caps/exotic-coin bonds constrain you.
- **Base URL, co-signer pubkey, CORS origins, a devnet/staging test path, and
  exact bond values** — coordinate with us directly.
