import type { GeoJSONSource, ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { latlonToCell, type Terrain } from "../data";
import { nearestPassable } from "../route/snap";
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
  findMode: "off" | "random" | "place"; // one unplanned find: none, at a random place, or placed by mission control
  objective: { name: string; quote?: string; sourceUrl?: string }; // the mission brief from Earth
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
const FIND_SECONDS = 60; // planning an inspection takes longer than reacting to a calamity
const SPEEDS = [30, 60, 120];
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clock = (s: number) => {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const litres = (l: number) => (Number.isFinite(l) ? `${l.toFixed(1)} L` : "--");
const PHASE = {
  outbound: "Walking out",
  detour: "Detour to the find",
  inspect: "Inspecting the find",
  science: "Science work",
  inbound: "Returning",
  returned: "Back at base",
  lost: "EVA failed",
} as const;
const empty = { type: "FeatureCollection", features: [] } as never;

export function startSim(s: SimSetup): () => void {
  const { map, terrain } = s;
  const sim = new Sim(
    { grid: gridFromTerrain(terrain), base: s.base, goal: s.goal, outPath: s.cells, reserveL: s.reserveL, strategy: STRATEGIES[s.strategy], scienceS: s.scienceS },
    s.seed,
  );
  if (s.randomCount > 0) sim.scheduleRandom(s.randomCount);
  if (s.findMode === "random") sim.scheduleFind();
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
  for (const id of ["sim-options", "sim-ahead", "sim-trail", "sim-poi"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({
    id: "sim-options", type: "line", source: "sim-options",
    paint: {
      "line-color": ["match", ["get", "id"], "continue", "#ffd23f", "inspect", "#3ddc84", "inspect-return", "#b388ff", "#39c6ff"],
      "line-width": 4, "line-dasharray": [1.5, 1.2], "line-opacity": 0.9,
    },
  });
  const poiColor = ["match", ["get", "state"], "done", "#3ddc84", "skipped", "#8b93a0", "armed", "#b388ff", "#ffd23f"] as never;
  map.addLayer({ id: "sim-poi-halo", type: "circle", source: "sim-poi", paint: { "circle-radius": 17, "circle-color": poiColor, "circle-opacity": 0.22 } });
  map.addLayer({ id: "sim-poi", type: "circle", source: "sim-poi", paint: { "circle-radius": 7, "circle-color": poiColor, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
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
  let paused = true; // held on the mission brief until the user presses Begin
  let began = false;
  let follow = true;
  const plan0 = sim.options().find((o) => o.id === "continue");
  const planLine = plan0
    ? `Plan: ${Math.round(plan0.walkS / 60)} min of walking out and back, ${Math.floor(s.scienceS / 60)} min of observation. Needs <b>${litres(plan0.needL)}</b> of the <b>${litres(s.reserveL)}</b> reserve, leaving <b>${litres(plan0.spareL)}</b> spare.`
    : "";
  s.panel.innerHTML = `
    <div class="mc-head"><span class="live"></span>MISSION CONTROL<span class="met" id="mc-met">T+0:00:00</span></div>
    <div class="brief" id="mc-brief">
      <div class="brief-tag">MISSION BRIEF &middot; EARTH SCIENCE TEAM <small>(training scenario)</small></div>
      <p><b>Objective:</b> reach <b>${esc(s.objective.name)}</b>, observe for ${Math.floor(s.scienceS / 60)} min, and return to base.</p>
      <p><b>Also:</b> report anything notable on the way, but only if the oxygen allows it.</p>
      ${s.objective.quote ? `<blockquote>&ldquo;${esc(s.objective.quote)}&rdquo;<cite>NASA Curiosity team blog${s.objective.sourceUrl ? ` &middot; <a href="${esc(s.objective.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ""}</cite></blockquote>` : ""}
      <p class="note">${planLine}</p>
      <button class="primary wide" id="mc-begin">Begin EVA &#9654;</button>
    </div>
    <ul class="objectives" id="mc-obj"></ul>
    ${s.findMode === "place" ? `<div class="place"><button class="ghost wide" id="mc-place">&#9678; Place the find on the map</button><p class="note" id="mc-place-msg">Click the button, then click the map. The astronaut notices it once within ${SCENARIO.findRevealM} m of it (violet dot = placed, not yet noticed). You can move it until then. Scenario target, not a real Mars observation.</p></div>` : ""}
    <div class="mc-controls">
      <button class="ghost sm" id="mc-pause">Resume</button>
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
  $<HTMLButtonElement>("#mc-begin").addEventListener("click", () => {
    began = true;
    paused = false;
    pauseBtn.textContent = "Pause";
    $("#mc-brief").classList.add("started");
    $<HTMLButtonElement>("#mc-begin").hidden = true;
  });
  // ---- placing the find by hand ----
  let placing = false;
  const placeBtn = s.panel.querySelector<HTMLButtonElement>("#mc-place");
  const placeMsg = s.panel.querySelector<HTMLElement>("#mc-place-msg");
  const onMapClick = (e: { lngLat: { lng: number; lat: number } }) => {
    if (!placing) return;
    placing = false;
    map.getCanvas().style.cursor = "";
    placeBtn?.classList.remove("active");
    const rc = latlonToCell(terrain.meta, e.lngLat.lat, e.lngLat.lng);
    if (!rc) {
      if (placeMsg) placeMsg.textContent = "That point is outside the map.";
      return;
    }
    const snap = nearestPassable(terrain, rc.row, rc.col, 6);
    if (!snap) {
      if (placeMsg) placeMsg.textContent = "No walkable ground within 60 m of that point.";
      return;
    }
    const err = sim.armFind(snap.row * terrain.cols + snap.col);
    if (placeMsg) {
      placeMsg.textContent = err
        ? err
        : `Find placed ${Math.round(sim.armed!.offsetM)} m off the route${snap.distM > 1 ? ` (moved ${Math.round(snap.distM)} m to walkable ground)` : ""}. It is noticed within ${SCENARIO.findRevealM} m. Click the button again to move it.`;
    }
  };
  map.on("click", onMapClick);
  placeBtn?.addEventListener("click", () => {
    placing = !placing;
    map.getCanvas().style.cursor = placing ? "crosshair" : "";
    placeBtn.classList.toggle("active", placing);
    if (placing && placeMsg) placeMsg.textContent = "Click the map where the find should be.";
  });
  $<HTMLInputElement>("#mc-follow").addEventListener("change", (e) => (follow = (e.target as HTMLInputElement).checked));
  $<HTMLButtonElement>("#mc-exit").addEventListener("click", () => s.onExit());
  s.panel.querySelectorAll<HTMLButtonElement>(".mc-inject button").forEach((b) =>
    b.addEventListener("click", () => {
      if (sim.done || decision || findPlan || !began) return;
      const kind = b.dataset.k as CalamityKind;
      sim.apply(kind);
      onCalamity(kind);
    }),
  );

  // ---- decisions ----
  let decision: { kind: CalamityKind; opts: OptionPlan[]; rec: OptionPlan["id"]; until: number } | null = null;
  const decisionEl = $("#mc-decision");

  const lineFeatures = (opts: OptionPlan[]) =>
    ({
      type: "FeatureCollection",
      features: opts
        .filter((o) => (o.fullPath ?? o.path).length > 1)
        .map((o) => ({ type: "Feature", properties: { id: o.id }, geometry: { type: "LineString", coordinates: (o.fullPath ?? o.path).map(s.lonLat) } })),
    }) as never;

  const onCalamity = (kind: CalamityKind) => {
    const opts = sim.options();
    const rec = sim.recommend(opts);
    // Already heading home with one way to go: the suit replans without a pause.
    if (opts.length === 1) {
      sim.choose("return", "Suit computer (only option)");
      return;
    }
    decision = { kind, opts, rec, until: performance.now() + DECISION_SECONDS * 1000 };
    (map.getSource("sim-options") as GeoJSONSource).setData(lineFeatures(opts));
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

  // ---- unplanned find: plan an inspection against the oxygen budget ----
  let findPlan: { minutes: number; until: number } | null = null;
  const findEl = decisionEl;

  // The oxygen on hand, split into what the plan spends and what is left over.
  const budgetBar = (o: OptionPlan) => {
    const left = Math.max(1e-9, sim.o2LeftL);
    const total = Math.max(1e-9, o.walkS + (o.inspectS ?? 0) + o.scienceS);
    const part = (sec: number) => (o.needL * sec) / total;
    const walkL = part(o.walkS);
    const inspL = part(o.inspectS ?? 0);
    const sciL = part(o.scienceS);
    const spare = Math.max(0, left - o.needL);
    const margin = s.reserveL * (1 - CAUTION_FRACTION);
    const marginL = Math.min(spare, margin);
    const w = (l: number) => `${Math.max(0, (100 * l) / left).toFixed(2)}%`;
    return `<div class="budget ${o.needL > left ? "over" : ""}" title="Oxygen on hand, split by use">
        <i class="b-walk" style="width:${w(walkL)}"></i><i class="b-insp" style="width:${w(inspL)}"></i><i class="b-sci" style="width:${w(sciL)}"></i><i class="b-spare" style="width:${w(spare - marginL)}"></i><i class="b-margin" style="width:${w(marginL)}"></i>
      </div>
      <div class="budget-key"><span class="k-walk">walk ${litres(walkL)}</span><span class="k-insp">inspect ${litres(inspL)}</span><span class="k-sci">science ${litres(sciL)}</span><span class="k-spare">spare ${litres(spare)}</span></div>`;
  };

  // Every leg priced on the real terrain, plus the check at the find itself:
  // after inspecting, is the way straight home still affordable?
  const legTable = (o: OptionPlan) => {
    if (!o.legs || !Number.isFinite(o.needL)) return "";
    const total = Math.max(1e-9, o.walkS + (o.inspectS ?? 0) + o.scienceS);
    const perS = o.needL / total;
    const rows = o.legs.map((l) => `<tr><td>${l.label}</td><td>${Math.round(l.m)} m</td><td>${clock(l.s)}</td><td>${litres(l.s * perS)}</td></tr>`).join("");
    const f = o.atFind;
    const esc2 = f
      ? `<div class="escape ${f.o2AfterL >= f.homeL ? "ok" : "bad"}">At the find, after inspecting: <b>${litres(f.o2AfterL)}</b> left; straight home from there needs <b>${litres(f.homeL)}</b> (${Math.round(f.homeM)} m) &rarr; ${f.o2AfterL >= f.homeL ? `<b>can still get home</b>, ${litres(f.o2AfterL - f.homeL)} to spare` : "<b>cannot get home from there</b>"}</div>`
      : "";
    return `<div class="legs"><table>${rows}</table>${esc2}</div>`;
  };

  const renderFindOpts = () => {
    if (!findPlan) return;
    const opts = sim.findOptions(findPlan.minutes * 60);
    const rec = sim.recommendFind(opts);
    (map.getSource("sim-options") as GeoJSONSource).setData(lineFeatures(opts));
    const box = findEl.querySelector<HTMLElement>("#find-opts");
    if (!box) return;
    box.innerHTML = opts
      .map(
        (o) => `<div class="opt ${o.feasible ? "ok" : "bad"} ${o.id === rec ? "rec" : ""}">
          <div class="opt-head"><b>${o.label}</b>${o.id === rec ? `<span class="badge">RECOMMENDED</span>` : ""}</div>
          ${o.id === "return" || !Number.isFinite(o.needL) ? "" : budgetBar(o)}
          ${legTable(o)}
          <div class="opt-grid">
            <span>needs <b>${litres(o.needL)}</b> of ${litres(sim.o2LeftL)}</span>
            <span>spare at base <b class="${o.spareL < 0 ? "neg" : ""}">${litres(o.spareL)}</b></span>
            <span>home at <b>T+${clock(o.arriveS)}</b>${sim.deadlineS !== null ? ` (deadline T+${clock(sim.deadlineS)})` : ""}</span>
            <span>${o.note}</span>
          </div>
          <div class="opt-foot"><em>${o.feasible ? (o.spareL < s.reserveL * (1 - CAUTION_FRACTION) - 1e-6 ? "Survivable, margin thin" : "Survivable") : "NOT survivable"}</em><button class="${o.id === rec ? "primary" : "ghost"} sm" data-id="${o.id}">Choose</button></div>
        </div>`,
      )
      .join("");
    box.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) => b.addEventListener("click", () => decideFind(b.dataset.id as OptionPlan["id"], "Mission control")));
  };

  const onDiscovery = () => {
    const f = sim.find!;
    const bGoal = Math.floor(sim.inspectBudgetS("goal") / 60);
    const bBase = Math.floor(sim.inspectBudgetS("base") / 60);
    findPlan = { minutes: Math.max(5, Math.min(10, bGoal)), until: performance.now() + FIND_SECONDS * 1000 };
    findEl.innerHTML = `<div class="decision find">
        <div class="dec-title"><span>&#9678;</span>UNPLANNED FIND<small>T+${clock(sim.t)}</small></div>
        <p>The astronaut notices ${f.label}, about <b>${Math.round(f.offsetM)} m</b> off the route (gold dot on the map). Worth a look? Plan the stop against the oxygen on hand.
          <em>Scenario target, not a real Mars observation.</em></p>
        <div class="budget-note">Spare time at the find, keeping the 20% oxygen margin:
          <b>${bGoal > 0 ? `up to ${bGoal} min` : "none"}</b> and still finishing the destination;
          <b>${bBase > 0 ? `up to ${bBase} min` : "none"}</b> if the destination is skipped.</div>
        <label class="check"><input type="checkbox" id="find-legs" checked> Show path costs per leg</label>
        <label class="slider">Inspection time <output id="find-min">${findPlan.minutes} min</output>
          <input type="range" id="find-slider" min="0" max="${SCENARIO.findMaxInspectMin}" step="1" value="${findPlan.minutes}"></label>
        <div id="find-opts"></div>
        <div class="countdown"><i id="mc-count"></i><span id="mc-count-text"></span></div>
      </div>`;
    findEl.querySelector<HTMLInputElement>("#find-slider")!.addEventListener("input", (e) => {
      if (!findPlan) return;
      findPlan.minutes = Number((e.target as HTMLInputElement).value);
      findPlan.until = Math.max(findPlan.until, performance.now() + 20_000); // do not cut off a planner mid-drag
      findEl.querySelector("#find-min")!.textContent = `${findPlan.minutes} min`;
      renderFindOpts();
    });
    findEl.querySelector<HTMLInputElement>("#find-legs")!.addEventListener("change", (e) => findEl.querySelector(".decision")!.classList.toggle("hide-legs", !(e.target as HTMLInputElement).checked));
    renderFindOpts();
  };

  const decideFind = (id: OptionPlan["id"], by: string) => {
    if (!findPlan) return;
    sim.answerFind(id, findPlan.minutes * 60, by);
    if (sim.find?.state === "found") sim.answerFind("continue", 0, by); // the chosen plan was not possible: skip it
    findPlan = null;
    findEl.innerHTML = "";
    (map.getSource("sim-options") as GeoJSONSource).setData(empty);
  };

  // ---- rendering ----
  let logLen = -1;
  let lastHud = 0;
  let lastLine = 0;
  let lastHome = 0;
  let lastPoi = "";
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
        : sim.phase === "inspect"
          ? `<div><b>${clock(sim.inspectLeftS)}</b><small>inspection left</small></div>`
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

  const objEl = $("#mc-obj");
  const renderObjectives = () => {
    const row = (ok: boolean | null, text: string) => `<li class="${ok === true ? "done" : ok === false ? "fail" : ""}">${text}</li>`;
    const full = sim.goalReached && sim.scienceDoneS >= plannedScienceS - 1;
    const fs = sim.find?.state;
    const findRow = s.findMode === "off"
      ? ""
      : !sim.find
        ? row(null, sim.armed ? "A find is placed: not noticed yet" : s.findMode === "place" ? "Optional: place a find on the map" : "Optional: report anything notable on the way")
        : fs === "done"
          ? row(true, `Find inspected (${Math.round(sim.inspectDoneS / 60)} min)`)
          : fs === "skipped"
            ? row(false, "Find skipped")
            : row(null, fs === "inspecting" ? "Inspecting the find&hellip;" : fs === "detour" ? "Detour to the find&hellip;" : "Find: decision pending");
    objEl.innerHTML = [
      row(sim.goalReached, `Reach ${esc(s.objective.name)}`),
      row(full ? true : sim.done ? false : null, `Observe ${Math.floor(sim.scienceDoneS / 60)} / ${Math.floor(plannedScienceS / 60)} min`),
      row(sim.phase === "returned" ? true : sim.phase === "lost" ? false : null, "Return to base"),
      findRow,
    ].join("");
  };

  const renderEnd = () => {
    const outcome =
      sim.phase === "lost"
        ? { cls: "no-go", title: "EVA FAILED" }
        : sim.goalReached && sim.scienceDoneS >= plannedScienceS - 1
          ? { cls: "go", title: sim.find?.state === "done" ? "MISSION SUCCESS, FIND INSPECTED" : "MISSION SUCCESS" }
          : !sim.goalReached && sim.inspectDoneS > 0
            ? { cls: "caution", title: "RETURNED SAFELY, FIND INSPECTED, DESTINATION SKIPPED" }
            : { cls: "caution", title: sim.scienceDoneS > 0 ? "RETURNED SAFELY, SCIENCE CUT SHORT" : "ABORTED, RETURNED SAFELY" };
    const events = sim.log.filter((e) => e.kind === "event").length;
    const decisions = sim.log.filter((e) => e.kind === "decision").length;
    decisionEl.innerHTML = `<div class="verdict ${outcome.cls}"><span>${outcome.title}</span></div>
      <div class="kpis">
        <div><b>${clock(sim.t)}</b><small>EVA duration</small></div>
        <div><b>${litres(sim.o2LeftL)}</b><small>O<sub>2</sub> left</small></div>
        <div><b>${Math.floor(sim.scienceDoneS / 60)} / ${Math.floor(plannedScienceS / 60)} min</b><small>science done</small></div>
        <div><b>${sim.find ? (sim.inspectDoneS > 0 ? `${Math.round(sim.inspectDoneS / 60)} min` : sim.find.state === "skipped" ? "skipped" : "none") : "no find"}</b><small>find inspection</small></div>
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
    if (!paused && !decision && !findPlan && !sim.done) {
      const kind = sim.advance(dt * speed);
      if (kind === "discovery") onDiscovery();
      else if (kind) onCalamity(kind);
    }
    const pending = decision ?? findPlan;
    if (pending) {
      const leftMs = pending.until - now;
      const bar = s.panel.querySelector<HTMLElement>("#mc-count");
      const txt = s.panel.querySelector<HTMLElement>("#mc-count-text");
      if (bar) bar.style.width = `${Math.max(0, (100 * leftMs) / ((decision ? DECISION_SECONDS : FIND_SECONDS) * 1000))}%`;
      if (txt) txt.textContent = `No call? The astronaut follows the recommendation in ${Math.ceil(Math.max(0, leftMs) / 1000)} s`;
      if (leftMs <= 0 && !paused) {
        const by = "No call from mission control; astronaut followed the suit computer";
        if (decision) decide(decision.rec, by);
        else if (findPlan) decideFind(sim.recommendFind(sim.findOptions(findPlan.minutes * 60)), by);
      }
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
      const ahead = sim.phase === "outbound" || sim.phase === "inbound" || sim.phase === "detour" ? [pos, ...sim.path.slice(sim.idx + 1).map(s.lonLat)] : [];
      (map.getSource("sim-ahead") as GeoJSONSource).setData(ahead.length > 1 ? line(ahead) : empty);
      drawHazard();
      const poi = sim.find ?? sim.armed;
      const poiKey = poi ? `${poi.cell}:${poi.state}` : "";
      if (poiKey !== lastPoi) {
        lastPoi = poiKey;
        (map.getSource("sim-poi") as GeoJSONSource).setData(
          poi ? ({ type: "Feature", properties: { state: poi.state }, geometry: { type: "Point", coordinates: s.lonLat(poi.cell) } } as never) : empty,
        );
      }
    }
    if (now - lastHome > 1000 && !sim.done) {
      lastHome = now;
      home = sim.options().find((o) => o.id === "return");
    }
    if (now - lastHud > 150) {
      lastHud = now;
      metEl.textContent = `T+${clock(sim.t)}`;
      renderHud();
      renderObjectives();
      if (placeBtn) placeBtn.disabled = !!sim.find || sim.phase !== "outbound" || sim.done;
      renderLog();
      s.fx.classList.toggle("on", sim.active.has("dust") && !sim.done);
      s.app.classList.toggle("fx-spe", sim.deadlineS !== null && !sim.done);
    }
    if (sim.done && !ended) {
      ended = true;
      home = undefined;
      renderHud();
      renderObjectives();
      renderLog();
      renderEnd();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    map.off("click", onMapClick);
    map.getCanvas().style.cursor = "";
    for (const id of ["sim-poi-halo", "sim-poi", "sim-trail", "sim-ahead", "sim-options", "sim-hazard"]) {
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
