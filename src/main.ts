import { api, UnknownSymbol, type Symbol as Sym } from "./api";
import { Game, type SeriesData, type RunResult, type GhostFrame } from "./game/engine";
import { loadBest, recordRun } from "./bests";
import { sectorFor, nameFor, dailyTicker, fmtPrice, fmtDate, SECTOR_SKY, UNIVERSE, type Close } from "./shared/series";
import { catmullRom, toPath } from "./shared/spline";

const app = document.getElementById("app")!;
const POPULAR = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "RELIANCE.NS"];

// ---------- tiny helpers ----------
const h = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtTime = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(3, "0")}`;
};
const fmtNum = (n: number) => n.toLocaleString("en-US");
const fmtPct = (p: number) => `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
const pill = (p: number) => `<span class="pill ${p >= 0 ? "up" : "down"}">${fmtPct(p)}</span>`;
const simTag = (d: SeriesData) => (d.simulated ? `<span class="sim-tag" title="Live market data was unreachable, so these prices are made up">Simulated prices</span>` : "");
function snack(msg: string) {
  let host = document.querySelector(".toast-host");
  if (!host) { host = h(`<div class="toast-host"></div>`); document.body.appendChild(host); }
  const s = h(`<div class="snack"></div>`);
  s.textContent = msg;
  host.appendChild(s);
  setTimeout(() => s.remove(), 3200);
}

