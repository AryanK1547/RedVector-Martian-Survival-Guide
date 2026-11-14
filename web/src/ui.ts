import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { raiseOverlays } from "./map";
import { cellToLatlon, latlonToCell, type Terrain } from "./data";
import { Player } from "./player";
import { ReturnOverlay } from "./returnmap";
import { MAX_SLOPE_DEG, STRATEGIES, gridFromTerrain, type StrategyName } from "./route/cost";
import type { RouteClient } from "./route/client";
import { returnTimes } from "./route/noreturn";
import { nearestPassable } from "./route/snap";
import { buildSteps, type RouteStep } from "./route/steps";
import { assess, type Verdict } from "./route/verdict";

type Point = [number, number]; // [lon, lat], the order GeoJSON uses

const empty = { type: "FeatureCollection", features: [] } as const;

export interface RouteResult {
  steps: RouteStep[];
  verdict: Verdict;
}

export interface RoutingView {
  status(text: string, tone?: "info" | "warn"): void;
  result(r: RouteResult | null): void; // called whenever the route or the reserve changes
  stage(s: "base" | "goal" | "route" | "replay"): void; // which step of the workflow we are in
}

export interface RoutingOptions {
  eva: boolean; // false on regional maps: no return range and no turn-back marker
  strategy: () => StrategyName;
  reserve: () => number;
  follow: () => boolean;
  hud: HTMLElement;
}

export interface RoutingController {
  replan(): void;
  refresh(): void;
  reset(): void;
  play(): void;
  setReturnVisible(on: boolean): void;
  hasBase(): boolean;
  setBaseAt(lat: number, lon: number): boolean;
  goTo(lat: number, lon: number): boolean;
  stop(): void;
  // The planned walk, for the live simulation.
  current(): { base: number; goal: number; cells: number[]; strategy: StrategyName } | null;
  // While locked (simulation running), map clicks do not move the base or goal.
  lock(on: boolean): void;
  lonLat(idx: number): [number, number];
  // Run cb once the route layers exist and the initial reset has happened (now, if already).
  whenReady(cb: () => void): void;
}

