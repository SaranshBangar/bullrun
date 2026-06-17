import { getSeries } from "./stock";
import { makeAuth, currentUser } from "./auth";
import {
  UNIVERSE,
  sectorFor,
  nameFor,
  sentiment,
  dailyTicker,
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