// ---------- share links ----------
// A run is shared as a self-contained link (/?run=<code>): no backend needed.
// Opening it lands on that company with a "beat this" challenge banner.
interface Challenge { s: string; t: number | null; st: number; k?: string | null }
const encodeRun = (c: Challenge) => btoa(JSON.stringify(c)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeRun(code: string | null): Challenge | null {
  if (!code) return null;
  try {
    const c = JSON.parse(atob(code.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof c?.s === "string" && /^[A-Z0-9.\-^=]{1,20}$/.test(c.s) && Number.isFinite(c.st) ? c : null;
  } catch {
    return null;
  }
}
let challenge = decodeRun(new URLSearchParams(location.search).get("run"));
if (location.search || location.pathname !== "/") history.replaceState(null, "", "/");

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    snack("Link copied — paste it anywhere.");
  } catch {
    window.prompt("Copy this link:", text);
  }
}

// Smooth SVG path of the closes, fitted to a W×H box (top/bottom padding).
function chartPath(closes: Close[], W: number, H: number, pad = 20): string {
  const ys = closes.map((c) => c.close);
  const min = Math.min(...ys), span = Math.max(...ys) - min || 1;
  const pts = closes.map((c, i) => ({ x: (i / (closes.length - 1)) * W, y: H - pad - ((c.close - min) / span) * (H - pad * 2) }));
  return toPath(catmullRom(pts, 4));
}

// What the chart did over the window: the "explore" half of the game.
function recap(closes: Close[]) {
  const ys = closes.map((c) => c.close);
  const hi = ys.indexOf(Math.max(...ys));
  const lo = ys.indexOf(Math.min(...ys));
  let up = 1, down = 1;
  const ret = (i: number) => ys[i] / ys[i - 1] - 1;
  for (let i = 2; i < ys.length; i++) {
    if (ret(i) > ret(up)) up = i;
    if (ret(i) < ret(down)) down = i;
  }
  return { first: closes[0], last: closes[closes.length - 1], change: (ys[ys.length - 1] / ys[0] - 1) * 100, hi, lo, up, down, ret };
}

// ---------- start / search ----------
function startScreen(initial?: string) {
  const daily = dailyTicker(new Date().toISOString().slice(0, 10));
  const symbolOf = (s: string): Sym => ({ symbol: s, name: nameFor(s), sector: sectorFor(s) });
  let selected: Sym = symbolOf(initial ?? challenge?.s ?? daily);

  const chips = [daily, ...POPULAR.filter((s) => s !== daily)];
  const screen = h(`
    <div class="screen">
      <div class="start-sky"></div>
      <div class="start-sun"></div>
      <svg class="start-hill" viewBox="0 0 1280 340" preserveAspectRatio="none">
        <defs><linearGradient id="hp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient></defs>
        <path id="hpfill" fill="url(#hp)"></path>
        <path id="hpline" fill="none" stroke="#16c66a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
      </svg>
      <div class="nav">
        <div class="logo">BullRun</div>
        <button class="help-btn" id="help" aria-label="How to play" title="How to play">?</button>
      </div>
      <div class="search-wrap">
        ${challenge ? `<div class="challenge"><span class="flag">Challenge</span>A friend rode <b>${esc(challenge.s)}</b> in <b>${challenge.t ? fmtTime(challenge.t) : "—"}</b> with <b>${fmtNum(challenge.st)}</b> style. Beat it!</div>` : ""}
        <div class="search-kicker">Pick a company · ride its last 6 months</div>
        <div style="position:relative">
          <div class="search-row">
            <div class="search-box">
              <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2"><circle cx="9" cy="9" r="6"></circle><path d="M14 14 L18 18" stroke-linecap="round"></path></svg>
              <input id="q" placeholder="Ticker or company" maxlength="24" autocomplete="off" spellcheck="false" aria-label="Ticker or company" />
              <span class="nm" id="selname"></span>
              <span class="sector-tag" id="seltag"></span>
            </div>
            <button class="btn btn-primary" id="ride">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="#04140a"><path d="M4 2.5 L13 8 L4 13.5 Z"></path></svg>Ride
            </button>
          </div>
          <div class="ac" id="ac" style="display:none"></div>
        </div>
        <div class="quote" id="quote"></div>
        <div class="chips">
          ${chips.map((s) => `<button class="chip ${s === daily ? "daily" : ""}" data-s="${s}">${s === daily ? `<span class="chip-k">Today</span>` : ""}${s.replace(/\.NS$/, "")}</button>`).join("")}
        </div>
      </div>
    </div>`);
  app.replaceChildren(screen);
  screen.querySelector("#help")!.addEventListener("click", howToModal);

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => screen.querySelector<T>(sel)!;
  const q = $<HTMLInputElement>("#q");
  const ac = $("#ac");
  const quote = $("#quote");
  const sky = $(".start-sky");

  let token = 0;
  const pick = (s: Sym) => {
    selected = s;
    q.value = s.symbol;
    $("#selname").textContent = s.name;
    $("#seltag").textContent = s.sector;
    ac.style.display = "none";
    screen.querySelectorAll<HTMLElement>(".chip").forEach((c) => c.classList.toggle("on", c.dataset.s === s.symbol));
    const [a, b, c] = SECTOR_SKY[s.sector];
    sky.style.background = `linear-gradient(172deg, ${a} 0%, ${b} 56%, ${c} 100%)`;
    quote.innerHTML = `<span class="muted">Loading chart…</span>`;
    const mine = ++token;
    api.series(s.symbol).then(
      (d) => {
        if (mine !== token) return;
        if (d.name !== s.name || d.sector !== s.sector) {
          selected = { ...s, name: d.name, sector: d.sector };
          $("#selname").textContent = d.name;
          $("#seltag").textContent = d.sector;
          const [a2, b2, c2] = SECTOR_SKY[d.sector];
          sky.style.background = `linear-gradient(172deg, ${a2} 0%, ${b2} 56%, ${c2} 100%)`;
        }
        const last = d.closes[d.closes.length - 1];
        quote.innerHTML = `<span><b>${fmtPrice(last.close, d.currency)}</b></span>${pill(d.sentiment.netPct)}<span class="muted">6 months · ${esc(d.exchange || "")} ${fmtDate(d.closes[0].date)} → ${fmtDate(last.date)}</span>${simTag(d)}`;
        const line = chartPath(d.closes, 1280, 340, 30);
        $("#hpline").setAttribute("d", line);
        $("#hpline").setAttribute("stroke", d.sentiment.up ? "#16c66a" : "#ef4b3c");
        $("#hpfill").setAttribute("d", `${line} L 1280 340 L 0 340 Z`);
      },
      (e) => {
        if (mine !== token) return;
        quote.innerHTML = `<span class="err">${esc(e instanceof UnknownSymbol ? e.message : "Couldn't load that chart")}</span>`;
        $("#hpline").setAttribute("d", "");
        $("#hpfill").setAttribute("d", "");
      }
    );
  };

  // autocomplete (debounced; stale responses dropped)
  let acItems: Sym[] = [], sel = -1, acToken = 0, timer = 0;
  const renderAc = () => {
    if (!acItems.length) { ac.style.display = "none"; return; }
    ac.style.display = "block";
    ac.replaceChildren(...acItems.map((it, i) =>
      h(`<div class="ac-item ${i === sel ? "sel" : ""}"><span class="sym">${esc(it.symbol)}</span><span class="nm">${esc(it.name)}</span><span class="ex">${esc(it.exchange ?? "")}</span><span class="sector-tag">${it.sector}</span></div>`)));
    ac.querySelectorAll(".ac-item").forEach((node, i) => node.addEventListener("click", () => pick(acItems[i])));
  };
  q.addEventListener("input", () => {
    const v = q.value.trim();
    $("#selname").textContent = "";
    $("#seltag").textContent = "";
    clearTimeout(timer);
    if (!v) { acItems = []; renderAc(); return; }
    const mine = ++acToken;
    timer = window.setTimeout(async () => {
      const items = await api.search(v);
      if (mine !== acToken) return;
      acItems = items; sel = -1; renderAc();
    }, 160);
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(acItems.length - 1, sel + 1); renderAc(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); renderAc(); e.preventDefault(); }
    else if (e.key === "Escape") { ac.style.display = "none"; }
    else if (e.key === "Enter") ride();
  });
  screen.addEventListener("click", (e) => { if (!screen.querySelector(".search-wrap")!.contains(e.target as Node)) ac.style.display = "none"; });

  // Ride whatever the box says: the highlighted suggestion, an exact match,
  // the current selection, the top suggestion, or the raw ticker typed.
  const ride = () => {
    const typed = q.value.trim().toUpperCase();
    if (!typed) return;
    const target =
      (sel >= 0 && acItems[sel]) ||
      acItems.find((x) => x.symbol === typed) ||
      (typed === selected.symbol ? selected : null) ||
      (acItems.length && ac.style.display !== "none" ? acItems[0] : null) ||
      symbolOf(typed);
    loadAndPlay(target.symbol);
  };
  $("#ride").addEventListener("click", ride);
  screen.querySelectorAll<HTMLElement>(".chip").forEach((c) =>
    c.addEventListener("click", () => pick(UNIVERSE.find((u) => u.symbol === c.dataset.s) ?? symbolOf(c.dataset.s!))));

  pick(UNIVERSE.find((u) => u.symbol === selected.symbol) ?? selected);
}

