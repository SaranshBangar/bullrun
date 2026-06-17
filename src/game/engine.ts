import { buildTerrain, Terrain } from "./terrain";
import { POSES, Pose, lerpPose } from "./rider";
import { nameTrick, Jump, TrickDef } from "./tricks";
import { drawWorld } from "./draw";
import { step, P, normAngle, type Rider, type Input } from "./physics";
import type { Close, Sector } from "../shared/series";
import { SECTOR_SKY } from "../shared/series";

export interface SeriesData {
  symbol: string;
  name: string;
  sector: Sector;
  sentiment: { netPct: number; up: boolean };
  closes: Close[];
}

export interface GhostFrame {
  x: number;
  y: number;
  h: number;
}

export interface RunResult {
  ticker: string;
  timeMs: number | null;
  style: number;
  coins: number;
  bestTrick: string | null;
  path: GhostFrame[];
}

export interface HudState {
  symbol: string;
  price: number;
  netPct: number;
  up: boolean;
  timeMs: number;
  speed: number; // 0..1
  airtime: number; // 0..1
  style: number;
  mult: number;
  progress: number; // 0..1
  paused: boolean;
}

export interface TrickToast {
  name: string;
  points: number;
  mult: number;
}

export interface GameOpts {
  onHud: (h: HudState) => void;
  onTrick: (t: TrickToast) => void;
  onFinish: (r: RunResult) => void;
  ghost?: GhostFrame[] | null;
  replay?: GhostFrame[] | null;
}