// Click 1 = base (where the walk starts and must end), click 2 = destination
// (the route is planned), click 3 = new base. Science-stop buttons call goTo.
export function setupRouting(
  map: MapLibreMap,
  terrain: Terrain,
  client: RouteClient,
  opts: RoutingOptions,
  view: RoutingView,
): RoutingController {
  let start: number | null = null;
  let goal: number | null = null;
  let steps: RouteStep[] | null = null;
  let times: Float64Array | null = null; // walking seconds back to the base, per cell
  let overlay: ReturnOverlay | null = null;
  let player: Player | null = null;
  let returnVisible = true;
  let locked = false;
  let route: number[] | null = null; // cells of the planned route
  let token = 0; // bumped on every change so a slow, outdated result is ignored
  const grid = gridFromTerrain(terrain);

  const lonLat = (idx: number): Point => {
    const { lat, lon } = cellToLatlon(terrain.meta, Math.floor(idx / terrain.cols), idx % terrain.cols);
    return [lon, lat];
  };

  const drawPoints = (pnr: number | null) => {
    const marks: [number | null, string][] = [[start, "start"], [goal, "goal"], [pnr, "pnr"]];
    const features = marks
      .filter((m): m is [number, string] => m[0] !== null)
      .map(([idx, kind]) => ({ type: "Feature", properties: { kind }, geometry: { type: "Point", coordinates: lonLat(idx) } }));
    (map.getSource("points") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features } as never);
  };

  // Recomputes the return map and the verdict from the current state.
  const refresh = () => {
    const reserve = opts.reserve() > 0 ? opts.reserve() : 0.001;
    overlay?.render(opts.eva && returnVisible ? times : null, reserve);
    if (steps && times) {
      const verdict = assess(steps, times, reserve);
      drawPoints(opts.eva && verdict.pointOfNoReturn !== null ? steps[verdict.pointOfNoReturn].cell : null);
      view.result({ steps, verdict });
    } else {
      drawPoints(null);
      view.result(null);
    }
  };

  const draw = (cells: number[] | null) => {
    (map.getSource("route") as GeoJSONSource | undefined)?.setData(
      cells
        ? ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: cells.map(lonLat) } } as never)
        : (empty as never),
    );
    player?.stop();
    route = cells;
    steps = cells ? buildSteps(grid, cells) : null;
    refresh();
  };

  const plan = async () => {
    if (start === null || goal === null) return;
    const mine = ++token;
    const name = opts.strategy();
    view.status("Planning the safest way across the terrain...");
    const route = await client.plan(start, goal, name);
    if (mine !== token) return;
    if (!route) {
      draw(null);
      view.status(`No route: every way there crosses ground steeper than ${MAX_SLOPE_DEG} deg.`, "warn");
      view.stage("goal");
      return;
    }
    draw(route.cells);
    view.status(`${name[0].toUpperCase()}${name.slice(1)} route planned.${goalNote} Click elsewhere to set a new base.`);
    view.stage("route");
  };

  // snapCells > 0: if the point is too steep, use the nearest walkable cell
  // within that many cells (for science stops); 0: refuse (for map clicks).
  let snapNote = "";
  const cellAt = (lat: number, lon: number, snapCells = 0): number | null => {
    snapNote = "";
    const cell = latlonToCell(terrain.meta, lat, lon);
    if (!cell) {
      view.status("That point is outside the mapped area.", "warn");
      return null;
    }
    const idx = cell.row * terrain.cols + cell.col;
    if (terrain.slopeDeg[idx] <= MAX_SLOPE_DEG) return idx;
    const near = snapCells > 0 ? nearestPassable(terrain, cell.row, cell.col, snapCells) : null;
    if (!near) {
      view.status(`Too steep to stand there (over ${MAX_SLOPE_DEG} deg). Pick another spot.`, "warn");
      return null;
    }
    snapNote = ` The stop itself is on ground over ${MAX_SLOPE_DEG} deg in the 10 m model, so the route ends at the nearest walkable cell, ${Math.round(near.distM)} m away.`;
    return near.row * terrain.cols + near.col;
  };
  // Snap science stops by up to about 100 m (at least one cell).
  const SNAP_CELLS = Math.max(1, Math.round(100 / terrain.meta.grid.pixel_size_m));
  let goalNote = ""; // snap explanation for the current destination

  const setBase = (idx: number) => {
    token++;
    start = idx;
    goal = null;
    times = returnTimes(grid, idx);
    draw(null);
    view.status("Base set. The lit area is where you can walk and still get back. Now pick a destination or a science stop.");
    view.stage("goal");
  };

  const setGoal = (idx: number, note = "") => {
    goal = idx;
    goalNote = note;
    draw(null);
    void plan();
  };

  const reset = () => {
    token++;
    start = null;
    goal = null;
    times = null;
    draw(null);
    view.status("Click the map to set your base: where the walk starts and must end.");
    view.stage("base");
  };

  let wired = false;
  const readyQueue: (() => void)[] = [];
  const wire = () => {
    overlay = new ReturnOverlay(map, terrain);
    player = new Player(map, opts.hud, lonLat, opts.follow, () => view.stage("route"));
    map.addSource("route", { type: "geojson", data: empty as never });
    map.addSource("points", { type: "geojson", data: empty as never });
    map.addLayer({ id: "route-glow", type: "line", source: "route", paint: { "line-color": "#ffd23f", "line-width": 10, "line-opacity": 0.25, "line-blur": 6 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({ id: "route-line", type: "line", source: "route", paint: { "line-color": "#ffe27a", "line-width": 3 }, layout: { "line-join": "round", "line-cap": "round" } });
    map.addLayer({
      id: "points",
      type: "circle",
      source: "points",
      paint: {
        "circle-radius": ["match", ["get", "kind"], "pnr", 6, 8],
        "circle-color": ["match", ["get", "kind"], "start", "#3ddc84", "pnr", "#b266ff", "#ff6b4a"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 2,
      },
    });
    map.addSource("astronaut", { type: "geojson", data: empty as never });
    map.addLayer({
      id: "astronaut",
      type: "circle",
      source: "astronaut",
      paint: { "circle-radius": 8, "circle-color": "#ffffff", "circle-stroke-color": "#39c6ff", "circle-stroke-width": 3 },
    });
    raiseOverlays(map);
    reset();
    wired = true;
    readyQueue.splice(0).forEach((cb) => cb());
  };
  if (map.isStyleLoaded()) wire();
  else map.once("load", wire);

  map.on("click", (e) => {
    if (locked) return;
    const idx = cellAt(e.lngLat.lat, e.lngLat.lng);
    if (idx === null) return;
    if (start === null || goal !== null) setBase(idx);
    else setGoal(idx);
  });

  return {
    replan: () => void plan(),
    refresh,
    reset,
    play: () => {
      if (!steps || !times || steps.length < 2) return;
      view.stage("replay");
      player?.start(steps, times, opts.reserve() || 0.001);
    },
    setReturnVisible: (on) => {
      returnVisible = on;
      refresh();
    },
    hasBase: () => start !== null,
    setBaseAt: (lat, lon) => {
      const idx = cellAt(lat, lon, SNAP_CELLS);
      if (idx === null) return false;
      setBase(idx);
      return true;
    },
    goTo: (lat, lon) => {
      if (start === null) {
        view.status("Set a base first: click the map where the walk starts.", "warn");
        return false;
      }
      const idx = cellAt(lat, lon, SNAP_CELLS);
      if (idx === null) return false;
      setGoal(idx, snapNote);
      return true;
    },
    stop: () => player?.stop(),
    current: () => (start !== null && goal !== null && route ? { base: start, goal, cells: route, strategy: opts.strategy() } : null),
    lock: (on) => {
      locked = on;
    },
    lonLat,
    whenReady: (cb) => {
      if (wired) cb();
      else readyQueue.push(cb);
    },
  };
}

export const strategyNames = Object.keys(STRATEGIES) as StrategyName[];
