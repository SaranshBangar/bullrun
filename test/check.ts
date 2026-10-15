// Minimal self-check for the non-trivial pure logic. Run: npm run check
// (Node strips the TS types; no test framework needed.)
import assert from "node:assert";
import { catmullRom } from "../src/shared/spline.ts";
import { syntheticCloses, sentiment, dailyTicker } from "../src/shared/series.ts";
import { step, P, type Rider } from "../src/game/physics.ts";
import { buildTerrain } from "../src/game/terrain.ts";

// catmull-rom passes through its control points
const ctrl = [
  { x: 0, y: 0 },
  { x: 10, y: 5 },
  { x: 20, y: -3 },
  { x: 30, y: 8 },
];
const dense = catmullRom(ctrl, 8);
assert(dense[0].x === 0 && dense[0].y === 0, "starts at first control point");
assert(dense[dense.length - 1].x === 30, "ends at last control point");
assert(dense.some((p) => Math.abs(p.x - 10) < 1e-6 && Math.abs(p.y - 5) < 1e-6), "hits control point 2");
assert(dense.length > ctrl.length, "densified");

// synthetic prices are deterministic per ticker, varied across tickers, positive
const a1 = syntheticCloses("VOLT", 130);
const a2 = syntheticCloses("VOLT", 130);
const b = syntheticCloses("AAPL", 130);
assert(a1.length === 130, "130 closes");
assert(JSON.stringify(a1) === JSON.stringify(a2), "deterministic per ticker");
assert(JSON.stringify(a1) !== JSON.stringify(b), "differs across tickers");
assert(a1.every((c) => c.close > 0), "all prices positive");
assert(a1.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.date)), "iso dates");

// sentiment sign matches net move
assert(sentiment([{ date: "x", close: 100 }, { date: "y", close: 120 }]).up === true, "up");
assert(sentiment([{ date: "x", close: 100 }, { date: "y", close: 80 }]).up === false, "down");

// daily ticker deterministic per day
assert(dailyTicker("2026-06-17") === dailyTicker("2026-06-17"), "daily stable");

// physics A: over rolling hills the rider stays glued to the surface (no
// jitter), stays finite, and carries forward under pump from a drop-in start.
const surf = {
  heightAt: (x: number) => 400 - 120 * Math.sin(x / 180),
  slopeAt: (x: number) => Math.atan2(surf.heightAt(x + 6) - surf.heightAt(x - 6), 12),
};
const r: Rider = { x: 0, y: surf.heightAt(0) - P.RIDE_H, vx: 600, vy: 0, heading: surf.slopeAt(0), grounded: true };
let maxGlueErr = 0;
for (let i = 0; i < 3000; i++) {
  step(r, 1 / 60, surf, { hold: true, brake: false, rot: 0 });
  assert(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.vx) && Number.isFinite(r.vy), "finite state");
  if (r.grounded) maxGlueErr = Math.max(maxGlueErr, Math.abs(r.y - (surf.heightAt(r.x) - P.RIDE_H)));
}
assert(r.x > 1000, "rider travels forward under pump");
assert(maxGlueErr < 1.0, "grounded rider stays glued to the surface (no jitter)");

// physics B: a cliff edge launches the rider, who then lands cleanly below.
const cliff = {
  heightAt: (x: number) => (x < 500 ? 16 : 16 + (x - 500) * 0.8),
  slopeAt: (x: number) => Math.atan2(cliff.heightAt(x + 6) - cliff.heightAt(x - 6), 12),
};
const rc: Rider = { x: 400, y: 0, vx: 900, vy: 0, heading: 0, grounded: true };
let launched = false, landed = false;
for (let i = 0; i < 600; i++) {
  const ev = step(rc, 1 / 60, cliff, { hold: false, brake: false, rot: 0 });
  if (ev.launched) launched = true;
  if (ev.landed) landed = true;
  assert(Number.isFinite(rc.y), "cliff finite");
}
assert(launched, "launches off a cliff edge");
assert(landed, "lands after the launch");

// physics C: brake scrubs speed
const r2: Rider = { x: 0, y: 0, vx: 800, vy: 0, heading: 0, grounded: true };
const flat = { heightAt: () => 16, slopeAt: () => 0 };
for (let i = 0; i < 30; i++) step(r2, 1 / 60, flat, { hold: false, brake: true, rot: 0 });
assert(r2.vx < 800, "brake reduces speed");

// physics D: holding throttle crawls up even a wall steeper than pump can
// climb (a huge one-day rally); stalling there would trap the player.
const steep = {
  heightAt: (x: number) => (x < 300 ? 600 : x < 550 ? 600 - (x - 300) * 1.7 : 175),
  slopeAt: (x: number) => Math.atan2(steep.heightAt(x + 6) - steep.heightAt(x - 6), 12),
};
const rw: Rider = { x: 200, y: 600 - P.RIDE_H, vx: 100, vy: 0, heading: 0, grounded: true };
for (let i = 0; i < 60 * 20 && rw.x < 700; i++) step(rw, 1 / 60, steep, { hold: true, brake: false, rot: 0 });
assert(rw.x >= 700, "held throttle climbs a steep wall");

// terrain E: a held-throttle rider finishes real-shaped charts, and the HUD's
// position -> close lookup lands on the right trading day.
for (const sym of ["NVDA", "KO", "TSLA"]) {
  const closes = syntheticCloses(sym, 126);
  const t = buildTerrain(closes);
  const rt: Rider = { x: t.startX, y: t.heightAt(t.startX) - P.RIDE_H, vx: 350, vy: 0, heading: 0, grounded: true };
  for (let i = 0; i < 60 * 120 && rt.x < t.finishX; i++) step(rt, 1 / 60, t, { hold: true, brake: false, rot: 0 });
  assert(rt.x >= t.finishX, "held throttle reaches the finish");
  assert(t.indexAt(t.dayX[5] + 1) === 5 && t.indexAt(t.dayX[6] - 1) === 6 && t.indexAt(t.finishX) === 125, "position maps to the right close");
}

console.log("✓ all checks passed");
