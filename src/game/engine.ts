import { buildTerrain, Terrain } from "./terrain";
import { POSES, Pose, lerpPose } from "./rider";
import { sfx } from "../sfx";
import { nameTrick, Jump, TrickDef } from "./tricks";
import { drawWorld } from "./draw";
import { step, P, normAngle, bodyPoint, BODY, makeRagdoll, stepRagdoll, J, type Rider, type Input, type Crash, type Ragdoll } from "./physics";
import type { Close, Sector } from "../shared/series";
import { SECTOR_SKY } from "../shared/series";

export interface SeriesData {
  symbol: string;
  name: string;
  sector: Sector;
  sentiment: { netPct: number; up: boolean };
  closes: Close[];
  exchange?: string;
  currency?: string;
  simulated?: boolean; // offline fallback prices, not real market data
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
  crash?: { reason: Crash; index: number; progress: number }; // set when the run ended in a wipeout
}

export interface HudState {
  index: number; // close under the rider
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
}

const STEP = 1000 / 60; // ms per fixed sim step

export type Action = "hold" | "brake" | "left" | "right";
const CRASH_MS = 1700; // ragdoll tumble before the results screen

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
}

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
  armed = false; // held at the start line during the countdown
  runMs = 0;
  style = 0;
  coins = 0;
  mult = 1;
  bestTrick: TrickDef | null = null;
  bestTrickScore = 0;
  path: GhostFrame[] = [];
  settledMs = 0;

  // juice
  fx: Particle[] = [];
  trail: { x: number; y: number }[] = [];
  shake = 0;
  crash: { reason: Crash; ragdoll: Ragdoll; ms: number; index: number; progress: number } | null = null;

  // jump tracking
  inAir = false;
  airStart = 0;
  rotAccum = 0;
  lastHeading = 0;
  maxHeight = 0;
  grabMs = 0;
  launchCtx: Jump["launch"] = "normal";

  ghost: GhostFrame[] | null = null;
  replay: GhostFrame[] | null = null; // only set for GIF/image capture
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
    this.resize();
    this.updateCamera(STEP, true);
    window.addEventListener("resize", this.resize);
    this.attachInput();
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

  // Every input source (a key, a finger, the mouse) is tracked separately, so
  // any combination can be held at once: lifting one finger never cancels
  // what another is still holding. For tilt, the most recent press wins.
  private held = new Map<string, Action>();

  press(source: string, action: Action) {
    this.held.delete(source); // re-insert so this press counts as the newest
    this.held.set(source, action);
    this.syncInput();
  }

  release(source: string) {
    if (this.held.delete(source)) this.syncInput();
  }

  private syncInput() {
    const i = this.input;
    i.hold = i.brake = false;
    i.rot = 0;
    for (const a of this.held.values()) {
      if (a === "hold") i.hold = true;
      else if (a === "brake") i.brake = true;
      else i.rot = a === "left" ? -1 : 1;
    }
  }

  private attachInput() {
    const KEYS: Record<string, Action> = {
      KeyW: "hold", ArrowUp: "hold", Space: "hold",
      KeyS: "brake", ArrowDown: "brake",
      KeyA: "left", ArrowLeft: "left",
      KeyD: "right", ArrowRight: "right",
    };
    const down = (e: KeyboardEvent) => {
      if (e.code === "KeyP" || e.code === "Escape") return this.togglePause();
      const a = KEYS[e.code];
      if (!a) return;
      e.preventDefault();
      if (!e.repeat) this.press("key:" + e.code, a);
    };
    const up = (e: KeyboardEvent) => this.release("key:" + e.code);
    // Pressing anywhere on the stage (mouse or finger) also means "speed up".
    const pd = (e: PointerEvent) => this.press("ptr:" + e.pointerId, "hold");
    const pu = (e: PointerEvent) => this.release("ptr:" + e.pointerId);
    // Switching apps or tabs drops every held input (no stuck keys/fingers)
    // and pauses the run.
    const clear = () => { this.held.clear(); this.syncInput(); };
    const hidden = () => {
      if (!document.hidden) return;
      clear();
      if (this.running && !this.finished && !this.armed) this.togglePause();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    this.canvas.addEventListener("pointerdown", pd);
    window.addEventListener("pointerup", pu);
    window.addEventListener("pointercancel", pu);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", hidden);
    this.detach = () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      this.canvas.removeEventListener("pointerdown", pd);
      window.removeEventListener("pointerup", pu);
      window.removeEventListener("pointercancel", pu);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", hidden);
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
      sfx.wind(0, false);
      this.pushHud(true);
    }
  }

  // Haptics — a no-op on devices without a vibration motor (most desktops).
  private buzz(pattern: number | number[]) {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  }

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
    this.updateFx(dt);
    // Frozen at the start line until the countdown releases the rider; still
    // ease the camera into frame so the hold doesn't look static.
    if (this.armed) { this.updateCamera(dt); this.pushHud(false); return; }
    if (this.crash) return this.tickCrash(dt);

    if (!this.moving && (this.input.hold || this.state.x > this.terrain.startX + 4)) this.moving = true;
    if (this.moving) this.runMs += dt;

    const wasAir = !this.state.grounded;
    const prevX = this.state.x;
    const impactVy = this.state.vy;

    const ev = step(this.state, dt / 1000, this.terrain, this.input);
    this.syncRider();
    if (ev.crash) return this.startCrash(ev.crash, dt);

    // Rally ramps (the chart's biggest up-days) pop a grounded rider skyward.
    const ramp = !wasAir && this.state.grounded &&
      this.terrain.features.some((f) => f.type === "rally" && prevX < f.x && this.state.x >= f.x);
    if (ramp) {
      this.state.grounded = false;
      this.state.spin = 0;
      this.state.vy = Math.min(this.state.vy, 0) - 760;
      this.state.vx = Math.max(this.state.vx, 520) + 140;
      this.syncRider();
      this.onTakeoff("rally");
      this.burst(this.state.x, this.state.y + 10, 18, "#9ff5c4", 260);
      sfx.launch();
      this.buzz(30);
    }

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

    if (ev.launched) this.onTakeoff(this.terrain.slopeAt(this.state.x) < -0.15 ? "dip" : "normal");
    if (!this.state.grounded) this.trackAir(dt);
    if (ev.landed) this.onLand(ev.landing === "clean", impactVy);
    if (this.state.grounded && !wasAir) {
      this.settledMs += dt;
      if (this.settledMs > 700) this.mult = 1;
    }

    this.updatePose(dt);
    this.spray();
    this.checkCoins();
    this.checkFinish();

    this.trail.push({ x: this.state.x, y: this.state.y });
    if (this.trail.length > (this.state.grounded ? 1 : 22)) this.trail.splice(0, this.state.grounded ? 3 : 1);
    sfx.wind(Math.min(1, Math.hypot(this.state.vx, this.state.vy) / P.SMAX), !this.state.grounded);

    this.updateCamera(dt);
    this.recordGhost();
    this.pushHud(false);
  }

  // Head or body hit the snow (or a landing too far off): the rider becomes a
  // ragdoll, tumbles for a moment, then the run ends.
  private startCrash(reason: Crash, dt: number) {
    const t = this.terrain;
    this.crash = {
      reason,
      ragdoll: makeRagdoll(this.state, dt / 1000),
      ms: 0,
      index: t.indexAt(this.state.x),
      progress: Math.max(0, Math.min(1, (this.state.x - t.dayX[0]) / (t.finishX - t.dayX[0]))),
    };
    this.mult = 1;
    this.shake = 1;
    this.trail = [];
    this.inAir = false;
    const hit = bodyPoint(this.state, reason === "head" ? BODY.head : BODY.hip);
    this.burst(hit.x, hit.y, 40, "#ffffff", 420);
    sfx.wind(0, false);
    sfx.crash();
    this.buzz([60, 40, 90]);
  }

  private tickCrash(dt: number) {
    const c = this.crash!;
    c.ms += dt;
    stepRagdoll(c.ragdoll, dt / 1000, this.terrain);
    const hip = c.ragdoll.pts[J.hip];
    this.state.x = hip.x;
    this.state.y = hip.y;
    this.state.vx = (hip.x - hip.px) / (dt / 1000);
    this.state.vy = 0;
    this.state.grounded = true;
    this.syncRider();
    this.updateCamera(dt);
    this.pushHud(false);
    if (c.ms >= CRASH_MS) this.finish();
  }

  // Snow kicked up by the board: more at speed, a spray when braking.
  private spray() {
    if (!this.state.grounded) return;
    const sp = Math.hypot(this.state.vx, this.state.vy);
    const n = (sp / P.SMAX) * (this.input.brake ? 3 : 1.1);
    for (let i = 0; i < n + (Math.random() < n % 1 ? 1 : 0); i++) {
      const back = -14 - Math.random() * 10;
      this.fx.push({
        x: this.state.x + back * Math.cos(this.state.heading),
        y: this.state.y + 14 + back * Math.sin(this.state.heading),
        vx: -this.state.vx * (0.15 + Math.random() * 0.2) + (Math.random() - 0.5) * 60,
        vy: -80 - Math.random() * 160 - (this.input.brake ? 120 : 0),
        life: 0, max: 380 + Math.random() * 320, size: 1.6 + Math.random() * 2.6, color: "#ffffff",
      });
    }
  }

  burst(x: number, y: number, n: number, color: string, power: number) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * Math.random();
      const v = power * (0.3 + Math.random() * 0.7);
      this.fx.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 500 + Math.random() * 500, size: 2 + Math.random() * 3, color });
    }
  }

  private updateFx(dt: number) {
    const s = dt / 1000;
    for (const p of this.fx) {
      p.life += dt;
      p.vy += 900 * s;
      p.vx *= 1 - 1.5 * s;
      p.x += p.vx * s;
      p.y += p.vy * s;
    }
    this.fx = this.fx.filter((p) => p.life < p.max).slice(-360);
    this.shake = Math.max(0, this.shake - s * 1.8);
  }

  private onTakeoff(ctx: Jump["launch"]) {
    this.inAir = true;
    this.airStart = performance.now();
    this.rotAccum = 0;
    this.maxHeight = 0;
    this.grabMs = 0;
    this.lastHeading = this.state.heading;
    this.settledMs = 0;
    this.launchCtx = ctx;
  }

  private trackAir(dt: number) {
    this.rotAccum += normAngle(this.state.heading - this.lastHeading);
    this.lastHeading = this.state.heading;
    const groundY = this.terrain.heightAt(this.state.x);
    this.maxHeight = Math.max(this.maxHeight, groundY - this.state.y);
    if (this.input.hold) this.grabMs += dt;
    this.settledMs = 0;
  }

  private onLand(clean: boolean, impactVy: number) {
    this.inAir = false;
    const airtimeMs = performance.now() - this.airStart;
    const impact = Math.max(0, impactVy) / 1400;
    this.burst(this.state.x, this.state.y + 14, Math.round(6 + impact * 30), "#ffffff", 120 + impact * 260);
    if (impact > 0.7) this.shake = Math.max(this.shake, Math.min(0.6, impact * 0.4));
    sfx.land(impact);

    const jump: Jump = {
      flips: Math.floor(Math.abs(this.rotAccum) / (Math.PI * 2) + 0.15), // a near-full rotation counts
      airtimeMs,
      maxHeight: this.maxHeight,
      grabHeldMs: this.grabMs,
      launch: this.launchCtx,
    };
    const trick = nameTrick(jump);
    const showClean = clean && airtimeMs > 450;
    if (trick) {
      const pts = Math.round(trick.base * this.mult * (clean ? 1.25 : 1));
      this.style += pts;
      this.mult += trick.multAdd;
      this.opts.onTrick({ name: trick.name + (clean ? " · Clean" : ""), points: pts, mult: this.mult });
      if (pts > this.bestTrickScore) { this.bestTrickScore = pts; this.bestTrick = trick; }
      sfx.trick(jump.flips + 1);
      this.buzz(18); // landed trick
    } else if (showClean) {
      const pts = Math.round(100 * this.mult);
      this.style += pts;
      this.opts.onTrick({ name: "Clean landing", points: pts, mult: this.mult });
      sfx.clean();
    }
  }

  private updatePose(dt: number) {
    const k = 1 - Math.pow(0.001, dt / 1000);
    let target: Pose;
    if (!this.state.grounded) target = this.input.hold ? POSES.grab : POSES.air;
    else if (this.input.hold) target = POSES.tuck;
    else if (this.input.brake) target = POSES.ride;
    else target = POSES.ride;
    this.pose = lerpPose(this.pose, target, Math.min(1, k * 6));
  }

  private checkCoins() {
    for (const c of this.terrain.coins) {
      const body = bodyPoint(this.state, BODY.hip);
      if (!c.taken && Math.hypot(c.x - body.x, c.y - body.y) < 32) {
        c.taken = true;
        this.coins++;
        this.style += 250;
        this.burst(c.x, c.y, 8, "#f6d36b", 160);
        sfx.coin();
        this.buzz(12); // coin
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
    sfx.wind(0, false);
    const c = this.crash;
    if (!c) sfx.finish();
    this.opts.onFinish({
      ticker: this.data.symbol,
      timeMs: this.moving && !c ? Math.round(this.runMs) : null,
      style: this.style,
      coins: this.coins,
      bestTrick: this.bestTrick?.name ?? null,
      path: this.path,
      crash: c ? { reason: c.reason, index: c.index, progress: c.progress } : undefined,
    });
  }

  destroy() {
    sfx.wind(0, false);
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.detach?.();
    window.removeEventListener("resize", this.resize);
  }

  private recordGhost() {
    this.path.push({ x: this.state.x, y: this.state.y, h: this.state.heading });
    if (this.path.length > 5800) this.path.shift();
  }

  // Framing is relative to the canvas size so phones (portrait or landscape)
  // see the rider and the slope ahead the same way a desktop does.
  private updateCamera(dt: number, snap = false) {
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    const ground = this.terrain.heightAt(this.state.x);
    const air = Math.max(0, ground - this.state.y);
    // Pull back as the rider speeds up (and when airborne) to show more mountain.
    const speedFrac = Math.min(1, Math.abs(this.state.vx) / P.SMAX);
    const scale = Math.min(1.15, Math.max(0.42, Math.min(h / 720, w / 1000))); // portrait: width-limited
    const targetZoom = scale * Math.max(0.5, 1 - air / 1600 - speedFrac * 0.32);
    const k = snap ? 1 : 0.08 * (dt / STEP);
    this.cam.zoom += (targetZoom - this.cam.zoom) * (snap ? 1 : 0.06 * (dt / STEP));
    const z = this.cam.zoom;
    const fx = 0.36 - 0.12 * speedFrac; // rider sits left of centre, more so at speed
    const focusY = this.state.y + Math.min(air, 420) * 0.5; // keep the ground in view mid-air
    this.cam.x += (this.state.x - (w * fx) / z - this.cam.x) * k;
    this.cam.y += (focusY - (h * 0.55) / z - this.cam.y) * k;
  }

  private pushHud(paused: boolean) {
    this.opts.onHud({
      index: this.terrain.indexAt(this.state.x),
      timeMs: this.runMs,
      speed: Math.min(1, Math.abs(this.state.vx) / 1200),
      airtime: this.inAir ? Math.min(1, (performance.now() - this.airStart) / 3000) : 0,
      style: this.style,
      mult: this.mult,
      progress: Math.max(0, Math.min(1, (this.state.x - this.terrain.dayX[0]) / (this.terrain.finishX - this.terrain.dayX[0]))),
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

  // `fit` (stills): zoom so both the rider and the ground beneath stay in frame.
  seek(frac: number, fit = false) {
    const p = this.replay!;
    const idx = Math.min(p.length - 1, Math.max(0, Math.floor(frac * (p.length - 1))));
    const f = p[idx];
    this.state.x = f.x; this.state.y = f.y; this.state.heading = f.h;
    this.syncRider();
    const ground = this.terrain.heightAt(f.x);
    const air = ground - f.y;
    this.pose = air > 24 ? POSES.air : POSES.ride;
    const w = this.canvas.width;
    const hgt = this.canvas.height;
    this.cam.zoom = fit ? Math.min(0.62, Math.max(0.3, (hgt * 0.42) / (air + 220))) : 0.46;
    const midY = fit ? (f.y + ground) / 2 : f.y;
    this.cam.x = f.x - (w * 0.4) / this.cam.zoom;
    this.cam.y = midY - (hgt * (fit ? 0.42 : 0.52)) / this.cam.zoom;
    this.render();
  }

}
