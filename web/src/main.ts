import type { Map as MapLibreMap } from "maplibre-gl";
import { cellSizeLabel, loadTerrain } from "./data";
import { addWaypointMarkers, createMap, showLayer, type Layer } from "./map";
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
];

let teardown: (() => void) | null = null;

async function showRegion(app: HTMLElement, region: Region, waypoints: Waypoint[]) {
  teardown?.();
  app.textContent = "Loading terrain...";
  const terrain = await loadTerrain(region.base);
  const { meta } = terrain;
  app.textContent = "";

  const mapEl = document.createElement("div");
  mapEl.id = "map";
  app.append(mapEl);
  const map: MapLibreMap = createMap(mapEl, meta, region.base, region.attribution);
  addWaypointMarkers(map, waypoints);
  const client = new RouteClient(terrain);
  teardown = () => {
    client.dispose();
    map.remove();
  };

  const regionOptions = REGIONS.map((r) => `<option value="${r.id}"${r.id === region.id ? " selected" : ""}>${r.label}</option>`).join("");
  const strategyOptions = strategyNames.map((n) => `<option value="${n}">${n[0].toUpperCase()}${n.slice(1)}</option>`).join("");
  const exaggeration = meta.files["hillshade.png"].vertical_exaggeration;
  const panel = document.createElement("div");
  panel.id = "panel";
  panel.innerHTML = `<strong>MarsWalk</strong>
    <label>Region <select id="region">${regionOptions}</select></label>
    <label>Layer <select id="layer"><option value="hillshade">Hillshade</option><option value="slope">Slope</option></select></label>
    <label>Strategy <select id="strategy">${strategyOptions}</select></label>
    <button id="reset">Reset</button>
    <p id="status"></p>
    <div id="stats"></div>
    <canvas id="profile" width="236" height="90" hidden></canvas>
    <p class="note">Cell size ${cellSizeLabel(meta)}.${exaggeration !== 1 ? ` Hillshade uses ${exaggeration}x vertical exaggeration (visualization only).` : ""}
    Orange markers: Curiosity science waypoints (click for NASA sources).</p>`;
  app.append(panel);

  panel.querySelector<HTMLSelectElement>("#region")!.addEventListener("change", (e) => {
    const next = REGIONS.find((r) => r.id === (e.target as HTMLSelectElement).value)!;
    void showRegion(app, next, waypoints);
  });
  panel.querySelector<HTMLSelectElement>("#layer")!.addEventListener("change", (e) => {
    showLayer(map, (e.target as HTMLSelectElement).value as Layer);
  });

  const statsEl = panel.querySelector<HTMLElement>("#stats")!;
  const profile = panel.querySelector<HTMLCanvasElement>("#profile")!;
  setupRouting(
    map,
    terrain,
    client,
    {
      status: panel.querySelector<HTMLElement>("#status")!,
      strategy: panel.querySelector<HTMLSelectElement>("#strategy")!,
      reset: panel.querySelector<HTMLButtonElement>("#reset")!,
    },
    (steps) => {
      profile.hidden = !steps;
      drawProfile(profile, steps);
      if (steps) renderStats(statsEl, summarize(steps), cellSizeLabel(meta));
      else statsEl.innerHTML = "";
    },
  );
}

async function start() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const waypoints = await loadWaypoints();
  await showRegion(app, REGIONS[0], waypoints);
}

start().catch((err) => {
  document.querySelector("#app")!.textContent = `Failed to load: ${err}`;
});
