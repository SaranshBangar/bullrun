import { getSeries } from "./stock";
import { makeAuth, currentUser } from "./auth";
import {
  UNIVERSE,
  sectorFor,
  nameFor,
  sentiment,
  dailyTicker,
  SECTOR_SKY,
  type Sector,
} from "../src/shared/series";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;
  BASE_URL: string;
  AUTH_SECRET?: string;
  BETTER_AUTH_API_KEY?: string;
  TWELVE_DATA_KEY?: string;
  ALPHA_VANTAGE_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path.startsWith("/api/auth")) return makeAuth(env).handler(req);
      if (path === "/api/stock/search") return search(url);
      if (path === "/api/stock/series") return series(env, url);
      if (path === "/api/daily") return daily();
      if (path === "/api/leaderboard") return leaderboard(env, url);
      if (path === "/api/score" && req.method === "POST") return submitScore(env, req);
      if (path === "/api/ghost") return ghost(env, url);
      if (path === "/api/share" && req.method === "POST") return saveShare(env, req);
      if (path.startsWith("/api/share/")) return getShare(env, path.split("/").pop()!);
      if (path.startsWith("/api/")) return json({ error: "not found" }, 404);

      // Social preview: a per-run Open Graph card, and SPA HTML with injected
      // og:/twitter: tags so shared /r/<id> links unfurl with that card.
      const ogm = path.match(/^\/og\/([A-Za-z0-9_-]+)\.svg$/);
      if (ogm) return ogCard(env, ogm[1]);
      const rm = path.match(/^\/r\/([A-Za-z0-9_-]+)$/);
      if (rm && req.method === "GET") return replayPage(env, req, rm[1]);
    } catch (e: any) {
      console.error(e);
      return json({ error: e?.message || "server error" }, 500);
    }

    // Everything else is the SPA (Vite-built assets + SPA fallback for /r/<id>).
    return env.ASSETS.fetch(req);
  },
};

function search(url: URL): Response {
  const q = (url.searchParams.get("q") || "").toUpperCase().trim();
  const matches = (q ? UNIVERSE.filter((u) => u.symbol.startsWith(q) || u.name.toUpperCase().includes(q)) : UNIVERSE).slice(0, 8);
  return json(matches);
}

async function series(env: Env, url: URL): Promise<Response> {
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!/^[A-Z.]{1,8}$/.test(symbol)) return json({ error: "bad symbol" }, 400);
  const closes = await getSeries(env, symbol);
  return json({
    symbol,
    name: nameFor(symbol),
    sector: sectorFor(symbol),
    sentiment: sentiment(closes),
    closes,
  });
}

function daily(): Response {
  const day = new Date().toISOString().slice(0, 10);
  const symbol = dailyTicker(day);
  // ms until next UTC midnight, for the "resets in" countdown
  const next = new Date(day + "T00:00:00Z").getTime() + 86400000 - Date.now();
  return json({ symbol, name: nameFor(symbol), sector: sectorFor(symbol), day, resetsInMs: next });
}

async function leaderboard(env: Env, url: URL): Promise<Response> {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase();
  const tab = url.searchParams.get("tab") === "style" ? "style" : "time";
  const view = url.searchParams.get("view") === "all" ? "all" : "daily";
  const day = new Date().toISOString().slice(0, 10);

  const order = tab === "time" ? "time_ms ASC" : "style DESC";
  const where =
    tab === "time"
      ? "ticker = ?1 AND time_ms IS NOT NULL" + (view === "daily" ? " AND day = ?2" : "")
      : "ticker = ?1" + (view === "daily" ? " AND day = ?2" : "");
  const binds = view === "daily" ? [ticker, day] : [ticker];

  const rows = await env.DB.prepare(
    `SELECT username, time_ms, style, coins, best_trick, day FROM scores WHERE ${where} ORDER BY ${order} LIMIT 25`
  )
    .bind(...binds)
    .all();
  return json(rows.results ?? []);
}

