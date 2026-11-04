# Ride Markets — Down (short) Calls API

The perp extension to the [Spot Calls API](./PORTFI_INTEGRATION.md) you already use.
A **"Down"** is a **1× short** — the same open → sign → submit flow you built for
"Up" calls, on a different endpoint. If your spot integration works, Downs are a
small delta.

---

## The model (30 seconds)

- A **Down** is a 1× short a **fund opens with its own collateral** (its buying
  power). The caller bets `$X`; the fund backs the short.
- Same auth model as spot: **user-signed, we co-sign** — you never hold a Ride
  credential. `/api/build-perp` returns a set of transactions (one already
  co-signed by us); the user signs the rest and submits them **in order**.
- Everything after the open is **server-driven** (our resolver opens, holds for
  the KPI window, and closes at window end). You only drive the open.

**What's the same as spot** (reuse your existing code):
- Build → get tx blobs (one pre-co-signed) → `signAllTransactions` (one approval)
  → submit **in order**, keeping our co-signature intact.
- The idempotency + retry semantics.
- The fail-closed, server-authoritative gates (curation / KPI window / caps).

**What's different:**
- Endpoint is `POST /api/build-perp` (not `/api/build-trade`).
- Body carries `market` + `collateralUsd` + `evaluationPeriodSec` instead of
  `outputMint` / `usdcAmount`.
- The idempotency nonce is a **body field (`reservationId`)**, not the
  `Idempotency-Key` header.
- **No early close.** Downs settle at window end only — there is no take-profit /
  `/api/close-call` for a Down.
- Perp opens draw from a **shared, limited slot pool**; a build can be rejected
  with `slots_busy` if the pool is momentarily full (retry shortly — see below).

---

## 1. Pick a market — `GET /api/perp-markets`

```
GET  <API_BASE>/api/perp-markets?fund=<key>
-> { "markets": [ { "symbol": "SOL", "market": "<Eternal orderbook pubkey>", "priceUsd": 172.3 }, … ] }
```

- Returns the currently-allowed markets (deep-liquidity crypto + equities/RWA).
- `?fund=<key>` narrows to a **curated** fund's allowlisted markets. Omit it for
  the open universe.
- Use the returned **`market`** value (the orderbook pubkey) verbatim in the open
  body — it must be allowlisted server-side or the open is rejected.

---

## 2. Open a Down — `POST /api/build-perp`

**Body:**

| field | type | required | notes |
|---|---|---|---|
| `fund` | string | ✓ | fund key backing the short |
| `wallet` | string | ✓ | caller's wallet — signs, is the executor, holds the bond coin + SOL |
| `market` | string | ✓ | Eternal orderbook pubkey from `/api/perp-markets` |
| `collateralUsd` | number | ✓ | the short size. Server clamps to the fund's limit and a **$600** max |
| `evaluationPeriodSec` | number | ✓ | KPI window — must be within the fund's min/max (else `eval_period_out_of_bounds`) |
| `name` | string | ✓ | proposal name — **must end in `" Down"`** and be **≤ 32 chars**, e.g. `"SOL Down"` |
| `reservationId` | string | ✓ | your idempotency nonce (8–128 chars) — see §3 |

> `name` is what our indexer reads to mark the ride a Down — always
> `"<SYMBOL> Down"` (the symbol from the market you picked). Not ending in
> `" Down"` = it won't be recognized as a short.

**Response — approved:**

```jsonc
{
  "approved": true,
  "market": "SOL",
  "proposalPk": "…",
  "betPk": "…",
  "intentPk": "…",           // use this to read the Down's live state (§4)
  "slotIndex": 7,
  "size": { "collateralAtoms": "…", "priceUsd": 172.3, … },
  "txs": [
    { "label": "cpwt",               "txB64": "…", "needsUserSig": true },
    { "label": "executeTransaction", "txB64": "…", "needsUserSig": true },
    { "label": "executeIntent",      "txB64": "…", "needsUserSig": true, "alreadySignedBy": ["<our co-signer>"] }
  ]
}
```

**Response — rejected** (policy/UX; HTTP 200, exactly like the spot route):

