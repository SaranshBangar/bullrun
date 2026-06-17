import { catmullRom, Pt } from "../shared/spline";
import type { Close } from "../shared/series";

export interface Feature {
  type: "earnings" | "cliff";
  x: number;
}
export interface Coin {
  x: number;
  y: number;
  taken: boolean;
}

export interface Terrain {
  pts: Pt[];
  width: number;
  bottomY: number;
  coins: Coin[];
  features: Feature[];
  startX: number;
  finishX: number;
  roughness: number;
  minY: number;
  heightAt(x: number): number;
  slopeAt(x: number): number;
}

const SEG = 90; // world px per trading day
const AMP = 360; // price-range -> vertical span
const BASE_Y = 560; // world y of the lowest price
const SAMPLES = 6; // spline subdivisions per day

// Build the rideable world from daily closes: normalize, smooth with
// Catmull-Rom, roughen by volatility, then chain Matter segment bodies.
export function buildTerrain(closes: Close[]): Terrain {
  const ys = closes.map((c) => c.close);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;

  // volatility -> roughness: stdev of daily returns.
  let mean = 0;
  const rets: number[] = [];
  for (let i = 1; i < ys.length; i++) rets.push((ys[i] - ys[i - 1]) / ys[i - 1]);
  mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length || 1);
  const roughness = Math.min(1, Math.sqrt(variance) * 26);

  // control points, with cliffs (big overnight gaps) steepened by pulling x in.
  const ctrl: Pt[] = [];
  const features: Feature[] = [];
  let x = SEG;
  for (let i = 0; i < closes.length; i++) {
    const y = BASE_Y - ((ys[i] - min) / span) * AMP;
    const gap = i > 0 ? Math.abs(rets[i - 1]) : 0;
    if (gap > 0.06) {
      x -= SEG * 0.55; // squeeze x -> a sheer drop/rise
      features.push({ type: "cliff", x });
    }
    // earnings ~ every quarter (≈63 trading days) -> glowing boost ramp
    if (i > 0 && i % 63 === 0) features.push({ type: "earnings", x });
    ctrl.push({ x, y });
    x += SEG;
  }

  // smooth, then add volatility-scaled high-freq jitter for rougher hills.
  let pts = catmullRom(ctrl, SAMPLES);
  if (roughness > 0.05) {
    pts = pts.map((p, i) => ({
      x: p.x,
      y: p.y + Math.sin(i * 0.7) * roughness * 14 * (i % 3 === 0 ? 1 : 0.4),
    }));
  }

  const width = ctrl[ctrl.length - 1].x;
  const minY = Math.min(...pts.map((p) => p.y));
  const bottomY = BASE_Y + 240;

  const startX = ctrl[0].x + SEG * 0.5;
  const finishX = ctrl[ctrl.length - 1].x;

  const heightAt = (qx: number): number => {
    if (qx <= pts[0].x) return pts[0].y;
    if (qx >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
    // linear scan is fine at 60fps for ~800 pts near the rider; could bisect.
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x < qx) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    const t = (qx - a.x) / (b.x - a.x || 1);
    return a.y + (b.y - a.y) * t;
  };

  const slopeAt = (qx: number): number => {
    const a = heightAt(qx - 6);
    const b = heightAt(qx + 6);
    return Math.atan2(b - a, 12);
  };

  // scatter dividend coins along the line, lifted above the surface.
  const coins: Coin[] = [];
  for (let cx = startX + SEG; cx < finishX; cx += SEG * 1.7) {
    coins.push({ x: cx, y: heightAt(cx) - 46, taken: false });
  }

  return {
    pts,
    width,
    bottomY,
    coins,
    features,
    startX,
    finishX,
    roughness,
    minY,
    heightAt,
    slopeAt,
  };
}
