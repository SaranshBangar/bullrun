// Tiny synthesized sound kit (Web Audio, no asset files): wind that follows
// speed, coin blips, trick chimes, landing thuds and the crash. Mobile browsers
// only allow audio after a user gesture, so `unlock()` runs on the Ride tap.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let wind: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null = null;
let muted = localStorage.getItem("bullrun:muted") === "1";

function noiseBuffer(c: AudioContext, seconds: number) {
  const b = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

export const isMuted = () => muted;
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("bullrun:muted", m ? "1" : "0");
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.02);
}

function tone(freq: number, at: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + dur + 0.02);
}

function noise(at: number, dur: number, vol: number, cutoff: number) {
  if (!ctx || !master) return;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx, dur);
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  s.connect(f).connect(g).connect(master);
  s.start(at);
}

export const sfx = {
  coin() {
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(1320, t, 0.08, "square", 0.05);
    tone(1980, t + 0.06, 0.14, "square", 0.05);
  },
  trick(level = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    [523, 659, 784, 1047].slice(0, 2 + Math.min(2, level)).forEach((f, i) => tone(f, t + i * 0.07, 0.22, "triangle", 0.09));
  },
  clean() {
    if (!ctx) return;
    tone(880, ctx.currentTime, 0.12, "sine", 0.07, 1320);
  },
  land(impact: number) {
    if (!ctx) return;
    const v = Math.min(1, impact);
    noise(ctx.currentTime, 0.18 + v * 0.2, 0.15 + v * 0.35, 600 + v * 900);
  },
  launch() {
    if (!ctx) return;
    tone(220, ctx.currentTime, 0.25, "sine", 0.08, 520);
  },
  crash() {
    if (!ctx) return;
    const t = ctx.currentTime;
    noise(t, 0.6, 0.7, 1400);
    tone(160, t, 0.5, "sawtooth", 0.18, 45);
    tone(90, t + 0.12, 0.6, "sine", 0.25, 40);
  },
  finish() {
    if (!ctx) return;
    const t = ctx.currentTime;
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.09, 0.35, "triangle", 0.08));
  },
  // Continuous wind: louder and brighter with speed, airy when airborne.
  wind(speed: number, air: boolean) {
    if (!ctx || !master) return;
    if (!wind) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx, 2);
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      src.start();
      wind = { src, gain, filter };
    }
    const t = ctx.currentTime;
    wind.gain.gain.setTargetAtTime(speed * (air ? 0.16 : 0.11), t, 0.08);
    wind.filter.frequency.setTargetAtTime(300 + speed * (air ? 1400 : 900), t, 0.1);
  },
};