async function submitScore(env: Env, req: Request): Promise<Response> {
  const user = await currentUser(env, req);
  if (!user) return json({ error: "sign in to submit" }, 401);

  const body = (await req.json().catch(() => ({}))) as any;
  const ticker = String(body.ticker || "").toUpperCase();
  // Validate at the trust boundary — never trust client-reported scores blindly.
  const timeMs = body.timeMs == null ? null : Math.round(Number(body.timeMs));
  const style = Math.round(Number(body.style) || 0);
  const coins = Math.round(Number(body.coins) || 0);
  const bestTrick = String(body.bestTrick || "").slice(0, 40);
  const isDaily = body.isDaily ? 1 : 0;
  const path: unknown = body.path;

  if (!/^[A-Z.]{1,8}$/.test(ticker)) return json({ error: "bad ticker" }, 400);
  if (timeMs != null && (timeMs <= 0 || timeMs > 3600000)) return json({ error: "bad time" }, 400);
  if (style < 0 || style > 10_000_000 || coins < 0 || coins > 5000)
    return json({ error: "bad score" }, 400);

  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO scores (ticker,user_id,username,time_ms,style,coins,best_trick,day,is_daily,created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`
  )
    .bind(ticker, user.id, user.name, timeMs, style, coins, bestTrick, day, isDaily, Date.now())
    .run();

  // If this run is the new #1 (time or style) and a path was recorded, save it
  // as the ghost everyone replays on retry. Path size is bounded.
  if (Array.isArray(path) && path.length && path.length < 6000) {
    await maybeSaveGhost(env, ticker, "time", timeMs, path, user.name);
    await maybeSaveGhost(env, ticker, "style", style == null ? null : -style, path, user.name);
  }
  return json({ ok: true });
}

async function maybeSaveGhost(
  env: Env,
  ticker: string,
  tab: "time" | "style",
  metric: number | null,
  path: unknown,
  username: string
) {
  if (metric == null) return;
  const key = `ghost:${ticker}:${tab}`;
  const cur = (await env.KV.get(key, "json")) as { metric: number } | null;
  if (!cur || metric < cur.metric) {
    await env.KV.put(key, JSON.stringify({ metric, path, username }));
  }
}

async function ghost(env: Env, url: URL): Promise<Response> {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase();
  const tab = url.searchParams.get("tab") === "style" ? "style" : "time";
  const g = await env.KV.get(`ghost:${ticker}:${tab}`, "json");
  return json(g ?? null);
}

async function saveShare(env: Env, req: Request): Promise<Response> {
  const snapshot = await req.json().catch(() => null);
  if (!snapshot || typeof snapshot !== "object") return json({ error: "bad snapshot" }, 400);
  const id = Math.random().toString(36).slice(2, 9);
  await env.KV.put(`share:${id}`, JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ id, url: `/r/${id}` });
}

async function getShare(env: Env, id: string): Promise<Response> {
  const snap = await env.KV.get(`share:${id}`, "json");
  if (!snap) return json({ error: "not found" }, 404);
  return json(snap);
}

// ---- social preview (Open Graph) ----
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "DNF";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Serve the SPA shell with run-specific og:/twitter: tags injected so a shared
// /r/<id> link unfurls into a rich card on socials/chat. Falls back to the
// plain SPA when the run id isn't found.
async function replayPage(env: Env, req: Request, id: string): Promise<Response> {
  const indexRes = await env.ASSETS.fetch(new Request(new URL("/", req.url)));
  let html = await indexRes.text();
  const snap = (await env.KV.get(`share:${id}`, "json")) as any;
  if (snap) {
    const origin = (env.BASE_URL || new URL(req.url).origin).replace(/\/$/, "");
    const ticker = String(snap.ticker ?? snap.symbol ?? "").toUpperCase();
    const time = fmtTime(snap.result?.timeMs);
    const style = Number(snap.result?.style ?? 0).toLocaleString("en-US");
    const trick = snap.result?.bestTrick ? ` · ${snap.result.bestTrick}` : "";
    const title = `BullRun — ${ticker} · ${time}`;
    const desc = `Style ${style}${trick}. Ride ${snap.name ?? ticker}'s six-month chart on BullRun.`;
    const img = `${origin}/og/${id}.svg`;
    const tags =
      `<meta property="og:type" content="website">` +
      `<meta property="og:url" content="${esc(origin + "/r/" + id)}">` +
      `<meta property="og:title" content="${esc(title)}">` +
      `<meta property="og:description" content="${esc(desc)}">` +
      `<meta property="og:image" content="${esc(img)}">` +
      `<meta property="og:image:type" content="image/svg+xml">` +
      `<meta property="og:image:width" content="1200">` +
      `<meta property="og:image:height" content="630">` +
      `<meta name="twitter:card" content="summary_large_image">` +
      `<meta name="twitter:title" content="${esc(title)}">` +
      `<meta name="twitter:description" content="${esc(desc)}">` +
      `<meta name="twitter:image" content="${esc(img)}">`;
    html = html
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
      .replace("</head>", tags + "</head>");
  }
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// A self-contained SVG social card (1200×630): sector-tinted sky, the run's
// price line, ticker, time and style.
async function ogCard(env: Env, id: string): Promise<Response> {
  const snap = (await env.KV.get(`share:${id}`, "json")) as any;
  const W = 1200;
  const H = 630;
  const ticker = String(snap?.ticker ?? snap?.symbol ?? "BULLRUN").toUpperCase();
  const sector = (snap?.sector ?? sectorFor(ticker)) as Sector;
  const [c0, c1, c2] = SECTOR_SKY[sector] ?? SECTOR_SKY.Tech;
  const time = fmtTime(snap?.result?.timeMs);
  const style = Number(snap?.result?.style ?? 0).toLocaleString("en-US");
  const by = String(snap?.by ?? "guest");
  const line = snap?.sentiment?.up === false ? "#ef4b3c" : "#16c66a";

  const closes: { close: number }[] = Array.isArray(snap?.closes) ? snap.closes : [];
  let d = "";
  if (closes.length > 1) {
    const ys = closes.map((c) => c.close);
    const min = Math.min(...ys);
    const span = Math.max(...ys) - min || 1;
    const top = 360;
    const bot = H - 36;
    d = closes
      .map((c, i) => {
        const x = (i / (closes.length - 1)) * W;
        const y = bot - ((c.close - min) / span) * (bot - top);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${c0}"/><stop offset="0.56" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${d ? `<path d="${d} L ${W},${H} L 0,${H} Z" fill="${line}" fill-opacity="0.18"/><path d="${d}" fill="none" stroke="${line}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
  <text x="64" y="118" font-family="'Space Grotesk',sans-serif" font-size="40" font-weight="700" fill="#fff">BullRun</text>
  <text x="60" y="258" font-family="'Space Grotesk',sans-serif" font-size="150" font-weight="700" fill="#fff">${esc(ticker)}</text>
  <text x="64" y="320" font-family="monospace" font-size="32" fill="rgba(255,255,255,0.85)">${esc(sector)} · @${esc(by)}</text>
  <g font-family="monospace" fill="#fff">
    <text x="64" y="556" font-size="26" fill="rgba(255,255,255,0.7)">TIME</text>
    <text x="64" y="602" font-size="46" font-weight="700">${esc(time)}</text>
    <text x="440" y="556" font-size="26" fill="rgba(255,255,255,0.7)">STYLE</text>
    <text x="440" y="602" font-size="46" font-weight="700">${esc(style)}</text>
  </g>
</svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
