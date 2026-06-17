import { api, authClient, type Symbol as Sym } from "./api";
import { Game, type SeriesData, type RunResult, type GhostFrame } from "./game/engine";
import { syntheticCloses, sentiment, sectorFor, nameFor, SECTOR_SKY, type Sector } from "./shared/series";
import { catmullRom, toPath } from "./shared/spline";
import type { Close } from "./shared/series";

const app = document.getElementById("app")!;
let user: { id: string; name: string } | null = null;

// ---------- tiny helpers ----------
const h = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
const fmtTime = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000));
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(3, "0")}`;
};
const fmtNum = (n: number) => n.toLocaleString("en-US");
function snack(msg: string) {
  let host = document.querySelector(".toast-host");
  if (!host) { host = h(`<div class="toast-host"></div>`); document.body.appendChild(host); }
  const s = h(`<div class="snack">${msg}</div>`);
  host.appendChild(s);
  setTimeout(() => s.remove(), 2600);
}

// instant client-side hill preview (exact terrain loads on Ride)
function previewPath(closes: Close[], W = 1280, H = 340): string {
  const ys = closes.map((c) => c.close);
  const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
  const pts = closes.map((c, i) => ({ x: (i / (closes.length - 1)) * W, y: H - 30 - ((c.close - min) / span) * (H - 80) }));
  return toPath(catmullRom(pts, 6));
}

// ---------- boot ----------
async function boot() {
  try {
    const s = await authClient.getSession();
    if (s.data?.user) user = { id: s.data.user.id, name: s.data.user.name };
  } catch {}
  const m = location.pathname.match(/^\/r\/(\w+)/);
  if (m) return replayScreen(m[1]);
  startScreen("daily");
}

// ---------- start / search ----------
async function startScreen(mode: "daily" | "free") {
  const daily = await api.daily().catch(() => null);
  let selected: Sym | null = daily
    ? { symbol: daily.symbol, name: daily.name, sector: daily.sector }
    : { symbol: "VOLT", name: nameFor("VOLT"), sector: sectorFor("VOLT") };

  const screen = h(`
    <div class="screen">
      <div class="start-sky"></div>
      <div class="start-sun"></div>
      <svg class="start-hill" viewBox="0 0 1280 340" preserveAspectRatio="none">
        <defs><linearGradient id="hp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#16c66a" stop-opacity="0.3"/><stop offset="1" stop-color="#16c66a" stop-opacity="0"/>
        </linearGradient></defs>
        <path id="hpfill" fill="url(#hp)"></path>
        <path id="hpline" fill="none" stroke="#16c66a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <div class="nav">
        <div class="logo">BullRun</div>
        <div class="nav-right">
          <div class="toggle" id="mode">
            <span data-m="daily">Daily Challenge</span>
            <span data-m="free">Free Ride</span>
          </div>
          <div id="userslot"></div>
        </div>
      </div>
      <div class="search-wrap">
        <div class="search-kicker">Pick your mountain</div>
        <div style="position:relative">
          <div class="search-row">
            <div class="search-box">
              <svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2"><circle cx="9" cy="9" r="6"></circle><path d="M14 14 L18 18" stroke-linecap="round"></path></svg>
              <input id="q" placeholder="Search ticker" maxlength="8" value="${selected.symbol}" autocomplete="off" />
              <span class="nm" id="selname" style="font-size:15px;color:rgba(255,255,255,0.6)">${selected.name}</span>
              <span class="sector-tag" id="seltag" style="margin-left:auto">${selected.sector}</span>
            </div>
            <button class="btn btn-primary" id="ride" style="font-size:18px;padding:0 32px;border-radius:16px">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="#04140a"><path d="M4 2.5 L13 8 L4 13.5 Z"></path></svg>Ride
            </button>
          </div>
          <div class="ac" id="ac" style="display:none"></div>
        </div>
        <div class="daily-strip" id="dstrip"></div>
      </div>
    </div>`);
  app.replaceChildren(screen);

  // mode toggle
  const setMode = (m: "daily" | "free") => {
    mode = m;
    screen.querySelectorAll<HTMLElement>("#mode span").forEach((s) => s.classList.toggle("on", s.dataset.m === m));
    const ds = screen.querySelector<HTMLElement>("#dstrip")!;
    if (m === "daily" && daily) {
      ds.innerHTML = `<span>Today's challenge · <b>${daily.symbol}</b></span><span style="opacity:0.5">|</span><span>Resets in ${fmtTime(daily.resetsInMs).slice(0, 8)}</span>`;
      screen.querySelector<HTMLInputElement>("#q")!.value = daily.symbol;
      pick({ symbol: daily.symbol, name: daily.name, sector: daily.sector });
    } else {
      ds.innerHTML = `<span>Free Ride · any ticker, any day</span>`;
    }
  };

  renderUser(screen.querySelector("#userslot")!, () => startScreen(mode));

  const sky = screen.querySelector<HTMLElement>(".start-sky")!;
  const refreshPreview = (sec: Sector, closes: Close[]) => {
    const [a, b, c] = SECTOR_SKY[sec];
    sky.style.background = `linear-gradient(172deg, ${a} 0%, ${b} 56%, ${c} 100%)`;
    const W = 1280, H = 340;
    const ys = closes.map((x) => x.close), min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
    const line = previewPath(closes, W, H);
    screen.querySelector("#hpline")!.setAttribute("d", line);
    screen.querySelector("#hpfill")!.setAttribute("d", `${line} L ${W} ${H} L 0 ${H} Z`);
    void min; void span;
  };
  const pick = (s: Sym) => {
    selected = s;
    screen.querySelector<HTMLElement>("#selname")!.textContent = s.name;
    screen.querySelector<HTMLElement>("#seltag")!.textContent = s.sector;
    screen.querySelector<HTMLElement>("#ac")!.style.display = "none";
    refreshPreview(s.sector, syntheticCloses(s.symbol, 130));
  };
  pick(selected);

  // autocomplete
  const q = screen.querySelector<HTMLInputElement>("#q")!;
  const ac = screen.querySelector<HTMLElement>("#ac")!;
  let acItems: Sym[] = [], sel = -1;
  const renderAc = () => {
    if (!acItems.length) { ac.style.display = "none"; return; }
    ac.style.display = "block";
    ac.replaceChildren(
      ...acItems.map((it, i) =>
        h(`<div class="ac-item ${i === sel ? "sel" : ""}"><span class="sym">${it.symbol}</span><span class="nm">${it.name}</span><span class="sector-tag">${it.sector}</span></div>`)
      )
    );
    ac.querySelectorAll(".ac-item").forEach((node, i) => node.addEventListener("click", () => { q.value = acItems[i].symbol; pick(acItems[i]); }));
  };
  q.addEventListener("input", async () => {
    const v = q.value.trim().toUpperCase();
    q.value = v;
    if (!v) { ac.style.display = "none"; return; }
    acItems = await api.search(v).catch(() => []);
    sel = -1; renderAc();
  });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { sel = Math.min(acItems.length - 1, sel + 1); renderAc(); }
    else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); renderAc(); }
    else if (e.key === "Enter") {
      if (sel >= 0) { q.value = acItems[sel].symbol; pick(acItems[sel]); }
      else ride();
    }
  });

  const ride = () => loadAndPlay(selected!.symbol, mode === "daily");
  screen.querySelector("#ride")!.addEventListener("click", ride);
  screen.querySelectorAll<HTMLElement>("#mode span").forEach((s) => s.addEventListener("click", () => setMode(s.dataset.m as any)));
  setMode(mode);
}

