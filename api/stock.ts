// Vercel Function (also mounted by vite.config.ts in dev).
//   GET /api/stock?symbol=AAPL  -> ~6 months of daily closes + company meta
//   GET /api/stock?q=apple      -> symbol search
//   GET /api/stock?news=AAPL&n=Apple%20Inc.&d=2026-05-01,2026-07-31&m=+-
//                               -> one real headline per date (or null);
//                                  `m` is each day's move direction
// Prices come from Yahoo Finance's public chart/search endpoints and headlines
// from Google News search (RSS), both keyless.
// Responses are cached at the CDN so popular tickers cost one upstream call.
// Self-contained on purpose (type-only imports) so Vercel bundles it as-is.
import type { Close, NewsItem, Sector } from "../src/shared/series";

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

// ---------- news ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const shiftDay = (iso: string, days: number) => new Date(Date.parse(iso + "T12:00:00Z") + days * 864e5).toISOString().slice(0, 10);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ""), /^#x/i.test(e) ? 16 : 10)) : ENTITIES[e.toLowerCase()] ?? m)
    .trim();

// "Apple Inc." -> "Apple", "The Coca-Cola Company" -> "Coca-Cola"
export function shortName(name: string): string {
  const s = name
    .replace(/^the\s+/i, "")
    .replace(/[,.]?\s+(inc|incorporated|corp|corporation|company|co|ltd|limited|plc|ag|sa|se|nv|holdings?|group|& co)\.?$/gi, "")
    .replace(/[,.]?\s+(inc|incorporated|corp|corporation|company|co|ltd|limited|plc|holdings?|group|& co)\.?$/gi, "")
    .replace(/[,.]\s*$/, "")
    .trim();
  return s || name;
}

// Items from a Google News RSS feed. Titles come as "Headline - Publisher".
export function parseRss(xml: string): NewsItem[] {
  const tag = (it: string, t: string) => decode(it.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] ?? "");
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, it]) => {
    const source = tag(it, "source");
    let title = tag(it, "title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    const t = Date.parse(tag(it, "pubDate"));
    const url = tag(it, "link");
    return title && url && Number.isFinite(t) ? [{ date: new Date(t).toISOString().slice(0, 10), title, source, url }] : [];
  });
}

const UP_RE = /\b(ris\w*|rose|jump\w*|gain\w*|climb\w*|surg\w*|soar\w*|rall\w*|rebound\w*|up|higher|beats?|tops?|parabolic|record)\b/i;
const DOWN_RE = /\b(fall\w*|fell|drop\w*|sink\w*|sank|slid\w*|slide|tumbl\w*|plung\w*|slump\w*|flop\w*|down|lower|miss\w*|crash\w*|sell-?off|pressure|weak\w*)\b/i;

// One headline per key day, never the same story twice. Prefer titles that
// name the company, agree with the day's move (`moves`: "+" or "-") and were
// published on the day itself, then the morning after.
export function pickHeadlines(dates: string[], feeds: NewsItem[][], name: string, symbol: string, moves = ""): (NewsItem | null)[] {
  const base = symbol.replace(/\..*$/, "");
  const word = shortName(name).split(/\s+/)[0];
  const names = new RegExp(`\\b(${[word.length >= 3 ? word : "", base.length >= 2 ? base : ""].filter(Boolean).map((w) => w.replace(/[^\w&-]/g, "")).join("|")})\\b`, "i");
  const seen = new Set<string>();
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
  return dates.map((d, k) => {
    const next = shiftDay(d, 1);
    const [agree, clash] = moves[k] === "+" ? [UP_RE, DOWN_RE] : moves[k] === "-" ? [DOWN_RE, UP_RE] : [null, null];
    const score = (n: NewsItem) =>
      (names.test(n.title) ? 2 : 0) +
      (n.date === d ? 1 : n.date === next ? 0.5 : 0) +
      (agree?.test(n.title) && !clash?.test(n.title) ? 1.5 : clash?.test(n.title) && !agree?.test(n.title) ? -2 : 0);
    const best = (feeds[k] ?? [])
      .filter((n) => !seen.has(key(n.title)))
      .map((n, order) => ({ n, s: score(n), order }))
      .sort((a, b) => b.s - a.s || a.order - b.order)[0]?.n;
    if (!best) return null;
    seen.add(key(best.title));
    return best;
  });
}

async function news(symbol: string, name: string, dates: string[], moves: string) {
  const india = /\.(NS|BO)$/.test(symbol);
  const region = india ? "hl=en-IN&gl=IN&ceid=IN:en" : "hl=en-US&gl=US&ceid=US:en";
  const short = shortName(name);
  let failed = 0;
  const feeds = await Promise.all(
    dates.map(async (d) => {
      const q = `"${short}" stock after:${shiftDay(d, -1)} before:${shiftDay(d, 2)}`;
      try {
        const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${region}`, {
          headers: { "user-agent": HEADERS["user-agent"] },
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) throw new Error(`news ${r.status}`);
        return parseRss(await r.text());
      } catch {
        failed++;
        return [];
      }
    })
  );
  if (failed === dates.length) throw new Error("News unavailable");
  return pickHeadlines(dates, feeds, name, symbol, moves);
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const q = url.searchParams.get("q");
      if (q != null) return json(q.trim() ? await search(q.trim()) : []);

      const ns = url.searchParams.get("news");
      if (ns != null) {
        const sym = ns.trim().toUpperCase();
        const name = (url.searchParams.get("n") || sym).trim().slice(0, 80);
        const dates = (url.searchParams.get("d") || "").split(",").filter((d) => DATE_RE.test(d)).slice(0, 10);
        if (!SYMBOL_RE.test(sym) || !dates.length) return json({ error: "Bad news request", code: "bad_request" }, 400);
        const moves = (url.searchParams.get("m") || "").replace(/[^+-]/g, "");
        return json(await news(sym, name, dates, moves), 200, "public, s-maxage=21600, stale-while-revalidate=604800");
      }

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
