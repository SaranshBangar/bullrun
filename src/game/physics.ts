// Analytic heightmap rider — the Tiny-Wings / Alto's model. The rider surfs the
// smooth Catmull-Rom surface directly instead of colliding a rigid body against
// faceted terrain, which is what made the old Matter.js version jitter (every
// segment seam was a fresh micro-collision with residual bounce velocity).
//
// Pure & frame-rate independent: call step() with a fixed dt in SECONDS. No
// canvas, no engine deps — so the node self-check can exercise it directly.

export interface Surface {
  heightAt(x: number): number;
  slopeAt(x: number): number; // radians; +ve = surface descends to the right
}

export interface Rider {
  x: number;
  y: number; // board-contact point
  vx: number;
  vy: number; // px/s
  heading: number; // visual board angle (radians)
  grounded: boolean;
}

export interface Input {
  hold: boolean; // W / ↑ — pump / tuck for speed
  brake: boolean; // S / ↓
  rot: number; // -1 / 0 / 1 — A·D / ←·→ tilt in the air
}

export interface StepEvent {
  launched?: boolean; // left the ground this step
  landed?: boolean;
  landDiff?: number; // heading vs slope at touchdown (radians)
  slope?: number;
}

// --- tuning knobs (real game, real feel — adjust to taste) ---
export const P = {
  G: 2200, // gravity px/s^2
  RIDE_H: 16, // board contact sits this far above the surface line
  PUMP_BASE: 1300, // pump accel on the flat (climbs slopes up to ~36°)
  PUMP_DOWN: 2400, // extra pump accel scaled by how steep the downslope is
  BRAKE: 3200,
  DRAG_GROUND: 1.4, // /s exponential speed bleed when upright
  DRAG_TUCK: 0.3, // tucked = slippery
  ROLL_ASSIST: 140, // gentle forward nudge so a near-flat start still rolls
  ROLL_MIN: 120,
  SMAX: 1750, // top speed clamp
  AIR_ROT: 6.5, // air rotation rad/s
  HEAD_EASE: 12, // how fast the board aligns to the slope on the ground
  LAUNCH_EPS: 2.5, // px slack before we declare the rider airborne
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function step(r: Rider, dt: number, s: Surface, input: Input): StepEvent {
  return r.grounded ? groundStep(r, dt, s, input) : airStep(r, dt, s, input);
}

function groundStep(r: Rider, dt: number, s: Surface, input: Input): StepEvent {
  const theta = s.slopeAt(r.x);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // current speed along the slope tangent
  let speed = r.vx * cos + r.vy * sin;
  speed += P.G * sin * dt; // gravity component
  if (input.hold) speed += (P.PUMP_BASE + P.PUMP_DOWN * Math.max(0, sin)) * dt;
  if (input.brake) {
    const b = P.BRAKE * dt;
    speed = speed > 0 ? Math.max(0, speed - b) : Math.min(0, speed + b);
  }
  speed *= Math.max(0, 1 - (input.hold ? P.DRAG_TUCK : P.DRAG_GROUND) * dt);
  if (!input.brake && speed >= 0 && speed < P.ROLL_MIN) speed += P.ROLL_ASSIST * dt;
  speed = clamp(speed, -P.SMAX, P.SMAX);

  const vx = speed * cos;
  const vy = speed * sin;

  // Launch test: take a ballistic micro-step. If the terrain has fallen away
  // faster than gravity can pull the rider down, they leave the ground.
  const nx = r.x + vx * dt;
  const ballisticY = r.y + vy * dt + 0.5 * P.G * dt * dt;
  const surfN = s.heightAt(nx) - P.RIDE_H;

  if (ballisticY < surfN - P.LAUNCH_EPS) {
    r.x = nx;
    r.y = ballisticY;
    r.vx = vx;
    r.vy = vy + P.G * dt;
    r.grounded = false;
    return { launched: true };
  }

  // stay glued to the surface; derive vy from the height change for continuity
  r.x = nx;
  const ny = s.heightAt(nx) - P.RIDE_H;
  r.vy = (ny - r.y) / dt;
  r.y = ny;
  r.vx = vx;
  r.heading += normAngle(s.slopeAt(nx) - r.heading) * Math.min(1, P.HEAD_EASE * dt);
  return {};
}

function airStep(r: Rider, dt: number, s: Surface, input: Input): StepEvent {
  r.vy += P.G * dt;
  r.x += r.vx * dt;
  r.y += r.vy * dt;
  r.heading += input.rot * P.AIR_ROT * dt;

  const surf = s.heightAt(r.x) - P.RIDE_H;
  if (r.y >= surf && r.vy >= 0) {
    r.y = surf;
    const theta = s.slopeAt(r.x);
    const diff = normAngle(r.heading - theta);
    // project landing velocity onto the slope (kills the normal component =
    // no bounce). Engine applies any wipeout penalty on top.
    const speed = r.vx * Math.cos(theta) + r.vy * Math.sin(theta);
    r.vx = speed * Math.cos(theta);
    r.vy = speed * Math.sin(theta);
    r.grounded = true;
    return { landed: true, landDiff: diff, slope: theta };
  }
  return {};
}
