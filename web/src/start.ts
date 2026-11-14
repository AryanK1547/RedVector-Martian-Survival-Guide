import { createAirlockAudio, type AirlockAudio } from "./audio";
import type { Conditions } from "./conditions";
import { latlonToCell, parseTerrain, type Meta, type Terrain } from "./data";
import { astar } from "./route/astar";
import { FLAT_SPEED_KMH, KCAL_PER_LITRE_O2, METABOLIC_KCAL_PER_H, oxygenLitres } from "./route/assumptions";
import { STRATEGIES, gridFromTerrain } from "./route/cost";
import { moveTimeS } from "./route/noreturn";
import { nearestPassable } from "./route/snap";
import type { Waypoint } from "./waypoints";

// The mission the start screen hands to the EVA tab. The base sits ~300 m from
// the ridge top (the same illustrative offset as the example walk, but the one
// that is actually walkable on this terrain: about 25 L round trip, measured on
// 15 Nov by running A* on web/public/data/local).
export const MISSION = { targetId: "boxwork_ridge_top", baseOffset: [0.0045, -0.0045] as [number, number] };

// SCENARIO PRESETS: demo values for training, NOT NASA data.
export interface Preset {
  id: "training" | "standard" | "crisis";
  name: string;
  blurb: string;
  reserveL: number;
  scienceMin: number;
  calamities: boolean; // two random calamities
  findMode: "off" | "random" | "place";
  role?: Role;
}

// Who the player is. Same simulation engine, two seats.
export type Role = "astronaut" | "capcom";
export const ROLES: Record<Role, { name: string; blurb: string }> = {
  astronaut: { name: "EVA astronaut", blurb: "You are on the surface, in first person. Calamities come without warning. The habitat advises, you decide." },
  capcom: { name: "Mission Control", blurb: "You are CAPCOM in the habitat: overview camera, live telemetry, you can inject calamities to test the crew, and you advise every call." },
};

// Pressures for the depressurisation. The habitat value is an ASSUMPTION
// (Earth sea level, 101.3 kPa); the outside value is MEASURED (Curiosity REMS
// mean on the waypoint sol, from conditions.json).
const HAB_KPA = 101.3;
// Armstrong limit: below about 6.3 kPa water boils at body temperature.
// General physiology knowledge, shown for context.
const ARMSTRONG_KPA = 6.3;

export const PRESETS: Preset[] = [
  { id: "training", name: "Training walk", blurb: "Roomy oxygen and no surprises. Learn the planner and place a find to inspect.", reserveL: 60, scienceMin: 10, calamities: false, findMode: "place" },
  { id: "standard", name: "Standard EVA", blurb: "Two random calamities and a find you place. The margin is real but workable.", reserveL: 45, scienceMin: 10, calamities: true, findMode: "place" },
  { id: "crisis", name: "Crisis drill", blurb: "Tight reserve, two random calamities, and a find in a random place.", reserveL: 40, scienceMin: 8, calamities: true, findMode: "random" },
];

export interface StartDeps {
  waypoints: Waypoint[];
  conditions: Conditions;
  mountTopbar: () => void;
  onCommence: (preset: Preset, role: Role, view: "3d" | "2d") => void;
}

const el = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// ---- the mission package: real files, really fetched ----
interface Item {
  label: string;
  urls: string[];
  detail: string;
}

// Short, simulation-only sounds (synthesised, not recordings). Played only
// after the user clicks, so browsers allow audio.
function sfx(kind: "hiss" | "chime") {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(ctx.destination);
    if (kind === "hiss") {
      const len = Math.floor(ctx.sampleRate * 1.6);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 1800;
      src.connect(hp).connect(out);
      out.gain.setValueAtTime(0.0001, now);
      out.gain.exponentialRampToValueAtTime(0.18, now + 0.25);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      src.start(now);
    } else {
      [660, 990].forEach((f, i) => {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(out);
        out.gain.setValueAtTime(0.0001, now);
        out.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
        out.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        o.start(now + i * 0.12);
        o.stop(now + 0.7 + i * 0.12);
      });
    }
    setTimeout(() => void ctx.close(), 2200);
  } catch {
    /* no audio available: the screen still works */
  }
}

