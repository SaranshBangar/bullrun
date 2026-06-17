// Minimal self-check for the non-trivial pure logic. Run: npm run check
// (Node strips the TS types; no test framework needed.)
import assert from "node:assert";
import { catmullRom } from "../src/shared/spline.ts";
import { syntheticCloses, sentiment, dailyTicker } from "../src/shared/series.ts";
import { step, P, type Rider } from "../src/game/physics.ts";

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

// physics: rider stays glued to the surface (no jitter), moves forward, and
// completes launch+land cycles over rolling hills without going non-finite.
const surf = {
  heightAt: (x: number) => 400 - 120 * Math.sin(x / 180),
  slopeAt: (x: number) =>
    Math.atan2(surf.heightAt(x + 6) - surf.heightAt(x - 6), 12),
};
const r: Rider = { x: 0, y: surf.heightAt(0) - P.RIDE_H, vx: 0, vy: 0, heading: surf.slopeAt(0), grounded: true };
let launched = false, landed = false, maxGlueErr = 0;
for (let i = 0; i < 3000; i++) {
  const ev = step(r, 1 / 60, surf, { hold: true, brake: false, rot: 0 });
  assert(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.vx) && Number.isFinite(r.vy), "finite state");
  if (ev.launched) launched = true;
  if (ev.landed) landed = true;
  if (r.grounded) maxGlueErr = Math.max(maxGlueErr, Math.abs(r.y - (surf.heightAt(r.x) - P.RIDE_H)));
}
assert(r.x > 500, "rider travels forward under pump");
assert(maxGlueErr < 1.0, "grounded rider stays glued to the surface (no jitter)");
assert(launched && landed, "launches off peaks and lands");

// brake scrubs speed
const r2: Rider = { x: 0, y: 0, vx: 800, vy: 0, heading: 0, grounded: true };
const flat = { heightAt: () => 16, slopeAt: () => 0 };
for (let i = 0; i < 30; i++) step(r2, 1 / 60, flat, { hold: false, brake: true, rot: 0 });
assert(r2.vx < 800, "brake reduces speed");

console.log("✓ all checks passed");