// ---------- load + play ----------
async function loadAndPlay(symbol: string) {
  app.replaceChildren(h(`<div class="screen loading"><div class="micro">Drawing the mountain…</div></div>`));
  try {
    const data = await api.series(symbol);
    const ghost = loadBest(data.symbol)?.path;
    gameScreen(data, ghost?.length ? ghost : null);
  } catch (e) {
    snack(e instanceof UnknownSymbol ? e.message : "Couldn't load that chart. Try another ticker.");
    startScreen(symbol);
  }
}

// ---------- game ----------
function gameScreen(data: SeriesData, ghost: GhostFrame[] | null) {
  const closes = data.closes;
  const ys = closes.map((c) => c.close);
  const min = Math.min(...ys), span = Math.max(...ys) - min || 1;
  const mapY = (v: number) => 92 - ((v - min) / span) * 84; // minimap y in a 0..100 box
  const mini = closes.map((c, i) => `${i ? "L" : "M"}${((i / (closes.length - 1)) * 1000).toFixed(1)},${mapY(c.close).toFixed(1)}`).join(" ");
  const color = data.sentiment.up ? "#45d488" : "#ef4b3c";

  const screen = h(`
    <div class="game-screen">
      <div class="game-stage">
        <canvas id="game-canvas"></canvas>
        <div class="hud">
          <div class="glass hud-tl">
            <div class="t1"><span class="sym">${esc(data.symbol)}</span><span class="ex">${esc(data.exchange || data.name)}</span></div>
            <div class="pr"><span class="price" id="price"></span><span id="pctpill"></span></div>
            <div class="dt" id="date"></div>
            ${simTag(data)}
          </div>
          <div class="glass hud-chart" aria-hidden="true">
            <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
              <defs><clipPath id="ridden"><rect id="clip" x="0" y="0" width="0" height="100"/></clipPath></defs>
              <path d="${mini}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2" vector-effect="non-scaling-stroke"/>
              <path d="${mini}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" clip-path="url(#ridden)"/>
            </svg>
            <div class="mini-dot" id="dot" style="border-color:${color}"></div>
          </div>
          <div class="hud-tr">
            <div class="glass timer-box"><div class="timer" id="timer">00:00.000</div></div>
            <button class="hud-btn" id="pause" aria-label="Pause">❚❚</button>
            <button class="hud-btn" id="quit" aria-label="Quit to menu">✕</button>
          </div>
          <div class="hud-meters">
            <div class="glass meter"><div class="lbl">Speed</div><div class="bar"><div class="fill" id="speed" style="width:0%;background:#16c66a"></div></div></div>
            <div class="glass meter"><div class="lbl">Airtime</div><div class="bar"><div class="fill" id="air" style="width:0%;background:#f8c96b"></div></div></div>
          </div>
          <div class="glass hud-combo"><span class="k">Style</span><span class="v" id="style">0</span><span class="m" id="mult">×1.0</span></div>
          <div class="toasts" id="toasts"></div>
          <div class="pause-veil" id="veil" style="display:none">Paused · P to resume</div>
        </div>
      </div>
      <div class="game-controls">
        <div class="ctl-cluster ctl-dir">
          <button class="ctl-btn" id="c-left" aria-label="Tilt left">◄</button>
          <button class="ctl-btn" id="c-right" aria-label="Tilt right">►</button>
        </div>
        <div class="ctl-cluster ctl-throttle">
          <button class="ctl-btn" id="c-up" aria-label="Speed up">▲</button>
          <button class="ctl-btn" id="c-down" aria-label="Brake">▼</button>
        </div>
      </div>
    </div>`);
  app.replaceChildren(screen);

  const canvas = screen.querySelector<HTMLCanvasElement>("#game-canvas")!;
  const $ = (id: string) => screen.querySelector<HTMLElement>("#" + id)!;
  const game = new Game(canvas);
  game.armed = true; // hold at the start line for the 3·2·1 countdown

  let lastIdx = -1;
  game.start(data, {
    ghost,
    onHud: (s) => {
      $("timer").textContent = fmtTime(s.timeMs);
      $("style").textContent = fmtNum(s.style);
      $("mult").textContent = "×" + s.mult.toFixed(1);
      $("speed").style.width = (s.speed * 100).toFixed(0) + "%";
      $("air").style.width = (s.airtime * 100).toFixed(0) + "%";
      $("veil").style.display = s.paused ? "flex" : "none";
      if (s.index === lastIdx) return;
      lastIdx = s.index;
      const c = closes[s.index];
      const pct = (c.close / closes[0].close - 1) * 100;
      $("price").textContent = fmtPrice(c.close, data.currency);
      $("pctpill").innerHTML = pill(pct);
      $("date").textContent = fmtDate(c.date);
      const fx = s.index / (closes.length - 1);
      $("clip").setAttribute("width", String(fx * 1000));
      $("dot").style.left = fx * 100 + "%";
      $("dot").style.top = mapY(c.close) + "%";
    },
    onTrick: (t) => {
      const host = $("toasts");
      const el = h(`<div class="toast"><span class="nm">${t.name}</span><span class="pt">+${fmtNum(t.points)}</span><span class="mx">×${t.mult.toFixed(1)}</span></div>`);
      host.appendChild(el);
      while (host.children.length > 3) host.firstElementChild!.remove();
      setTimeout(() => { el.style.animation = "toastOut 0.4s forwards"; setTimeout(() => el.remove(), 400); }, 1200);
    },
    onFinish: (r) => { detachTouch?.(); resultsScreen(r, data); },
  });

  $("pause").addEventListener("click", () => game.togglePause());
  $("quit").addEventListener("click", () => { game.destroy(); detachTouch?.(); startScreen(data.symbol); });
  wireTouchControls(screen, game);
  runCountdown(screen, () => { game.armed = false; });
}

