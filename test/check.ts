// Minimal self-check for the non-trivial pure logic. Run: npm run check
// (Node strips the TS types; no test framework needed.)
import assert from "node:assert";
import { catmullRom } from "../src/shared/spline.ts";
import { syntheticCloses, sentiment, dailyTicker } from "../src/shared/series.ts";

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

console.log("✓ all checks passed");