function renderUser(slot: Element, refresh: () => void) {
  if (user) {
    const chip = h(`<div class="user-chip"><span class="av"></span>${user.name}</div>`);
    chip.addEventListener("click", async () => { await authClient.signOut(); user = null; refresh(); });
    slot.replaceChildren(chip);
  } else {
    const b = h(`<button class="btn btn-ghost" style="padding:9px 18px;font-size:13.5px;color:#fff">Sign in</button>`);
    b.addEventListener("click", () => signInModal(refresh));
    slot.replaceChildren(b);
  }
}

// ---------- load + play ----------
async function loadAndPlay(symbol: string, isDaily: boolean, replay?: GhostFrame[]) {
  const loading = h(`<div class="screen" style="display:flex;align-items:center;justify-content:center;background:var(--panel)"><div class="micro">Drawing the mountain…</div></div>`);
  app.replaceChildren(loading);
  let data: SeriesData;
  try {
    data = await api.series(symbol);
  } catch {
    const closes = syntheticCloses(symbol, 130);
    data = { symbol, name: nameFor(symbol), sector: sectorFor(symbol), sentiment: sentiment(closes), closes };
  }
  const ghost = replay ? null : (await api.ghost(symbol, "time").catch(() => null))?.path ?? null;
  gameScreen(data, isDaily, ghost, replay);
}

