// Minimal self-check for the non-trivial pure logic. Run: npm run check
// (Node strips the TS types; no test framework needed.)
import assert from "node:assert";
import { catmullRom } from "../src/shared/spline.ts";
import { syntheticCloses, sentiment, dailyTicker, keyDays } from "../src/shared/series.ts";
import { step, P, bodyHit, bodyPoint, BODY, makeRagdoll, stepRagdoll, type Rider } from "../src/game/physics.ts";
import { parseRss, pickHeadlines, shortName } from "../api/stock.ts";
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
  const grabbed = new Set<number>();
  for (let i = 0; i < 60 * 120 && rt.x < t.finishX; i++) {
    const ev = step(rt, 1 / 60, t, { hold: true, brake: false, rot: 0 });
    assert(!ev.crash, `hands-off rider never wipes out (${sym})`);
    const hip = bodyPoint(rt, BODY.hip);
    t.coins.forEach((c) => Math.hypot(c.x - hip.x, c.y - hip.y) < 36 && grabbed.add(c.i));
  }
  assert(rt.x >= t.finishX, "held throttle reaches the finish");
  assert(t.coins.length === 8 && grabbed.size >= 7, `news coins sit on the riding line (${sym}: ${grabbed.size}/${t.coins.length})`);
  assert(t.indexAt(t.dayX[5] + 1) === 5 && t.indexAt(t.dayX[6] - 1) === 6 && t.indexAt(t.finishX) === 125, "position maps to the right close");
}

// news coins: the biggest moves, spaced out, in date order.
{
  const cl = [100, 101, 102, 103, 104, 112, 113, 114, 115, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116].map((close, i) => ({ date: `d${i}`, close }));
  const days = keyDays(cl, 8, 3);
  assert(days.includes(5) && days.includes(9), "picks the +7.7% and -10.4% days");
  assert(days.every((d, k) => k === 0 || d - days[k - 1] >= 3), "key days are spaced out and sorted");
}
assert(shortName("The Coca-Cola Company") === "Coca-Cola" && shortName("Apple Inc.") === "Apple" && shortName("Reliance Industries Limited") === "Reliance Industries", "short company names");
{
  const item = (t: string, src: string, day: string) => `<item><title>${t} - ${src}</title><link>https://n.example/${encodeURIComponent(t)}</link><pubDate>${day} 07:00:00 GMT</pubDate><source url="x">${src}</source></item>`;
  const feed = parseRss(`<rss><channel>${item("Apple &amp; Google&#39;s deal lifts shares", "Reuters", "Fri, 01 May 2026")}${item("Why Apple stock fell today", "CNBC", "Sat, 02 May 2026")}</channel></rss>`);
  assert(feed.length === 2 && feed[0].title === "Apple & Google's deal lifts shares" && feed[0].source === "Reuters" && feed[0].date === "2026-05-01", "parses Google News RSS");
  // Same two stories on both days: the down day gets the "fell" story, the up day the other; never the same twice.
  const picks = pickHeadlines(["2026-05-01", "2026-05-01"], [feed, feed], "Apple Inc.", "AAPL", "-+");
  assert(picks[0]?.title === "Why Apple stock fell today" && picks[1]?.title === "Apple & Google's deal lifts shares", "headlines match the move and stay unique");
  assert(pickHeadlines(["2026-05-01"], [[]], "Apple Inc.", "AAPL")[0] === null, "no headline -> null");
}

// crash E: the run ends when the head/body hits the snow or the landing is
// way off, and a clean landing is recognised as such.
const flat2 = { heightAt: () => 500, slopeAt: () => 0 };
const fall = (heading: number, rot = 0, y = 380) => {
  const r: Rider = { x: 0, y, vx: 300, vy: 0, heading, grounded: false };
  for (let i = 0; i < 240; i++) {
    const ev = step(r, 1 / 60, flat2, { hold: false, brake: false, rot });
    if (ev.crash || ev.landed) return ev;
  }
  return {};
};
assert(fall(Math.PI, 0, 440).crash === "head", "upside down near the snow: head hits first");
assert(fall(Math.PI).crash, "falling upside down wipes out");
assert(fall(Math.PI / 2, 1).crash, "spinning into the ground wipes out");
assert(fall(0.15).landing === "clean", "near-level landing is clean");
assert(!bodyHit({ x: 0, y: 500 - P.RIDE_H, vx: 0, vy: 0, heading: 0, grounded: true }, flat2), "standing rider isn't 'hitting' the snow");

// physics F: rising into an up-slope lands on it instead of tunnelling through.
const wallUp = { heightAt: (x: number) => (x < 100 ? 600 : 600 - (x - 100) * 1.2), slopeAt: (x: number) => (x < 100 ? 0 : Math.atan(-1.2)) };
const rf: Rider = { x: 50, y: 560, vx: 700, vy: -600, heading: Math.atan(-1.2), grounded: false };
let under = false;
for (let i = 0; i < 120 && !rf.grounded; i++) {
  step(rf, 1 / 60, wallUp, { hold: false, brake: false, rot: 0 });
  if (rf.y > wallUp.heightAt(rf.x) - P.RIDE_H + 1) under = true;
}
assert(rf.grounded && !under, "lands on a wall while rising (no tunnelling)");

// ragdoll G: a crashed body settles on the snow and stays finite.
const rd = makeRagdoll({ x: 0, y: 300, vx: 600, vy: 200, heading: 2, grounded: false, spin: 4 }, 1 / 60);
for (let i = 0; i < 240; i++) stepRagdoll(rd, 1 / 60, flat2);
assert(rd.pts.every((p) => Number.isFinite(p.x) && p.y <= 500), "ragdoll stays above the snow");

console.log("✓ all checks passed");
