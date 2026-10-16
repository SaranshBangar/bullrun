// Analytic heightmap rider - the Tiny-Wings / Alto's model. The rider surfs the
// smooth Catmull-Rom surface directly instead of colliding a rigid body against
// faceted terrain (every segment seam would be a fresh micro-collision with
// residual bounce velocity). Crashes hand the body over to a small Verlet
// ragdoll that tumbles down the same surface.
//
// Pure & frame-rate independent: call step() with a fixed dt in SECONDS. No
// canvas, no engine deps, so the node self-check can exercise it directly.

export interface Surface {
  heightAt(x: number): number;
  slopeAt(x: number): number; // radians; +ve = surface descends to the right
}

export interface Rider {
  x: number;
  y: number; // board-contact point
  vx: number;
  vy: number; // px/s
  heading: number; // board angle (radians)
  grounded: boolean;
  spin?: number; // air angular velocity (rad/s)
}

export interface Input {
  hold: boolean; // W / ↑ - pump / tuck for speed
  brake: boolean; // S / ↓
  rot: number; // -1 / 0 / 1, A·D / ←·→ spin in the air
}

export type Crash = "head" | "body" | "landing";

export interface StepEvent {
  launched?: boolean; // left the ground this step
  landed?: boolean;
  landDiff?: number; // heading vs slope at touchdown (radians)
  slope?: number;
  landing?: "clean" | "sketchy";
  crash?: Crash; // run over: the engine switches to the ragdoll
}

// --- tuning knobs ---
export const P = {
  G: 2200, // gravity px/s^2
  RIDE_H: 16, // board contact sits this far above the surface line
  PUMP_BASE: 1300, // pump accel on the flat (climbs slopes up to ~36°)
  PUMP_DOWN: 2400, // extra pump accel scaled by how steep the downslope is
  BRAKE: 3200,
  DRAG_GROUND: 1.4, // /s exponential speed bleed when upright
  DRAG_TUCK: 0.8, // tucked = slippery
  DRAG_AIR: 0.12, // /s air drag
  ROLL_ASSIST: 140, // gentle forward nudge so a near-flat start still rolls
  ROLL_MIN: 120,
  SMAX: 1150, // top speed clamp
  CLIMB_MIN: 200, // holding throttle always crawls up even the steepest real rally
  SPIN_ACCEL: 30, // rad/s^2 while a spin key is held
  SPIN_MAX: 8.5, // rad/s
  SPIN_DAMP: 7, // /s spin decay with no input
  SPOT: 3.2, // /s: with no input the rider eases the board toward the landing slope
  HEAD_EASE: 12, // how fast the board aligns to the slope on the ground
  LAUNCH_EPS: 2.5, // px slack before we declare the rider airborne
  CLEAN: 0.35, // rad: landings within this are clean (speed bonus)
  CRASH: 1.1, // rad (~63°): land further off than this and you bail
};

// Body points in the rider's local frame (board contact at 0,0; body rises in
// -y). Matches the ride pose drawn by rider.ts.
export const BODY = { hip: -20, shoulder: -49, head: -63, headR: 9 };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// World position of a body point `oy` px up the rider's spine.
export function bodyPoint(r: Rider, oy: number): { x: number; y: number } {
  return { x: r.x - oy * Math.sin(r.heading), y: r.y + oy * Math.cos(r.heading) };
}

// Did the head or torso touch the snow?
export function bodyHit(r: Rider, s: Surface): Crash | null {
  const head = bodyPoint(r, BODY.head);
  if (head.y + BODY.headR > s.heightAt(head.x)) return "head";
  for (const oy of [BODY.shoulder, BODY.hip]) {
    const p = bodyPoint(r, oy);
    if (p.y > s.heightAt(p.x)) return "body";
  }
  return null;
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
  if (input.hold && speed < P.CLIMB_MIN) speed = P.CLIMB_MIN;
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
    r.spin = 0;
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
  const drag = Math.max(0, 1 - P.DRAG_AIR * dt);
  r.vx *= drag;
  r.x += r.vx * dt;
  r.y += r.vy * dt;

  // Spin has momentum: it builds while held and bleeds off when released.
  // Hands off, the rider spots the landing, easing the board toward the
  // slope they're about to land on, so a plain jump lands itself.
  let spin = r.spin ?? 0;
  if (input.rot) spin = clamp(spin + input.rot * P.SPIN_ACCEL * dt, -P.SPIN_MAX, P.SPIN_MAX);
  else {
    spin *= Math.max(0, 1 - P.SPIN_DAMP * dt);
    const target = s.slopeAt(r.x + r.vx * 0.2);
    r.heading += normAngle(target - r.heading) * Math.min(1, P.SPOT * dt);
  }
  r.spin = spin;
  r.heading += spin * dt;

  const hit = bodyHit(r, s);
  if (hit) return { crash: hit };

  // Touchdown whenever the board reaches the surface, including while still
  // rising into an up-slope, so the rider can't tunnel through a wall.
  const surf = s.heightAt(r.x) - P.RIDE_H;
  if (r.y >= surf) {
    r.y = surf;
    const theta = s.slopeAt(r.x);
    const diff = normAngle(r.heading - theta);
    if (Math.abs(diff) > P.CRASH) return { crash: "landing", landed: true, landDiff: diff, slope: theta };
    // project landing velocity onto the slope (kills the normal component =
    // no bounce); clean landings keep a little extra, sketchy ones scrub speed.
    let speed = r.vx * Math.cos(theta) + r.vy * Math.sin(theta);
    const clean = Math.abs(diff) <= P.CLEAN;
    speed *= clean ? 1.06 : 1 - (Math.abs(diff) - P.CLEAN) * 0.6;
    speed = clamp(speed, -P.SMAX, P.SMAX);
    r.vx = speed * Math.cos(theta);
    r.vy = speed * Math.sin(theta);
    r.heading = theta;
    r.spin = 0;
    r.grounded = true;
    return { landed: true, landDiff: diff, slope: theta, landing: clean ? "clean" : "sketchy" };
  }
  return {};
}