// 3·2·1·GO drop-in. The rider is frozen (game.armed) until "GO", which fires
// `onGo` to release it.
function runCountdown(screen: HTMLElement, onGo: () => void) {
  const stage = screen.querySelector(".game-stage") ?? screen;
  const el = h(`<div class="countdown"><span class="cd-num"></span></div>`);
  stage.appendChild(el);
  const num = el.querySelector<HTMLElement>(".cd-num")!;
  const seq = ["3", "2", "1", "GO"];
  let i = 0;
  const show = () => {
    num.textContent = seq[i];
    num.classList.toggle("go", seq[i] === "GO");
    num.classList.remove("pop");
    void num.offsetWidth; // restart the pop animation
    num.classList.add("pop");
    if (seq[i] === "GO") onGo();
    i++;
    if (i < seq.length) setTimeout(show, 750);
    else setTimeout(() => el.remove(), 550);
  };
  show();
}

// On-screen d-pad for touch devices. Each button holds while pressed and feeds
// the same input the keyboard does. Releases are tracked per-pointer at the
// window level, so any number of buttons can be held at once (true multitouch —
// e.g. accelerate + tilt together) and a finger that slides off still releases.
let detachTouch: (() => void) | null = null;
function wireTouchControls(screen: HTMLElement, game: Game) {
  detachTouch?.(); // drop listeners from a previous game before wiring this one
  const held = new Map<number, () => void>(); // pointerId -> release fn
  const bind = (id: string, on: () => void, off: () => void) => {
    const el = screen.querySelector<HTMLElement>("#" + id);
    if (!el) return;
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      el.classList.add("active");
      on();
      held.set(e.pointerId, () => { el.classList.remove("active"); off(); });
    });
  };
  const lift = (e: PointerEvent) => {
    const off = held.get(e.pointerId);
    if (off) { off(); held.delete(e.pointerId); }
  };
  window.addEventListener("pointerup", lift);
  window.addEventListener("pointercancel", lift);
  detachTouch = () => {
    window.removeEventListener("pointerup", lift);
    window.removeEventListener("pointercancel", lift);
    detachTouch = null;
  };
  bind("c-up", () => game.setHold(true), () => game.setHold(false));
  bind("c-down", () => game.setBrake(true), () => game.setBrake(false));
  bind("c-left", () => game.pressRot(-1), () => game.releaseRot(-1));
  bind("c-right", () => game.pressRot(1), () => game.releaseRot(1));
}

