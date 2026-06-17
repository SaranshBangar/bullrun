import { drawRider } from "./rider";
import type { Game } from "./engine";

const UP = "#16c66a";
const DOWN = "#ef4b3c";

export function drawWorld(ctx: CanvasRenderingContext2D, g: Game) {
  const w = g.canvas.clientWidth || g.canvas.width;
  const h = g.canvas.clientHeight || g.canvas.height;
  const { cam } = g;
  const zoom = cam.zoom;
  const sx = (x: number) => (x - cam.x) * zoom;
  const sy = (y: number) => (y - cam.y) * zoom;
  const line = g.data.sentiment.up ? UP : DOWN;

  // ---- sky (sector gradient) ----
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, g.sky[0]);
  sky.addColorStop(0.56, g.sky[1]);
  sky.addColorStop(1, g.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // drifting sun glow
  const sunX = w * 0.72 - (cam.x * 0.04) % w;
  const glow = ctx.createRadialGradient(sunX, h * 0.22, 0, sunX, h * 0.22, 220);
  glow.addColorStop(0, "rgba(255,255,255,0.5)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // ---- parallax back hills (cheap silhouettes) ----
  parallax(ctx, g, 0.35, "rgba(255,255,255,0.06)", h * 0.62);
  parallax(ctx, g, 0.6, "rgba(255,255,255,0.05)", h * 0.7);

  // ---- terrain (only points near the viewport) ----
  const pts = g.terrain.pts;
  ctx.beginPath();
  let started = false;
  const left = cam.x - 60 / zoom;
  const right = cam.x + (w + 60) / zoom;
  let firstX = 0;
  let lastX = 0;
  for (const p of pts) {
    if (p.x < left || p.x > right) {
      if (started && p.x > right) break;
      continue;
    }
    if (!started) {
      ctx.moveTo(sx(p.x), sy(p.y));
      firstX = sx(p.x);
      started = true;
    } else ctx.lineTo(sx(p.x), sy(p.y));
    lastX = sx(p.x);
  }
  // fill under the line
  ctx.save();
  ctx.lineTo(lastX, h + 40);
  ctx.lineTo(firstX, h + 40);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, h * 0.35, 0, h);
  fill.addColorStop(0, hexA(line, 0.32));
  fill.addColorStop(1, hexA(line, 0));
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  // earnings ramps (glow) — drawn before the stroke so the line sits on top
  for (const f of g.terrain.features) {
    if (f.type !== "earnings") continue;
    if (f.x < left || f.x > right) continue;
    const gy = g.terrain.heightAt(f.x);
    const rg = ctx.createRadialGradient(sx(f.x), sy(gy), 0, sx(f.x), sy(gy), 70);
    rg.addColorStop(0, "rgba(22,198,106,0.55)");
    rg.addColorStop(1, "rgba(22,198,106,0)");
    ctx.fillStyle = rg;
    ctx.fillRect(sx(f.x) - 70, sy(gy) - 90, 140, 120);
  }

  // the line itself — sentiment colour + breathing glow
  ctx.beginPath();
  started = false;
  for (const p of pts) {
    if (p.x < left || p.x > right) {
      if (started && p.x > right) break;
      continue;
    }
    if (!started) {
      ctx.moveTo(sx(p.x), sy(p.y));
      started = true;
    } else ctx.lineTo(sx(p.x), sy(p.y));
  }
  const breathe = 6 + Math.sin(performance.now() / 600) * 3;
  ctx.save();
  ctx.shadowColor = line;
  ctx.shadowBlur = breathe;
  ctx.strokeStyle = line;
  ctx.lineWidth = 4.5 * zoom;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();

  // ---- coins ----
  for (const c of g.terrain.coins) {
    if (c.taken || c.x < left || c.x > right) continue;
    ctx.beginPath();
    ctx.arc(sx(c.x), sy(c.y), 7 * zoom, 0, Math.PI * 2);
    ctx.strokeStyle = "#f6d36b";
    ctx.lineWidth = 2.5 * zoom;
    ctx.stroke();
    ctx.fillStyle = "#f6d36b";
    ctx.font = `${10 * zoom}px 'IBM Plex Mono', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", sx(c.x), sy(c.y) + 0.5);
  }

  // ---- finish flag ----
  const fx = g.terrain.finishX;
  if (fx > left - 80) {
    const fy = g.terrain.heightAt(fx);
    ctx.save();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4 * zoom;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(sx(fx), sy(fy));
    ctx.lineTo(sx(fx), sy(fy) - 70 * zoom);
    ctx.moveTo(sx(fx), sy(fy) - 66 * zoom);
    ctx.lineTo(sx(fx) + 30 * zoom, sy(fy) - 66 * zoom);
    ctx.lineTo(sx(fx) + 22 * zoom, sy(fy) - 56 * zoom);
    ctx.lineTo(sx(fx) + 30 * zoom, sy(fy) - 46 * zoom);
    ctx.lineTo(sx(fx), sy(fy) - 46 * zoom);
    ctx.stroke();
    ctx.restore();
  }

  // ---- ghost (translucent best run) ----
  if (g.ghost && g.ghost.length) {
    const fps = 60;
    const idx = Math.min(g.ghost.length - 1, Math.floor((g.runMs / 1000) * fps));
    const gf = g.ghost[idx];
    ctx.save();
    ctx.globalAlpha = 0.32;
    drawRider(ctx, sx(gf.x), sy(gf.y), gf.h, g.pose, zoom, "#9fd9ec");
    ctx.restore();
  }

  // ---- rider ----
  drawRider(ctx, sx(g.rider.position.x), sy(g.rider.position.y), g.heading, g.pose, zoom);
}

function parallax(ctx: CanvasRenderingContext2D, g: Game, factor: number, color: string, baseY: number) {
  const w = g.canvas.clientWidth;
  const off = (g.cam.x * factor) % 320;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-off, baseY);
  for (let x = -off; x < w + 320; x += 320) {
    ctx.quadraticCurveTo(x + 80, baseY - 70, x + 160, baseY);
    ctx.quadraticCurveTo(x + 240, baseY + 60, x + 320, baseY);
  }
  ctx.lineTo(w, 9999);
  ctx.lineTo(-off, 9999);
  ctx.closePath();
  ctx.fill();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
