import type { GhostFrame, RunResult } from "./game/engine";

// Personal bests per ticker, kept in localStorage. The fastest run's path is
// saved too and replayed as your ghost next time you ride that ticker.
export interface Best {
  timeMs: number | null;
  style: number;
  path: GhostFrame[];
}

const key = (ticker: string) => `bullrun:best:${ticker.toUpperCase()}`;

export function loadBest(ticker: string): Best | null {
  try {
    const raw = localStorage.getItem(key(ticker));
    return raw ? (JSON.parse(raw) as Best) : null;
  } catch {
    return null;
  }
}

// Records a finished run; returns which personal bests it set.
export function recordRun(r: RunResult): { time: boolean; style: boolean; best: Best } {
  const prev = loadBest(r.ticker);
  const time = r.timeMs != null && (prev?.timeMs == null || r.timeMs < prev.timeMs);
  const style = r.style > (prev?.style ?? 0);
  const best: Best = {
    timeMs: time ? r.timeMs : prev?.timeMs ?? null,
    style: Math.max(r.style, prev?.style ?? 0),
    path: time
      ? r.path.map((f) => ({ x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10, h: Math.round(f.h * 1000) / 1000 }))
      : prev?.path ?? [],
  };
  if (time || style) {
    try {
      localStorage.setItem(key(r.ticker), JSON.stringify(best));
    } catch {
      // storage full or disabled: bests just won't persist
    }
  }
  return { time, style, best };
}
