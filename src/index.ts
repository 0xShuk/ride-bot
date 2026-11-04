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

/** Runs `fn` every `ms`, never overlapping itself; errors are logged, not fatal. */
function every(name: string, ms: number, fn: () => Promise<void>) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error(`[${name}]`, e instanceof Error ? e.message : e);
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

  every("decide", DECIDE_EVERY_MS, () => bot.decideRound());
  every("monitor", MONITOR_EVERY_MS, () => bot.monitorRound());
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
