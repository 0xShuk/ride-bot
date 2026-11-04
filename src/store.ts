// The bot's records: Postgres in production, memory for a local dry run.
// Tables live in their own schema (`ridebot`), so the bot can share a database with
// another app (realms_api) without touching its tables or its Prisma migrations.

import pg from "pg";

export type CallStatus = "building" | "open" | "close_requested" | "resolved" | "failed";

export type CallRow = {
  id: number;
  idempotencyKey: string;
  mint: string;
  symbol: string;
  durationSecs: number;
  usdcRequested: number;
  reason: string;
  status: CallStatus;
  proposalPk: string | null;
  intentPk: string | null;
  inputUsd: number | null;
  outputAtoms: string | null;
  outputDecimals: number;
  executedAt: number | null; // unix seconds
  peakPnlPct: number | null;
  realizedPnlUsd: number | null;
  error: string | null;
  createdAt: number; // unix ms
};

export interface Store {
  init(): Promise<void>;
  logDecision(d: { action: string; symbol: string | null; reason: string; shortlist: string[] }): Promise<void>;
  createCall(c: Pick<CallRow, "idempotencyKey" | "mint" | "symbol" | "durationSecs" | "usdcRequested" | "reason" | "outputDecimals">): Promise<CallRow>;
  updateCall(id: number, patch: Partial<CallRow>): Promise<void>;
  /** Calls not yet resolved or failed. */
  activeCalls(): Promise<CallRow[]>;
  /** Resolved calls since `sinceMs`, for the daily summary. */
  resolvedSince(sinceMs: number): Promise<CallRow[]>;
}

export class MemoryStore implements Store {
  private calls: CallRow[] = [];
  async init() {}
  async logDecision() {}
  async createCall(c: Parameters<Store["createCall"]>[0]) {
    const row: CallRow = {
      ...c,
      id: this.calls.length + 1,
      status: "building",
      proposalPk: null,
      intentPk: null,
      inputUsd: null,
      outputAtoms: null,
      executedAt: null,
      peakPnlPct: null,
      realizedPnlUsd: null,
      error: null,
      createdAt: Date.now(),
    };
    this.calls.push(row);
    return row;
  }
  async updateCall(id: number, patch: Partial<CallRow>) {
    Object.assign(this.calls[id - 1], patch);
  }
  async activeCalls() {
    return this.calls.filter((c) => c.status !== "resolved" && c.status !== "failed");
  }
  async resolvedSince(sinceMs: number) {
    return this.calls.filter((c) => c.status === "resolved" && c.createdAt >= sinceMs);
  }
}

const COLS: Record<keyof CallRow, string> = {
  id: "id",
  idempotencyKey: "idempotency_key",
  mint: "mint",
  symbol: "symbol",
  durationSecs: "duration_secs",
  usdcRequested: "usdc_requested",
  reason: "reason",
  status: "status",
  proposalPk: "proposal_pk",
  intentPk: "intent_pk",
  inputUsd: "input_usd",
  outputAtoms: "output_atoms",
  outputDecimals: "output_decimals",
  executedAt: "executed_at",
  peakPnlPct: "peak_pnl_pct",
  realizedPnlUsd: "realized_pnl_usd",
  error: "error",
  createdAt: "created_at",
};

const fromRow = (r: Record<string, unknown>): CallRow => {
  const out = {} as Record<string, unknown>;
  for (const [k, col] of Object.entries(COLS)) out[k] = r[col];
  // pg returns bigint/numeric as strings.
  for (const k of ["id", "durationSecs", "usdcRequested", "outputDecimals", "createdAt"]) out[k] = Number(out[k]);
  for (const k of ["inputUsd", "executedAt", "peakPnlPct", "realizedPnlUsd"]) out[k] = out[k] === null ? null : Number(out[k]);
  return out as CallRow;
};

export class PgStore implements Store {
  private pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: false } });
  }

  async init() {
    await this.pool.query(`
      create schema if not exists ridebot;
      create table if not exists ridebot.decisions (
        id serial primary key,
        at timestamptz not null default now(),
        action text not null,
        symbol text,
        reason text not null,
        shortlist text[] not null
      );
      create table if not exists ridebot.calls (
        id serial primary key,
        idempotency_key text not null unique,
        mint text not null,
        symbol text not null,
        duration_secs int not null,
        usdc_requested numeric not null,
        reason text not null,
        status text not null,
        proposal_pk text,
        intent_pk text,
        input_usd numeric,
        output_atoms text,
        output_decimals int not null,
        executed_at bigint,
        peak_pnl_pct numeric,
        realized_pnl_usd numeric,
        error text,
        created_at bigint not null
      );`);
  }

  async logDecision(d: { action: string; symbol: string | null; reason: string; shortlist: string[] }) {
    await this.pool.query("insert into ridebot.decisions (action, symbol, reason, shortlist) values ($1, $2, $3, $4)", [
      d.action,
      d.symbol,
      d.reason,
      d.shortlist,
    ]);
  }

  async createCall(c: Parameters<Store["createCall"]>[0]) {
    const { rows } = await this.pool.query(
      `insert into ridebot.calls (idempotency_key, mint, symbol, duration_secs, usdc_requested, reason, status, output_decimals, created_at)
       values ($1, $2, $3, $4, $5, $6, 'building', $7, $8) returning *`,
      [c.idempotencyKey, c.mint, c.symbol, c.durationSecs, c.usdcRequested, c.reason, c.outputDecimals, Date.now()],
    );
    return fromRow(rows[0]);
  }

  async updateCall(id: number, patch: Partial<CallRow>) {
    const entries = Object.entries(patch) as [keyof CallRow, unknown][];
    if (!entries.length) return;
    const sets = entries.map(([k], i) => `${COLS[k]} = $${i + 2}`).join(", ");
    await this.pool.query(`update ridebot.calls set ${sets} where id = $1`, [id, ...entries.map(([, v]) => v)]);
  }

  async activeCalls() {
    const { rows } = await this.pool.query("select * from ridebot.calls where status not in ('resolved', 'failed') order by id");
    return rows.map(fromRow);
  }

  async resolvedSince(sinceMs: number) {
    const { rows } = await this.pool.query("select * from ridebot.calls where status = 'resolved' and created_at >= $1", [sinceMs]);
    return rows.map(fromRow);
  }
}
