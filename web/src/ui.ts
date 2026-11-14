import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { raiseOverlays } from "./map";
import { cellToLatlon, latlonToCell, type Terrain } from "./data";
import { ReturnOverlay } from "./returnmap";
import { MAX_SLOPE_DEG, STRATEGIES, gridFromTerrain, type StrategyName } from "./route/cost";
import type { RouteClient } from "./route/client";
import { checkRoute, returnTimes } from "./route/noreturn";
import { buildSteps, type RouteStep } from "./route/steps";

type Point = [number, number]; // [lon, lat], the order GeoJSON uses

const empty = { type: "FeatureCollection", features: [] } as const;

const metres = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// Click 1 = start (also the base to return to), click 2 = destination (route is
// planned), click 3 = new start.
export function setupRouting(
  map: MapLibreMap,
  terrain: Terrain,
  client: RouteClient,
  controls: {
    status: HTMLElement;
    safety: HTMLElement;
    strategy: HTMLSelectElement;
    reserve: HTMLInputElement;
    reset: HTMLButtonElement;
  },
  onRoute: (steps: RouteStep[] | null) => void,
): void {
  let start: number | null = null;
  let goal: number | null = null;
  let steps: RouteStep[] | null = null;
  let times: Float64Array | null = null; // walking seconds back to the start, per cell
  let noReturnCell: number | null = null;
  let overlay: ReturnOverlay | null = null;
  let token = 0; // bumped on every change so a slow, outdated result is ignored
  const grid = gridFromTerrain(terrain);

  const lonLat = (idx: number): Point => {
    const { lat, lon } = cellToLatlon(terrain.meta, Math.floor(idx / terrain.cols), idx % terrain.cols);
    return [lon, lat];
  };

  const drawPoints = () => {
    const marks: [number | null, string][] = [[start, "start"], [goal, "goal"], [noReturnCell, "pnr"]];
    const features = marks
      .filter((m): m is [number, string] => m[0] !== null)
      .map(([idx, kind]) => ({ type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: lonLat(idx) } }));
    (map.getSource("points") as GeoJSONSource).setData({ type: "FeatureCollection", features } as never);
  };

  // Recomputes the return map and the turn-back check from the current state.
  const refreshSafety = () => {
    const reserve = Number(controls.reserve.value);
    noReturnCell = null;
    overlay?.render(times, reserve > 0 ? reserve : 0.001);
    if (!times || !(reserve > 0)) {
      controls.safety.textContent = "";
    } else if (!steps) {
      controls.safety.textContent = "Return map: green = can walk back on under half the oxygen reserve, amber = tight, red = could not get back.";
    } else {
      const check = checkRoute(steps, times, reserve);
      if (check.pointOfNoReturn) {
        const p = check.pointOfNoReturn;
        noReturnCell = steps[p.index].cell;
        controls.safety.textContent = `Turn back before the purple marker, ${metres(steps[p.index].distanceM)} along: oxygen used ${p.outL.toFixed(0)} L + ${p.backL.toFixed(0)} L to return exceeds the ${reserve} L reserve.`;
      } else {
        controls.safety.textContent = `Round trip fits: at worst ${check.peakRoundTripL.toFixed(0)} L of the ${reserve} L reserve is committed (used so far + needed to return).`;
      }
    }
    controls.safety.className = steps && noReturnCell !== null ? "warn" : "";
    drawPoints();
  };

  const draw = (cells: number[] | null) => {
    (map.getSource("route") as GeoJSONSource).setData(
      cells
        ? ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cells.map(lonLat) } } as never)
        : (empty as never),
    );
    steps = cells ? buildSteps(grid, cells) : null;
    onRoute(steps);
    refreshSafety();
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
    times = null;
    draw(null);
    controls.status.textContent = "Click the map to set a start (your base).";
  };

  const wire = () => {
    overlay = new ReturnOverlay(map, terrain);
    map.addSource("route", { type: "geojson", data: empty as never });
    map.addSource("points", { type: "geojson", data: empty as never });
    map.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#ffd23f", "line-width": 3 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        "circle-radius": 7,
        "circle-color": ["match", ["get", "kind"], "start", "#3ddc84", "pnr", "#b266ff", "#ff4d4d"],
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
      times = returnTimes(grid, idx);
      draw(null);
      controls.status.textContent = "Base set. Click a destination.";
    } else {
      goal = idx;
      draw(null);
      void plan();
    }
  });

  controls.strategy.addEventListener("change", () => void plan());
  controls.reserve.addEventListener("input", refreshSafety);
  controls.reset.addEventListener("click", clear);
}

export const strategyNames = Object.keys(STRATEGIES) as StrategyName[];
