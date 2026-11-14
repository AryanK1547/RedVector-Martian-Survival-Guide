import { MinHeap } from "./heap";
import { NEIGHBOURS, heuristic, passable, stepCost, type Grid, type Strategy } from "./cost";

export interface RouteResult {
  cells: number[]; // cell indices (row * cols + col), start first
  cost: number;
}

// A* = Dijkstra's algorithm that explores the most promising cell first.
// Priority f = g (cost so far) + h (optimistic guess of cost still to go).
// Returns null if an endpoint is impassable or the goal is unreachable.
export function astar(g: Grid, s: Strategy, start: number, goal: number): RouteResult | null {
  if (!passable(g, start) || !passable(g, goal)) return null;
  const n = g.rows * g.cols;
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  best[start] = 0;
  heap.push(heuristic(g, start, goal), start);

  while (heap.size > 0) {
    const { id } = heap.pop();
    if (closed[id]) continue; // stale entry: this cell was already settled via a cheaper entry
    closed[id] = 1;
    if (id === goal) break;
    const r = Math.floor(id / g.cols);
    const c = id % g.cols;
    for (const [dr, dc] of NEIGHBOURS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      const next = nr * g.cols + nc;
      if (closed[next]) continue;
      const cost = best[id] + stepCost(g, s, id, next);
      if (cost < best[next]) {
        best[next] = cost;
        from[next] = id;
        heap.push(cost + heuristic(g, next, goal), next);
      }
    }
  }
  return trace(best, from, start, goal);
}

export function trace(best: Float64Array, from: Int32Array, start: number, goal: number): RouteResult | null {
  if (!Number.isFinite(best[goal])) return null;
  const cells = [goal];
  while (cells[cells.length - 1] !== start) cells.push(from[cells[cells.length - 1]]);
  return { cells: cells.reverse(), cost: best[goal] };
}
