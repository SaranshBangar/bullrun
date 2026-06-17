// Pure, dependency-free helpers shared by the Worker, the browser game, and the
// node self-check. Keep it side-effect free so all three can import it.

export type Sector =
  | "Tech"
  | "Energy"
  | "Finance"
  | "Healthcare"
  | "Consumer"
  | "Industrial";

export interface Close {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface SeriesMeta {
  symbol: string;
  name: string;
  sector: Sector;
}

// 170deg gradient stops per sector, straight from the art direction doc.
export const SECTOR_SKY: Record<Sector, [string, string, string]> = {
  Tech: ["#1c2160", "#3f51cf", "#9fd9ec"],
  Energy: ["#5e1f30", "#d4602a", "#f8c96b"],
  Finance: ["#0d3b2b", "#2c8a58", "#e6d98a"],
  Healthcare: ["#0f4750", "#34a59c", "#dff4ec"],
  Consumer: ["#57214c", "#df6a8d", "#ffd9a8"],
  Industrial: ["#272d34", "#5b6975", "#b6bfc6"],
};

const SECTORS = Object.keys(SECTOR_SKY) as Sector[];

// Small hand-curated universe so ticker search + sector themes work offline.
// Real autocomplete would proxy a symbol-search API; this covers demo + tests.
export const UNIVERSE: SeriesMeta[] = [
  { symbol: "VOLT", name: "Voltaic Energy", sector: "Energy" },
  { symbol: "AAPL", name: "Apple Inc.", sector: "Tech" },
  { symbol: "NVDA", name: "NVIDIA Corp.", sector: "Tech" },
  { symbol: "MSFT", name: "Microsoft Corp.", sector: "Tech" },
  { symbol: "TSLA", name: "Tesla Inc.", sector: "Consumer" },
  { symbol: "AMZN", name: "Amazon.com Inc.", sector: "Consumer" },
  { symbol: "GOOGL", name: "Alphabet Inc.", sector: "Tech" },
  { symbol: "META", name: "Meta Platforms", sector: "Tech" },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Finance" },
  { symbol: "GS", name: "Goldman Sachs", sector: "Finance" },
  { symbol: "BAC", name: "Bank of America", sector: "Finance" },
  { symbol: "XOM", name: "Exxon Mobil", sector: "Energy" },
  { symbol: "CVX", name: "Chevron Corp.", sector: "Energy" },
  { symbol: "PFE", name: "Pfizer Inc.", sector: "Healthcare" },
  { symbol: "JNJ", name: "Johnson & Johnson", sector: "Healthcare" },
  { symbol: "UNH", name: "UnitedHealth Group", sector: "Healthcare" },
  { symbol: "VLDR", name: "Valdera Health", sector: "Healthcare" },
  { symbol: "VOLY", name: "Volsky Materials", sector: "Industrial" },
  { symbol: "CAT", name: "Caterpillar Inc.", sector: "Industrial" },
  { symbol: "BA", name: "Boeing Co.", sector: "Industrial" },
  { symbol: "GE", name: "General Electric", sector: "Industrial" },
  { symbol: "KO", name: "Coca-Cola Co.", sector: "Consumer" },
  { symbol: "NKE", name: "Nike Inc.", sector: "Consumer" },
  { symbol: "DIS", name: "Walt Disney Co.", sector: "Consumer" },
];

export function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic PRNG so synthetic courses are stable per ticker.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sectorFor(symbol: string): Sector {
  const known = UNIVERSE.find((u) => u.symbol === symbol.toUpperCase());
  if (known) return known.sector;
  return SECTORS[hashStr(symbol.toUpperCase()) % SECTORS.length];
}

export function nameFor(symbol: string): string {
  const known = UNIVERSE.find((u) => u.symbol === symbol.toUpperCase());
  return known ? known.name : symbol.toUpperCase();
}

// Deterministic synthetic daily closes seeded from the ticker. A drifting
// random walk with occasional overnight gaps so terrain has cliffs to clear.
export function syntheticCloses(symbol: string, n = 130, endDate = new Date()): Close[] {
  const rnd = mulberry32(hashStr(symbol.toUpperCase()));
  // Per-ticker character: starting price, drift, volatility.
  let price = 40 + rnd() * 260;
  const drift = (rnd() - 0.45) * 0.004; // slight upward bias on average
  const vol = 0.012 + rnd() * 0.03;
  const out: Close[] = [];
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 2 * vol;
    const gap = rnd() < 0.04 ? (rnd() - 0.5) * 0.12 : 0; // rare overnight gap
    price = Math.max(1, price * (1 + drift + shock + gap));
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    out.push({ date: d.toISOString().slice(0, 10), close: +price.toFixed(2) });
  }
  return out;
}

export function sentiment(closes: Close[]): { netPct: number; up: boolean } {
  if (closes.length < 2) return { netPct: 0, up: true };
  const a = closes[0].close;
  const b = closes[closes.length - 1].close;
  const netPct = ((b - a) / a) * 100;
  return { netPct, up: netPct >= 0 };
}

// Deterministic "ticker of the day": same symbol for everyone on a given UTC day.
export function dailyTicker(day: string): string {
  return UNIVERSE[hashStr(day) % UNIVERSE.length].symbol;
}
