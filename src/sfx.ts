// Sound kit: recorded CC0 samples and music (public/audio, see CREDITS.txt)
// played through Web Audio, plus a synthesized wind bed that follows speed.
// Browsers only allow audio after a user gesture, so the context is created on
// the first tap or key press anywhere; music asked for before that starts then.

type Sample =
  | "tick" | "go" | "coin" | "trick" | "clean" | "launch" | "land" | "land-hard"
  | "crash" | "click" | "finish" | "best" | "fail";
type Track = "home" | "ride";

const SAMPLES: Sample[] = ["tick", "go", "coin", "trick", "clean", "launch", "land", "land-hard", "crash", "click", "finish", "best", "fail"];
// `xfade`: seconds blended from the track's end into its start so a recording
// that wasn't written as a loop still loops without a seam.
const TRACKS: Record<Track, { vol: number; xfade: number }> = {
  home: { vol: 0.9, xfade: 1.5 },
  ride: { vol: 0.75, xfade: 0 },
};
const MASTER = 0.8;
const MUSIC = 0.6;
const MUSIC_DUCKED = 0.18;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicBus: GainNode | null = null;
let sfxBus: GainNode | null = null;
let muted = localStorage.getItem("bullrun:muted") === "1";
// User loudness, 0..1 per channel, remembered on this device.
type Channel = "music" | "sfx";
const volume: Record<Channel, number> = { music: 1, sfx: 1 };
try {
  const v = JSON.parse(localStorage.getItem("bullrun:volume") ?? "{}");
  for (const k of ["music", "sfx"] as Channel[]) if (Number.isFinite(v[k])) volume[k] = Math.min(1, Math.max(0, v[k]));
} catch {}
let ducked = false;
const buffers = new Map<string, AudioBuffer>();
const loading = new Map<string, Promise<AudioBuffer | null>>();

let wanted: Track | null = null;
let current: { name: Track; src: AudioBufferSourceNode; gain: GainNode } | null = null;
let wind: { gain: GainNode; filter: BiquadFilterNode } | null = null;