// ---------- game ----------
function gameScreen(data: SeriesData, isDaily: boolean, ghost: GhostFrame[] | null, replay?: GhostFrame[]) {
  const controls = replay ? "" : `
      <div class="game-controls">
        <div class="ctl-cluster ctl-dir">
          <button class="ctl-btn" id="c-left" aria-label="Tilt left">◄</button>
          <button class="ctl-btn" id="c-right" aria-label="Tilt right">►</button>
        </div>
        <div class="ctl-cluster ctl-throttle">
          <button class="ctl-btn" id="c-up" aria-label="Speed up">▲</button>
          <button class="ctl-btn" id="c-down" aria-label="Brake">▼</button>
        </div>
      </div>`;
  const screen = h(`
    <div class="game-screen">
      <div class="game-stage">
        <canvas id="game-canvas"></canvas>
        <div class="hud">
          <div class="glass hud-tl">
            <div class="t1"><span class="sym">${data.symbol}</span><span class="ex">NASDAQ</span></div>
            <div style="display:flex;align-items:baseline;gap:10px;margin-top:4px"><span class="price" id="price">$0.00</span><span id="pctpill"></span></div>
          </div>
          <div class="hud-tr">
            <div class="glass" style="padding:10px 16px;text-align:right"><div class="timer" id="timer">00:00.000</div></div>
            <button class="hud-pause" id="pause">❚❚</button>
          </div>
          <div class="hud-meters">
            <div class="glass meter"><div class="lbl">Speed</div><div class="bar"><div class="fill" id="speed" style="width:0%;background:#16c66a"></div></div></div>
            <div class="glass meter"><div class="lbl">Airtime</div><div class="bar"><div class="fill" id="air" style="width:0%;background:#f8c96b"></div></div></div>
          </div>
          <div class="glass hud-combo"><span class="k">Combo</span><span class="v" id="style">0</span><span class="m" id="mult">×1.0</span></div>
          <div class="toasts" id="toasts"></div>
          <div class="pause-veil" id="veil" style="display:none">Paused · P to resume</div>
        </div>
      </div>
      ${controls}
    </div>`);
  app.replaceChildren(screen);

  const canvas = screen.querySelector<HTMLCanvasElement>("#game-canvas")!;
  const $ = (id: string) => screen.querySelector<HTMLElement>("#" + id)!;
  const game = new Game(canvas);
  game.armed = !replay; // hold at the start line for the 3·2·1 countdown

  game.start(data, {
    ghost,
    replay,
    onHud: (s) => {
      $("price").textContent = "$" + s.price.toFixed(2);
      $("timer").textContent = fmtTime(s.timeMs);
      $("style").textContent = fmtNum(s.style);
      $("mult").textContent = "×" + s.mult.toFixed(1);
      $("speed").style.width = (s.speed * 100).toFixed(0) + "%";
      $("air").style.width = (s.airtime * 100).toFixed(0) + "%";
      $("veil").style.display = s.paused ? "flex" : "none";
      const pill = $("pctpill");
      pill.className = "pill " + (s.up ? "up" : "down");
      pill.textContent = (s.up ? "+" : "") + s.netPct.toFixed(1) + "%";
    },
    onTrick: (t) => {
      const host = $("toasts");
      const el = h(`<div class="toast"><span class="nm">${t.name}</span><span class="pt">+${fmtNum(t.points)}</span><span class="mx">×${t.mult.toFixed(1)}</span></div>`);
      host.appendChild(el);
      while (host.children.length > 3) host.firstElementChild!.remove();
      setTimeout(() => { el.style.animation = "toastOut 0.4s forwards"; setTimeout(() => el.remove(), 400); }, 1200);
    },
    onFinish: (r) => {
      if (replay) return; // read-only replay just stops
      resultsScreen(r, data, isDaily);
    },
  });

  if (replay) {
    const back = h(`<button class="btn btn-ghost" style="position:absolute;top:22px;left:24px;pointer-events:auto;color:#fff">← Back</button>`);
    back.addEventListener("click", () => { game.destroy(); history.pushState({}, "", "/"); startScreen("daily"); });
    screen.querySelector(".hud")!.appendChild(back);
  } else {
    $("pause").addEventListener("click", () => game.togglePause());
    wireTouchControls(screen, game);
    runCountdown(screen, () => { game.armed = false; });
  }
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
  };
  bind("c-up", () => game.setHold(true), () => game.setHold(false));
  bind("c-down", () => game.setBrake(true), () => game.setBrake(false));
  bind("c-left", () => game.pressRot(-1), () => game.releaseRot(-1));
  bind("c-right", () => game.pressRot(1), () => game.releaseRot(1));
}

