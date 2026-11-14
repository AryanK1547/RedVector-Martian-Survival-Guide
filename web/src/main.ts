import type { Map as MapLibreMap } from "maplibre-gl";
import { loadConditions, renderConditions, type Conditions } from "./conditions";
import { cellSizeLabel, loadTerrain } from "./data";
import { addWaypointMarkers, createMap, createOverviewMap, setBase, setOverlay, type Base, type Overlay, type OverviewInfo } from "./map";
import { RouteClient } from "./route/client";
import type { StrategyName } from "./route/cost";
import { drawProfile, renderVerdict } from "./stats";
import { startSim } from "./sim/view";
import { setupRouting, strategyNames, type RouteResult } from "./ui";
import { loadWaypoints, type Waypoint } from "./waypoints";
import "./style.css";

interface Region {
  id: string;
  tab: string;
  label: string;
  base: string; // folder under public/ holding meta.json, elevation.bin, slope.bin and PNGs
  attribution: string;
  kind?: "overview"; // overview = whole-planet picture with site markers, no routing
}

const REGIONS: Region[] = [
  {
    id: "mars",
    tab: "Mars",
    label: "Mars overview (MOLA, about 15 km)",
    base: "data/mars/",
    attribution: "Terrain: NASA MGS MOLA MEGDR, PDS Geosciences Node. Colour and shading are our own visualization.",
    kind: "overview",
  },
  {
    id: "gale",
    tab: "Gale Crater",
    label: "Gale Crater overview (1.85 km cells)",
    base: "data/",
    attribution: "Terrain: NASA MGS MOLA MEGDR, PDS Geosciences Node. Imagery: NASA MRO CTX via NASA Mars Trek; THEMIS (ASU). Rover positions: NASA PDS MSL PLACES. Hillshade and slope are our own visualization.",
  },
  {
    id: "boxwork",
    tab: "Boxwork EVA site",
    label: "Boxwork area, Mount Sharp (10 m cells)",
    base: "data/local/",
    attribution: "Terrain: USGS MSL Gale Merged DEM 1 m (from NASA MRO HiRISE). Imagery: NASA MRO CTX via NASA Mars Trek; THEMIS (ASU). Rover positions: NASA PDS MSL PLACES. Hillshade and slope are our own visualization.",
  },
];

type Lens = Overlay | "return" | "none";

// One data lens at a time over the base map: stacking the photo, thermal and
// slope layers made the map unreadable.
const LENS_OPACITY: Record<Lens, number> = { return: 100, slope: 60, thermal: 60, none: 0 };
const LEGENDS: Record<Lens, string> = {
  return: `<span class="sw" style="background:rgba(61,220,132,.55)"></span>comfortable <span class="sw" style="background:rgba(255,200,50,.6)"></span>tight <span class="sw" style="background:rgba(8,4,4,.75)"></span>beyond reserve`,
  slope: `<span>0&deg;</span><i class="ramp" style="background:linear-gradient(90deg,#000,#fff)"></i><span>45&deg;+</span>`,
  thermal: `<span>low (dust, sand)</span><i class="ramp" style="background:linear-gradient(90deg,rgb(30,40,160),rgb(40,190,220),rgb(250,220,60),rgb(220,50,40))"></i><span>high (rock)</span>`,
  none: "",
};

const OVERLAY_NOTES: Record<Lens | Base, string> = {
  photo: "Base: NASA MRO Context Camera (CTX) photo mosaic via NASA Mars Trek, about 10 m per pixel on the EVA site. Where the mosaic has no data, the relief map shows through.",
  relief: "Base: shaded relief computed from the elevation model (our own visualization).",
  slope: "Slope: brighter = steeper. Ground over 25 deg is impassable for routing.",
  thermal: "Thermal inertia (NASA Mars Odyssey THEMIS, 100 m pixels, ASU): blue = low, generally loose dust or sand; red = high, generally rock. Context only; not used in routing.",
  return: "Return range: lit area = you can walk there and back on the reserve (green = comfortable, amber = tight). Dimmed = beyond the reserve. Appears once a base is set.",
  none: "Base map only.",
};

const STEPS = ["Site", "Plan", "Check", "Rehearse"];
const STAGE_STEP = { base: 1, goal: 1, route: 2, replay: 3 } as const;

let teardown: (() => void) | null = null;

const el = <T extends HTMLElement = HTMLElement>(html: string): T => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
};

