# BullRun

Search a stock ticker. Six months of daily closes become a mountain a jointed
stick-man rides on a snowboard, left → right through time. Pump the dips, launch
the peaks, land the trick. Best **time** and **style** per ticker go on global
leaderboards.

TypeScript + Vite + HTML5 Canvas on the frontend with a custom analytic
heightmap rider (the Tiny-Wings / Alto's model); a single Cloudflare Worker
(D1 + KV, Better Auth) on the back. **It runs with zero config** — no API key
required — on deterministic synthetic prices.

## Quick start

```bash
npm install
cp .dev.vars.example .dev.vars      # optional — game runs without keys
npm run dev                         # http://localhost:5173
```

`npm run dev` serves the SPA and the Worker together via `@cloudflare/vite-plugin`,
so the API and frontend share one origin (no proxy).

For leaderboards/auth locally you also need a local D1 database:

```bash
npm run db:local                    # applies migrations to local D1
```

(Without D1, the game is fully playable as a guest; only score submission and
sign-in are unavailable.)

Run the logic self-check any time:

```bash
npm run check
```

## How it plays

- **`W` / `↑`** (or tap-and-hold) — speed up: tuck and dive, carrying speed down
  slopes and pumping out of dips, Tiny-Wings / Alto style. Release on a peak to launch.
- **`S` / `↓`** — brake: dig in and scrub speed.
- **`A`·`D`** or **`←`·`→`** — tilt left / right (rotate in the air). Land square or you wipe out.
- `P` / `Esc` pauses.

Tricks (Bull Flip, Short Squeeze, Diamond Hands, Dead Cat Bounce, To The Moon)
raise a combo multiplier that resets when you settle or wipe out. Earnings dates
are glowing boost ramps; overnight price gaps are cliffs; "dividend" coins line
the chart for bonus points.

## Architecture

```
index.html
src/
  main.ts            SPA: start/search, in-game HUD, results+share, leaderboard, /r/<id> replay
  api.ts             fetch wrappers + Better Auth browser client
  style.css          design tokens straight from the art direction doc
  shared/            pure math imported by browser, Worker, and the self-check
    series.ts          synthetic prices, sector palettes, ticker universe, sentiment
    spline.ts          Catmull-Rom resampling
  game/
    physics.ts       pure heightmap rider integrator (no canvas/engine deps — unit-tested)
    engine.ts        game loop, controls, scoring, ghost record/replay, GIF capture hooks
    terrain.ts       closes -> spline -> normalized heightmap + features (height/slope queries)
    rider.ts         jointed stick-man skeleton + poses
    tricks.ts        finance-themed trick table + naming
    draw.ts          canvas render: sky, parallax, terrain, coins, flag, rider, ghost
    gif.ts           replays the run path into a downloadable GIF (gifenc, lazy-loaded)
worker/
  index.ts           API router; serves the SPA via the ASSETS binding
  stock.ts           Twelve Data -> Alpha Vantage -> synthetic, cached in KV by symbol+day
  auth.ts            Better Auth over D1 (Kysely D1 dialect) + Infra dash/sentinel plugins
migrations/0001_init.sql   Better Auth tables + scores
```

### Physics

The rider **surfs the smooth Catmull-Rom surface analytically** (`physics.ts`)
rather than colliding a rigid body against terrain. Rolling a circle over a
faceted segment chain produces jitter — every seam is a fresh micro-collision
with residual bounce velocity (the classic internal-edge problem), which is the
genre's known failure mode. Instead the rider is glued to the heightmap when
grounded (velocity projected onto the slope tangent → zero bounce), goes
ballistic only when the terrain falls away faster than gravity (launch off
peaks/cliffs), and lands by projecting back onto the slope; a too-off landing
angle is a wipeout. `physics.step()` is pure and frame-rate independent, so the
node self-check (`npm run check`) exercises it directly — asserting the rider
stays glued (no jitter), carries forward under pump, and launches + lands.
Tuning knobs live in `physics.ts` (`P`).

## Stock data

Server-side only — keys never reach the browser. One interface, three sources
tried in order, cached in KV under `stock:<SYMBOL>:<YYYY-MM-DD>` (so a course
"updates each day" and is reused within a day):

1. **Twelve Data** `time_series` (`interval=1day`, `outputsize=130`) — needs `TWELVE_DATA_KEY`.
2. **Alpha Vantage** `TIME_SERIES_DAILY` fallback — needs `ALPHA_VANTAGE_KEY`.
3. **Deterministic synthetic** prices seeded from the ticker — always works.

Sector (→ background palette) and sentiment (→ chart-line green/red) are derived
server-side. The hand-curated ticker universe in `src/shared/series.ts` powers
autocomplete and sector themes offline.

## Cloudflare setup (deploy)

```bash
# 1. D1 — create, paste the id into wrangler.jsonc, migrate
npx wrangler d1 create bullrun
#   -> copy "database_id" into wrangler.jsonc
npm run db:remote

# 2. KV — ghost recordings, share snapshots, cached stock data
npx wrangler kv namespace create KV
#   -> copy "id" into wrangler.jsonc

# 3. Secrets (all optional; game runs on synthetic data without them)
npx wrangler secret put TWELVE_DATA_KEY
npx wrangler secret put ALPHA_VANTAGE_KEY
npx wrangler secret put AUTH_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID       # optional Google sign-in
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put BETTER_AUTH_API_KEY     # optional — powers dash + sentinel

# 4. set BASE_URL in wrangler.jsonc [vars] to your deployed origin, then:
npm run deploy
```

### KV namespaces / keys

| Binding | Key pattern | Holds |
| --- | --- | --- |
| `KV` | `stock:<SYMBOL>:<YYYY-MM-DD>` | cached daily series (1-day TTL) |
| `KV` | `ghost:<TICKER>:<time\|style>` | #1 run path, replayed as a translucent ghost |
| `KV` | `share:<id>` | shareable run snapshot for `/r/<id>` (30-day TTL) |

### D1 schema

`migrations/0001_init.sql` creates Better Auth's tables (`user`, `session`,
`account`, `verification`) plus `scores` (per-ticker leaderboard rows with
`time_ms`, `style`, `coins`, `best_trick`, `day`, `is_daily`). If you change auth
plugins, regenerate the auth tables with `npx @better-auth/cli generate`.

## Daily Challenge

`/api/daily` derives a deterministic ticker-of-the-day from the UTC date, so
everyone rides the same mountain. Its leaderboard (the Daily view) is filtered to
today's date and naturally resets each day; All-Time spans every run.

## Notes / deliberate shortcuts

- Ghost = recorded **path** (positions), not raw inputs — robust against
  physics non-determinism across machines. See `// ponytail:` markers in code.
- Custom heightmap physics replaced Matter.js: rigid-body collision against a
  faceted spline jitters (internal-edge bounce), so it was the wrong tool for a
  Tiny-Wings-style surfer. Matter was dropped; the client bundle is ~75 KB smaller.
- Better Auth Infra (`dash` + `sentinel`) is wired in `worker/auth.ts`. Both are
  cloud-backed (set `BETTER_AUTH_API_KEY`); without the key they degrade
  gracefully and never block sign-in, and they add no D1 tables.
- Autocomplete uses a curated universe; swap in a real symbol-search proxy in
  `worker/index.ts > search()` when you want the full market.