const STEP = 1000 / 60; // ms per fixed sim step
const WIPEOUT_RAD = 0.95;

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  terrain!: Terrain;
  data!: SeriesData;
  opts!: GameOpts;
  sky!: [string, string, string];

  // rider: a plain analytic state. `rider.position/velocity` shadow the state so
  // the renderer + camera read it the same way they always did.
  state: Rider = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, grounded: true };
  rider = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 } };
  get heading() { return this.state.heading; }
  set heading(v: number) { this.state.heading = v; }

  cam = { x: 0, y: 0, zoom: 1 };
  input: Input = { hold: false, brake: false, rot: 0 };
  pose: Pose = { ...POSES.ride };

  running = false;
  finished = false;
  moving = false;
  runMs = 0;
  style = 0;
  coins = 0;
  mult = 1;
  bestTrick: TrickDef | null = null;
  bestTrickScore = 0;
  path: GhostFrame[] = [];
  wipeUntil = 0;
  settledMs = 0;

  // jump tracking
  inAir = false;
  airStart = 0;
  rotAccum = 0;
  lastHeading = 0;
  maxHeight = 0;
  grabMs = 0;
  launchCtx: Jump["launch"] = "normal";

  ghost: GhostFrame[] | null = null;
  replay: GhostFrame[] | null = null;
  raf = 0;
  acc = 0;
  last = 0;
  detach: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  start(data: SeriesData, opts: GameOpts) {
    this.data = data;
    this.opts = opts;
    this.ghost = opts.ghost ?? null;
    this.replay = opts.replay ?? null;
    this.sky = SECTOR_SKY[data.sector];
    this.terrain = buildTerrain(data.closes);

    const t = this.terrain;
    this.state = {
      x: t.startX,
      y: t.heightAt(t.startX) - P.RIDE_H,
      vx: 350, // drop-in: start with momentum so the run rolls even if it opens uphill
      vy: 0,
      heading: t.slopeAt(t.startX),
      grounded: true,
    };
    this.lastHeading = this.state.heading;
    this.syncRider();
    this.cam.x = t.startX;
    this.resize();
    window.addEventListener("resize", this.resize);
    if (!this.replay) this.attachInput();
    this.running = true;
    this.last = performance.now();
    this.loop(this.last);
  }

  private syncRider() {
    this.rider.position.x = this.state.x;
    this.rider.position.y = this.state.y;
    this.rider.velocity.x = this.state.vx;
    this.rider.velocity.y = this.state.vy;
  }

  private attachInput() {
    const isSpeed = (c: string) => c === "KeyW" || c === "ArrowUp" || c === "Space";
    const isBrake = (c: string) => c === "KeyS" || c === "ArrowDown";
    const down = (e: KeyboardEvent) => {
      if (isSpeed(e.code)) { this.input.hold = true; e.preventDefault(); }
      if (isBrake(e.code)) { this.input.brake = true; e.preventDefault(); }
      if (e.code === "ArrowLeft" || e.code === "KeyA") this.input.rot = -1;
      if (e.code === "ArrowRight" || e.code === "KeyD") this.input.rot = 1;
      if (e.code === "KeyP" || e.code === "Escape") this.togglePause();
    };
    const up = (e: KeyboardEvent) => {
      if (isSpeed(e.code)) this.input.hold = false;
      if (isBrake(e.code)) this.input.brake = false;
      if ((e.code === "ArrowLeft" || e.code === "KeyA") && this.input.rot === -1) this.input.rot = 0;
      if ((e.code === "ArrowRight" || e.code === "KeyD") && this.input.rot === 1) this.input.rot = 0;
    };
    const pd = () => (this.input.hold = true);
    const pu = () => (this.input.hold = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.canvas.addEventListener("pointerdown", pd);
    window.addEventListener("pointerup", pu);
    this.detach = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      this.canvas.removeEventListener("pointerdown", pd);
      window.removeEventListener("pointerup", pu);
    };
  }

  resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.clientWidth * dpr;
    this.canvas.height = this.canvas.clientHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  togglePause() {
    if (this.finished) return;
    this.running = !this.running;
    if (this.running) {
      this.last = performance.now();
      this.loop(this.last);
    } else this.pushHud(true);
  }

  // On-screen touch controls (mobile / tablet) feed the exact same `input` the
  // keyboard handlers do, so the physics path is identical.
  setHold(v: boolean) { this.input.hold = v; }
  setBrake(v: boolean) { this.input.brake = v; }
  pressRot(dir: -1 | 1) { this.input.rot = dir; }
  releaseRot(dir: -1 | 1) { if (this.input.rot === dir) this.input.rot = 0; }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = now - this.last;
    this.last = now;
    if (dt > 100) dt = 100;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.tick(STEP);
      this.acc -= STEP;
    }
    this.render();
  };

  private tick(dt: number) {
    if (this.finished) return;
    if (this.replay) {
      this.driveReplay(dt);
      this.updateCamera(dt);
      this.pushHud(false);
      return;
    }

    if (!this.moving && (this.input.hold || this.state.x > this.terrain.startX + 4)) this.moving = true;
    if (this.moving) this.runMs += dt;

    const wiped = performance.now() < this.wipeUntil;
    const input: Input = wiped ? { hold: false, brake: true, rot: 0 } : this.input;
    const wasAir = !this.state.grounded;

    const ev = step(this.state, dt / 1000, this.terrain, input);
    this.syncRider();

    // Hard barriers at both ends so the rider can never ride off the map. The
    // right wall sits on the finish line, so hitting it ends the run normally.
    const minX = this.terrain.pts[0].x;
    const maxX = this.terrain.finishX;
    if (this.state.x < minX) {
      this.state.x = minX;
      if (this.state.vx < 0) this.state.vx = 0;
      this.syncRider();
    } else if (this.state.x > maxX) {
      this.state.x = maxX;
      if (this.state.vx > 0) this.state.vx = 0;
      this.syncRider();
    }

    if (ev.launched) this.onTakeoff();
    if (!this.state.grounded) this.trackAir(dt);
    if (ev.landed) this.onLand(ev.landDiff ?? 0, ev.slope ?? 0);
    if (this.state.grounded && !wasAir) {
      this.settledMs += dt;
      if (this.settledMs > 700) this.mult = 1;
    }

    this.updatePose(dt, wiped);
    this.checkCoins();
    this.checkFinish();

    this.updateCamera(dt);
    this.recordGhost();
    this.pushHud(false);
  }

  private onTakeoff() {
    this.inAir = true;
    this.airStart = performance.now();
    this.rotAccum = 0;
    this.maxHeight = 0;
    this.grabMs = 0;
    this.lastHeading = this.state.heading;
    this.settledMs = 0;
    const x = this.state.x;
    const slope = this.terrain.slopeAt(x);
    const onRamp = this.terrain.features.some((f) => f.type === "earnings" && Math.abs(f.x - x) < 80);
    this.launchCtx = onRamp ? "earnings" : slope < -0.15 ? "dip" : "normal";
    if (onRamp) { this.state.vy -= 620; this.state.vx += 180; } // boost ramp pop
  }

  private trackAir(dt: number) {
    this.rotAccum += normAngle(this.state.heading - this.lastHeading);
    this.lastHeading = this.state.heading;
    const groundY = this.terrain.heightAt(this.state.x);
    this.maxHeight = Math.max(this.maxHeight, groundY - this.state.y);
    if (this.input.hold) this.grabMs += dt;
    this.settledMs = 0;
  }

  private onLand(diff: number, slope: number) {
    this.inAir = false;
    const airtimeMs = performance.now() - this.airStart;

    if (Math.abs(diff) > WIPEOUT_RAD && airtimeMs > 250) {
      this.wipeUntil = performance.now() + 900;
      this.mult = 1;
      this.state.vx *= 0.2;
      this.state.vy *= 0.2;
      this.state.heading = slope;
      this.syncRider();
      return;
    }

    const jump: Jump = {
      flips: Math.floor(Math.abs(this.rotAccum) / (Math.PI * 2)),
      airtimeMs,
      maxHeight: this.maxHeight,
      grabHeldMs: this.grabMs,
      launch: this.launchCtx,
    };
    const trick = nameTrick(jump);
    if (trick) {
      const pts = Math.round(trick.base * this.mult);
      this.style += pts;
      this.mult += trick.multAdd;
      this.opts.onTrick({ name: trick.name, points: pts, mult: this.mult });
      if (pts > this.bestTrickScore) { this.bestTrickScore = pts; this.bestTrick = trick; }
    }
    this.state.heading = slope;
  }

  private updatePose(dt: number, wiped: boolean) {
    const k = 1 - Math.pow(0.001, dt / 1000);
    let target: Pose;
    if (wiped) target = POSES.wipeout;
    else if (!this.state.grounded) target = this.input.hold ? POSES.grab : POSES.air;
    else if (this.input.hold) target = POSES.tuck;
    else if (this.input.brake) target = POSES.ride;
    else target = POSES.ride;
    this.pose = lerpPose(this.pose, target, Math.min(1, k * 6));
  }

  private checkCoins() {
    for (const c of this.terrain.coins) {
      if (!c.taken && Math.hypot(c.x - this.state.x, c.y - this.state.y) < 30) {
        c.taken = true;
        this.coins++;
        this.style += 250;
      }
    }
  }

  private checkFinish() {
    if (this.state.x >= this.terrain.finishX && !this.finished) this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.detach?.();
    window.removeEventListener("resize", this.resize);
    this.opts.onFinish({
      ticker: this.data.symbol,
      timeMs: this.moving ? Math.round(this.runMs) : null,
      style: this.style,
      coins: this.coins,
      bestTrick: this.bestTrick?.name ?? null,
      path: this.path,
    });
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.detach?.();
    window.removeEventListener("resize", this.resize);
  }

  private driveReplay(dt: number) {
    this.runMs += dt;
    const fps = 1000 / STEP;
    const idx = Math.floor((this.runMs / 1000) * fps);
    const p = this.replay!;
    if (idx >= p.length - 1) {
      const last = p[p.length - 1];
      this.state.x = last.x; this.state.y = last.y; this.state.heading = last.h;
      this.syncRider();
      if (!this.finished) this.finish();
      return;
    }
    const a = p[idx];
    const b = p[idx + 1] ?? a;
    const f = (this.runMs / 1000) * fps - idx;
    this.state.x = a.x + (b.x - a.x) * f;
    this.state.y = a.y + (b.y - a.y) * f;
    this.state.heading = a.h;
    this.syncRider();
  }

  private recordGhost() {
    if (this.replay) return;
    this.path.push({ x: this.state.x, y: this.state.y, h: this.state.heading });
    if (this.path.length > 5800) this.path.shift();
  }

  private updateCamera(dt: number) {
    const w = this.canvas.clientWidth || this.canvas.width;
    const targetX = this.state.x - w * 0.32 + this.state.vx * 0.18;
    const air = Math.max(0, this.terrain.heightAt(this.state.x) - this.state.y);
    // Pull the camera back as the rider speeds up (and when airborne) so more of
    // the mountain is visible at pace.
    const speedFrac = Math.min(1, Math.abs(this.state.vx) / P.SMAX);
    const targetZoom = Math.max(0.5, 1 - air / 1600 - speedFrac * 0.32);
    const k = 0.08 * (dt / STEP);
    this.cam.x += (targetX - this.cam.x) * k;
    this.cam.y += (this.state.y - 360 - this.cam.y) * 0.05 * (dt / STEP);
    this.cam.zoom += (targetZoom - this.cam.zoom) * 0.06 * (dt / STEP);
  }

  private pushHud(paused: boolean) {
    const i = Math.min(
      this.data.closes.length - 1,
      Math.floor((this.state.x / this.terrain.finishX) * this.data.closes.length)
    );
    this.opts.onHud({
      symbol: this.data.symbol,
      price: this.data.closes[Math.max(0, i)].close,
      netPct: this.data.sentiment.netPct,
      up: this.data.sentiment.up,
      timeMs: this.runMs,
      speed: Math.min(1, Math.abs(this.state.vx) / 1200),
      airtime: this.inAir ? Math.min(1, (performance.now() - this.airStart) / 3000) : 0,
      style: this.style,
      mult: this.mult,
      progress: Math.min(1, this.state.x / this.terrain.finishX),
      paused,
    });
  }

  private render() {
    drawWorld(this.ctx, this);
  }

  // ---- offscreen capture for the GIF exporter ----
  setupForCapture(data: SeriesData, path: GhostFrame[]) {
    this.data = data;
    this.sky = SECTOR_SKY[data.sector];
    this.terrain = buildTerrain(data.closes);
    this.replay = path;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  seek(frac: number) {
    const p = this.replay!;
    const idx = Math.min(p.length - 1, Math.max(0, Math.floor(frac * (p.length - 1))));
    const f = p[idx];
    this.state.x = f.x; this.state.y = f.y; this.state.heading = f.h;
    this.syncRider();
    const air = this.terrain.heightAt(f.x) - f.y;
    this.pose = air > 24 ? POSES.air : POSES.ride;
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    this.cam.zoom = 0.46;
    this.cam.x = f.x - (w * 0.4) / this.cam.zoom;
    this.cam.y = f.y - (hgt * 0.52) / this.cam.zoom;
    this.render();
  }
}
