import { catmullRom, type Pt } from "../shared/spline.ts";
import { keyDays, type Close } from "../shared/series.ts";

export interface Feature {
  type: "rally" | "cliff";
  x: number;
  i: number; // index of the close this feature belongs to
}
// A news coin marks one of the chart's biggest moves (close index `i`).
export interface Coin {
  x: number;
  y: number;
  i: number;
  taken: boolean;
}
export interface Tick {
  x: number;
  label: string;
}

export interface Terrain {
  pts: Pt[];
  dayX: number[]; // world x of each close
  coins: Coin[];
  features: Feature[];
  ticks: Tick[]; // first trading day of each month
  hi: number; // index of the highest close
  lo: number; // index of the lowest close
  startX: number;
  finishX: number;
  heightAt(x: number): number;
  slopeAt(x: number): number;
  indexAt(x: number): number; // nearest close for a world x
}

const SEG = 140; // world px per trading day
const BASE_Y = 560; // world y of the lowest price
const SAMPLES = 6; // spline subdivisions per day
const TYPICAL_RISE = Math.tan((25 * Math.PI) / 180) * SEG;
const GAP = 0.06; // a one-day drop this big becomes a cliff
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Build the rideable world from daily closes. The surface is the real chart,
// smoothed with Catmull-Rom; only the vertical scale adapts per ticker so a
// calm stock still has hills and a wild one stays climbable.
export function buildTerrain(closes: Close[]): Terrain {
  const ys = closes.map((c) => c.close);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const ret = (i: number) => (ys[i] - ys[i - 1]) / ys[i - 1];

  // Vertical scale: a typical big day (90th-percentile move) climbs ~25°.
  // Rarer, bigger days become steep walls; holding throttle still crawls up
  // them (physics CLIMB_MIN) and the biggest get rally ramps.
  const moves = ys.slice(1).map((y, i) => Math.abs(y - ys[i]) / span).sort((a, b) => a - b);
  const p90 = moves[Math.floor(moves.length * 0.9)] || 0.05;
  const amp = Math.min(950, Math.max(450, TYPICAL_RISE / p90));

  const ctrl: Pt[] = [];
  const dayX: number[] = [];
  const features: Feature[] = [];
  let x = SEG;
  for (let i = 0; i < closes.length; i++) {
    if (i > 0 && ret(i) < -GAP) {
      x -= SEG * 0.55; // squeeze x -> a sheer drop
      features.push({ type: "cliff", x, i });
    }
    ctrl.push({ x, y: BASE_Y - ((ys[i] - min) / span) * amp });
    dayX.push(x);
    x += SEG;
  }

  // Rally ramps on the chart's three biggest up-days (≥3%, spaced out). The
  // pad sits mid-climb into that day's close.
  const rallies = closes
    .map((_, i) => i)
    .filter((i) => i > 2 && i < closes.length - 2 && ret(i) >= 0.03)
    .sort((a, b) => ret(b) - ret(a));
  for (const i of rallies) {
    if (features.filter((f) => f.type === "rally").length >= 3) break;
    if (features.some((f) => f.type === "rally" && Math.abs(f.i - i) < 10)) continue;
    features.push({ type: "rally", x: (dayX[i - 1] + dayX[i]) / 2, i });
  }

  const pts = catmullRom(ctrl, SAMPLES);
  const startX = dayX[0] + SEG * 0.5;
  const finishX = dayX[dayX.length - 1];

  const heightAt = (qx: number): number => {
    if (qx <= pts[0].x) return pts[0].y;
    if (qx >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].x < qx) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    return a.y + (b.y - a.y) * ((qx - a.x) / (b.x - a.x || 1));
  };

  const slopeAt = (qx: number): number => Math.atan2(heightAt(qx + 6) - heightAt(qx - 6), 12);

  const indexAt = (qx: number): number => {
    let lo = 0;
    let hi = dayX.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dayX[mid] < qx) lo = mid;
      else hi = mid;
    }
    return qx - dayX[lo] < dayX[hi] - qx ? lo : hi;
  };

  // News coins on the key days, hung where the move starts so the rider
  // meets them going into it (a cliff top, the foot of a rally).
  const coins: Coin[] = keyDays(closes).map((i) => {
    const cx = dayX[i] - 0.6 * SEG;
    return { x: cx, y: heightAt(cx) - 46, i, taken: false };
  });

  const ticks: Tick[] = [];
  closes.forEach((c, i) => {
    if (i > 0 && c.date.slice(5, 7) !== closes[i - 1].date.slice(5, 7)) {
      ticks.push({ x: dayX[i], label: MONTHS[Number(c.date.slice(5, 7)) - 1] });
    }
  });

  return {
    pts,
    dayX,
    coins,
    features,
    ticks,
    hi: ys.indexOf(max),
    lo: ys.indexOf(min),
    startX,
    finishX,
    heightAt,
    slopeAt,
    indexAt,
  };
}