// ---------- results + share ----------
function resultsScreen(r: RunResult, data: SeriesData, isDaily: boolean) {
  const [a, b, c] = SECTOR_SKY[data.sector];
  const screen = h(`
    <div class="results">
      <div class="results-main">
        <div class="micro">Run complete · ${data.symbol}</div>
        <h3>${r.timeMs ? "Nice line." : "Wiped out."}</h3>
        <div class="stat-grid">
          <div class="stat"><div class="k">Time</div><div class="v">${r.timeMs ? fmtTime(r.timeMs) : "—"}</div></div>
          <div class="stat"><div class="k">Style score</div><div class="v">${fmtNum(r.style)}</div></div>
          <div class="stat"><div class="k">Best trick</div><div class="v name">${r.bestTrick ?? "—"}</div></div>
          <div class="stat"><div class="k">Coins</div><div class="v">${r.coins}</div></div>
        </div>
        <div class="results-actions">
          <button class="btn btn-primary" id="submit">Submit to leaderboard</button>
          <button class="btn btn-ghost" id="retry">Retry</button>
          <button class="btn btn-ghost" id="new">New ticker</button>
          <button class="btn btn-ghost" id="board">Leaderboard</button>
        </div>
      </div>
      <div class="results-share">
        <div class="share-card">
          <div class="share-top" style="background:linear-gradient(168deg, ${a}, ${b} 60%, ${c})">
            <div class="bn">BullRun</div><div class="tk">${data.symbol}</div>
            <svg viewBox="0 0 600 260" preserveAspectRatio="none" width="100%" height="80" style="position:absolute;bottom:0;left:0"><path d="${previewPath(data.closes, 600, 260)}" fill="none" stroke="#16c66a" stroke-width="6" stroke-linecap="round"></path></svg>
          </div>
          <div class="share-bot">
            <div class="row">
              <div><div class="k">Time</div><div class="v">${r.timeMs ? fmtTime(r.timeMs).slice(0, 8) : "—"}</div></div>
              <div style="text-align:right"><div class="k">Style</div><div class="v">${fmtNum(r.style)}</div></div>
            </div>
            <div class="foot"><span style="color:var(--muted)">@${user?.name ?? "guest"}</span><span style="color:var(--up);font-weight:600" id="rank"></span></div>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:22px">
          <button class="btn btn-light" id="share" style="font-size:15px;padding:12px 22px">Share run</button>
          <button class="btn btn-ghost" id="img" style="font-size:15px;padding:12px 20px">Download image</button>
          <button class="btn btn-ghost" id="gif" style="font-size:15px;padding:12px 20px">Download GIF</button>
        </div>
      </div>
    </div>`);
  app.replaceChildren(screen);

  screen.querySelector("#retry")!.addEventListener("click", () => loadAndPlay(data.symbol, isDaily));
  screen.querySelector("#new")!.addEventListener("click", () => startScreen("free"));
  screen.querySelector("#board")!.addEventListener("click", () => leaderboardScreen(data.symbol));
  screen.querySelector("#submit")!.addEventListener("click", async () => {
    if (!user) return signInModal(() => resultsScreen(r, data, isDaily));
    try {
      await api.submit({ ...r, isDaily });
      snack("Posted to the leaderboard.");
      leaderboardScreen(data.symbol);
    } catch (e: any) {
      snack(e.message || "Submit failed");
    }
  });
  screen.querySelector("#share")!.addEventListener("click", async () => {
    try {
      const snap = { ticker: data.symbol, name: data.name, sector: data.sector, closes: data.closes, sentiment: data.sentiment,
        result: { timeMs: r.timeMs, style: r.style, coins: r.coins, bestTrick: r.bestTrick }, path: r.path, by: user?.name ?? "guest" };
      const { url } = await api.share(snap);
      const full = location.origin + url;
      await navigator.clipboard.writeText(full).catch(() => {});
      snack(`${data.name} · ${r.timeMs ? fmtTime(r.timeMs).slice(0, 8) : "DNF"} — link copied: ${full}`);
    } catch (e: any) { snack(e.message || "Share failed"); }
  });
  screen.querySelector("#img")!.addEventListener("click", async () => {
    snack("Rendering image…");
    try {
      const { downloadRunImage } = await import("./game/gif");
      await downloadRunImage(data, r.path, r.timeMs);
      snack("Image downloaded.");
    } catch (e: any) { snack(e.message || "Image failed"); }
  });
  screen.querySelector("#gif")!.addEventListener("click", async () => {
    snack("Rendering GIF…");
    try {
      const { downloadRunGif } = await import("./game/gif");
      await downloadRunGif(data, r.path, r.timeMs);
      snack("GIF downloaded.");
    } catch (e: any) { snack(e.message || "GIF failed"); }
  });
}

