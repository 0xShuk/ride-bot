// Runs one bot process per fund in FUNDS (comma-separated, default fomcvault) inside a single worker.
// Per-fund overrides: <FUND>_WINDOWS_MINUTES, <FUND>_DRY_RUN, <FUND>_KILL_SWITCH (e.g. RIDOR_DRY_RUN=true);
// otherwise each process gets the shared WINDOWS_MINUTES / DRY_RUN / KILL_SWITCH.
// If any process exits, the rest are stopped too, so Render restarts the whole worker.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const funds = (process.env.FUNDS ?? "fomcvault").split(",").map((f) => f.trim()).filter(Boolean);
const children = funds.map((fund) => {
  const up = fund.toUpperCase();
  const pick = (name) => process.env[`${up}_${name}`] ?? process.env[name] ?? "";
  return spawn("node_modules/.bin/tsx", ["src/index.ts"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, FUND_KEY: fund, WINDOWS_MINUTES: pick("WINDOWS_MINUTES") || "60", DRY_RUN: pick("DRY_RUN"), KILL_SWITCH: pick("KILL_SWITCH") },
  });
});

let stopping = false;
const stopAll = (code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 5000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((r) => c.on("exit", r))))).then(() => process.exit(code));
};
children.forEach((c, i) =>
  c.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[start-all] ${funds[i]} exited (${signal ?? code}); stopping the others`);
    stopAll(code || 1);
  }),
);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => stopAll(0));
