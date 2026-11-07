// Fixed settings for each fund the bot can run on, plus the environment. One process runs one fund,
// picked by FUND_KEY (default fomcvault); each fund gets its own Render worker.

type Profile = {
  fund: { key: string; symbol: string; realm: string; governance: string; bondMint: string; bondAtoms: bigint };
  /** steady: 1- to 6-hour calls on established trends, closing small gains early.
   *  swing: few 1- to 2-day calls chasing big moves. */
  style: "steady" | "swing";
  /** Each call asks for this share of the live USDC treasury. A hair under the fund's cap, so a small
   *  treasury move between build and execute doesn't trip SpendingLimitExceeded. */
  sizeShare: number;
  /** The bot's own cap on calls per rolling 24 hours, under the fund's; null = as many as the fund allows. */
  maxCallsPerDay: number | null;
  takeProfit: number;
  holdReviewEverySecs: number;
  lockFloor: number;
  trailFrom: number;
  maxPump5mPct: number;
  maxRoundTripCost: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
};

const PROFILES: Record<string, Profile> = {
  fomcvault: {
    fund: {
      key: "fomcvault",
      symbol: "FOMC",
      realm: "JBkfmLArRp164zFX5w2sMKyzM7gX1g4XomEgLqLVXTyR",
      governance: "AW9354ircwqjmZNzGY6kzwcA4CqxP3ujcz5ydBMLN3hZ",
      bondMint: "5xD4rmd4Vsw3j35qnC8yQmPbxJ9HSbeiF9VTqoqride",
      bondAtoms: 500_000n * 1_000_000n, // 500K FOMC, 6 decimals
    },
    style: "steady",
    sizeShare: 0.25 * 0.97, // the fund's cap is 25%
    maxCallsPerDay: null,
    takeProfit: 0.05,
    holdReviewEverySecs: 5 * 60,
    // The chain lets an early close through only if the sale returns 4% more than the cost
    // (minEarlyProfitBps 400); the 0.4 points cover the price moving and the sale filling worse
    // than quoted while the close is cranked.
    lockFloor: 0.044,
    trailFrom: 0.08,
    maxPump5mPct: 1.5,
    maxRoundTripCost: 0.01,
    minLiquidityUsd: 100_000, // the fund itself requires $100K liquidity
    minVolume24hUsd: 1_000_000,
  },
  ridor: {
    fund: {
      key: "ridor",
      symbol: "RDR",
      realm: "9ZVrbuGqK9CydsW7cdqQXGPejyLqjmzveM9x9LXCV3By",
      governance: "ENQeWdjREgaHMgRDVXukrQ1dxFm8nDepPrY3cjgRc1wG",
      bondMint: "12nord6GuoXXzjuCanmu6RGDgd4LatVbzPBQep5rride",
      bondAtoms: 2_500_000n * 1_000_000n, // 2.5M RDR, 6 decimals
    },
    style: "swing",
    sizeShare: 0.2 * 0.97, // the fund's cap is 20%
    // Owner 2026-11-08: bonds for about 11 rides, so only the best 4-5 setups a day.
    maxCallsPerDay: 5,
    takeProfit: 0.2,
    holdReviewEverySecs: 15 * 60,
    lockFloor: 0.12,
    trailFrom: 0.3,
    maxPump5mPct: 4,
    maxRoundTripCost: 0.02,
    minLiquidityUsd: 50_000, // the fund allows $20K; calls are ~$120
    minVolume24hUsd: 250_000,
  },
};

const FUND_KEY = process.env.FUND_KEY?.trim() || "fomcvault";
const P = PROFILES[FUND_KEY];
if (!P) throw new Error(`FUND_KEY "${FUND_KEY}": use one of ${Object.keys(PROFILES).join(", ")}`);

export const FUND = P.fund;
export const STYLE = P.style;
export const MAX_CALLS_PER_DAY = P.maxCallsPerDay;

export const PROGRAMS = {
  sowellGov: "soGovSpYWEyohCPzQu3cwKrvBDBqL4kCbj3kBXvD8LW",
  tradeExecutor: "tRADeQ3SJVHnFXv1rpwZzVt5HE6DWDu4J6cH34Md6ZA",
} as const;

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Windows the code supports, in minutes. Which ones the bot may pick is set by WINDOWS_MINUTES
 *  (the fund must accept them: fomcvault allows up to 6h, ridor up to 2 days). */
