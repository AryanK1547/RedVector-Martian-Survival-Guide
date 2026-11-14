import type { GeoJSONSource, ImageSource, Map as MapLibreMap } from "maplibre-gl";
import type { Terrain } from "../data";
import { STRATEGIES, gridFromTerrain, type StrategyName } from "../route/cost";
import { CAUTION_FRACTION } from "../route/replay";
import { CALAMITIES, SCENARIO, Sim, type CalamityKind, type OptionPlan } from "./engine";

type LonLat = [number, number];

export interface SimSetup {
  map: MapLibreMap;
  terrain: Terrain;
  base: number;
  goal: number;
  cells: number[];
  strategy: StrategyName;
  reserveL: number;
  scienceS: number;
  randomCount: number;
  seed: number;
  lonLat: (idx: number) => LonLat;
  panel: HTMLElement; // mission control card
  hud: HTMLElement; // astronaut suit display
  fx: HTMLElement; // full-screen effects layer (dust)
  app: HTMLElement;
  onExit: () => void;
  onRestart: (seed: number) => void;
}

const DECISION_SECONDS = 15; // real seconds before the astronaut follows the recommendation
const SPEEDS = [30, 60, 120];

const clock = (s: number) => {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const litres = (l: number) => (Number.isFinite(l) ? `${l.toFixed(1)} L` : "--");
const PHASE = { outbound: "Walking out", science: "Science work", inbound: "Returning", returned: "Back at base", lost: "EVA failed" } as const;
const empty = { type: "FeatureCollection", features: [] } as never;

export function startSim(s: SimSetup): () => void {
  const { map, terrain } = s;
  const sim = new Sim(
    { grid: gridFromTerrain(terrain), base: s.base, goal: s.goal, outPath: s.cells, reserveL: s.reserveL, strategy: STRATEGIES[s.strategy], scienceS: s.scienceS },
    s.seed,
  );
  if (s.randomCount > 0) sim.scheduleRandom(s.randomCount);
  const plannedScienceS = s.scienceS;

  // ---- map layers ----
  const c = terrain.meta.crop;
  const hazardCanvas = document.createElement("canvas");
  hazardCanvas.width = terrain.cols;
  hazardCanvas.height = terrain.rows;
  map.addSource("sim-hazard", {
    type: "image",
    url: hazardCanvas.toDataURL(),
    coordinates: [[c.lon_left, c.lat_top], [c.lon_right, c.lat_top], [c.lon_right, c.lat_bottom], [c.lon_left, c.lat_bottom]],
  });
  map.addLayer({ id: "sim-hazard", type: "raster", source: "sim-hazard", paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } });
  for (const id of ["sim-options", "sim-ahead", "sim-trail"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({
    id: "sim-options", type: "line", source: "sim-options",
    paint: { "line-color": ["match", ["get", "id"], "continue", "#ffd23f", "#39c6ff"], "line-width": 4, "line-dasharray": [1.5, 1.2], "line-opacity": 0.9 },
  });
  map.addLayer({ id: "sim-ahead", type: "line", source: "sim-ahead", paint: { "line-color": "#ffe27a", "line-width": 3, "line-opacity": 0.85 }, layout: { "line-join": "round", "line-cap": "round" } });
  map.addLayer({ id: "sim-trail", type: "line", source: "sim-trail", paint: { "line-color": "#ffffff", "line-width": 3, "line-opacity": 0.9 }, layout: { "line-join": "round", "line-cap": "round" } });
  for (const id of ["route-line", "route-glow", "points"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  if (map.getLayer("astronaut")) map.moveLayer("astronaut");
  map.easeTo({ center: s.lonLat(s.base), zoom: Math.max(map.getZoom(), 16.3), duration: 1200 });

  let blockedCount = 0;
  const drawHazard = () => {
    const n = sim.blocked.reduce((a, b) => a + b, 0);
    if (n === blockedCount) return;
    blockedCount = n;
    const ctx = hazardCanvas.getContext("2d")!;
    const img = ctx.createImageData(terrain.cols, terrain.rows);
    sim.blocked.forEach((b, i) => b && img.data.set([255, 60, 40, 175], i * 4));
    ctx.putImageData(img, 0, 0);
    (map.getSource("sim-hazard") as ImageSource).updateImage({ url: hazardCanvas.toDataURL() });
  };
  const line = (cells: LonLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cells } }) as never;

  // ---- mission control panel ----
  let speed = 60;
  let paused = false;
  let follow = true;
  s.panel.innerHTML = `
    <div class="mc-head"><span class="live"></span>MISSION CONTROL<span class="met" id="mc-met">T+0:00:00</span></div>
    <div class="mc-controls">
      <button class="ghost sm" id="mc-pause">Pause</button>
      <div class="seg" id="mc-speed">${SPEEDS.map((v) => `<button data-v="${v}" class="${v === speed ? "active" : ""}">${v}x</button>`).join("")}</div>
      <label class="check"><input type="checkbox" id="mc-follow" checked> Follow</label>
    </div>
    <div id="mc-decision"></div>
    <h3>Inject a calamity</h3>
    <div class="mc-inject">${(Object.keys(CALAMITIES) as CalamityKind[]).map((k) => `<button class="ghost" data-k="${k}" title="${CALAMITIES[k].detail}"><span>${CALAMITIES[k].icon}</span>${CALAMITIES[k].label}</button>`).join("")}</div>
    <p class="note">${s.randomCount > 0 ? `${s.randomCount} random calamities scheduled (seed ${s.seed}); timing hidden.` : "No random calamities; inject them by hand."}
      Calamity strengths are scenario settings for training, not NASA data.</p>
    <h3>Mission log</h3>
    <ol class="mc-log" id="mc-log"></ol>
    <button class="ghost" id="mc-exit">Exit simulation</button>`;
  const $ = <T extends HTMLElement>(sel: string) => s.panel.querySelector<T>(sel)!;
  const pauseBtn = $<HTMLButtonElement>("#mc-pause");
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });
  s.panel.querySelectorAll<HTMLButtonElement>("#mc-speed button").forEach((b) =>
    b.addEventListener("click", () => {
      speed = Number(b.dataset.v);
      s.panel.querySelectorAll("#mc-speed button").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  $<HTMLInputElement>("#mc-follow").addEventListener("change", (e) => (follow = (e.target as HTMLInputElement).checked));
  $<HTMLButtonElement>("#mc-exit").addEventListener("click", () => s.onExit());
  s.panel.querySelectorAll<HTMLButtonElement>(".mc-inject button").forEach((b) =>
    b.addEventListener("click", () => {
      if (sim.done || decision) return;
      const kind = b.dataset.k as CalamityKind;
      sim.apply(kind);
      onCalamity(kind);
    }),
  );

  // ---- decisions ----
  let decision: { kind: CalamityKind; opts: OptionPlan[]; rec: OptionPlan["id"]; until: number } | null = null;
  const decisionEl = $("#mc-decision");

  const onCalamity = (kind: CalamityKind) => {
    const opts = sim.options();
    const rec = sim.recommend(opts);
    // Already heading home with one way to go: the suit replans without a pause.
    if (opts.length === 1) {
      sim.choose("return", "Suit computer (only option)");
      return;
    }
    decision = { kind, opts, rec, until: performance.now() + DECISION_SECONDS * 1000 };
    (map.getSource("sim-options") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: opts.filter((o) => o.path.length > 1).map((o) => ({ type: "Feature", properties: { id: o.id }, geometry: { type: "LineString", coordinates: o.path.map(s.lonLat) } })),
    } as never);
    const info = CALAMITIES[kind];
    decisionEl.innerHTML = `<div class="decision">
        <div class="dec-title"><span>${info.icon}</span>${info.label.toUpperCase()}<small>T+${clock(sim.t)}</small></div>
        <p>${sim.log[sim.log.length - 1].text}</p>
        ${opts.map((o) => `<div class="opt ${o.feasible ? "ok" : "bad"} ${o.id === rec ? "rec" : ""}">
            <div class="opt-head"><b>${o.label}</b>${o.id === rec ? `<span class="badge">RECOMMENDED</span>` : ""}</div>
            <div class="opt-grid">
              <span>needs <b>${litres(o.needL)}</b> of ${litres(sim.o2LeftL)} left</span>
              <span>spare at base <b class="${o.spareL < 0 ? "neg" : ""}">${litres(o.spareL)}</b></span>
              <span>home at <b>T+${clock(o.arriveS)}</b>${sim.deadlineS !== null ? ` (deadline T+${clock(sim.deadlineS)})` : ""}</span>
              <span>${o.note}</span>
            </div>
            <div class="opt-foot"><em>${o.feasible ? "Survivable" : "NOT survivable"}</em><button class="${o.id === rec ? "primary" : "ghost"} sm" data-id="${o.id}">Choose</button></div>
          </div>`).join("")}
        <div class="countdown"><i id="mc-count"></i><span id="mc-count-text"></span></div>
      </div>`;
    decisionEl.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => decide(b.dataset.id as OptionPlan["id"], "Mission control")),
    );
  };

  const decide = (id: OptionPlan["id"], by: string) => {
    sim.choose(id, by);
    decision = null;
    decisionEl.innerHTML = "";
    (map.getSource("sim-options") as GeoJSONSource).setData(empty);
  };

  // ---- rendering ----
  let logLen = -1;
  let lastHud = 0;
  let lastLine = 0;
  let lastHome = 0;
  let home: OptionPlan | undefined;
  let ended = false;
  const logEl = $("#mc-log");
  const metEl = $("#mc-met");

  const renderLog = () => {
    if (sim.log.length === logLen) return;
    logLen = sim.log.length;
    logEl.innerHTML = sim.log.slice().reverse().map((e) => `<li class="${e.kind}"><time>T+${clock(e.t)}</time>${e.text}</li>`).join("");
  };

  const renderHud = () => {
    const left = sim.o2LeftL;
    const needHome = home ? home.needL : NaN;
    const margin = left - needHome;
    const caution = s.reserveL * (1 - CAUTION_FRACTION);
    const level = sim.phase === "lost" || margin < 0 ? "turn-back" : margin < caution ? "caution" : "ok";
    const chips = [...sim.active].map((k) => `<span class="chip">${CALAMITIES[k].icon} ${CALAMITIES[k].label}</span>`).join("");
    const extra =
      sim.deadlineS !== null && !sim.done
        ? `<div><b>${clock(sim.deadlineS - sim.t)}</b><small>to radiation deadline</small></div>`
        : sim.phase === "science"
          ? `<div><b>${clock(sim.scienceLeftS)}</b><small>science left</small></div>`
          : `<div><b>x${sim.speedFactor.toFixed(1)}</b><small>walking speed</small></div>`;
    s.hud.className = `hud suit ${level}${sim.active.has("leak") ? " leak" : ""}`;
    s.hud.innerHTML = `
      <div class="hud-row"><span>ASTRONAUT &middot; SUIT DISPLAY</span><span>MET ${clock(sim.t)} &middot; ${PHASE[sim.phase]}</span></div>
      <div class="hud-grid">
        <div><b class="o2">${litres(left)}</b><small>O<sub>2</sub> left</small></div>
        <div><b>${litres(needHome)}</b><small>O<sub>2</sub> to get home</small></div>
        <div><b class="${margin < 0 ? "neg" : ""}">${litres(margin)}</b><small>margin</small></div>
        <div><b>${home && Number.isFinite(home.walkS) ? clock(home.walkS) : "--"}</b><small>walk home</small></div>
        ${extra}
      </div>
      <div class="o2bar"><i style="width:${((100 * left) / s.reserveL).toFixed(1)}%"></i><em style="left:${Math.min(100, (100 * (Number.isFinite(needHome) ? needHome : 0)) / s.reserveL).toFixed(1)}%"></em></div>
      <div class="hud-alerts">${chips}${
        level === "turn-back" && !sim.done ? `<div class="turn-back">CANNOT REACH BASE ON REMAINING OXYGEN</div>` : level === "caution" && !sim.done ? `<div class="caution">Oxygen margin low</div>` : ""
      }</div>`;
  };

  const renderEnd = () => {
    const outcome =
      sim.phase === "lost"
        ? { cls: "no-go", title: "EVA FAILED" }
        : sim.scienceDoneS >= plannedScienceS - 1
          ? { cls: "go", title: "MISSION SUCCESS" }
          : { cls: "caution", title: sim.scienceDoneS > 0 ? "RETURNED SAFELY, SCIENCE CUT SHORT" : "ABORTED, RETURNED SAFELY" };
    const events = sim.log.filter((e) => e.kind === "event").length;
    const decisions = sim.log.filter((e) => e.kind === "decision").length;
    decisionEl.innerHTML = `<div class="verdict ${outcome.cls}"><span>${outcome.title}</span></div>
      <div class="kpis">
        <div><b>${clock(sim.t)}</b><small>EVA duration</small></div>
        <div><b>${litres(sim.o2LeftL)}</b><small>O<sub>2</sub> left</small></div>
        <div><b>${Math.floor(sim.scienceDoneS / 60)} / ${Math.floor(plannedScienceS / 60)} min</b><small>science done</small></div>
        <div><b>${events}</b><small>calamities</small></div>
        <div><b>${decisions}</b><small>decisions</small></div>
        <div><b>${s.seed}</b><small>seed</small></div>
      </div>
      <div class="mc-controls"><button class="primary sm" id="mc-again">Run again (same seed)</button><button class="ghost sm" id="mc-new">New random seed</button></div>`;
    $<HTMLButtonElement>("#mc-again").addEventListener("click", () => s.onRestart(s.seed));
    $<HTMLButtonElement>("#mc-new").addEventListener("click", () => s.onRestart(Math.floor(Math.random() * 1e6)));
  };

  let raf = 0;
  let last = performance.now();
  s.hud.hidden = false;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!paused && !decision && !sim.done) {
      const kind = sim.advance(dt * speed);
      if (kind) onCalamity(kind);
    }
    if (decision) {
      const leftMs = decision.until - now;
      const bar = s.panel.querySelector<HTMLElement>("#mc-count");
      const txt = s.panel.querySelector<HTMLElement>("#mc-count-text");
      if (bar) bar.style.width = `${Math.max(0, (100 * leftMs) / (DECISION_SECONDS * 1000))}%`;
      if (txt) txt.textContent = `No call? The astronaut follows the recommendation in ${Math.ceil(Math.max(0, leftMs) / 1000)} s`;
      if (leftMs <= 0 && !paused) decide(decision.rec, "No call from mission control; astronaut followed the suit computer");
    }

    const p = sim.position();
    const a = s.lonLat(p.from);
    const b = s.lonLat(p.to);
    const pos: LonLat = [a[0] + (b[0] - a[0]) * p.frac, a[1] + (b[1] - a[1]) * p.frac];
    (map.getSource("astronaut") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pos } } as never);
    if (follow && !sim.done) map.setCenter(pos);

    if (now - lastLine > 120) {
      lastLine = now;
      (map.getSource("sim-trail") as GeoJSONSource).setData(line([...sim.trail.map(s.lonLat), pos]));
      const ahead = sim.phase === "outbound" || sim.phase === "inbound" ? [pos, ...sim.path.slice(sim.idx + 1).map(s.lonLat)] : [];
      (map.getSource("sim-ahead") as GeoJSONSource).setData(ahead.length > 1 ? line(ahead) : empty);
      drawHazard();
    }
    if (now - lastHome > 1000 && !sim.done) {
      lastHome = now;
      home = sim.options().find((o) => o.id === "return");
    }
    if (now - lastHud > 150) {
      lastHud = now;
      metEl.textContent = `T+${clock(sim.t)}`;
      renderHud();
      renderLog();
      s.fx.classList.toggle("on", sim.active.has("dust") && !sim.done);
      s.app.classList.toggle("fx-spe", sim.deadlineS !== null && !sim.done);
    }
    if (sim.done && !ended) {
      ended = true;
      home = undefined;
      renderHud();
      renderLog();
      renderEnd();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    for (const id of ["sim-trail", "sim-ahead", "sim-options", "sim-hazard"]) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    for (const id of ["route-line", "route-glow", "points"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
    (map.getSource("astronaut") as GeoJSONSource | undefined)?.setData(empty);
    s.hud.hidden = true;
    s.fx.classList.remove("on");
    s.app.classList.remove("fx-spe");
  };
}

export { SCENARIO };