function load(name: string, prep?: (b: AudioBuffer) => AudioBuffer) {
  if (!ctx) return Promise.resolve(null);
  let p = loading.get(name);
  if (!p) {
    const c = ctx;
    p = fetch(`/audio/${name}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.statusText))))
      .then((data) => c.decodeAudioData(data))
      .then((b) => {
        const out = prep ? prep(b) : b;
        buffers.set(name, out);
        return out;
      })
      .catch(() => {
        loading.delete(name); // retry on the next request
        return null;
      });
    loading.set(name, p);
  }
  return p;
}

// Trim encoder padding off both ends, then fold the last `xfade` seconds into
// the start (equal-power) so `loop = true` plays it seamlessly.
function loopable(b: AudioBuffer, xfade: number): AudioBuffer {
  const d = b.getChannelData(0);
  let s = 0, e = d.length;
  while (s < e && Math.abs(d[s]) < 1e-4) s++;
  while (e > s && Math.abs(d[e - 1]) < 1e-4) e--;
  const n = Math.min(Math.round(xfade * b.sampleRate), Math.floor((e - s) / 2));
  const len = e - s - n;
  const out = ctx!.createBuffer(b.numberOfChannels, len, b.sampleRate);
  for (let ch = 0; ch < b.numberOfChannels; ch++) {
    const src = b.getChannelData(ch), dst = out.getChannelData(ch);
    dst.set(src.subarray(s, s + len));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      dst[i] = src[s + i] * Math.sqrt(t) + src[s + len + i] * Math.sqrt(1 - t);
    }
  }
  return out;
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    // Soft limiter so stacked jingles and music never clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.ratio.value = 12;
    limiter.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(limiter);
    musicBus = ctx.createGain();
    musicBus.gain.value = musicLevel();
    musicBus.connect(master);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = volume.sfx ** 2;
    sfxBus.connect(master);
    SAMPLES.forEach((s) => load(s));
    music(wanted);
  }
  if (ctx.state !== "running" && !document.hidden) ctx.resume().catch(() => {});
}

for (const ev of ["pointerup", "touchend", "keydown"]) addEventListener(ev, unlock, { passive: true });
// Silence everything while the tab or app is in the background.
document.addEventListener("visibilitychange", () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend().catch(() => {});
  else ctx.resume().catch(() => {});
});

// Perceived loudness is roughly logarithmic, so the slider position is squared.
const musicLevel = () => (ducked ? MUSIC_DUCKED : MUSIC) * volume.music ** 2;

export const getVolume = (ch: Channel) => volume[ch];
export function setVolume(ch: Channel, v: number) {
  volume[ch] = Math.min(1, Math.max(0, v));
  localStorage.setItem("bullrun:volume", JSON.stringify(volume));
  if (!ctx) return;
  if (ch === "music" && musicBus) musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.03);
  if (ch === "sfx" && sfxBus) sfxBus.gain.setTargetAtTime(volume.sfx ** 2, ctx.currentTime, 0.03);
}

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("bullrun:muted", m ? "1" : "0");
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.03);
}

function play(name: Sample, vol = 1, rate = 1, delay = 0) {
  const b = buffers.get(name);
  if (!ctx || !sfxBus || !b || ctx.state !== "running") return;
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(sfxBus);
  src.start(ctx.currentTime + delay);
}

// Crossfade to a music track (or to silence with null). Safe to call before
// audio is unlocked or while the track is still downloading.
export function music(name: Track | null, fade = 0.8) {
  wanted = name;
  if (!ctx || !musicBus) return;
  if (current?.name === name) return;
  if (current) {
    const { src, gain } = current;
    const t = ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.linearRampToValueAtTime(0, t + fade);
    src.stop(t + fade + 0.05);
    current = null;
  }
  if (!name) return;
  load("music-" + name, (b) => loopable(b, TRACKS[name].xfade)).then((b) => {
    if (!b || !ctx || !musicBus || wanted !== name || current) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(TRACKS[name].vol, t + fade);
    src.connect(gain).connect(musicBus);
    src.start(t);
    current = { name, src, gain };
  });
}

// Pull the music back (pause menu) without stopping it.
export function duck(on: boolean) {
  if (on === ducked) return;
  ducked = on;
  if (ctx && musicBus) musicBus.gain.setTargetAtTime(musicLevel(), ctx.currentTime, 0.15);
}

const jitter = (amt: number) => 1 + (Math.random() * 2 - 1) * amt;

export const sfx = {
  tick: () => play("tick", 0.8),
  go: () => play("go", 0.9),
  click: () => play("click", 0.6, jitter(0.04)),
  coin: () => play("coin", 0.55, jitter(0.03)),
  // Bigger tricks ring higher.
  trick: (level = 1) => play("trick", 0.7, 1 + 0.08 * Math.min(4, level - 1)),
  clean: () => play("clean", 0.5),
  launch: () => play("launch", 0.45, jitter(0.05)),
  land(impact: number) {
    const v = Math.min(1, Math.max(0, impact));
    if (v > 0.55) play("land-hard", 0.55 + 0.45 * v, jitter(0.05));
    else play("land", 0.35 + 0.6 * v, jitter(0.06));
  },
  // Impact + snow, the ride music cuts out, then the wipeout jingle.
  crash() {
    play("crash", 1);
    play("land-hard", 0.8, 0.85);
    music(null, 0.25);
    play("fail", 0.8, 1, 0.45);
  },
  finish: () => play("finish", 0.85),
  best: () => play("best", 0.9),
  // Continuous wind: louder and brighter with speed, airy when airborne.
  wind(speed: number, air: boolean) {
    if (!ctx || !sfxBus) return;
    if (!wind) {
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(sfxBus);
      src.start();
      wind = { gain, filter };
    }
    const t = ctx.currentTime;
    wind.gain.gain.setTargetAtTime(speed * (air ? 0.11 : 0.07), t, 0.08);
    wind.filter.frequency.setTargetAtTime(300 + speed * (air ? 1400 : 900), t, 0.1);
  },
};
