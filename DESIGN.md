# Ride Bot: autonomous trading on fomcvault (experiment)

A bot that makes Up calls on the Ride fund **fomcvault** on its own, through ride-api's public call API
(see `PORTFI_INTEGRATION.md`). Built to run as an experiment; performance is secondary.

## Fund

| | |
|---|---|
| Fund key | `fomcvault` (https://www.ride.markets/funds/fomcvault) |
| Fund address (realm) | `JBkfmLArRp164zFX5w2sMKyzM7gX1g4XomEgLqLVXTyR` |
| Bond coin | FOMC `5xD4rmd4Vsw3j35qnC8yQmPbxJ9HSbeiF9VTqoqride` |
| Bond | 500,000 FOMC per call |
| Position cap | 25% of the treasury's USDC (ride-api clamps) |
| Allowed tokens | $100K+ liquidity (enforced by ride-api) |
| Early-close minimum | 4% (`minEarlyProfitBps` 400) |

### Fund limits (shared with human callers)

| Limit | Value |
|---|---|
| Open calls on one coin | 3 |
| Calls on one coin per day | 6 |
| Calls on the whole fund per day | 16 |
| Calls on the whole fund per hour | 7 |
| Blue chips (SOL, cbBTC, WETH, LSTs) | 8 open, 8 per day per coin |

## Decisions

- **Brain:** rules shortlist, Claude Sonnet 5.5 picks.
- **Direction:** Up only (`POST /api/build-trade`).
- **Tokens:** Jupiter-verified, $100K+ liquidity, filtered further by the bot on 24h volume.
- **Pace:** as many calls as the fund limits allow (up to 16/day).
- **Size:** 25% of the live USDC treasury per call.
- **Duration:** 1, 4 or 6 hours, picked per call (`WINDOWS_MINUTES`; 4h/6h once fomcvault accepts them).
- **Entry filters:** skip a token up more than 1.5% in the last 5 minutes, and one whose buy + sell-back costs more than 1% at the call's size (Jupiter quote + 0.15% allowance).
- **Early close:** checked every 30 s. At +5% on the trade, Claude decides: close now or hold for more. While holding, it is asked again every 5 minutes, and the call closes without asking if the gain falls to 4.5% or 2 points below its peak. A failed review closes.
- **Safety:** kill switch only.
- **Disclosure:** none; calls look like any other caller's. Claude's reasons stay in the bot's own records.
- **Alerts:** Telegram.
- **Data:** Birdeye (candles, volume, liquidity) + Jupiter (live prices, verified list).
- **Wallet:** dedicated hot wallet with 200M FOMC (400 bonds) and ~0.1 SOL.

## Loop

**Every 15 minutes**
1. Kill switch on → no new calls (open calls still run to their end).
2. Room left under the limits? (own records + `GET /api/funds/limits`). If not, skip.
3. Rules rank liquid tokens by an established 1h/6h/24h trend, drop fresh 5m jumps and costly round trips, keep ~5.
4. Claude Sonnet 5.5 picks one token and a window (from `WINDOWS_MINUTES`), or passes, with a short reason.
5. `POST /api/build-trade` (fund `fomcvault`, 25% of live USDC treasury, unique `Idempotency-Key`),
   sign, send in order. On failure, rebuild with the same key; on `intent_expired` /
   `resetIdempotency`, drop it.

**Every ~30 seconds, per open call**
- Mark to market with Jupiter prices vs entry. Up ≥ 5% → Claude: close or hold (`src/exit.ts`). Close → `POST /api/close-call` (signed by the bot wallet).
- Otherwise it resolves at window end; record the result from `GET /api/call-realized/:proposalPk`.

## Running

- Render **Background Worker** (Node + TypeScript), repo `ride-bot`.
- Render **Postgres** (paid tier): decisions, calls, idempotency keys, entries, closes, results, P&L.
- Telegram: call opened, early close, result, errors, daily P&L summary.

### Secrets (Render env vars)

| Name | What |
|---|---|
| `BOT_KEYPAIR` | bot wallet secret key |
| `ANTHROPIC_API_KEY` | Claude API |
| `BIRDEYE_API_KEY` | Birdeye |
| `JUPITER_API_KEY` | Jupiter |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | alerts |
| `RPC_URL` | Solana mainnet RPC |
| `DATABASE_URL` | Render Postgres |
| `RIDE_API_URL` | `https://ride-api.fly.dev` |
| `KILL_SWITCH` | `true` stops new calls |
