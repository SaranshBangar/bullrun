# BullRun

Pick any company. Its last six months of **real** daily closing prices become a
mountain, and a stick-man snowboards across it left → right through time. Every
hill is a rally, every valley a sell-off: the HUD shows the date and price under
the board, a minimap shows where you are on the full chart, and the run ends
with a recap of what the stock did (6-month high/low, best and worst day).

Plays on desktop (keyboard) and phones/tablets (on-screen pad, portrait or
landscape). Share a run as a link that challenges a friend to beat your time.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173 — SPA + API on one origin
npm run check    # logic self-check (spline, prices, physics, terrain)
npm run build    # type-check + production build into dist/
```

No API keys, accounts, or database needed.

## How it plays

- **`W` / `↑`** (or hold **▲**) — speed up: tuck and pump down slopes; holding it
  always climbs, even a huge one-day rally. Release on a peak to launch.
- **`S` / `↓`** (**▼**) — brake.
- **`A`·`D`** / **`←`·`→`** (**◄ ►**) — spin in the air. Spin has momentum; let go
  and the rider spots the landing, lining the board up with the slope below.
- `P` / `Esc` pauses. On touch screens every button can be held together.

**Wipeouts end the run:** if the head or body touches the snow, or you land more
than ~63° off the slope, the rider ragdolls down the hill and you get the date
and price where you fell. Land square for a clean-landing bonus and a speed kick.

Rally ramps sit on the chart's biggest up-days and pop you into the air; drops of
more than 6% in a day are cliffs. Tricks (Bull Flip, Short Squeeze, Diamond
Hands, Dead Cat Bounce, To The Moon) raise a combo multiplier. Sound (wind,
coins, tricks, landings, crash) is synthesized with Web Audio; 🔊 toggles it.

## Architecture

```
index.html
api/stock.ts         Vercel Function: Yahoo Finance chart + symbol search (no key), CDN-cached
vite.config.ts       mounts api/stock.ts under `vite dev`
src/
  main.ts            start/search, game HUD + minimap, results recap, share links, how-to
  api.ts             /api/stock client; offline fallback to clearly-labelled simulated prices
  bests.ts           per-ticker personal bests + ghost path in localStorage
  sfx.ts             synthesized sound effects (Web Audio)
  shared/series.ts   ticker list, sector palettes, synthetic prices, formatting
  shared/spline.ts   Catmull-Rom resampling
  game/
    physics.ts       pure rider integrator, body/head collision, crash ragdoll (unit-tested)
    terrain.ts       closes -> rideable surface, rally ramps, cliffs, month ticks, hi/lo
    engine.ts        game loop, input, scoring, ghost record, camera
    draw.ts          canvas render
    rider.ts         jointed stick-man
    tricks.ts        trick table
    gif.ts           shareable PNG card + GIF export
test/check.ts        node self-check
```

### Where state lives

There is no database: nothing needs one.

| What | Where |
| --- | --- |
| Stock prices | fetched live by `api/stock.ts`, cached at the CDN (30 min, stale-while-revalidate) |
| Personal bests + ghost | browser `localStorage` (`bullrun:best:<TICKER>`) |
| Shared runs | encoded in the link itself: `/?run=<base64 JSON>` |

If the API is unreachable (e.g. Yahoo rate-limits), the game still plays on
deterministic simulated prices and says so on screen.

## Deploy

Vercel, zero config: `vercel.json` serves `dist/` with an SPA fallback, and
`api/stock.ts` deploys as a function automatically. Pushing to `main` deploys
production.
