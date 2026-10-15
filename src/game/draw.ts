import { drawRider } from "./rider";
import type { Game } from "./engine";
import { fmtPrice } from "../shared/series";

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

  // ---- terrain (only points near the viewport, extended flat past both ends) ----
  const t = g.terrain;
  const left = cam.x - 60 / zoom;
  const right = cam.x + (w + 60) / zoom;
  const vis: { x: number; y: number }[] = [{ x: left, y: t.heightAt(left) }];
  for (const p of t.pts) {
    if (p.x <= left) continue;
    if (p.x >= right) break;
    vis.push(p);
  }
  vis.push({ x: right, y: t.heightAt(right) });
  const trace = () => {
    ctx.beginPath();
    vis.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
  };

  // fill under the line
  trace();
  ctx.lineTo(sx(right), h + 40);
  ctx.lineTo(sx(left), h + 40);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, h * 0.35, 0, h);
  fill.addColorStop(0, hexA(line, 0.32));
  fill.addColorStop(1, hexA(line, 0));
  ctx.fillStyle = fill;
  ctx.fill();

  // month gridlines + labels along the bottom, so you always know *when* you are
  ctx.save();
  for (const tk of t.ticks) {
    if (tk.x < left || tk.x > right) continue;
    const gx = sx(tk.x);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(gx, sy(t.heightAt(tk.x)) + 8);
    ctx.lineTo(gx, h - 26);
    ctx.stroke();
    ctx.setLineDash([]);
    tag(ctx, gx, h - 16, tk.label.toUpperCase(), "rgba(13,15,19,0.55)", "#fff");
  }
  ctx.restore();

  // rally ramps (glow + chevrons) and cliff gaps, labelled with the real move
  for (const f of t.features) {
    if (f.x < left || f.x > right) continue;
    const gy = t.heightAt(f.x);
    const c = g.data.closes;
    const pct = ((c[f.i].close - c[f.i - 1].close) / c[f.i - 1].close) * 100;
    if (f.type === "rally") {
      const rg = ctx.createRadialGradient(sx(f.x), sy(gy), 0, sx(f.x), sy(gy), 80 * zoom);
      rg.addColorStop(0, "rgba(69,212,136,0.7)");
      rg.addColorStop(1, "rgba(69,212,136,0)");
      ctx.fillStyle = rg;
      ctx.fillRect(sx(f.x) - 80 * zoom, sy(gy) - 100 * zoom, 160 * zoom, 140 * zoom);
      ctx.save();
      ctx.strokeStyle = "#eafff2";
      ctx.lineWidth = 3 * zoom;
      ctx.lineCap = "round";
      const bob = Math.sin(performance.now() / 220) * 3 * zoom;
      for (let k = 0; k < 3; k++) {
        const cy = sy(gy) - (22 + k * 12) * zoom + bob;
        ctx.globalAlpha = 1 - k * 0.28;
        ctx.beginPath();
        ctx.moveTo(sx(f.x) - 9 * zoom, cy + 6 * zoom);
        ctx.lineTo(sx(f.x), cy);
        ctx.lineTo(sx(f.x) + 9 * zoom, cy + 6 * zoom);
        ctx.stroke();
      }
      ctx.restore();
      tag(ctx, sx(f.x), sy(gy) - 78 * zoom, `+${pct.toFixed(1)}% DAY`, "#45d488", "#04140a");
    } else {
      tag(ctx, sx(f.x), sy(gy) - 40 * zoom, `${pct.toFixed(1)}% GAP`, "#ef4b3c", "#fff");
    }
  }

  // the line itself — sentiment colour + breathing glow
  trace();
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

  // six-month high / low markers
  for (const [i, label] of [[t.hi, "6M HIGH"], [t.lo, "6M LOW"]] as const) {
    const mx = t.dayX[i];
    if (mx < left || mx > right) continue;
    const my = sy(t.heightAt(mx));
    ctx.beginPath();
    ctx.arc(sx(mx), my, 6 * zoom, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.lineWidth = 3 * zoom;
    ctx.strokeStyle = line;
    ctx.stroke();
    const below = label === "6M LOW";
    tag(ctx, sx(mx), my + (below ? 34 : -30) * zoom, `${label} ${fmtPrice(g.data.closes[i].close, g.data.currency)}`, "rgba(13,15,19,0.72)", "#fff");
  }

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
  const w = g.canvas.clientWidth || g.canvas.width;
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

// A small rounded label pill centred on (x, y).
function tag(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, bg: string, fg: string) {
  ctx.save();
  ctx.font = `600 11px 'IBM Plex Mono', monospace`;
  const tw = ctx.measureText(text).width;
  const pw = tw + 14;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x - pw / 2, y - 10, pw, 20, 6);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
