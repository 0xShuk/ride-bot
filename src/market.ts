// Market data: Birdeye for the token list and candles, Jupiter for the verified list and live prices.

import { fetchWithTimeout } from "./http";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type ListToken = {
  mint: string;
  symbol: string;
  price: number;
  liquidity: number;
  volume24h: number;
  change5m: number | null;
  change1h: number | null;
  change6h: number | null;
  change24h: number | null;
  trades24h: number;
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export class Market {
  private verified: { mints: Map<string, number>; at: number } | null = null;

  constructor(
    private birdeyeKey: string,
    private jupiterKey: string | undefined,
  ) {}

  private async birdeye<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `https://public-api.birdeye.so/${path}?${new URLSearchParams(params)}`;
    const res = await fetchWithTimeout(`birdeye ${path}`, url, {
      headers: { "X-API-KEY": this.birdeyeKey, "x-chain": "solana", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`birdeye ${path} ${res.status}`);
    const json = (await res.json()) as { success?: boolean; data?: T };
    if (json.data === undefined) throw new Error(`birdeye ${path}: no data`);
    return json.data;
  }

  private jupiterHeaders() {
    return { "User-Agent": UA, ...(this.jupiterKey ? { "x-api-key": this.jupiterKey } : {}) };
  }

  /** Top tokens by 24h volume with at least `minLiquidity`, two pages of 50. */
  async topTokens(minLiquidity: number): Promise<ListToken[]> {
    type Item = {
      address: string;
      symbol?: string | null;
      price?: number | null;
      liquidity?: number | null;
      volume_24h_usd?: number | null;
      trade_24h_count?: number | null;
      price_change_5m_percent?: number | null;
      price_change_1h_percent?: number | null;
      price_change_6h_percent?: number | null;
      price_change_24h_percent?: number | null;
    };
    const out: ListToken[] = [];
    for (const offset of [0, 50]) {
      const data = await this.birdeye<{ items?: Item[] }>("defi/v3/token/list", {
        sort_by: "volume_24h_usd",
        sort_type: "desc",
        offset: String(offset),
        limit: "50",
        min_liquidity: String(minLiquidity),
      });
      for (const t of data.items ?? []) {
        if (!t.address || !(t.price && t.price > 0)) continue;
        out.push({
          mint: t.address,
          symbol: t.symbol ?? "?",
          price: t.price,
          liquidity: t.liquidity ?? 0,
          volume24h: t.volume_24h_usd ?? 0,
          change5m: t.price_change_5m_percent ?? null,
          change1h: t.price_change_1h_percent ?? null,
          change6h: t.price_change_6h_percent ?? null,
          change24h: t.price_change_24h_percent ?? null,
          trades24h: t.trade_24h_count ?? 0,
        });
      }
    }
    return out;
  }

  /** OHLCV candles, oldest first. */
  async candles(mint: string, type: "1m" | "5m" | "15m" | "1H" | "4H", count: number): Promise<Candle[]> {
    const step = { "1m": 60, "5m": 300, "15m": 900, "1H": 3600, "4H": 14400 }[type];
    const to = Math.floor(Date.now() / 1000);
    const data = await this.birdeye<{ items?: { unixTime: number; o: number; h: number; l: number; c: number; v: number }[] }>(
      "defi/ohlcv",
      { address: mint, type, time_from: String(to - step * count), time_to: String(to) },
    );
    return (data.items ?? [])
      .map((i) => ({ t: i.unixTime, o: i.o, h: i.h, l: i.l, c: i.c, v: i.v }))
      .sort((a, b) => a.t - b.t);
  }

  /** Jupiter-verified mints and their decimals, cached for an hour. */
  async verifiedMints(): Promise<Map<string, number>> {
    if (this.verified && Date.now() - this.verified.at < 3_600_000) return this.verified.mints;
    const res = await fetchWithTimeout(
      "jupiter verified list",
      "https://api.jup.ag/tokens/v2/tag?query=verified",
      { headers: this.jupiterHeaders() },
      45_000,
    );
    if (!res.ok) throw new Error(`jupiter tokens ${res.status}`);
    const tokens = (await res.json()) as { id: string; decimals: number }[];
    const mints = new Map(tokens.map((t) => [t.id, t.decimals]));
    this.verified = { mints, at: Date.now() };
    return mints;
  }

  /** Jupiter's output for swapping `amount` atoms, from the same build endpoint the app's swaps use. */
  private async quoteOut(inputMint: string, outputMint: string, amount: bigint, taker: string): Promise<bigint> {
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      taker,
      slippageBps: "50",
      wrapAndUnwrapSol: "true",
    });
    let res = await fetchWithTimeout("jupiter quote", `https://api.jup.ag/swap/v2/build?${q}`, { headers: this.jupiterHeaders() });
    // Rate-limited: wait and try twice more rather than skipping the token.
    for (let i = 1; res.status === 429 && i <= 2; i++) {
      await new Promise((r) => setTimeout(r, 2000 * i));
      res = await fetchWithTimeout("jupiter quote", `https://api.jup.ag/swap/v2/build?${q}`, { headers: this.jupiterHeaders() });
    }
    const json = (await res.json().catch(() => ({}))) as { outAmount?: string; error?: string; errorCode?: string };
    if (!res.ok || !json.outAmount || json.error || json.errorCode) {
      throw new Error(`jupiter quote ${res.status}: ${json.error ?? json.errorCode ?? "no route"}`);
    }
    return BigInt(json.outAmount);
  }

  /** Share of `usdc` lost buying `mint` and selling it straight back, as Jupiter quotes it now (0.004 = 0.4%). */
  async roundTripCost(mint: string, usdc: number, taker: string, usdcMint: string): Promise<number> {
    const usdcAtoms = BigInt(Math.floor(usdc * 1e6));
    const coins = await this.quoteOut(usdcMint, mint, usdcAtoms, taker);
    const back = await this.quoteOut(mint, usdcMint, coins, taker);
    return 1 - Number(back) / Number(usdcAtoms);
  }

  /** USDC atoms Jupiter would return now for selling `atoms` of `mint`. */
  async sellQuote(mint: string, atoms: bigint, taker: string, usdcMint: string): Promise<bigint> {
    return this.quoteOut(mint, usdcMint, atoms, taker);
  }

  /** Live USD prices from Jupiter. Missing mints are left out. */
  async prices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < mints.length; i += 50) {
      const ids = mints.slice(i, i + 50);
      const res = await fetchWithTimeout("jupiter price", `https://api.jup.ag/price/v3?ids=${ids.join(",")}`, {
        headers: this.jupiterHeaders(),
      });
      if (!res.ok) throw new Error(`jupiter price ${res.status}`);
      const json = (await res.json()) as Record<string, { usdPrice?: number } | undefined>;
      for (const m of ids) {
        const p = json[m]?.usdPrice;
        if (p && p > 0) out.set(m, p);
      }
    }
    return out;
  }
}
