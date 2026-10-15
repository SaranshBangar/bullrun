// Vercel Function (also mounted by vite.config.ts in dev).
//   GET /api/stock?symbol=AAPL  -> ~6 months of daily closes + company meta
//   GET /api/stock?q=apple      -> symbol search
// Data comes from Yahoo Finance's public chart/search endpoints: no API key.
// Responses are cached at the CDN so popular tickers cost one upstream call.
// Self-contained on purpose (type-only imports) so Vercel bundles it as-is.
import type { Close, Sector } from "../src/shared/series";

const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const HEADERS = { "user-agent": "Mozilla/5.0 (compatible; BullRun/2.0)", accept: "application/json" };
const SYMBOL_RE = /^[A-Z0-9.\-^=]{1,20}$/;

const SECTORS: Record<string, Sector> = {
  Technology: "Tech",
  "Communication Services": "Tech",
  Energy: "Energy",
  Utilities: "Energy",
  "Financial Services": "Finance",
  Healthcare: "Healthcare",
  "Consumer Cyclical": "Consumer",
  "Consumer Defensive": "Consumer",
  Industrials: "Industrial",
  "Basic Materials": "Industrial",
  "Real Estate": "Industrial",
};

const json = (data: unknown, status = 200, cache = "public, s-maxage=1800, stale-while-revalidate=86400") =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": status === 200 ? cache : "no-store" },
  });

// Try each Yahoo host; a 404 is a real answer ("unknown symbol"), not a reason to retry.
async function yahoo(path: string): Promise<any> {
  let err: unknown = new Error("no upstream");
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + path, { headers: HEADERS });
      if (r.ok || r.status === 404) return await r.json();
      err = new Error(`upstream ${r.status}`);
    } catch (e) {
      err = e;
    }
  }
  throw err;
}

async function search(q: string, count = 8) {
  const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${count}&newsCount=0&listsCount=0`);
  return ((j?.quotes ?? []) as any[])
    .filter((x) => (x.quoteType === "EQUITY" || x.quoteType === "ETF") && x.symbol)
    .map((x) => ({
      symbol: String(x.symbol).toUpperCase(),
      name: String(x.longname || x.shortname || x.symbol),
      exchange: x.exchDisp ? String(x.exchDisp) : undefined,
      sector: SECTORS[x.sector] as Sector | undefined,
    }));
}

async function series(symbol: string) {
  const [chart, matches] = await Promise.all([
    yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`),
    search(symbol, 5).catch(() => []), // only used for the sector; best-effort
  ]);
  const res = chart?.chart?.result?.[0];
  const ts: number[] = res?.timestamp ?? [];
  const raw: (number | null)[] = res?.indicators?.quote?.[0]?.close ?? [];
  const offset = Number(res?.meta?.gmtoffset) || 0;
  const closes: Close[] = [];
  ts.forEach((t, i) => {
    const c = raw[i];
    if (c == null || !Number.isFinite(c)) return;
    // Date in the exchange's own timezone, so a Mumbai close isn't shifted a day.
    closes.push({ date: new Date((t + offset) * 1000).toISOString().slice(0, 10), close: +c.toFixed(4) });
  });
  if (closes.length < 10) return null;
  const m = res.meta;
  const hit = matches.find((x) => x.symbol === symbol);
  return {
    symbol,
    name: String(m.longName || m.shortName || hit?.name || symbol),
    exchange: String(m.fullExchangeName || m.exchangeName || hit?.exchange || ""),
    currency: String(m.currency || "USD"),
    sector: hit?.sector,
    closes,
  };
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const q = url.searchParams.get("q");
      if (q != null) return json(q.trim() ? await search(q.trim()) : []);

      const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
      if (!SYMBOL_RE.test(symbol)) return json({ error: "Bad symbol", code: "bad_symbol" }, 400);
      const data = await series(symbol);
      if (!data) return json({ error: `No chart found for ${symbol}`, code: "unknown_symbol" }, 404);
      return json(data);
    } catch (e: any) {
      return json({ error: e?.message || "Market data unavailable", code: "upstream" }, 502);
    }
  },
};