export const SUPPORTED_WINDOWS_MIN = [60, 240, 360, 1440, 2880] as const;
export type WindowMin = (typeof SUPPORTED_WINDOWS_MIN)[number];

export const SIZE_SHARE = P.sizeShare;
/** Gains for early closing are measured by Jupiter's quote for selling the whole position, not the
 *  market price: the chain checks what the sale returns. */
/** Once the position would sell for this much more than it cost, Claude decides: close now or keep holding. */
export const TAKE_PROFIT = P.takeProfit;
/** While holding past TAKE_PROFIT, ask Claude again this often. */
export const HOLD_REVIEW_EVERY_SECS = P.holdReviewEverySecs;
/** While holding, close if the gain falls to this; below 4% (minEarlyProfitBps 400) the call can only
 *  ride to the end of its window. */
export const LOCK_FLOOR = P.lockFloor;
/** Trailing starts once the peak gain reaches this; below it only the floor closes a held call. */
export const TRAIL_FROM = P.trailFrom;
/** Trailing keeps this share of the peak gain (a 10% peak closes at 6%)... */
export const TRAIL_KEEP = 0.6;
/** ...or allows this many of the coin's typical 1-minute swings below the peak, whichever leaves more room. */
export const TRAIL_SWINGS = 2;
/** A floor or trail close fires only after this many monitor checks in a row under the line, so a wick doesn't sell. */
export const CONFIRM_CHECKS = 2;
/** Skip a token that rose more than this (%) in the last 5 minutes: buying right after a jump lost the most. */
export const MAX_PUMP_5M_PCT = P.maxPump5mPct;
/** Skip a token whose buy-and-sell-back at the call's size costs more than this, all in. */
export const MAX_ROUND_TRIP_COST = P.maxRoundTripCost;
/** Added to Jupiter's quoted round trip for what the quote doesn't show (executor tip, drift between
 *  quote and execution). Measured buy legs on liquid tokens cost 0-0.3% against 0.02-0.06% quotes. */
export const ROUND_TRIP_OVERHEAD = 0.0015;

/** Never called: stablecoins and the bond coin itself. */
export const SKIP_MINTS = new Set([
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", // USDG
  "CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", // CASH
  "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", // USDY
  FUND.bondMint,
]);

export const MODEL = "claude-sonnet-5-5";
export const DECIDE_EVERY_MS = 15 * 60_000;
export const MONITOR_EVERY_MS = 30_000;
export const MIN_LIQUIDITY_USD = P.minLiquidityUsd;
export const MIN_VOLUME_24H_USD = P.minVolume24hUsd;
export const SHORTLIST_SIZE = 5;

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const opt = (name: string) => process.env[name]?.trim() || undefined;

/** "60,240" -> [60, 240]; only supported windows, at least one. */
export function parseWindows(raw: string): WindowMin[] {
  const out = [...new Set(raw.split(",").map((x) => Number(x.trim())))].filter((m): m is WindowMin =>
    (SUPPORTED_WINDOWS_MIN as readonly number[]).includes(m),
  );
  if (!out.length) throw new Error(`WINDOWS_MINUTES "${raw}": use any of ${SUPPORTED_WINDOWS_MIN.join(", ")}`);
  return out.sort((a, b) => a - b);
}

export function loadEnv() {
  const dryRun = process.env.DRY_RUN === "true";
  return {
    dryRun,
    killSwitch: process.env.KILL_SWITCH === "true",
    windowsMin: parseWindows(process.env.WINDOWS_MINUTES ?? "60"),
    rpcUrl: need("RPC_URL"),
    rideApi: (opt("RIDE_API_URL") ?? "https://ride-api.fly.dev").replace(/\/+$/, ""),
    birdeyeKey: need("BIRDEYE_API_KEY"),
    jupiterKey: opt("JUPITER_API_KEY"),
    anthropicKey: need("ANTHROPIC_API_KEY"),
    // A dry run only needs the wallet's address; a live run needs the secret key.
    keypair: dryRun ? opt("BOT_KEYPAIR") : need("BOT_KEYPAIR"),
    walletAddress: opt("BOT_WALLET"),
    databaseUrl: dryRun ? opt("DATABASE_URL") : need("DATABASE_URL"),
    telegramToken: opt("TELEGRAM_BOT_TOKEN"),
    telegramChat: opt("TELEGRAM_CHAT_ID"),
  };
}
export type Env = ReturnType<typeof loadEnv>;
