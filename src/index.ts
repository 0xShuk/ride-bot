// Entry point: wire everything up and run the loops.
//   npm start         live (needs BOT_KEYPAIR, DATABASE_URL)
//   npm run dry       decides and reports what it would open; sends nothing
//   --once            one decision round, then exit

import { PublicKey } from "@solana/web3.js";
import { Bot } from "./bot";
import { Brain } from "./brain";
import { Chain, TREASURY, parseKeypair } from "./chain";
import { DECIDE_EVERY_MS, FUND, MONITOR_EVERY_MS, loadEnv } from "./config";
import { Market } from "./market";
import { RideApi } from "./ride";
import { MemoryStore, PgStore } from "./store";
import { Telegram } from "./telegram";

/** Error alerts per loop: at most one Telegram message per 30 minutes, plus one when it recovers. */
const ALERT_EVERY_MS = 30 * 60_000;

/** Runs `fn` every `ms`, never overlapping itself. Errors are logged and alerted, never fatal. */
function every(name: string, ms: number, fn: () => Promise<void>, tg: Telegram) {
  let busy = false;
  let failing = 0;
  let alertedAt = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (failing) {
        if (alertedAt) await tg.send(`${name} loop recovered after ${failing} failed round(s).`);
        failing = 0;
        alertedAt = 0;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${name}]`, msg);
      failing++;
      if (Date.now() - alertedAt > ALERT_EVERY_MS) {
        alertedAt = Date.now();
        await tg.send(`${name} loop error (${failing} in a row), will retry: ${msg}`);
      }
    } finally {
      busy = false;
    }
  };
  void tick();
  return setInterval(tick, ms);
}

async function main() {
  const env = loadEnv();
  const kp = env.keypair ? parseKeypair(env.keypair) : null;
  const wallet = kp?.publicKey ?? (env.walletAddress ? new PublicKey(env.walletAddress) : null);
  if (!wallet) throw new Error("set BOT_KEYPAIR, or BOT_WALLET for a dry run");

  const store = env.databaseUrl ? new PgStore(env.databaseUrl) : new MemoryStore();
  await store.init();
  const tg = new Telegram(env.telegramToken, env.telegramChat);
  const bot = new Bot(
    env,
    wallet,
    kp,
    new Chain(env.rpcUrl),
    new Market(env.birdeyeKey, env.jupiterKey),
    new Brain(env.anthropicKey),
    new RideApi(env.rideApi),
    store,
    tg,
  );

  console.log(
    `[ride-bot] fund ${FUND.key}, wallet ${wallet.toBase58()}, treasury ${TREASURY.toBase58()}` +
      `${env.dryRun ? ", DRY RUN" : ""}${env.killSwitch ? ", KILL SWITCH ON" : ""}`,
  );

  if (process.argv.includes("--once")) {
    await bot.decideRound();
    process.exit(0);
  }

  await bot.recover();
  every("decide", DECIDE_EVERY_MS, () => bot.decideRound(), tg);
  every("monitor", MONITOR_EVERY_MS, () => bot.monitorRound(), tg);
  // Daily summary at 00:00 UTC.
  let lastDay = new Date().getUTCDate();
  setInterval(() => {
    const day = new Date().getUTCDate();
    if (day !== lastDay) {
      lastDay = day;
      void bot.dailySummary().catch((e) => console.error("[summary]", e));
    }
  }, 60_000);
  if (!env.dryRun) await tg.send(`Ride Bot started on ${FUND.key}${env.killSwitch ? " (kill switch ON)" : ""}`);
}

// Anything that escapes the loops: log it and exit, and Render restarts the worker.
process.on("unhandledRejection", (e) => {
  console.error("[fatal] unhandled rejection", e);
  process.exit(1);
});

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
