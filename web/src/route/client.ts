import type { Terrain } from "../data";
import { astar } from "./astar";
import { STRATEGIES, gridFromTerrain, type Grid, type StrategyName } from "./cost";
import type { ResultMsg, WorkerIn } from "./engine";

export interface PlannedRoute {
  cells: number[];
  cost: number;
}

// Page-side handle to the worker: plan() sends a request and returns a Promise
// that resolves when the matching result (same id) comes back.
export class RouteClient {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, (r: PlannedRoute | null) => void>();
  private grid: Grid;
  private failed = false;

  constructor(terrain: Terrain) {
    this.grid = gridFromTerrain(terrain);
    // If the worker cannot run, plan on the page instead of waiting forever.
    this.worker.onerror = (e) => {
      console.error("route worker failed; planning on the main thread", e.message);
      this.failed = true;
    };
    this.worker.onmessage = (e: MessageEvent<ResultMsg>) => {
      const resolve = this.pending.get(e.data.id);
      this.pending.delete(e.data.id);
      resolve?.(e.data.cells && e.data.cost !== null ? { cells: e.data.cells, cost: e.data.cost } : null);
    };
    const { crop, grid } = terrain.meta;
    const init: WorkerIn = {
      type: "init",
      rows: terrain.rows,
      cols: terrain.cols,
      elevation: terrain.elevation,
      slopeDeg: terrain.slopeDeg,
      latTop: crop.lat_top,
      pixelsPerDegree: grid.pixels_per_degree,
      pixelSizeM: grid.pixel_size_m,
    };
    this.worker.postMessage(init);
  }

  // Stops the worker thread; used when switching to another region.
  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }

  private local(start: number, goal: number, strategy: StrategyName): PlannedRoute | null {
    const r = astar(this.grid, STRATEGIES[strategy], start, goal);
    return r ? { cells: r.cells, cost: r.cost } : null;
  }

  plan(start: number, goal: number, strategy: StrategyName): Promise<PlannedRoute | null> {
    if (this.failed) return Promise.resolve(this.local(start, goal, strategy));
    const id = this.nextId++;
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: PlannedRoute | null) => {
        if (done) return;
        done = true;
        this.pending.delete(id);
        resolve(r);
      };
      this.pending.set(id, finish);
      const msg: WorkerIn = { type: "plan", id, start, goal, strategy };
      this.worker.postMessage(msg);
      // Same A*, same grid: the answer is identical, only the thread differs.
      window.setTimeout(() => {
        if (done) return;
        console.warn("route worker did not answer in 8 s; planning on the main thread");
        finish(this.local(start, goal, strategy));
      }, 8000);
    });
  }
}