// ---------- results ----------
function resultsScreen(r: RunResult, data: SeriesData) {
  const pb = recordRun(r);
  const rc = recap(data.closes);
  const c = data.closes;
  const cur = (n: number) => fmtPrice(n, data.currency);
  const W = 600, H = 200;
  const xOf = (i: number) => (i / (c.length - 1)) * W;
  const ys = c.map((x) => x.close), min = Math.min(...ys), span = Math.max(...ys) - min || 1;
  const yOf = (i: number) => H - 20 - ((c[i].close - min) / span) * (H - 40);
  const color = rc.change >= 0 ? "#16c66a" : "#ef4b3c";
  const [a, b, sk] = SECTOR_SKY[data.sector];
  const pbTag = (on: boolean) => (on ? `<span class="pb">NEW BEST</span>` : "");
  const ch = challenge?.s === data.symbol && challenge.t && r.timeMs ? challenge.t - r.timeMs : null;
  const chLine = ch == null ? "" : `<div class="best-line ${ch >= 0 ? "won" : "lost"}">Challenge ${fmtTime(challenge!.t!)} — ${ch >= 0 ? `you beat it by ${(ch / 1000).toFixed(2)}s!` : `missed by ${(-ch / 1000).toFixed(2)}s. Again?`}</div>`;

  const screen = h(`
    <div class="results">
      <div class="results-main">
        <div class="micro">Run complete · ${esc(data.symbol)}</div>
        <h3>${pb.time ? "New personal best!" : "Nice line."}</h3>
        <div class="stat-grid">
          <div class="stat"><div class="k">Time${pbTag(pb.time)}</div><div class="v">${r.timeMs ? fmtTime(r.timeMs) : "—"}</div></div>
          <div class="stat"><div class="k">Style score${pbTag(pb.style)}</div><div class="v">${fmtNum(r.style)}</div></div>
          <div class="stat"><div class="k">Best trick</div><div class="v name">${r.bestTrick ?? "—"}</div></div>
          <div class="stat"><div class="k">Coins</div><div class="v">${r.coins}</div></div>
        </div>
        ${chLine}
        <div class="best-line">Your best on ${esc(data.symbol)}: <b>${pb.best.timeMs ? fmtTime(pb.best.timeMs) : "—"}</b> · <b>${fmtNum(pb.best.style)}</b> style${pb.best.path.length ? " — race your ghost next run" : ""}</div>
        <div class="results-actions">
          <button class="btn btn-primary" id="retry">Ride again</button>
          <button class="btn btn-ghost" id="new">New company</button>
        </div>
      </div>
      <div class="results-share">
        <div class="recap">
          <div class="recap-top" style="background:linear-gradient(168deg, ${a}, ${b} 60%, ${sk})">
            <div class="recap-name"><b>${esc(data.name)}</b><span>${esc(data.symbol)}${data.exchange ? " · " + esc(data.exchange) : ""}</span></div>
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
              <path d="${chartPath(c, W, H)} L ${W} ${H} L 0 ${H} Z" fill="rgba(255,255,255,0.18)"/>
              <path d="${chartPath(c, W, H)}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
              <circle cx="${xOf(rc.hi)}" cy="${yOf(rc.hi)}" r="6" fill="#fff" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"/>
              <circle cx="${xOf(rc.lo)}" cy="${yOf(rc.lo)}" r="6" fill="#fff" stroke="${color}" stroke-width="3" vector-effect="non-scaling-stroke"/>
            </svg>
          </div>
          <div class="recap-body">
            <div class="recap-head">
              <div><div class="k">${fmtDate(rc.first.date)} → ${fmtDate(rc.last.date)}</div><div class="v">${cur(rc.first.close)} → ${cur(rc.last.close)}</div></div>
              ${pill(rc.change)}
            </div>
            <div class="recap-grid">
              <div><div class="k">6M high</div><div class="v">${cur(c[rc.hi].close)}</div><div class="d">${fmtDate(c[rc.hi].date)}</div></div>
              <div><div class="k">6M low</div><div class="v">${cur(c[rc.lo].close)}</div><div class="d">${fmtDate(c[rc.lo].date)}</div></div>
              <div><div class="k">Best day</div><div class="v up">${fmtPct(rc.ret(rc.up) * 100)}</div><div class="d">${fmtDate(c[rc.up].date)}</div></div>
              <div><div class="k">Worst day</div><div class="v down">${fmtPct(rc.ret(rc.down) * 100)}</div><div class="d">${fmtDate(c[rc.down].date)}</div></div>
            </div>
            ${simTag(data)}
          </div>
        </div>
        <div class="share-actions">
          <button class="btn btn-light" id="share">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9"/></svg>Share run
          </button>
          <button class="btn btn-ghost" id="copy">Copy link</button>
          <button class="btn btn-ghost" id="img">Image</button>
          <button class="btn btn-ghost" id="gif">GIF</button>
        </div>
      </div>
    </div>`);
  app.replaceChildren(screen);

  screen.querySelector("#retry")!.addEventListener("click", () => loadAndPlay(data.symbol));
  screen.querySelector("#new")!.addEventListener("click", () => startScreen(data.symbol));

  // Share: link + text, plus the result card image where the platform takes
  // files (mobile share sheets). The image is pre-rendered now because the
  // share call must happen right inside the click (Safari drops the gesture
  // across slow awaits).
  const link = `${location.origin}/?run=${encodeRun({ s: data.symbol, t: r.timeMs, st: r.style, k: r.bestTrick })}`;
  const text = `I rode ${data.name} (${data.symbol}) on BullRun in ${r.timeMs ? fmtTime(r.timeMs) : "—"} with ${fmtNum(r.style)} style. Can you beat it?`;
  const gif = import("./game/gif");
  let card: File | null = null;
  const cardReady = gif
    .then((m) => m.renderRunImage(data, r.path, r.timeMs, r.style))
    .then((b) => (card = new File([b], `bullrun-${data.symbol}.png`, { type: "image/png" })));
  cardReady.catch(() => {});

  screen.querySelector("#share")!.addEventListener("click", async () => {
    if (navigator.share) {
      const files = card && navigator.canShare?.({ files: [card] }) ? [card] : null;
      try {
        await navigator.share(files ? { title: "BullRun", text: `${text} ${link}`, files } : { title: "BullRun", text, url: link });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return; // user closed the sheet
      }
    }
    copyText(`${text} ${link}`);
  });
  screen.querySelector("#copy")!.addEventListener("click", () => copyText(link));
  screen.querySelector("#img")!.addEventListener("click", async () => {
    try {
      const f = card ?? (await cardReady);
      (await gif).downloadBlob(f, f.name);
    } catch (e: any) { snack(e.message || "Image failed"); }
  });
  screen.querySelector("#gif")!.addEventListener("click", async () => {
    snack("Rendering GIF…");
    try {
      await (await gif).downloadRunGif(data, r.path, r.timeMs);
    } catch (e: any) { snack(e.message || "GIF failed"); }
  });
}