```json
{ "approved": false, "reasonCode": "slots_busy", "reasonHuman": "all perp slots are busy — try again shortly", "details": {} }
```

### Sign + submit (identical to your spot flow)

1. If `approved !== true`, surface `reasonHuman` (see §5 for codes). Do **not**
   submit anything.
2. Decode each `txs[].txB64` (base64 → `VersionedTransaction`).
3. Sign all blobs in **one** `wallet.signAllTransactions(...)` call. For
   `executeIntent`, the user signature is **added** to the already co-signed tx —
   do **not** re-serialize/rebuild it or our co-signature is lost.
4. Submit **in order**; `skipPreflight` on every step after the first.

**Worked example:**

```bash
curl -X POST $API_BASE/api/build-perp \
  -H "Content-Type: application/json" \
  -d '{
    "fund": "bandito",
    "wallet": "<CALLER_WALLET>",
    "market": "<orderbook pubkey from /api/perp-markets>",
    "collateralUsd": 50,
    "evaluationPeriodSec": 86400,
    "name": "SOL Down",
    "reservationId": "d1f0…"      // any unique string (a UUID is fine)
  }'
# -> { "approved": true, "proposalPk":"…", "intentPk":"…", "txs":[ {label:"cpwt",…}, {label:"executeTransaction",…}, {label:"executeIntent",…,"alreadySignedBy":[…]} ] }
```

```ts
const decoded = txs.map(t => VersionedTransaction.deserialize(base64ToBytes(t.txB64)));
const signed  = await wallet.signAllTransactions(decoded); // one approval; keeps our co-sig on executeIntent
for (let i = 0; i < signed.length; i++) {
  await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: i > 0 });
}
```

---

## 3. `reservationId` — just an idempotency nonce (nobody "reserves" anything)

`reservationId` is the Down equivalent of the spot **`Idempotency-Key`** — a
unique string **you generate** per open (a UUID is fine). There is **no reserve
step and no reserve endpoint**: you pass the nonce to `/api/build-perp` and the
server claims a free slot for you as part of the build.

- **Retrying a failed/un-landed open?** Send the **same `reservationId`** — the
  server derives the same intent (no double-open, no double slot).
- **Slot pool momentarily full?** You get `approved:false, reasonCode:"slots_busy"`.
  Back off a few seconds and retry (a fresh or the same `reservationId` both
  work). This is the only Down-specific failure to code for.

---

## 4. Reading a Down's state (for your UI)

| value | source | notes |
|---|---|---|
| Market list + price | `GET /api/perp-markets` (`priceUsd`) | ~60s freshness |
| Single live price | `GET /api/perp-price/:symbol` | one market at a time |
| **Entry price** | `GET /api/perp-ride/:intentPk` → `{ entryPrice, openedAt }` | the mark AT open; **not** on-chain, read it here |
| Live PnL % | `(entry − current) / entry` | a short wins when price **falls** |
| **Resolved PnL** | indexer `perpSettlement` (`realizedPnl` / `callerPayout`) | frozen once resolved — **not** `/api/call-pnl` (that's spot only) |

Direction/market are decoded from the on-chain name (ends in `" Down"`).

---

## 5. Endpoints & rejection codes

**Endpoints (all you need):**
`POST /api/build-perp` · `GET /api/perp-markets` · `GET /api/perp-price/:symbol` ·
`GET /api/perp-ride/:intentPk`

**Common `reasonCode`s** (`approved:false`):

| code | meaning |
|---|---|
| `slots_busy` | shared perp-slot pool momentarily full — retry shortly |
| `eval_period_out_of_bounds` | `evaluationPeriodSec` outside the fund's KPI window |
| `name_too_long` | `name` > 32 chars |
| `market_not_allowed` | `market` not on this fund's (or the global) allowlist |
| `unknown_fund` | bad `fund` key |
| `nft_gate_required` / `bricks_burn_required` | fund-specific entry gate (same as spot) |
| `alt_unavailable` / `build_failed` | transient — retry |

---

*Base URL + our co-signer pubkey are the same ones you use for spot. Ping us with
any questions.*
