import { astar } from "./astar";
import { STRATEGIES, makeGrid, type Grid, type StrategyName } from "./cost";

// Messages between the page and the worker. postMessage COPIES them (structured
// clone), so the worker gets its own copy of the terrain and never shares memory.
export interface InitMsg {
  type: "init";
  rows: number;
  cols: number;
  elevation: Float32Array;
  slopeDeg: Float32Array;
  latTop: number;
  pixelsPerDegree: number;
  pixelSizeM: number;
}
export interface PlanMsg {
  type: "plan";
  id: number;
  start: number;
  goal: number;
  strategy: StrategyName;
}
export type WorkerIn = InitMsg | PlanMsg;
export interface ResultMsg {
  type: "result";
  id: number;
  cells: number[] | null; // null = no route (blocked endpoint or unreachable)
  cost: number | null;
}

// The worker's logic lives here, not in worker.ts, so tests can run it directly.
export function createEngine(): (msg: WorkerIn) => ResultMsg | undefined {
  let grid: Grid | null = null;
  return (msg) => {
    if (msg.type === "init") {
      grid = makeGrid(msg.elevation, msg.slopeDeg, msg.rows, msg.cols, msg.latTop, msg.pixelsPerDegree, msg.pixelSizeM);
      return undefined;
    }
    if (!grid) throw new Error("plan received before init");
    const r = astar(grid, STRATEGIES[msg.strategy], msg.start, msg.goal);
    return { type: "result", id: msg.id, cells: r ? r.cells : null, cost: r ? r.cost : null };
  };
}
