import { createAuthClient } from "better-auth/client";
import type { SeriesData, GhostFrame, RunResult } from "./game/engine";
import type { Sector } from "./shared/series";

const j = async (r: Response): Promise<any> => {
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || r.statusText);
  }
  return r.json();
};

export const authClient = createAuthClient();

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
  search: (q: string): Promise<Symbol[]> => fetch(`/api/stock/search?q=${encodeURIComponent(q)}`).then(j),
  series: (symbol: string): Promise<SeriesData> => fetch(`/api/stock/series?symbol=${symbol}`).then(j),
  daily: (): Promise<DailyInfo> => fetch(`/api/daily`).then(j),
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
