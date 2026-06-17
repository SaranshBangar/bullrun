import { createAuthClient } from "better-auth/client";
import { dashClient, sentinelClient } from "@better-auth/infra/client";
import type { SeriesData, GhostFrame, RunResult } from "./game/engine";
import {
  UNIVERSE,
  syntheticCloses,
  sentiment,
  sectorFor,
  nameFor,
  dailyTicker,
  type Sector,
} from "./shared/series";

const j = async (r: Response): Promise<any> => {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || r.statusText);
  }
  return r.json();
};

// The Worker (worker/index.ts) backs the API on Cloudflare. On a static-only
// host (e.g. Vercel) there is no Worker, so the read-only synthetic-data routes
// fall back to computing the same result in the browser from the shared pure
// helpers — keeping the core game (search/series/daily) fully playable. These
// mirror the Worker handlers exactly. Persistence routes (leaderboard, ghost,
// score, share, auth) stay backend-only and degrade gracefully via their
// callers' empty-state handling.
const withFallback = async <T>(remote: () => Promise<T>, local: () => T): Promise<T> => {
  try {
    return await remote();
  } catch {
    return local();
  }
};

const localSearch = (q: string): Symbol[] => {
  const u = q.toUpperCase().trim();
  return (u ? UNIVERSE.filter((x) => x.symbol.startsWith(u) || x.name.toUpperCase().includes(u)) : UNIVERSE).slice(0, 8);
};
const localSeries = (symbol: string): SeriesData => {
  const sym = symbol.toUpperCase();
  const closes = syntheticCloses(sym, 130);
  return { symbol: sym, name: nameFor(sym), sector: sectorFor(sym), sentiment: sentiment(closes), closes };
};
const localDaily = (): DailyInfo => {
  const day = new Date().toISOString().slice(0, 10);
  const symbol = dailyTicker(day);
  const resetsInMs = new Date(day + "T00:00:00Z").getTime() + 86400000 - Date.now();
  return { symbol, name: nameFor(symbol), sector: sectorFor(symbol), day, resetsInMs };
};

export const authClient = createAuthClient({
  // `as any`: infra's client plugin types and better-auth 1.6's client typings
  // disagree across the version boundary; the plugin objects are valid at runtime.
  plugins: [dashClient(), sentinelClient()] as any,
});

export interface Symbol {
  symbol: string;
  name: string;
  sector: Sector;
}
export interface DailyInfo {
  symbol: string;
  name: string;
  sector: Sector;
  day: string;
  resetsInMs: number;
}
export interface ScoreRow {
  username: string;
  time_ms: number | null;
  style: number;
  coins: number;
  best_trick: string | null;
  day: string;
}

export const api = {
  search: (q: string): Promise<Symbol[]> =>
    withFallback(() => fetch(`/api/stock/search?q=${encodeURIComponent(q)}`).then(j), () => localSearch(q)),
  series: (symbol: string): Promise<SeriesData> =>
    withFallback(() => fetch(`/api/stock/series?symbol=${symbol}`).then(j), () => localSeries(symbol)),
  daily: (): Promise<DailyInfo> => withFallback(() => fetch(`/api/daily`).then(j), () => localDaily()),
  leaderboard: (ticker: string, tab: "time" | "style", view: "daily" | "all"): Promise<ScoreRow[]> =>
    fetch(`/api/leaderboard?ticker=${ticker}&tab=${tab}&view=${view}`).then(j),
  ghost: (ticker: string, tab: "time" | "style"): Promise<{ path: GhostFrame[]; username: string } | null> =>
    fetch(`/api/ghost?ticker=${ticker}&tab=${tab}`).then(j),
  submit: (r: RunResult & { isDaily: boolean }): Promise<{ ok: true }> =>
    fetch(`/api/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticker: r.ticker,
        timeMs: r.timeMs,
        style: r.style,
        coins: r.coins,
        bestTrick: r.bestTrick,
        isDaily: r.isDaily,
        path: r.path,
      }),
    }).then(j),
  share: (snapshot: unknown): Promise<{ id: string; url: string }> =>
    fetch(`/api/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    }).then(j),
  getShare: (id: string): Promise<any> => fetch(`/api/share/${id}`).then(j),
};
