import Matter from "matter-js";
import { buildTerrain, Terrain } from "./terrain";
import { POSES, Pose, lerpPose } from "./rider";
import { nameTrick, Jump, TrickDef } from "./tricks";
import { drawWorld } from "./draw";
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
  replay?: GhostFrame[] | null; // play back instead of taking input (share view)
}

const STEP = 1000 / 60;
const WIPEOUT_RAD = 0.95;

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  engine: Matter.Engine;
  rider!: Matter.Body;
  terrain!: Terrain;
  data!: SeriesData;
  opts!: GameOpts;
  sky!: [string, string, string];

  // camera
  cam = { x: 0, y: 0, zoom: 1 };
  // input: hold = speed/tuck (W / ↑ / tap), brake = slow (S / ↓), rot = tilt (A·D / ←·→)
  input = { hold: false, brake: false, rot: 0 };
  // rider visual
  heading = 0;
  pose: Pose = { ...POSES.ride };
  grounded = true;
  groundContacts = 0;

  // run state
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
  takeoffX = 0;

  ghost: GhostFrame[] | null = null;
  replay: GhostFrame[] | null = null;
  raf = 0;
  acc = 0;
  last = 0;
  detach: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.engine = Matter.Engine.create();
    this.engine.gravity.y = 1.1;
  }

  start(data: SeriesData, opts: GameOpts) {
    this.data = data;
    this.opts = opts;
    this.ghost = opts.ghost ?? null;
    this.replay = opts.replay ?? null;
    this.sky = SECTOR_SKY[data.sector];
    this.terrain = buildTerrain(data.closes);

    const t = this.terrain;
    this.rider = Matter.Bodies.circle(t.startX, t.heightAt(t.startX) - 40, 13, {
      friction: 0.02,
      frictionAir: 0.01,
      restitution: 0,
      label: "rider",
      density: 0.004,
    });
    Matter.Composite.add(this.engine.world, [...t.bodies, this.rider]);

    Matter.Events.on(this.engine, "collisionStart", (e) => this.contacts(e, 1));
    Matter.Events.on(this.engine, "collisionEnd", (e) => this.contacts(e, -1));

    this.heading = t.slopeAt(t.startX);
    this.lastHeading = this.heading;
    this.cam.x = t.startX;
    this.resize();
    window.addEventListener("resize", this.resize);
    if (!this.replay) this.attachInput();
    this.running = true;
    this.last = performance.now();
    this.loop(this.last);
  }

  private contacts(e: Matter.IEventCollision<Matter.Engine>, dir: number) {
    for (const p of e.pairs) {
      const labels = [p.bodyA.label, p.bodyB.label];
      if (labels.includes("rider") && (labels.includes("terrain") || labels.includes("floor")))
        this.groundContacts = Math.max(0, this.groundContacts + dir);
    }
  }

  private attachInput() {
    const isSpeed = (c: string) => c === "KeyW" || c === "ArrowUp" || c === "Space";
    const isBrake = (c: string) => c === "KeyS" || c === "ArrowDown";
    const down = (e: KeyboardEvent) => {
      if (isSpeed(e.code)) {
        this.input.hold = true;
        e.preventDefault();
      }
      if (isBrake(e.code)) {
        this.input.brake = true;
        e.preventDefault();
      }
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
    } else {
      this.pushHud(true);
    }
  }

  private loop = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = now - this.last;
    this.last = now;
    if (dt > 100) dt = 100; // tab-out clamp
    this.acc += dt;
    while (this.acc >= STEP) {
      this.tick(STEP);
      this.acc -= STEP;
    }
    this.render();
  };

  private tick(dt: number) {
    if (this.finished) return;
    const t = this.terrain;
    const r = this.rider;

    if (this.replay) {
      this.driveReplay(dt);
    } else {
      this.grounded = this.groundContacts > 0;
      const wiped = performance.now() < this.wipeUntil;

      // start timing on first real movement
      if (!this.moving && (this.input.hold || r.position.x > t.startX + 4)) this.moving = true;
      if (this.moving && !this.finished) this.runMs += dt;

      if (!wiped) this.applyControls(dt);
      Matter.Engine.update(this.engine, dt);
      this.updateRiderVisual(dt, wiped);
      this.handleJumpTracking(dt);
      this.checkCoinsAndFeatures();
      this.checkFinish();
    }

    this.updateCamera(dt);
    this.recordGhost();
    this.pushHud(false);
  }

  private applyControls(dt: number) {
    const r = this.rider;
    const slope = this.terrain.slopeAt(r.position.x);

    if (this.grounded) {
      if (this.input.brake) {
        // S / ↓ : dig in and scrub speed
        r.frictionAir = 0.14;
        Matter.Body.applyForce(r, r.position, { x: -Math.sign(r.velocity.x || 1) * 0.0035, y: 0 });
      } else if (this.input.hold) {
        // W / ↑ : pump — drives speed along the slope (buy-the-dip).
        const downhill = slope; // slope>0 means going down to the right
        const f = 0.0016 + Math.max(0, downhill) * 0.004;
        Matter.Body.applyForce(r, r.position, { x: Math.cos(slope) * f, y: Math.sin(slope) * f });
        r.frictionAir = 0.002; // tuck is slippery
      } else {
        r.frictionAir = 0.012;
        // gentle forward nudge so a flat start still rolls
        if (r.velocity.x < 6) Matter.Body.applyForce(r, r.position, { x: 0.0006, y: 0 });
      }
    } else {
      // air rotation
      if (this.input.rot !== 0) this.heading += this.input.rot * 0.13 * (dt / STEP);
      if (this.input.hold) this.grabMs += dt; // hold in air = grab
    }
  }

  private updateRiderVisual(dt: number, wiped: boolean) {
    const r = this.rider;
    const k = 1 - Math.pow(0.001, dt / 1000); // frame-rate independent ease
    let target: Pose;
    if (wiped) target = POSES.wipeout;
    else if (!this.grounded) target = this.input.hold ? POSES.grab : POSES.air;
    else if (this.input.hold) target = POSES.tuck;
    else target = POSES.ride;
    this.pose = lerpPose(this.pose, target, Math.min(1, k * 6));

    if (this.grounded && !wiped) {
      // ease heading onto the slope under the board
      const slope = this.terrain.slopeAt(r.position.x);
      let d = slope - this.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.heading += d * Math.min(1, k * 8);
    }
  }

  private handleJumpTracking(dt: number) {
    const r = this.rider;
    if (!this.grounded) {
      if (!this.inAir) {
        this.inAir = true;
        this.airStart = performance.now();
        this.rotAccum = 0;
        this.maxHeight = 0;
        this.grabMs = 0;
        this.takeoffX = r.position.x;
        const slope = this.terrain.slopeAt(r.position.x);
        const onRamp = this.terrain.features.some(
          (f) => f.type === "earnings" && Math.abs(f.x - r.position.x) < 80
        );
        this.launchCtx = onRamp ? "earnings" : slope < -0.15 ? "dip" : "normal";
        if (onRamp) Matter.Body.applyForce(r, r.position, { x: 0.02, y: -0.06 }); // boost ramp pop
      }
      let d = this.heading - this.lastHeading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.rotAccum += d;
      const groundY = this.terrain.heightAt(r.position.x);
      this.maxHeight = Math.max(this.maxHeight, groundY - r.position.y);
      this.settledMs = 0;
    } else {
      if (this.inAir) this.land();
      this.settledMs += dt;
      if (this.settledMs > 700) this.mult = 1; // combo cools off once settled
    }
    this.lastHeading = this.heading;
  }

  private land() {
    this.inAir = false;
    const r = this.rider;
    const slope = this.terrain.slopeAt(r.position.x);
    let diff = this.heading - slope;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const airtimeMs = performance.now() - this.airStart;

    if (Math.abs(diff) > WIPEOUT_RAD && airtimeMs > 250) {
      // bad landing -> wipeout: bleed speed, reset combo, no points
      this.wipeUntil = performance.now() + 900;
      this.mult = 1;
      Matter.Body.setVelocity(r, { x: r.velocity.x * 0.2, y: 0 });
      this.heading = slope;
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
      if (pts > this.bestTrickScore) {
        this.bestTrickScore = pts;
        this.bestTrick = trick;
      }
    }
    this.heading = slope;
  }

  private checkCoinsAndFeatures() {
    const r = this.rider;
    for (const c of this.terrain.coins) {
      if (!c.taken && Math.hypot(c.x - r.position.x, c.y - r.position.y) < 30) {
        c.taken = true;
        this.coins++;
        this.style += 250;
      }
    }
  }

  private checkFinish() {
    if (this.rider.position.x >= this.terrain.finishX && !this.finished) this.finish();
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

  // ---- offscreen capture (used by the GIF exporter) ----
  // Builds the world without input/loop/events; seek() then renders one frame.
  setupForCapture(data: SeriesData, path: GhostFrame[]) {
    this.data = data;
    this.sky = SECTOR_SKY[data.sector];
    this.terrain = buildTerrain(data.closes);
    this.replay = path;
    this.rider = Matter.Bodies.circle(this.terrain.startX, 0, 13, {});
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  seek(frac: number) {
    const p = this.replay!;
    const idx = Math.min(p.length - 1, Math.max(0, Math.floor(frac * (p.length - 1))));
    const f = p[idx];
    Matter.Body.setPosition(this.rider, { x: f.x, y: f.y });
    this.heading = f.h;
    const air = this.terrain.heightAt(f.x) - f.y;
    this.pose = air > 24 ? POSES.air : POSES.ride;
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    this.cam.zoom = 0.46;
    this.cam.x = f.x - (w * 0.4) / this.cam.zoom;
    this.cam.y = f.y - (hgt * 0.52) / this.cam.zoom;
    this.render();
  }

  private driveReplay(dt: number) {
    this.runMs += dt;
    const fps = 1000 / STEP;
    const idx = Math.floor((this.runMs / 1000) * fps);
    const p = this.replay!;
    if (idx >= p.length - 1) {
      const last = p[p.length - 1];
      Matter.Body.setPosition(this.rider, { x: last.x, y: last.y });
      this.heading = last.h;
      if (!this.finished) this.finish();
      return;
    }
    const a = p[idx];
    const b = p[idx + 1] ?? a;
    const f = (this.runMs / 1000) * fps - idx;
    Matter.Body.setPosition(this.rider, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    this.heading = a.h;
  }

  private recordGhost() {
    if (this.replay) return;
    const r = this.rider;
    this.path.push({ x: r.position.x, y: r.position.y, h: this.heading });
    if (this.path.length > 5800) this.path.shift(); // safety bound for KV size
  }

  private updateCamera(dt: number) {
    const r = this.rider;
    const w = this.canvas.clientWidth;
    const targetX = r.position.x - w * 0.32 + r.velocity.x * 14;
    const air = Math.max(0, this.terrain.heightAt(r.position.x) - r.position.y);
    const targetZoom = Math.max(0.7, 1 - air / 1600);
    const k = 0.08 * (dt / STEP);
    this.cam.x += (targetX - this.cam.x) * k;
    this.cam.y += (r.position.y - 360 - this.cam.y) * 0.05 * (dt / STEP);
    this.cam.zoom += (targetZoom - this.cam.zoom) * 0.06 * (dt / STEP);
  }

  private pushHud(paused: boolean) {
    const i = Math.min(this.data.closes.length - 1, Math.floor((this.rider.position.x / this.terrain.finishX) * this.data.closes.length));
    this.opts.onHud({
      symbol: this.data.symbol,
      price: this.data.closes[Math.max(0, i)].close,
      netPct: this.data.sentiment.netPct,
      up: this.data.sentiment.up,
      timeMs: this.runMs,
      speed: Math.min(1, Math.abs(this.rider.velocity.x) / 18),
      airtime: this.inAir ? Math.min(1, (performance.now() - this.airStart) / 3000) : 0,
      style: this.style,
      mult: this.mult,
      progress: Math.min(1, this.rider.position.x / this.terrain.finishX),
      paused,
    });
  }

  private render() {
    drawWorld(this.ctx, this);
  }
}