// ---------- leaderboard ----------
async function leaderboardScreen(ticker: string, tab: "time" | "style" = "time", view: "daily" | "all" = "daily") {
  const sec = sectorFor(ticker);
  const rows = await api.leaderboard(ticker, tab, view).catch(() => []);
  const screen = h(`
    <div class="lb-screen">
      <div class="lb-veil"></div>
      <div class="lb-panel">
        <div class="lb-head">
          <div style="display:flex;align-items:center;gap:12px"><span class="sym">${ticker}</span><span style="font-size:18px;font-weight:600;color:var(--muted)">Leaderboard</span></div>
          <div class="toggle" id="view">
            <span data-v="daily" class="${view === "daily" ? "on" : ""}">Daily</span>
            <span data-v="all" class="${view === "all" ? "on" : ""}">All-Time</span>
          </div>
        </div>
        <div class="lb-tabs" id="tabs">
          <div class="tab ${tab === "time" ? "on" : ""}" data-t="time">Fastest Time</div>
          <div class="tab ${tab === "style" ? "on" : ""}" data-t="style">Top Style</div>
        </div>
        <div class="lb-rows">
          <div class="lb-rowhead"><span>Rank</span><span>Rider</span><span style="text-align:right">${tab === "time" ? "Time" : "Style"}</span><span style="text-align:right">Date</span></div>
          ${rows.length ? rows.map((r, i) => rowHtml(r, i, tab)).join("") : `<div class="lb-empty">No runs yet — be the first to post a time.</div>`}
        </div>
        <div class="lb-foot">
          <span style="font-size:14px;color:var(--muted)" id="footmsg"></span>
          <div style="display:flex;gap:10px"><button class="btn btn-ghost" id="ride2" style="padding:11px 22px;font-size:14px">Ride ${ticker}</button><span id="footbtn"></span></div>
        </div>
      </div>
    </div>`);
  app.replaceChildren(screen);

  screen.querySelectorAll<HTMLElement>("#tabs .tab").forEach((t) =>
    t.addEventListener("click", () => leaderboardScreen(ticker, t.dataset.t as any, view)));
  screen.querySelectorAll<HTMLElement>("#view span").forEach((v) =>
    v.addEventListener("click", () => leaderboardScreen(ticker, tab, v.dataset.v as any)));
  screen.querySelector("#ride2")!.addEventListener("click", () => loadAndPlay(ticker, false));

  const foot = screen.querySelector<HTMLElement>("#footmsg")!;
  const fbtn = screen.querySelector<HTMLElement>("#footbtn")!;
  if (user) { foot.textContent = "Signed in as " + user.name + "."; }
  else {
    foot.textContent = "Sign in to post your time and unlock ghost replays.";
    const b = h(`<button class="btn btn-primary" style="padding:11px 22px;font-size:14px">Sign in</button>`);
    b.addEventListener("click", () => signInModal(() => leaderboardScreen(ticker, tab, view)));
    fbtn.replaceChildren(b);
  }

  // watch-replay on the #1 ghost
  screen.querySelectorAll<HTMLElement>(".replay-tag").forEach((tag) =>
    tag.addEventListener("click", async () => {
      const g = await api.ghost(ticker, tab).catch(() => null);
      if (g?.path?.length) loadAndPlay(ticker, false, g.path);
      else snack("No ghost recorded yet.");
    }));
}

