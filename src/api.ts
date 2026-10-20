import type { SeriesData } from "./game/engine";
import { UNIVERSE, syntheticCloses, sentiment, sectorFor, nameFor, keyDays, type NewsItem, type Sector } from "./shared/series";

export interface Symbol {
  symbol: string;
  name: string;
  sector: Sector;
  exchange?: string;
}

// Thrown when the market-data API answered and the ticker doesn't exist.
export class UnknownSymbol extends Error {}

const localSearch = (q: string): Symbol[] => {
  const u = q.toUpperCase().trim();
  return UNIVERSE.filter((x) => x.symbol.startsWith(u) || x.name.toUpperCase().includes(u)).slice(0, 8);
};

// Offline fallback: deterministic prices so the game still plays when the
// API is unreachable. Flagged `simulated` so the UI never passes it off as real.
const localSeries = (symbol: string): SeriesData => {
  const closes = syntheticCloses(symbol, 126);
  return { symbol, name: nameFor(symbol), sector: sectorFor(symbol), sentiment: sentiment(closes), closes, simulated: true };
};

const cache = new Map<string, Promise<SeriesData>>();
const newsCache = new Map<string, Promise<(NewsItem | null)[]>>();

export const api = {
  search: async (q: string): Promise<Symbol[]> => {
    try {
      const r = await fetch(`/api/stock?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error(String(r.status));
      const rows = (await r.json()) as (Omit<Symbol, "sector"> & { sector?: Sector })[];
      return rows.map((x) => ({ ...x, sector: x.sector ?? sectorFor(x.symbol) }));
    } catch {
      return localSearch(q);
    }
  },

  series: (symbol: string): Promise<SeriesData> => {
    symbol = symbol.trim().toUpperCase();
    let p = cache.get(symbol);
    if (!p) {
      p = loadSeries(symbol);
      cache.set(symbol, p);
      p.catch(() => cache.delete(symbol));
    }
    return p;
  },

  // Headlines for the chart's key days (same order as keyDays), null where
  // none was found. Empty when offline or the prices are simulated.
  news: (d: SeriesData): Promise<(NewsItem | null)[]> => {
    if (d.simulated) return Promise.resolve([]);
    let p = newsCache.get(d.symbol);
    if (!p) {
      const days = keyDays(d.closes);
      const qs = new URLSearchParams({
        news: d.symbol,
        n: d.name,
        d: days.map((i) => d.closes[i].date).join(","),
        m: days.map((i) => (d.closes[i].close >= d.closes[i - 1].close ? "+" : "-")).join(""),
      });
      p = fetch(`/api/stock?${qs}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
      newsCache.set(d.symbol, p);
      p.catch(() => newsCache.delete(d.symbol));
    }
    return p.catch(() => []);
  },
};

async function loadSeries(symbol: string): Promise<SeriesData> {
  let r: Response;
  try {
    r = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}`);
  } catch {
    return localSeries(symbol);
  }
  const body = (await r.json().catch(() => null)) as any;
  if (r.ok && body?.closes?.length) {
    return { ...body, sector: body.sector ?? sectorFor(symbol), sentiment: sentiment(body.closes) };
  }
  if (body?.code === "unknown_symbol" || body?.code === "bad_symbol") throw new UnknownSymbol(body.error);
  return localSeries(symbol); // API missing or upstream down
}