// ---------------------------------------------------------------- ragdoll
// A crashed rider becomes point masses joined by sticks (Verlet), so it
// tumbles, bounces and slides down the real terrain.

export interface Ragdoll {
  pts: { x: number; y: number; px: number; py: number }[];
  sticks: [number, number, number][]; // a, b, rest length
}

// Joint indices; rider.ts draws from the same layout.
export const J = { head: 0, neck: 1, hip: 2, kneeL: 3, kneeR: 4, footL: 5, footR: 6, handL: 7, handR: 8 } as const;

export function makeRagdoll(r: Rider, dt: number): Ragdoll {
  // local (x, y) per joint in the ride pose
  const local: [number, number][] = [
    [0, BODY.head], [0, BODY.shoulder], [0, BODY.hip],
    [-7, -8], [9, -8], [-16, 0], [16, 0],
    [-26, -40], [26, -40],
  ];
  const c = Math.cos(r.heading), sn = Math.sin(r.heading);
  const pts = local.map(([lx, ly]) => {
    const x = r.x + lx * c - ly * sn;
    const y = r.y + lx * sn + ly * c;
    // carry the rider's momentum, plus the spin as tangential velocity
    const w = r.spin ?? 0;
    const vx = r.vx - w * (y - r.y);
    const vy = r.vy + w * (x - r.x);
    return { x, y, px: x - vx * dt, py: y - vy * dt };
  });
  const d = (a: number, b: number) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
  const pairs: [number, number][] = [
    [J.head, J.neck], [J.neck, J.hip], [J.hip, J.kneeL], [J.hip, J.kneeR],
    [J.kneeL, J.footL], [J.kneeR, J.footR], [J.footL, J.footR], // board
    [J.neck, J.handL], [J.neck, J.handR], [J.head, J.hip], // keep the spine straight-ish
  ];
  return { pts, sticks: pairs.map(([a, b]) => [a, b, d(a, b)]) };
}

export function stepRagdoll(rd: Ragdoll, dt: number, s: Surface) {
  for (const p of rd.pts) {
    const vx = (p.x - p.px) * 0.995;
    const vy = (p.y - p.py) * 0.995;
    p.px = p.x;
    p.py = p.y;
    p.x += vx;
    p.y += vy + P.G * dt * dt;
  }
  for (let it = 0; it < 6; it++) {
    for (const [a, b, len] of rd.sticks) {
      const pa = rd.pts[a], pb = rd.pts[b];
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const dist = Math.hypot(dx, dy) || 1;
      const k = ((dist - len) / dist) * 0.5;
      pa.x += dx * k; pa.y += dy * k;
      pb.x -= dx * k; pb.y -= dy * k;
    }
    for (const p of rd.pts) {
      const ground = s.heightAt(p.x) - 3;
      if (p.y > ground) {
        // push out along the surface normal, then add friction + a small bounce
        const th = s.slopeAt(p.x);
        const vx = p.x - p.px, vy = p.y - p.py;
        const tx = Math.cos(th), ty = Math.sin(th);
        const vt = vx * tx + vy * ty;
        const vn = -vx * ty + vy * tx;
        p.y = ground;
        const nvt = vt * 0.92, nvn = vn > 0 ? -vn * 0.25 : vn;
        p.px = p.x - (nvt * tx - nvn * ty);
        p.py = p.y - (nvt * ty + nvn * tx);
      }
    }
  }
}