function topbar(app: HTMLElement, current: Region, go: (r: Region) => void, withSteps: boolean): HTMLElement {
  const bar = el(`<header id="topbar">
      <div class="brand"><span class="logo"></span>MARSWALK<small>EVA planner &middot; NASA data</small></div>
      <nav class="tabs">${REGIONS.map((r) => `<button data-id="${r.id}" class="${r.id === current.id ? "active" : ""}" title="${r.label}">${r.tab}</button>`).join("")}</nav>
      ${withSteps ? `<ol class="steps">${STEPS.map((s, i) => `<li data-step="${i}">${s}</li>`).join("")}</ol>` : ""}
    </header>`);
  bar.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
    b.addEventListener("click", () => go(REGIONS.find((r) => r.id === b.dataset.id)!)),
  );
  app.append(bar);
  return bar;
}

function setStep(bar: HTMLElement, step: number) {
  bar.querySelectorAll<HTMLElement>(".steps li").forEach((li) => {
    const i = Number(li.dataset.step);
    li.className = i < step ? "done" : i === step ? "active" : "";
  });
}

async function showOverview(app: HTMLElement, region: Region, go: (r: Region) => void) {
  const info: OverviewInfo = await (await fetch(region.base + "mars.json")).json();
  app.textContent = "";
  const mapEl = el(`<div id="map"></div>`);
  app.append(mapEl);
  const map = createOverviewMap(mapEl, region.base, info, region.attribution, (target) => {
    const next = REGIONS.find((r) => r.id === target);
    if (next) go(next);
  });
  teardown = () => map.remove();
  topbar(app, region, go, false);
  const left = el(`<aside id="left" class="card">
      <h2>Choose an EVA site</h2>
      <p class="lead">MarsWalk plans a single Marswalk: where an astronaut can safely go, how long they can work there, and when they must turn back.</p>
      <div class="sites"></div>
      <p class="note">Whole-planet view from NASA MOLA elevation (colour = height). Detailed maps, routing and science layers exist
      only where MarsWalk has verified local data: today, Gale Crater.</p>
    </aside>`);
  const sites = left.querySelector<HTMLElement>(".sites")!;
  for (const s of info.sites) {
    const card = el(`<div class="site-card${s.region ? "" : " muted"}"><b>${s.name}</b><small>${s.region ? "Verified local data" : "No local MarsWalk data yet"}</small></div>`);
    if (s.region) {
      const btn = el<HTMLButtonElement>(`<button class="primary">Open EVA site</button>`);
      btn.addEventListener("click", () => go(REGIONS.find((r) => r.id === "boxwork")!));
      card.append(btn);
    }
    sites.append(card);
  }
  app.append(left);
}

