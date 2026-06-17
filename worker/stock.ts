import { Close, syntheticCloses } from "../src/shared/series";
import type { Env } from "./index";

const N = 130;

// One pluggable interface, three sources tried in order: Twelve Data → Alpha
// Vantage → deterministic synthetic. Cached per symbol+day so the course
// "updates each day" but reuses data within a day.
export async function getSeries(env: Env, symbol: string): Promise<Close[]> {
  symbol = symbol.toUpperCase();
  const day = new Date().toISOString().slice(0, 10);
  const cacheKey = `stock:${symbol}:${day}`;

  const cached = await env.KV.get(cacheKey, "json");
  if (cached && Array.isArray(cached) && cached.length) return cached as Close[];

  let series: Close[] | null = null;
  try {
    if (env.TWELVE_DATA_KEY) series = await fromTwelveData(symbol, env.TWELVE_DATA_KEY);
  } catch (e) {
    console.warn("twelvedata failed", e);
  }
  try {
    if (!series && env.ALPHA_VANTAGE_KEY)
      series = await fromAlphaVantage(symbol, env.ALPHA_VANTAGE_KEY);
  } catch (e) {
    console.warn("alphavantage failed", e);
  }
  if (!series || series.length < 10) series = syntheticCloses(symbol, N);

  // Cache for a day (86400s). Synthetic is deterministic so caching it is fine too.
  await env.KV.put(cacheKey, JSON.stringify(series), { expirationTtl: 86400 });
  return series;
}

async function fromTwelveData(symbol: string, key: string): Promise<Close[]> {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    symbol
  )}&interval=1day&outputsize=${N}&order=ASC&apikey=${key}`;
  const r = await fetch(url);
  const j: any = await r.json();
  if (j.status === "error" || !Array.isArray(j.values)) throw new Error(j.message || "no data");
  return j.values.map((v: any) => ({ date: v.datetime, close: +v.close }));
}

async function fromAlphaVantage(symbol: string, key: string): Promise<Close[]> {
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(
    symbol
  )}&outputsize=compact&apikey=${key}`;
  const r = await fetch(url);
  const j: any = await r.json();
  const ts = j["Time Series (Daily)"];
  if (!ts) throw new Error(j.Note || j["Error Message"] || "no data");
  return Object.entries(ts)
    .map(([date, v]: [string, any]) => ({ date, close: +v["4. close"] }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-N);
}