// A schematic horizon drawn from the local DEM (rows of real elevations), not a photo.
function drawHorizon(canvas: HTMLCanvasElement, terrain: Terrain | null, sunX = 0.72) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = (canvas.width = Math.max(200, Math.round((canvas.clientWidth || 600) * dpr)));
  const h = (canvas.height = Math.max(150, Math.round((canvas.clientHeight || 400) * dpr)));
  const g = canvas.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, h * 0.62);
  sky.addColorStop(0, "#7d5a4b");
  sky.addColorStop(0.6, "#c99a79");
  sky.addColorStop(1, "#e6bf97");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const sun = g.createRadialGradient(w * sunX, h * 0.3, 2, w * sunX, h * 0.3, h * 0.22);
  sun.addColorStop(0, "rgba(255,248,225,1)");
  sun.addColorStop(0.18, "rgba(255,230,180,0.85)");
  sun.addColorStop(1, "rgba(255,200,140,0)");
  g.fillStyle = sun;
  g.fillRect(0, 0, w, h);
  const horizonY = h * 0.6;
  let lo = Infinity;
  let hi = -Infinity;
  if (terrain) {
    for (const v of terrain.elevation) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const colours = ["#b98a6a", "#8f6045", "#6d4331", "#4a2c20"];
  for (let k = 0; k < colours.length; k++) {
    const base = horizonY + k * h * 0.045;
    const amp = h * (0.07 + 0.05 * k);
    g.beginPath();
    g.moveTo(0, h);
    const n = Math.min(120, Math.floor(w / 3));
    for (let i = 0; i <= n; i++) {
      let y = base;
      if (terrain && hi > lo) {
        const row = Math.floor(terrain.rows * (0.18 + 0.2 * k));
        const col = Math.min(terrain.cols - 1, Math.floor((i / n) * terrain.cols));
        y = base - ((terrain.elevation[row * terrain.cols + col] - lo) / (hi - lo)) * amp;
      } else y = base - Math.sin(i * 0.2 + k) * amp * 0.2;
      g.lineTo((i / n) * w, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fillStyle = colours[k];
    g.fill();
  }
  const haze = g.createLinearGradient(0, horizonY - h * 0.06, 0, horizonY + h * 0.1);
  haze.addColorStop(0, "rgba(230,190,150,0)");
  haze.addColorStop(0.5, "rgba(230,190,150,0.28)");
  haze.addColorStop(1, "rgba(230,190,150,0)");
  g.fillStyle = haze;
  g.fillRect(0, horizonY - h * 0.06, w, h * 0.16);
}

// Round trip on the real terrain for the mission's base and destination.
function previewMission(terrain: Terrain, wp: Waypoint) {
  const grid = gridFromTerrain(terrain);
  const snap = (lat: number, lon: number) => {
    const rc = latlonToCell(terrain.meta, lat, lon);
    const p = rc ? nearestPassable(terrain, rc.row, rc.col, 12) : null;
    return p ? p.row * terrain.cols + p.col : null;
  };
  const goal = snap(wp.lat, wp.lon);
  const base = snap(wp.lat + MISSION.baseOffset[0], wp.lon + MISSION.baseOffset[1]);
  if (goal === null || base === null) return null;
  const out = astar(grid, STRATEGIES.shortest, base, goal);
  const back = astar(grid, STRATEGIES.shortest, goal, base);
  if (!out || !back) return null;
  const time = (cells: number[]) => cells.slice(1).reduce((s, c, i) => s + moveTimeS(grid, cells[i], c), 0);
  const dist = (cells: number[]) => cells.slice(1).reduce((s, c, i) => s + Math.hypot(((c % terrain.cols) - (cells[i] % terrain.cols)) * grid.dx[Math.floor(c / terrain.cols)], (Math.floor(c / terrain.cols) - Math.floor(cells[i] / terrain.cols)) * grid.dy), 0);
  const outS = time(out.cells);
  const backS = time(back.cells);
  return { outM: dist(out.cells), outS, backS, walkL: oxygenLitres(outS + backS), base, goal };
}

export function showStart(app: HTMLElement, deps: StartDeps): () => void {
  let alive = true;
  let raf = 0;
  const timers: number[] = [];
  const target = deps.waypoints.find((w) => w.id === MISSION.targetId) ?? deps.waypoints[0];
  let selected = PRESETS[1];
  let terrain: Terrain | null = null;
  let preview: ReturnType<typeof previewMission> = null;
  let ready = false;
  let launched = false;
  let powered = false;
  let role: Role = selected.role ?? "astronaut";
  let audio: AirlockAudio | null = null;
  let air: import("./three/airlock").AirlockScene | null = null;
  // Measured outside conditions (Curiosity REMS / RAD on the waypoint sol).
  const solKey = Object.keys(deps.conditions.sols).sort()[0];
  const sol = solKey ? deps.conditions.sols[solKey] : null;
  const outKPa = sol ? sol.rems.pressure_mean_pa / 1000 : null;

  app.textContent = "";
  const root = el(`<section id="start" aria-label="MarsWalk mission start">
      <div class="st-scene">
        <div class="st-door">
          <canvas class="st-outside"></canvas>
          <div class="st-panel left"></div><div class="st-panel right"></div>
          <div class="st-hazard top"></div><div class="st-hazard bottom"></div>
          <div class="st-stencil">HAB-01 // AIRLOCK B</div>
          <div class="st-window"><canvas></canvas></div>
        </div>
        <div class="st-console"><i></i><i></i><i></i><i></i><span class="glove l"></span><span class="glove r"></span></div>
      </div>
      <canvas class="st-dust"></canvas>
      <div class="st-fog"></div><div class="st-visor"></div><div class="st-light"></div>

      <div class="st-title">
        <b>MARSWALK</b><span>EVA MISSION SIMULATOR</span>
        <small>SECTOR: Gale Crater &nbsp;|&nbsp; SOL 001 (simulated) &nbsp;|&nbsp; SUIT MW-04 &nbsp;|&nbsp; AIRLOCK B</small>
      </div>
      <div class="st-uplink">
        <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div><b id="st-link">CONNECTING TO MISSION CONTROL&hellip;</b><small>EARTH LINK &middot; SIMULATED &middot; Earth is roughly 3 to 22 light-minutes away, depending on where the planets are, so live calls during the walk come from the habitat (CAPCOM), not from Earth</small></div>
      </div>

      <div class="st-brief" id="st-brief"></div>
      <div class="st-terminal"><div class="st-term-head">MISSION UPLINK <span id="st-pct">0%</span></div><div id="st-term" class="st-term"></div></div>

      <div class="st-ready" id="st-ready"></div>
      <div class="st-cta">
        <div class="st-role" id="st-role" role="group" aria-label="Your role"></div>
        <div class="st-count" id="st-count">UPLINK COMPLETE IN: --:--</div>
        <div class="st-btns">
          <button class="ghost" id="st-scn">SELECT MISSION SCENARIO</button>
          <button class="primary" id="st-go" disabled>COMMENCE EVA MISSION</button>
        </div>
      </div>
      <div class="st-flash" id="st-flash" hidden></div>
      <div class="st-fact" id="st-fact" hidden></div>
      <div class="st-view" id="st-view" hidden>
        <div class="st-view-card" role="dialog" aria-label="Choose your view">
          <h3>HOW DO YOU WANT TO FLY THIS MISSION?</h3>
          <p>Same mission, same oxygen model, same decisions. Only the view differs.</p>
          <div class="st-view-grid">
            <button class="st-view-opt sim" id="st-view-sim">
              <span class="vo-tag">SIMULATED VIEW</span><b>Walk it in 3D</b>
              <ul><li>Airlock depressurises, the door opens, you walk out on the real terrain</li><li>First-person helmet view, chase and overview cameras</li><li>Synthesised wind, breathing, footsteps and radio voices</li><li>Best with headphones and a decent graphics card</li></ul>
              <span class="vo-go">ENTER THE AIRLOCK &#9654;</span>
            </button>
            <button class="st-view-opt edu" id="st-view-edu">
              <span class="vo-tag">EDUCATIONAL VIEW</span><b>Study it on the map</b>
              <ul><li>Top-down map of the real terrain with route, trail and oxygen reach</li><li>Elevation profile and live numbers next to the map</li><li>Lighter on your computer, quick to start, easy to screenshot</li><li>Every decision and field note works exactly the same</li></ul>
              <span class="vo-go">OPEN THE MAP &#9654;</span>
            </button>
          </div>
          <button class="link" id="st-view-back">&larr; back to the briefing</button>
        </div>
      </div>
      <div class="st-power" id="st-power">
        <div class="st-power-card">
          <div class="st-power-title">SUIT MW-04 &middot; POWER OFF</div>
          <button class="primary" id="st-power-btn">&#9211; POWER UP SUIT</button>
          <small>Puts on your helmet and starts the mission uplink, with sound. Best with headphones.
            All sound is synthesised simulation audio, not recordings from Mars.</small>
          <button class="link" id="st-quiet">continue without sound</button>
        </div>
      </div>
      <p class="st-foot">Simulation. Scenery, suit ID, sol number and cabin readings are cosmetic. Terrain, waypoints and conditions listed in the uplink panel are the real data files, loaded for real; the uplink timing is paced for effect. The airlock room is scenery; the land outside its door is the real terrain. Habitat pressure is assumed (Earth sea level); the outside pressure is Curiosity's REMS measurement. Sounds are synthesised simulation audio.</p>
      <div class="st-modal" id="st-modal" hidden></div>
    </section>`);
  app.append(root);
  deps.mountTopbar();
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  // ---- scenery ----
  const outside = $<HTMLCanvasElement>(".st-outside");
  const windowCanvas = $<HTMLCanvasElement>(".st-window canvas");
  const redraw = () => {
    drawHorizon(outside, terrain, 0.7);
    drawHorizon(windowCanvas, terrain, 0.7);
  };
  redraw();
  const onResize = () => redraw();
  window.addEventListener("resize", onResize);

  // The 3D airlock (Three.js, loaded on demand). If WebGL is missing, the flat door above stays.
  const terrainUrl = "data/local/ctx.png";
  const giveTerrain = () => {
    if (air && terrain && preview) air.setTerrain(terrain, preview.base, preview.goal, terrainUrl);
    if (air && terrain && location.hash === "#airlock-open") air.setPhase("open"); // preview of the view through the door (for checking)
  };
  void import("./three/airlock")
    .then((m) => {
      if (!alive) return;
      air = m.createAirlockScene(root);
      if (!air) return;
      root.classList.add("has3d");
      air.setPressure(HAB_KPA, "HABITAT  (assumed: Earth sea level)");
      air.setPhase(powered ? "on" : "off");
      giveTerrain();
      pushUplink();
    })
    .catch(() => {
      /* no 3D: keep the flat door */
    });

  const dust = $<HTMLCanvasElement>(".st-dust");
  const specks = Array.from({ length: 60 }, () => ({ x: Math.random(), y: Math.random(), vx: 0.004 + Math.random() * 0.01, vy: (Math.random() - 0.5) * 0.004, r: 0.6 + Math.random() * 1.6, a: 0.15 + Math.random() * 0.35 }));
  let lastT = performance.now();
  const loop = (now: number) => {
    if (!alive) return;
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    const w = (dust.width = dust.clientWidth);
    const h = (dust.height = dust.clientHeight);
    const g = dust.getContext("2d")!;
    for (const s of specks) {
      if (!reduced()) {
        s.x = (s.x + s.vx * dt * 6 + 1) % 1;
        s.y = (s.y + s.vy * dt * 6 + 1) % 1;
      }
      g.fillStyle = `rgba(255,236,205,${s.a})`;
      g.beginPath();
      g.arc(s.x * w, s.y * h, s.r, 0, 6.2832);
      g.fill();
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // ---- brief and readiness pills ----
  const briefEl = $("#st-brief");
  const readyEl = $("#st-ready");
  let cabin = "EQUALIZING&hellip;";
  const renderBrief = () => {
    const need = preview ? preview.walkL + oxygenLitres(selected.scienceMin * 60) : null;
    const spare = need !== null ? ((selected.reserveL - need) / selected.reserveL) * 100 : null;
    briefEl.innerHTML = `<div class="tag">MISSION BRIEF &middot; EARTH SCIENCE TEAM <small>(training scenario)</small></div>
      <p><b>Objective:</b> reach <b>${esc(target.name)}</b>, observe for ${selected.scienceMin} min, and return to base.</p>
      <p><b>Also:</b> report anything notable on the way, if the oxygen allows.</p>
      <blockquote>&ldquo;${esc(target.identificationQuote)}&rdquo;<cite>NASA Curiosity team blog &middot; <a href="${esc(target.identificationSource)}" target="_blank" rel="noopener">source</a></cite></blockquote>
      <p class="preview">${
        preview && need !== null && spare !== null
          ? `Preview on the real terrain (shortest route): <b>${Math.round(preview.outM)} m</b> out, walking <b>${Math.round(preview.outS / 60)}</b> + <b>${Math.round(preview.backS / 60)}</b> min. Needs <b>${need.toFixed(1)} L</b> of <b>${selected.reserveL} L</b> (${spare >= 0 ? `${spare.toFixed(0)}% spare` : "<b class='neg'>not enough</b>"}).`
          : "Preview appears when the terrain has loaded."
      }</p>
      <p class="scn">Scenario: <b>${selected.name}</b>. ${selected.blurb}</p>`;
    readyEl.innerHTML = `<div class="pill"><small>O&#8322; RESERVE</small><b>${selected.reserveL} L &middot; 100%</b><em>demo value</em></div>
      <div class="pill"><small>SUIT BATTERY</small><b>not modelled</b><em>no battery data</em></div>
      <div class="pill"><small>CABIN PRESSURE</small><b>${cabin}</b><em>scenery</em></div>`;
  };
  renderBrief();

  // ---- the package, loaded for real, paced for effect ----
  const sols = Object.keys(deps.conditions.sols);
  const items: Item[] = [
    { label: "Local terrain, 10 m cells (USGS DEM from HiRISE)", urls: ["data/local/meta.json", "data/local/elevation.bin", "data/local/slope.bin"], detail: "400 x 400 cells" },
    { label: "Regional terrain, Gale Crater (NASA MOLA, 1.85 km)", urls: ["data/meta.json", "data/elevation.bin", "data/slope.bin"], detail: "256 x 256 cells" },
    { label: `Science stops: ${deps.waypoints.length} rover waypoints (NASA PLACES)`, urls: ["data/waypoints.csv"], detail: "positions + NASA blog quotes" },
    { label: `Curiosity conditions: REMS / RAD, sols ${sols.join(", ")}`, urls: ["data/conditions.json"], detail: "history, not a forecast" },
    { label: "Imagery: CTX photo + THEMIS thermal inertia", urls: ["data/local/ctx.png", "data/local/thermal.png"], detail: "visualization layers" },
  ];
  const PACE_MS = reduced() ? 80 : 700;
  type State = "wait" | "load" | "ok" | "fail";
  const log: { text: string; state?: State }[] = [];
  const state: State[] = items.map(() => "wait");
  const sizes: string[] = items.map(() => "");
  let progress = 0;
  const termEl = $("#st-term");
  const mark = (s: State) => ({ wait: "&nbsp;&nbsp;", load: "&#10227;", ok: "&#10003;", fail: "&#10007;" })[s];
  const renderTerm = () => {
    const pkg = items
      .map((it, i) => `<div class="${state[i]}">${i === items.length - 1 ? "&#9492;&#9472;&#9472;" : "&#9500;&#9472;&#9472;"} [${mark(state[i])}] ${esc(it.label)}${state[i] === "ok" ? ` <em>${sizes[i]}</em>` : state[i] === "wait" ? "" : ""}</div>`)
      .join("");
    termEl.innerHTML = log.slice(0, 2).map((l) => `<div>&gt; ${l.text}</div>`).join("") + (log.length > 2 ? `<div>&gt; RECEIVING MISSION PACKAGE FROM EARTH&hellip; [${Math.round(progress * 100)}%]</div>${pkg}` : "") + log.slice(3).map((l) => `<div class="${l.state ?? ""}">&gt; ${l.text}</div>`).join("");
    $("#st-pct").textContent = `${Math.round(progress * 100)}%`;
    const left = state.filter((s) => s === "wait" || s === "load").length;
    $("#st-count").textContent = ready ? "UPLINK COMPLETE" : state.includes("fail") ? "UPLINK FAILED" : `UPLINK COMPLETE IN: 00:0${Math.min(9, Math.ceil((left * PACE_MS) / 1000))}`;
  };

  const SHORT = ["Local terrain 10 m (USGS/HiRISE)", "Gale Crater terrain (MOLA)", "Rover waypoints (NASA PLACES)", "Curiosity REMS / RAD", "CTX photo + THEMIS"];
  const pushUplink = () => {
    if (!air) return;
    const lines = [powered ? "+LINK: MISSION CONTROL (SIM)" : "SUIT POWER OFF", ...items.map((_, i) => (state[i] === "ok" ? "+" : state[i] === "fail" ? "!" : state[i] === "load" ? "> " : "  ") + SHORT[i])];
    if (ready && sol) lines.push(`OUTSIDE ${Math.round(sol.rems.pressure_mean_pa)} Pa, ${sol.rems.ambient_temp_min_c} to ${sol.rems.ambient_temp_max_c} C`, "+READY FOR EVA");
    air.setUplink(progress * 100, lines);
  };

  const boot = async () => {
    log.push({ text: "INITIALIZING SUIT TELEMETRY&hellip; [OK]" });
    renderTerm();
    await sleep(reduced() ? 0 : 450);
    if (!alive) return;
    log.push({ text: "ESTABLISHING LINK TO MISSION CONTROL (EARTH)&hellip; [CONNECTED, SIMULATED]" });
    $("#st-link").textContent = "CONNECTION ESTABLISHED: MISSION CONTROL (EARTH)";
    root.classList.add("linked");
    renderTerm();
    await sleep(reduced() ? 0 : 450);
    log.push({ text: "" }); // placeholder: the package block renders here
    renderTerm();
    const tick = window.setInterval(renderTerm, 120);
    timers.push(tick);
    let meta: Meta | null = null;
    let elev: ArrayBuffer | null = null;
    let slope: ArrayBuffer | null = null;
    for (let i = 0; i < items.length && alive; i++) {
      state[i] = "load";
      const t0 = performance.now();
      try {
        const bufs = await Promise.all(items[i].urls.map(async (u) => {
          const r = await fetch(u);
          if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
          return r.arrayBuffer();
        }));
        sizes[i] = kb(bufs.reduce((s, b) => s + b.byteLength, 0));
        if (i === 0) {
          meta = JSON.parse(new TextDecoder().decode(bufs[0])) as Meta;
          elev = bufs[1];
          slope = bufs[2];
        }
      } catch (e) {
        state[i] = "fail";
        log.push({ text: `LOAD FAILED: ${esc(String(e))}`, state: "fail" });
        renderTerm();
        window.clearInterval(tick);
        return;
      }
      const wait = PACE_MS - (performance.now() - t0);
      const t1 = performance.now();
      while (alive && performance.now() - t1 < wait) {
        progress = (i + Math.min(1, (performance.now() - t0) / PACE_MS)) / items.length;
        await sleep(40);
      }
      state[i] = "ok";
      progress = (i + 1) / items.length;
      audio?.tick();
      if (i === 0 && meta && elev && slope) {
        try {
          terrain = parseTerrain(meta, elev, slope);
          preview = previewMission(terrain, target);
          redraw();
          giveTerrain();
          renderBrief();
        } catch (e) {
          log.push({ text: `TERRAIN PARSE FAILED: ${esc(String(e))}`, state: "fail" });
        }
      }
      renderTerm();
      pushUplink();
    }
    window.clearInterval(tick);
    if (!alive) return;
    log.push({ text: `MODELS (assumed, not NASA values): walk ${FLAT_SPEED_KMH} km/h &middot; ${METABOLIC_KCAL_PER_H} kcal/h &middot; ${KCAL_PER_LITRE_O2} kcal per litre O&#8322; &middot; return reserve: Dijkstra back from base [OK]` });
    if (sol)
      log.push({
        text: `OUTSIDE NOW (Curiosity, sol ${solKey}, measured): ${Math.round(sol.rems.pressure_mean_pa)} Pa &middot; air ${sol.rems.ambient_temp_min_c} to ${sol.rems.ambient_temp_max_c} &deg;C &middot; radiation ${sol.rad.dose_rate_b_silicon_ugy_per_day} &micro;Gy/day (RAD, silicon)`,
      });
    log.push({ text: "MISSION PACKAGE COMPLETE &mdash; READY FOR EVA", state: "ok" });
    ready = true;
    cabin = "EQUALIZED";
    renderBrief();
    renderTerm();
    $<HTMLButtonElement>("#st-go").disabled = false;
    root.classList.add("ready");
    audio?.ready();
    pushUplink();
  };

  // ---- power up: the click that lets the browser play sound, then the uplink ----
  const powerUp = (withSound: boolean) => {
    if (powered) return;
    powered = true;
    if (withSound) audio = createAirlockAudio();
    audio?.boot();
    $("#st-power").classList.add("gone");
    root.classList.add("powered");
    air?.setPhase("on");
    window.setTimeout(() => ($("#st-power").hidden = true), 900);
    void boot();
  };
  $<HTMLButtonElement>("#st-power-btn").addEventListener("click", () => powerUp(true));
  $<HTMLButtonElement>("#st-quiet").addEventListener("click", () => powerUp(false));

  // ---- role ----
  const roleEl = $("#st-role");
  const renderRole = () => {
    roleEl.innerHTML = `<span>YOUR ROLE</span>${(Object.keys(ROLES) as Role[])
      .map((r) => `<button data-r="${r}" class="${r === role ? "active" : ""}" title="${esc(ROLES[r].blurb)}">${ROLES[r].name}</button>`)
      .join("")}<small>${esc(ROLES[role].blurb)}</small>`;
    roleEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) =>
      b.addEventListener("click", () => {
        role = b.dataset.r as Role;
        renderRole();
      }),
    );
  };
  renderRole();

  // ---- scenario picker ----
  const modal = $("#st-modal");
  const openModal = () => {
    modal.hidden = false;
    modal.innerHTML = `<div class="st-card"><h3>Select mission scenario</h3>
      <p class="note">Scenario settings for training, not NASA data. Oxygen, calamities and the find are set on the EVA tab from these.</p>
      ${PRESETS.map((p) => {
        const need = preview ? preview.walkL + oxygenLitres(p.scienceMin * 60) : null;
        return `<label class="scn ${p.id === selected.id ? "on" : ""}"><input type="radio" name="scn" value="${p.id}" ${p.id === selected.id ? "checked" : ""}>
          <div><b>${p.name}</b><span>${p.blurb}</span>
          <small>${p.reserveL} L reserve &middot; ${p.scienceMin} min observation &middot; ${p.calamities ? "2 random calamities" : "no calamities"} &middot; find: ${p.findMode === "place" ? "you place it" : p.findMode === "random" ? "random" : "none"}${need !== null ? ` &middot; plan needs ${need.toFixed(1)} L (${(((p.reserveL - need) / p.reserveL) * 100).toFixed(0)}% spare)` : ""}</small></div></label>`;
      }).join("")}
      <div class="st-btns"><button class="primary" id="st-scn-ok">Use this scenario</button></div></div>`;
    modal.querySelectorAll<HTMLInputElement>("input[name=scn]").forEach((r) =>
      r.addEventListener("change", () => {
        selected = PRESETS.find((p) => p.id === r.value)!;
        modal.querySelectorAll(".scn").forEach((l) => l.classList.toggle("on", l.contains(r) && r.checked));
      }),
    );
    modal.querySelector<HTMLButtonElement>("#st-scn-ok")!.addEventListener("click", () => {
      modal.hidden = true;
      renderBrief();
    });
  };
  $<HTMLButtonElement>("#st-scn").addEventListener("click", openModal);

  // ---- commence: first choose the view, then fly it ----
  const commence = (view: "3d" | "2d") => {
    if (!ready || launched) return;
    launched = true;
    $("#st-view").hidden = true;
    if (view === "2d") {
      // Educational view: no airlock show, straight to the map with the mission loaded.
      const flash = $("#st-flash");
      flash.hidden = false;
      flash.textContent = "OPENING THE EDUCATIONAL VIEW";
      root.classList.add("launching");
      audio?.ready();
      timers.push(window.setTimeout(() => {
        audio?.dispose();
        deps.onCommence(selected, role, "2d");
      }, reduced() ? 0 : 900));
      return;
    }
    const flash = $("#st-flash");
    const fact = $("#st-fact");
    flash.hidden = false;
    flash.textContent = "DATA UPLOAD COMPLETE — AIRLOCK DEPRESSURIZING";
    root.classList.add("launching");
    const go = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, reduced() ? Math.min(ms, 300) : ms));
    if (!air) {
      // flat fallback: the CSS door
      if (audio) audio.depressurize(1.6);
      else sfx("hiss");
      go(1300, () => root.classList.add("opening"));
      go(3000, () => {
        audio?.linger();
        deps.onCommence(selected, role, "3d");
      });
      return;
    }
    const DEP_S = reduced() ? 0.3 : 4.6;
    const target = outKPa ?? 0.7;
    audio?.depressurize(DEP_S);
    air.setPhase("depress");
    const t0 = performance.now();
    const step = () => {
      if (!alive || !air) return;
      const k = Math.min(1, (performance.now() - t0) / (DEP_S * 1000));
      // pressure falls roughly exponentially as the pumps work
      const kPa = target + (HAB_KPA - target) * (Math.exp(-5 * k) - Math.exp(-5) * k);
      air.setPressure(
        Math.max(target, kPa),
        kPa > ARMSTRONG_KPA ? `TARGET: OUTSIDE ${(target * 1000).toFixed(0)} Pa (REMS, sol ${solKey ?? "?"})` : `BELOW ${ARMSTRONG_KPA} kPa: SUIT ONLY. OUTSIDE = MARS`,
      );
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    if (outKPa !== null) {
      go(DEP_S * 450, () => {
        fact.hidden = false;
        fact.innerHTML = `<b>Outside: ${Math.round(outKPa * 1000)} Pa</b>, about ${((outKPa / HAB_KPA) * 100).toFixed(1)}% of Earth&rsquo;s sea-level air pressure (Curiosity REMS, sol ${solKey}).
          Below ${ARMSTRONG_KPA} kPa (the Armstrong limit) water boils at body temperature, so out there the suit is the only thing keeping you alive.`;
      });
    }
    go(DEP_S * 1000, () => {
      flash.textContent = "EQUALIZED — DOOR OPENING";
      air?.setPhase("open");
      audio?.doorOpen();
    });
    go(DEP_S * 1000 + 2200, () => {
      flash.hidden = true;
      fact.hidden = true;
      air?.setPhase("exit");
    });
    go(DEP_S * 1000 + 3600, () => root.classList.add("opening"));
    go(DEP_S * 1000 + 5000, () => {
      audio?.linger();
      deps.onCommence(selected, role, "3d");
    });
  };
  $<HTMLButtonElement>("#st-go").addEventListener("click", () => {
    if (!ready || launched) return;
    $("#st-view").hidden = false;
    $<HTMLButtonElement>("#st-view-sim").focus();
  });
  $<HTMLButtonElement>("#st-view-sim").addEventListener("click", () => commence("3d"));
  $<HTMLButtonElement>("#st-view-edu").addEventListener("click", () => commence("2d"));
  $<HTMLButtonElement>("#st-view-back").addEventListener("click", () => ($("#st-view").hidden = true));

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)));
    window.removeEventListener("resize", onResize);
    air?.dispose();
    if (!launched) audio?.dispose(); // after launch the outside wind lingers into the walk
  };
}