async function showRegion(app: HTMLElement, region: Region, waypoints: Waypoint[], conditions: Conditions) {
  teardown?.();
  teardown = null;
  app.innerHTML = `<div class="loading">Loading terrain...</div>`;
  const go = (r: Region) => void showRegion(app, r, waypoints, conditions);
  if (region.kind === "overview") return showOverview(app, region, go);
  const terrain = await loadTerrain(region.base);
  const { meta } = terrain;
  app.textContent = "";

  const mapEl = el(`<div id="map"></div>`);
  app.append(mapEl);
  const map: MapLibreMap = createMap(mapEl, meta, region.base, region.attribution);
  const markers = addWaypointMarkers(map, waypoints);
  const client = new RouteClient(terrain);
  const bar = topbar(app, region, go, true);
  setStep(bar, 1);

  const hud = el(`<div class="hud" hidden></div>`);
  app.append(hud);

  // ---- left card: plan ----
  const left = el(`<aside id="left" class="card">
      <h2>${region.label}</h2>
      <p id="status" class="status"></p>
      ${region.id === "boxwork" ? `<button id="example" class="ghost">Try an example walk</button>` : ""}
      <h3>Route strategy</h3>
      <div class="seg" id="strategy">${strategyNames.map((n, i) => `<button data-v="${n}" class="${i === 0 ? "active" : ""}">${n[0].toUpperCase()}${n.slice(1)}</button>`).join("")}</div>
      <h3>Oxygen reserve <output id="reserve-out">30 L</output></h3>
      <input id="reserve" type="range" min="10" max="120" step="1" value="30">
      <p class="note">Demo value, not a NASA suit figure.</p>
      <h3>Science stops</h3>
      <div id="stops"></div>
      <h3>Map layers</h3>
      <div class="seg" id="base"><button data-v="photo" class="active">Photo (CTX)</button><button data-v="relief">Relief</button></div>
      <h3>Data lens <output>one at a time</output></h3>
      <div class="seg" id="lens"><button data-v="return" class="active">Return</button><button data-v="slope">Slope</button><button data-v="thermal">Thermal</button><button data-v="none">None</button></div>
      <input id="lens-opacity" type="range" min="15" max="100" step="5" value="100" aria-label="Lens opacity">
      <div class="legend" id="legend">${LEGENDS.return}</div>
      <p class="note" id="layer-note">${OVERLAY_NOTES.return}</p>
      <p class="note">Cell size ${cellSizeLabel(meta)}.</p>
    </aside>`);
  app.append(left);

  // ---- right card: verdict ----
  const right = el(`<aside id="right" class="card">
      <div id="verdict"><div class="empty">
        <h2>Is this walk safe?</h2>
        <ol><li><b>Click the map</b> to set your base.</li><li><b>Click a destination</b> or press <i>Walk here</i> on a science stop.</li>
        <li>Get a <b>GO / NO-GO</b> verdict, your science time on site and where to turn back.</li></ol>
      </div></div>
      <div class="actions" hidden>
        <h3>Live EVA simulation</h3>
        <div class="sim-setup">
          <label>Science time <input id="sci" type="number" min="0" max="120" step="1" value="10"> min</label>
          <label class="check"><input id="rand" type="checkbox" checked> Random calamities</label>
        </div>
        <button id="sim" class="primary wide">Start live EVA &#9654;</button>
        <p class="note">You play mission control: calamities strike during the walk and you decide, live, whether the astronaut continues or turns back.</p>
      </div>
      <div id="conditions"></div>
    </aside>`);
  app.append(right);
  renderConditions(right.querySelector<HTMLElement>("#conditions")!, conditions);

  // ---- bottom strip: elevation profile ----
  const bottom = el(`<div id="bottom" hidden><span class="strip-label">Elevation along the route</span><canvas id="profile"></canvas></div>`);
  app.append(bottom);
  const profile = bottom.querySelector<HTMLCanvasElement>("#profile")!;

  const statusEl = left.querySelector<HTMLElement>("#status")!;
  const reserveEl = left.querySelector<HTMLInputElement>("#reserve")!;
  const reserveOut = left.querySelector<HTMLOutputElement>("#reserve-out")!;
  const verdictEl = right.querySelector<HTMLElement>("#verdict")!;
  const emptyVerdict = verdictEl.innerHTML;
  const actions = right.querySelector<HTMLElement>(".actions")!;
  const sciEl = right.querySelector<HTMLInputElement>("#sci")!;
  let strategy: StrategyName = strategyNames[0];
  let lens: Lens = "return";
  let last: RouteResult | null = null;

  const rates = Object.values(conditions.sols).map((s) => s.rad.dose_rate_b_silicon_ugy_per_day);
  const doseRate = rates.reduce((a, b) => a + b, 0) / rates.length;

  const routing = setupRouting(
    map,
    terrain,
    client,
    {
      strategy: () => strategy,
      reserve: () => Number(reserveEl.value),
      follow: () => true,
      hud,
    },
    {
      status: (text, tone = "info") => {
        statusEl.textContent = text;
        statusEl.className = `status ${tone}`;
      },
      stage: (s) => setStep(bar, STAGE_STEP[s]),
      result: (r) => {
        last = r;
        actions.hidden = !r;
        bottom.hidden = !r;
        app.classList.toggle("has-route", !!r);
        if (r) {
          // Suggest a science stint that leaves headroom for surprises.
          sciEl.value = String(Math.max(0, Math.min(15, Math.floor(r.verdict.scienceMin * 0.6))));
          renderVerdict(verdictEl, r.steps, r.verdict, doseRate, cellSizeLabel(meta));
          drawProfile(profile, r.steps, r.verdict.pointOfNoReturn);
        } else {
          verdictEl.innerHTML = emptyVerdict;
        }
      },
    },
  );
  const onResize = () => last && drawProfile(profile, last.steps, last.verdict.pointOfNoReturn);
  window.addEventListener("resize", onResize);
  teardown = () => {
    stopSim?.();
    window.removeEventListener("resize", onResize);
    routing.stop();
    client.dispose();
    map.remove();
  };

  // ---- wiring ----
  left.querySelectorAll<HTMLButtonElement>("#strategy button").forEach((b) =>
    b.addEventListener("click", () => {
      left.querySelectorAll("#strategy button").forEach((x) => x.classList.toggle("active", x === b));
      strategy = b.dataset.v as StrategyName;
      routing.replan();
    }),
  );
  reserveEl.addEventListener("input", () => {
    reserveOut.textContent = `${reserveEl.value} L`;
    routing.refresh();
  });
  // ---- live simulation: mission control replaces the cards ----
  const fx = el(`<div class="fx-dust"></div>`);
  app.append(fx);
  const mc = el(`<aside id="mc" class="card" hidden></aside>`);
  app.append(mc);
  let stopSim: (() => void) | null = null;
  const exitSim = () => {
    stopSim?.();
    stopSim = null;
    mc.hidden = true;
    left.hidden = false;
    right.hidden = false;
    bottom.hidden = !last;
    app.classList.remove("sim-mode");
    routing.lock(false);
    routing.setReturnVisible(lens === "return");
    setStep(bar, last ? 2 : 1);
  };
  const runSim = (seed: number) => {
    const cur = routing.current();
    if (!cur) return;
    stopSim?.();
    app.classList.add("sim-mode");
    left.hidden = true;
    right.hidden = true;
    bottom.hidden = true;
    mc.hidden = false;
    routing.lock(true);
    routing.setReturnVisible(false);
    setStep(bar, 3);
    stopSim = startSim({
      map, terrain, ...cur,
      reserveL: Number(reserveEl.value),
      scienceS: Math.max(0, Number(sciEl.value) || 0) * 60,
      randomCount: right.querySelector<HTMLInputElement>("#rand")!.checked ? 2 : 0,
      seed,
      lonLat: routing.lonLat,
      panel: mc,
      hud,
      fx,
      app,
      onExit: exitSim,
      onRestart: (next) => runSim(next),
    });
  };
  right.querySelector<HTMLButtonElement>("#sim")!.addEventListener("click", () => runSim(Math.floor(Math.random() * 1e6)));

  const note = left.querySelector<HTMLElement>("#layer-note")!;
  left.querySelectorAll<HTMLButtonElement>("#base button").forEach((b) =>
    b.addEventListener("click", () => {
      left.querySelectorAll("#base button").forEach((x) => x.classList.toggle("active", x === b));
      setBase(map, b.dataset.v as Base);
      note.textContent = OVERLAY_NOTES[b.dataset.v as Base];
    }),
  );
  const opacityEl = left.querySelector<HTMLInputElement>("#lens-opacity")!;
  const legendEl = left.querySelector<HTMLElement>("#legend")!;
  const applyOpacity = () => {
    const id = lens === "none" ? null : lens;
    if (id && map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", Number(opacityEl.value) / 100);
  };
  left.querySelectorAll<HTMLButtonElement>("#lens button").forEach((b) =>
    b.addEventListener("click", () => {
      left.querySelectorAll("#lens button").forEach((x) => x.classList.toggle("active", x === b));
      lens = b.dataset.v as Lens;
      setOverlay(map, "slope", lens === "slope");
      setOverlay(map, "thermal", lens === "thermal");
      routing.setReturnVisible(lens === "return");
      opacityEl.value = String(LENS_OPACITY[lens]);
      opacityEl.disabled = lens === "none";
      applyOpacity();
      legendEl.innerHTML = LEGENDS[lens];
      note.textContent = OVERLAY_NOTES[lens];
    }),
  );
  opacityEl.addEventListener("input", applyOpacity);
  map.once("load", () => setBase(map, "photo"));

  // Science stops as cards: photo, sol, and one-click planning.
  const stops = left.querySelector<HTMLElement>("#stops")!;
  waypoints.forEach((w, i) => {
    const card = el(`<div class="stop">
        <img src="data/${w.imageFile}" alt="${w.imageCaption.replace(/"/g, "&quot;")}">
        <div><b>${w.name}</b><small>Curiosity, sol ${w.sol}</small>
          <span><button class="primary sm" data-a="walk">Walk here</button><button class="ghost sm" data-a="view">View</button></span></div>
      </div>`);
    card.querySelector<HTMLButtonElement>('[data-a="walk"]')!.addEventListener("click", () => routing.goTo(w.lat, w.lon));
    card.querySelector<HTMLButtonElement>('[data-a="view"]')!.addEventListener("click", () => {
      markers.forEach((m) => m.getPopup()?.isOpen() && m.togglePopup());
      map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 17) });
      map.once("moveend", () => markers[i].togglePopup());
    });
    stops.append(card);
  });

  // Example: an illustrative base a few hundred metres from the ridge (not a
  // real landing site), then a walk to the ridge top.
  left.querySelector<HTMLButtonElement>("#example")?.addEventListener("click", () => {
    const target = waypoints.find((w) => w.id === "boxwork_ridge_top") ?? waypoints[0];
    const offsets = [[-0.0045, -0.0045], [0.0045, -0.0045], [-0.0045, 0.0045], [0.0045, 0.0045]];
    if (offsets.some(([dlat, dlon]) => routing.setBaseAt(target.lat + dlat, target.lon + dlon))) {
      routing.goTo(target.lat, target.lon);
    }
  });
}

async function start() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const [waypoints, conditions] = await Promise.all([loadWaypoints(), loadConditions()]);
  await showRegion(app, REGIONS.find((r) => r.id === "boxwork")!, waypoints, conditions);
}

start().catch((err) => {
  document.querySelector("#app")!.textContent = `Failed to load: ${err}`;
});
