import type { Map as MapLibreMap } from "maplibre-gl";
import { loadConditions, renderConditions, type Conditions } from "./conditions";
import { cellSizeLabel, loadTerrain } from "./data";
import { addWaypointMarkers, createMap, createOverviewMap, showLayer, type Layer } from "./map";
import { RouteClient } from "./route/client";
import { summarize } from "./route/steps";
import { drawProfile, renderStats } from "./stats";
import { setupRouting, strategyNames } from "./ui";
import { loadWaypoints, type Waypoint } from "./waypoints";
import "./style.css";

interface Region {
  id: string;
  label: string;
  base: string; // folder under public/ holding meta.json, elevation.bin, slope.bin and PNGs
  attribution: string;
  kind?: "overview"; // overview = whole-planet picture with site markers, no routing
}

const REGIONS: Region[] = [
  {
    id: "boxwork",
    label: "Boxwork area, Mount Sharp (10 m)",
    base: "data/local/",
    attribution: "Terrain: USGS MSL Gale Merged DEM 1 m (from NASA MRO HiRISE). Rover positions: NASA PDS MSL PLACES. Hillshade and slope are our own visualization.",
  },
  {
    id: "gale",
    label: "Gale Crater overview (1.85 km)",
    base: "data/",
    attribution: "Terrain: NASA MGS MOLA MEGDR, PDS Geosciences Node. Rover positions: NASA PDS MSL PLACES. Hillshade and slope are our own visualization.",
  },
  {
    id: "mars",
    label: "Mars overview (MOLA, about 15 km)",
    base: "data/mars/",
    attribution: "Terrain: NASA MGS MOLA MEGDR, PDS Geosciences Node. Colour and shading are our own visualization.",
    kind: "overview",
  },
];

const regionSelect = (current: string) =>
  `<label>Region <select id="region">${REGIONS.map((r) => `<option value="${r.id}"${r.id === current ? " selected" : ""}>${r.label}</option>`).join("")}</select></label>`;

async function showOverview(app: HTMLElement, region: Region, waypoints: Waypoint[], conditions: Conditions) {
  const info = await (await fetch(region.base + "mars.json")).json();
  app.textContent = "";
  const mapEl = document.createElement("div");
  mapEl.id = "map";
  app.append(mapEl);
  const map = createOverviewMap(mapEl, region.base, info, region.attribution, (target) => {
    const next = REGIONS.find((r) => r.id === target);
    if (next) void showRegion(app, next, waypoints, conditions);
  });
  teardown = () => map.remove();
  const panel = document.createElement("div");
  panel.id = "panel";
  panel.innerHTML = `<strong>MarsWalk</strong>${regionSelect(region.id)}
    <p class="note">Whole-planet overview from NASA MOLA elevation (colour = height). Click a site marker.
    Detailed maps, routing and science layers exist only where MarsWalk has verified local data: today, Gale Crater.</p>`;
  app.append(panel);
  panel.querySelector<HTMLSelectElement>("#region")!.addEventListener("change", (e) => {
    const next = REGIONS.find((r) => r.id === (e.target as HTMLSelectElement).value)!;
    void showRegion(app, next, waypoints, conditions);
  });
}

let teardown: (() => void) | null = null;