function rowHtml(r: any, i: number, tab: "time" | "style"): string {
  const val = tab === "time" ? (r.time_ms ? fmtTime(r.time_ms) : "—") : fmtNum(r.style);
  const you = user && r.username === user.name;
  const cls = i === 0 ? "first" : you ? "you" : "";
  const tag = i === 0 ? `<span class="replay-tag">▶ Watch replay</span>` : you ? `<span style="font-family:var(--mono);font-size:10px;color:var(--up);background:rgba(22,198,106,0.18);padding:3px 8px;border-radius:6px">YOU</span>` : "";
  return `<div class="lb-row ${cls}"><span class="rank" ${i === 0 ? 'style="color:var(--gold)"' : ""}>${i + 1}</span><div class="who"><span class="av"></span><span style="font-weight:600">${r.username}</span>${tag}</div><span class="val">${val}</span><span class="date">${r.day === new Date().toISOString().slice(0, 10) ? "today" : r.day}</span></div>`;
}

// ---------- replay (shared run /r/<id>) ----------
async function replayScreen(id: string) {
  const loading = h(`<div class="screen" style="display:flex;align-items:center;justify-content:center;background:var(--panel)"><div class="micro">Loading shared run…</div></div>`);
  app.replaceChildren(loading);
  try {
    const snap = await api.getShare(id);
    const data: SeriesData = { symbol: snap.ticker, name: snap.name ?? nameFor(snap.ticker), sector: snap.sector, sentiment: snap.sentiment, closes: snap.closes };
    gameScreen(data, false, null, snap.path ?? []);
  } catch {
    snack("Run not found.");
    startScreen("daily");
  }
}

// ---------- sign in ----------
function signInModal(onDone: () => void) {
  let signup = false;
  const veil = h(`<div class="veil"></div>`);
  const render = () => {
    const modal = h(`
      <div class="modal">
        <button class="x">✕</button>
        <h4>${signup ? "Create account" : "Save your run"}</h4>
        <p>Sign in to post to the global leaderboard and keep your best times.</p>
        ${signup ? `<input id="name" placeholder="Username" autocomplete="username" />` : ""}
        <input id="email" type="email" placeholder="Email" autocomplete="email" />
        <input id="pass" type="password" placeholder="Password" autocomplete="current-password" />
        <div class="err" id="err"></div>
        <button class="btn btn-primary full" id="go">${signup ? "Create account" : "Continue with email"}</button>
        <button class="btn btn-ghost full" id="google">Continue with Google</button>
        <div class="swap" id="swap">${signup ? "Have an account? Sign in" : "New here? Create an account"}</div>
        <div class="skip" id="skip">Skip — ride as guest</div>
      </div>`);
    veil.replaceChildren(modal);
    const err = modal.querySelector<HTMLElement>("#err")!;
    const val = (id: string) => modal.querySelector<HTMLInputElement>("#" + id)?.value ?? "";
    const close = () => veil.remove();
    modal.querySelector("#x, .x")?.addEventListener("click", close);
    modal.querySelector(".x")!.addEventListener("click", close);
    modal.querySelector("#skip")!.addEventListener("click", close);
    modal.querySelector("#swap")!.addEventListener("click", () => { signup = !signup; render(); });
    modal.querySelector("#google")!.addEventListener("click", () => authClient.signIn.social({ provider: "google", callbackURL: location.href }));
    modal.querySelector("#go")!.addEventListener("click", async () => {
      err.textContent = "";
      try {
        const res = signup
          ? await authClient.signUp.email({ email: val("email"), password: val("pass"), name: val("name") || val("email").split("@")[0] })
          : await authClient.signIn.email({ email: val("email"), password: val("pass") });
        if ((res as any).error) throw new Error((res as any).error.message);
        const s = await authClient.getSession();
        if (s.data?.user) user = { id: s.data.user.id, name: s.data.user.name };
        close();
        onDone();
      } catch (e: any) { err.textContent = e.message || "Auth failed"; }
    });
  };
  render();
  veil.addEventListener("click", (e) => { if (e.target === veil) veil.remove(); });
  document.body.appendChild(veil);
}

window.addEventListener("popstate", () => boot());
boot();
