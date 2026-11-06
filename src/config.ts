// Fixed settings for the fomcvault experiment, plus the environment.

export const FUND = {
  key: "fomcvault",
  realm: "JBkfmLArRp164zFX5w2sMKyzM7gX1g4XomEgLqLVXTyR",
  governance: "AW9354ircwqjmZNzGY6kzwcA4CqxP3ujcz5ydBMLN3hZ",
  bondMint: "5xD4rmd4Vsw3j35qnC8yQmPbxJ9HSbeiF9VTqoqride", // FOMC
  bondAtoms: 500_000n * 1_000_000n, // 500K FOMC, 6 decimals
} as const;

export const PROGRAMS = {
  sowellGov: "soGovSpYWEyohCPzQu3cwKrvBDBqL4kCbj3kBXvD8LW",
  tradeExecutor: "tRADeQ3SJVHnFXv1rpwZzVt5HE6DWDu4J6cH34Md6ZA",
} as const;

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Windows the code supports, in minutes. Which ones the bot may pick is set by WINDOWS_MINUTES
 *  (fomcvault must accept them: until ride-api allows 4h/6h, keep it at "60"). */
export const SUPPORTED_WINDOWS_MIN = [60, 240, 360] as const;
export type WindowMin = (typeof SUPPORTED_WINDOWS_MIN)[number];

/** Each call asks for this share of the live USDC treasury (the fund's cap is 25%).
 *  A hair under, so a small treasury move between build and execute doesn't trip SpendingLimitExceeded. */
export const SIZE_SHARE = 0.25 * 0.97;
/** Once the position is up this much on the trade, Claude decides: close now or keep holding. */
export const TAKE_PROFIT = 0.05;
/** While holding past TAKE_PROFIT, ask Claude again this often. */
export const HOLD_REVIEW_EVERY_SECS = 5 * 60;
/** While holding past TAKE_PROFIT, close at once if the gain falls to this. The fund only allows an
 *  early close above 4% (minEarlyProfitBps 400); below that the call rides to the end of its window. */
export const LOCK_FLOOR = 0.045;
/** ...or if it falls this far (0.02 = 2 points) below its peak. */
export const TRAIL_POINTS = 0.02;
/** Skip a token that rose more than this (%) in the last 5 minutes: buying right after a jump lost the most. */
export const MAX_PUMP_5M_PCT = 1.5;
/** Skip a token whose buy-and-sell-back at the call's size costs more than this, all in. */
export const MAX_ROUND_TRIP_COST = 0.01;
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
/** Shortlist filters: the fund itself requires $100K liquidity. */
export const MIN_LIQUIDITY_USD = 100_000;
export const MIN_VOLUME_24H_USD = 1_000_000;
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
