import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { raiseOverlays } from "./map";
import { cellToLatlon, latlonToCell, type Terrain } from "./data";
import { MAX_SLOPE_DEG, STRATEGIES, gridFromTerrain, type StrategyName } from "./route/cost";
import type { RouteClient } from "./route/client";
import { buildSteps, type RouteStep } from "./route/steps";

type Point = [number, number]; // [lon, lat], the order GeoJSON uses

const empty = { type: "FeatureCollection", features: [] } as const;

// Click 1 = start, click 2 = destination (route is planned), click 3 = new start.
export function setupRouting(
  map: MapLibreMap,
  terrain: Terrain,
  client: RouteClient,
  controls: { status: HTMLElement; strategy: HTMLSelectElement; reset: HTMLButtonElement },
  onRoute: (steps: RouteStep[] | null) => void,
): void {
  let start: number | null = null;
  let goal: number | null = null;
  let token = 0; // bumped on every change so a slow, outdated result is ignored
  const grid = gridFromTerrain(terrain);

  const lonLat = (idx: number): Point => {
    const { lat, lon } = cellToLatlon(terrain.meta, Math.floor(idx / terrain.cols), idx % terrain.cols);
    return [lon, lat];
  };

  const draw = (cells: number[] | null) => {
    const points = [start, goal]
      .map((idx, i) => (idx === null ? null : { type: "Feature", properties: { kind: i === 0 ? "start" : "goal" }, geometry: { type: "Point", coordinates: lonLat(idx) } }))
      .filter((f) => f !== null);
    (map.getSource("points") as GeoJSONSource).setData({ type: "FeatureCollection", features: points } as never);
    (map.getSource("route") as GeoJSONSource).setData(
      cells
        ? ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cells.map(lonLat) } } as never)
        : (empty as never),
    );
    onRoute(cells ? buildSteps(grid, cells) : null);
  };

  const plan = async () => {
    if (start === null || goal === null) return;
    const mine = ++token;
    const name = controls.strategy.value as StrategyName;
    controls.status.textContent = "Planning...";
    const route = await client.plan(start, goal, name);
    if (mine !== token) return;
    if (!route) {
      draw(null);
      controls.status.textContent = "No route: the destination is unreachable below the slope limit.";
      return;
    }
    draw(route.cells);
    controls.status.textContent = `${name[0].toUpperCase()}${name.slice(1)} route planned.`;
  };

  const clear = () => {
    token++;
    start = null;
    goal = null;
    draw(null);
    controls.status.textContent = "Click the map to set a start.";
  };

  const wire = () => {
    map.addSource("route", { type: "geojson", data: empty as never });
    map.addSource("points", { type: "geojson", data: empty as never });
    map.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#ffd23f", "line-width": 3 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        "circle-radius": 7,
        "circle-color": ["match", ["get", "kind"], "start", "#3ddc84", "#ff4d4d"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    raiseOverlays(map);
    clear();
  };
  if (map.isStyleLoaded()) wire();
  else map.once("load", wire);

  map.on("click", (e) => {
    const cell = latlonToCell(terrain.meta, e.lngLat.lat, e.lngLat.lng);
    if (!cell) {
      controls.status.textContent = "That point is outside the mapped region.";
      return;
    }
    const idx = cell.row * terrain.cols + cell.col;
    if (terrain.slopeDeg[idx] > MAX_SLOPE_DEG) {
      controls.status.textContent = `That cell is steeper than ${MAX_SLOPE_DEG} deg (impassable). Pick another.`;
      return;
    }
    if (start === null || goal !== null) {
      token++;
      start = idx;
      goal = null;
      draw(null);
      controls.status.textContent = "Start set. Click a destination.";
    } else {
      goal = idx;
      draw(null);
      void plan();
    }
  });

  controls.strategy.addEventListener("change", () => void plan());
  controls.reset.addEventListener("click", clear);
}

export const strategyNames = Object.keys(STRATEGIES) as StrategyName[];
