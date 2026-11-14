import { NEIGHBOURS, passable, stepCost, type Grid, type Strategy } from "./cost";
import { trace, type RouteResult } from "./astar";

// Plain Dijkstra with a linear scan instead of a heap: slow (O(n^2)) but
// simple enough to trust. It is the REFERENCE the tests compare A* against, and
// it deliberately shares no heap code with astar.ts.
export function dijkstra(g: Grid, s: Strategy, start: number, goal: number): RouteResult | null {
  if (!passable(g, start) || !passable(g, goal)) return null;
  const n = g.rows * g.cols;
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  best[start] = 0;
  for (;;) {
    let id = -1;
    for (let i = 0; i < n; i++) {
      if (!done[i] && best[i] < Infinity && (id < 0 || best[i] < best[id])) id = i;
    }
    if (id < 0 || id === goal) break;
    done[id] = 1;
    const r = Math.floor(id / g.cols);
    const c = id % g.cols;
    for (const [dr, dc] of NEIGHBOURS) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      const next = nr * g.cols + nc;
      const cost = best[id] + stepCost(g, s, id, next);
      if (cost < best[next]) {
        best[next] = cost;
        from[next] = id;
      }
    }
  }
  return trace(best, from, start, goal);
}
