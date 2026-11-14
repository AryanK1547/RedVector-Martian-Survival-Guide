import type { Terrain } from "../data";
import type { StrategyName } from "./cost";
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

  constructor(terrain: Terrain) {
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

  plan(start: number, goal: number, strategy: StrategyName): Promise<PlannedRoute | null> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const msg: WorkerIn = { type: "plan", id, start, goal, strategy };
      this.worker.postMessage(msg);
    });
  }
}