// ---------- how to play ----------
function howToModal() {
  const leg = (icon: string, name: string, desc: string) =>
    `<div class="leg-item"><div class="leg-ic">${icon}</div><div class="leg-txt"><b>${name}</b><span>${desc}</span></div></div>`;

  const icLine = `<svg viewBox="0 0 40 40"><path d="M4 29 L13 19 L21 25 L36 9" fill="none" stroke="#16c66a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icCoin = `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="11" fill="none" stroke="#f6d36b" stroke-width="3"/><text x="20" y="26" text-anchor="middle" font-family="monospace" font-size="16" fill="#f6d36b">$</text></svg>`;
  const icRamp = `<svg viewBox="0 0 40 40"><defs><radialGradient id="htRamp" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#45d488" stop-opacity="0.85"/><stop offset="1" stop-color="#45d488" stop-opacity="0"/></radialGradient></defs><circle cx="20" cy="22" r="16" fill="url(#htRamp)"/><path d="M13 20 L20 14 L27 20 M13 28 L20 22 L27 28" fill="none" stroke="#eafff2" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icCliff = `<svg viewBox="0 0 40 40"><path d="M4 11 L17 11 L17 31 L36 31" fill="none" stroke="#ef4b3c" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const icHiLo = `<svg viewBox="0 0 40 40"><path d="M4 30 L14 12 L24 26 L36 20" fill="none" stroke="#16c66a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="14" cy="12" r="4.5" fill="#fff" stroke="#16c66a" stroke-width="2.5"/></svg>`;
  const icMap = `<svg viewBox="0 0 40 40"><rect x="3" y="9" width="34" height="22" rx="5" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2"/><path d="M8 25 L15 18 L21 22 L32 14" fill="none" stroke="#45d488" stroke-width="2.5" stroke-linecap="round"/><circle cx="21" cy="22" r="3.5" fill="#fff"/></svg>`;
  const icGhost = `<svg viewBox="0 0 40 40"><circle cx="20" cy="14" r="5.5" fill="#9fd9ec" opacity="0.55"/><rect x="13" y="20" width="14" height="14" rx="6" fill="#9fd9ec" opacity="0.4"/></svg>`;

  const veil = h(`<div class="veil howto-veil"></div>`);
  const panel = h(`
    <div class="howto">
      <button class="x" id="hclose" aria-label="Close">✕</button>
      <div class="howto-head">
        <div class="micro">BullRun</div>
        <h3>How to play</h3>
        <p>Pick any company. Its last six months of daily closing prices become a mountain, and you snowboard across it left → right through time. The HUD shows the date and price under your board, so every hill is a real rally and every valley a real sell-off.</p>
      </div>

      <div class="howto-sec">
        <div class="howto-title">Controls</div>
        <div class="howto-controls">
          <div class="kctl"><span class="keys"><kbd>W</kbd><kbd>↑</kbd></span><span>Speed up — tuck &amp; pump down slopes; release on a peak to launch.</span></div>
          <div class="kctl"><span class="keys"><kbd>S</kbd><kbd>↓</kbd></span><span>Brake — dig in and scrub speed.</span></div>
          <div class="kctl"><span class="keys"><kbd>A</kbd><kbd>D</kbd> <kbd>←</kbd><kbd>→</kbd></span><span>Rotate in the air — spin flips, but land square or you wipe out.</span></div>
          <div class="kctl"><span class="keys"><kbd>P</kbd><kbd>Esc</kbd></span><span>Pause.</span></div>
          <div class="kctl"><span class="keys touch">▲ ▼ ◄ ►</span><span>On phones &amp; tablets: the on-screen pad — hold several buttons at once.</span></div>
        </div>
      </div>

      <div class="howto-sec">
        <div class="howto-title">Reading the mountain</div>
        <div class="legend">
          ${leg(icLine, "The mountain", "Six months of real daily closes. Green if the stock is up over the window, red if down.")}
          ${leg(icMap, "Chart map", "The full chart at the top of the screen. The dot is you; the bright part is what you've ridden.")}
          ${leg(icHiLo, "6M high / low", "The highest and lowest close in the window, with the price.")}
          ${leg(icRamp, "Rally ramp", "One of the chart's biggest up-days. Ride over it for a launch into big air.")}
          ${leg(icCliff, "Gap down", "A day the price fell more than 6% — a sheer cliff. Launch it, then land square.")}
          ${leg(icCoin, "Dividend coin", "Grab it for +250 style.")}
          ${leg(icGhost, "Your ghost", "A replay of your fastest run on this company. Race it.")}
        </div>
      </div>

      <div class="howto-sec">
        <div class="howto-title">Scoring</div>
        <p class="howto-note">Tricks — Bull Flip, Short Squeeze, Diamond Hands, Dead Cat Bounce, To The Moon — raise a combo multiplier that resets when you settle or wipe out. Chase your fastest <b>time</b> and highest <b>style</b> per company; bests are saved in this browser.</p>
      </div>

      <button class="btn btn-primary full" id="hgo">Got it — let's ride</button>
    </div>`);
  veil.appendChild(panel);

  const close = () => { veil.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  panel.querySelector("#hclose")!.addEventListener("click", close);
  panel.querySelector("#hgo")!.addEventListener("click", close);
  veil.addEventListener("click", (e) => { if (e.target === veil) close(); });
  document.addEventListener("keydown", esc);
  document.body.appendChild(veil);
}

startScreen();