async function showRegion(app: HTMLElement, region: Region, waypoints: Waypoint[], conditions: Conditions) {
  teardown?.();
  teardown = null;
  app.textContent = "Loading terrain...";
  if (region.kind === "overview") return showOverview(app, region, waypoints, conditions);
  const terrain = await loadTerrain(region.base);
  const { meta } = terrain;
  app.textContent = "";

  const mapEl = document.createElement("div");
  mapEl.id = "map";
  app.append(mapEl);
  const map: MapLibreMap = createMap(mapEl, meta, region.base, region.attribution);
  const markers = addWaypointMarkers(map, waypoints);
  const client = new RouteClient(terrain);
  let stopRouting: () => void = () => {};
  teardown = () => {
    stopRouting();
    client.dispose();
    map.remove();
  };
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.hidden = true;
  app.append(hud);

  const strategyOptions = strategyNames.map((n) => `<option value="${n}">${n[0].toUpperCase()}${n.slice(1)}</option>`).join("");
  const exaggeration = meta.files["hillshade.png"].vertical_exaggeration;
  const panel = document.createElement("div");
  panel.id = "panel";
  panel.innerHTML = `<strong>MarsWalk</strong>
    ${regionSelect(region.id)}
    <label>Layer <select id="layer"><option value="hillshade">Hillshade</option><option value="slope">Slope</option><option value="thermal">Thermal inertia (THEMIS)</option></select></label>
    <p class="note" id="layer-note"></p>
    <label>Strategy <select id="strategy">${strategyOptions}</select></label>
    <label>Oxygen reserve (L) <input id="reserve" type="number" min="1" step="1" value="30"></label>
    <p class="note">Reserve is a model assumption (demo value), not a NASA suit figure.</p>
    <button id="reset">Reset</button>
    <button id="play" disabled>Play mission</button>
    <label class="inline"><input id="follow" type="checkbox" checked> Follow astronaut</label>
    <p id="status"></p>
    <p id="safety"></p>
    <div id="stats"></div>
    <canvas id="profile" width="236" height="90" hidden></canvas>
    <div id="waypoints"></div>
    <div id="conditions"></div>
    <p class="note">Cell size ${cellSizeLabel(meta)}.${exaggeration !== 1 ? ` Hillshade uses ${exaggeration}x vertical exaggeration (visualization only).` : ""}
    Orange markers: Curiosity science waypoints (click for NASA sources).</p>`;
  app.append(panel);

  panel.querySelector<HTMLSelectElement>("#region")!.addEventListener("change", (e) => {
    const next = REGIONS.find((r) => r.id === (e.target as HTMLSelectElement).value)!;
    void showRegion(app, next, waypoints, conditions);
  });
  panel.querySelector<HTMLSelectElement>("#layer")!.addEventListener("change", (e) => {
    const layer = (e.target as HTMLSelectElement).value as Layer;
    showLayer(map, layer);
    panel.querySelector<HTMLElement>("#layer-note")!.textContent =
      layer === "thermal"
        ? "NASA Mars Odyssey THEMIS, qualitative thermal inertia at 100 m (ASU). Blue = low, generally loose dust or sand; red = high, generally rock or bedrock. Visual context only; not used in routing. Covers the boxwork map fully, only central Gale on the overview."
        : "";
  });

  renderConditions(panel.querySelector<HTMLElement>("#conditions")!, conditions);
  // The two waypoints are 22 m apart, so their markers overlap until zoomed in:
  // the list zooms close enough to separate them and opens the chosen popup.
  const wpList = panel.querySelector<HTMLElement>("#waypoints")!;
  wpList.innerHTML = "<strong>Science waypoints</strong>";
  waypoints.forEach((w, i) => {
    const btn = document.createElement("button");
    btn.className = "wp-button";
    btn.textContent = w.name;
    btn.addEventListener("click", () => {
      markers.forEach((m) => m.getPopup()?.isOpen() && m.togglePopup());
      map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(map.getZoom(), 18) });
      map.once("moveend", () => markers[i].togglePopup());
    });
    wpList.append(btn);
  });
  const rates = Object.values(conditions.sols).map((s) => s.rad.dose_rate_b_silicon_ugy_per_day);
  const doseRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const statsEl = panel.querySelector<HTMLElement>("#stats")!;
  const profile = panel.querySelector<HTMLCanvasElement>("#profile")!;
  stopRouting = setupRouting(
    map,
    terrain,
    client,
    {
      status: panel.querySelector<HTMLElement>("#status")!,
      safety: panel.querySelector<HTMLElement>("#safety")!,
      reserve: panel.querySelector<HTMLInputElement>("#reserve")!,
      play: panel.querySelector<HTMLButtonElement>("#play")!,
      follow: panel.querySelector<HTMLInputElement>("#follow")!,
      hud,
      strategy: panel.querySelector<HTMLSelectElement>("#strategy")!,
      reset: panel.querySelector<HTMLButtonElement>("#reset")!,
    },
    (steps) => {
      profile.hidden = !steps;
      drawProfile(profile, steps);
      if (steps) renderStats(statsEl, summarize(steps), cellSizeLabel(meta), doseRate);
      else statsEl.innerHTML = "";
    },
  );
}

async function start() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const [waypoints, conditions] = await Promise.all([loadWaypoints(), loadConditions()]);
  await showRegion(app, REGIONS[0], waypoints, conditions);
}

start().catch((err) => {
  document.querySelector("#app")!.textContent = `Failed to load: ${err}`;
});
