import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { Game } from "./engine";
import type { SeriesData, GhostFrame } from "./engine";

const W = 480;
const H = 270;

function fmt(ms: number | null): string {
  if (ms == null) return "—";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Replays the recorded run path into an animated GIF and triggers a download.
// Frames are sampled evenly across the run so length stays a short ~4s loop.
export async function downloadRunGif(data: SeriesData, path: GhostFrame[], timeMs: number | null) {
  if (!path || path.length < 4) throw new Error("Run too short to capture.");

  const cap = document.createElement("canvas");
  cap.width = W;
  cap.height = H;
  const ctx = cap.getContext("2d")!;
  const g = new Game(cap);
  g.setupForCapture(data, path);

  const enc = GIFEncoder();
  const N = Math.min(56, Math.max(16, Math.floor(path.length / 6)));
  const caption = `${data.symbol} · ${fmt(timeMs)}`;

  for (let i = 0; i < N; i++) {
    g.seek(i / (N - 1));
    // burn-in caption pill (company + time)
    ctx.save();
    ctx.font = "600 16px 'Space Grotesk', sans-serif";
    const tw = ctx.measureText(caption).width;
    ctx.fillStyle = "rgba(13,15,19,0.55)";
    roundRect(ctx, 12, 12, tw + 24, 30, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "middle";
    ctx.fillText(caption, 24, 28);
    ctx.fillStyle = "#16c66a";
    ctx.font = "700 13px 'Space Grotesk', sans-serif";
    ctx.fillText("BullRun", W - 78, 26);
    ctx.restore();

    const { data: px } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(px, 256);
    const index = applyPalette(px, palette);
    enc.writeFrame(index, W, H, { palette, delay: 70 });
    if (i % 8 === 0) await new Promise((r) => setTimeout(r)); // yield so UI stays live
  }
  enc.finish();

  const blob = new Blob([enc.bytes() as BlobPart], { type: "image/gif" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bullrun-${data.symbol}.gif`;
  a.click();
  URL.revokeObjectURL(url);
  g.destroy();
}

// Renders a single still of the run (the rider's highest point — the most
// dramatic frame) to a high-res PNG and triggers a download.
export async function downloadRunImage(data: SeriesData, path: GhostFrame[], timeMs: number | null) {
  if (!path || path.length < 2) throw new Error("Run too short to capture.");

  const IW = 1200;
  const IH = 675;
  const cap = document.createElement("canvas");
  cap.width = IW;
  cap.height = IH;
  const ctx = cap.getContext("2d")!;
  const g = new Game(cap);
  g.setupForCapture(data, path);

  // smallest y = highest the rider got (y grows downward)
  let peak = 0;
  for (let i = 1; i < path.length; i++) if (path[i].y < path[peak].y) peak = i;
  g.seek(peak / (path.length - 1));

  const caption = `${data.symbol} · ${fmt(timeMs)}`;
  ctx.save();
  ctx.font = "600 34px 'Space Grotesk', sans-serif";
  const tw = ctx.measureText(caption).width;
  ctx.fillStyle = "rgba(13,15,19,0.55)";
  roundRect(ctx, 28, 28, tw + 52, 64, 16);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(caption, 54, 62);
  ctx.fillStyle = "#16c66a";
  ctx.font = "700 30px 'Space Grotesk', sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("BullRun", IW - 40, 60);
  ctx.restore();

  const blob: Blob = await new Promise((res, rej) =>
    cap.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/png")
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bullrun-${data.symbol}.png`;
  a.click();
  URL.revokeObjectURL(url);
  g.destroy();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
