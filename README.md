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
npm run dev      # http://localhost:5173, SPA + API on one origin
npm run check    # logic self-check (spline, prices, physics, terrain)
npm run build    # type-check + production build into dist/
```

No API keys, accounts, or database needed.

## How it plays

- **`W` / `↑`** (or hold **▲**) - speed up: tuck and pump down slopes; holding it
  always climbs, even a huge one-day rally. Release on a peak to launch.
- **`S` / `↓`** (**▼**) - brake.
- **`A`·`D`** / **`←`·`→`** (**◄ ►**) - spin in the air. Spin has momentum; let go
  and the rider spots the landing, lining the board up with the slope below.
- `P` / `Esc` pauses. On touch screens every button can be held together.

**Wipeouts end the run:** if the head or body touches the snow, or you land more
than ~63° off the slope, the rider ragdolls down the hill and you get the date
and price where you fell. Land square for a clean-landing bonus and a speed kick.

Rally ramps sit on the chart's biggest up-days and pop you into the air; drops of
more than 6% in a day are cliffs. Tricks (Bull Flip, Short Squeeze, Diamond
Hands, Dead Cat Bounce, To The Moon) raise a combo multiplier.

**News coins:** eight gold coins sit on the chart's biggest one-day moves (green
arrow for an up day, red for a down day). Grabbing one shows the real headline
behind that move for that company, from that day, and the results screen lists
every key day's story with a link to the article (missed coins stay locked until
a later run). Headlines come from Google News search; if none is found the coin
explains the move instead ("Its worst day in 6 months").

## Architecture

```
index.html
api/stock.ts         Vercel Function: Yahoo Finance chart + symbol search, Google News
                     headlines for key days (no keys), CDN-cached
vite.config.ts       mounts api/stock.ts under `vite dev`
src/
  main.ts            start/search, game HUD + minimap, results recap, share links, how-to
  api.ts             /api/stock client; offline fallback to clearly-labelled simulated prices
  bests.ts           per-ticker personal bests + ghost path in localStorage
  sfx.ts             sound effects and music (Web Audio, CC0 samples in public/audio)
  shared/series.ts   ticker list, sector palettes, synthetic prices, key days, formatting
  shared/spline.ts   Catmull-Rom resampling
  game/
    physics.ts       pure rider integrator, body/head collision, crash ragdoll (unit-tested)
    terrain.ts       closes -> rideable surface, rally ramps, cliffs, news coins, month ticks, hi/lo
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

## Sound

Recorded sound effects and music live in `public/audio` and play through Web
Audio (`src/sfx.ts`): menu music on the home screen, a 3-2-1-GO countdown, ride
music, coins, tricks, snow landings, crash and finish / new-best jingles. Players
can set Music and Effects loudness (or mute) from the 🔊 button on the home
screen or the pause menu; the levels are saved in `localStorage`.

All audio is CC0: sound effects and jingles by [Kenney](https://www.kenney.nl),
music by wipics on OpenGameArt ([Calm Loop](https://opengameart.org/content/calm-loop),
[Menu Music](https://opengameart.org/content/menu-music-1)). See
`public/audio/CREDITS.txt` for the file-by-file list.

## Deploy

Vercel, zero config: `vercel.json` serves `dist/` with an SPA fallback, and
`api/stock.ts` deploys as a function automatically. Pushing to `main` deploys
production.
