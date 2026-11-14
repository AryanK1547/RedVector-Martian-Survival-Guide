import { oxygenLitres, walkingSpeedKmh } from "./assumptions";
import { MinHeap } from "./heap";
import { NEIGHBOURS, STRATEGIES, groundDistance, stepCost, type Grid } from "./cost";
import type { RouteStep } from "./steps";

// Walking time in seconds for the move from -> to (slower uphill, per Tobler).
export function moveTimeS(g: Grid, from: number, to: number): number {
  const dist = groundDistance(g, from, to);
  const grade = (g.elevation[to] - g.elevation[from]) / dist;
  return dist / ((walkingSpeedKmh(grade) * 1000) / 3600);
}

// Dijkstra run BACKWARDS from the base: result[c] = least walking time (s) to
// get from cell c back to the base, or Infinity if there is no way back.
// Backwards because the time of a move depends on its direction (uphill is
// slower), so "time from base to c" would be the wrong number for a return trip:
// we pop a cell v and ask which neighbours u can step INTO v, charging u -> v.
export function returnTimes(g: Grid, base: number): Float64Array {
  const n = g.rows * g.cols;
  const best = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heap = new MinHeap();
  best[base] = 0;
  heap.push(0, base);
  while (heap.size > 0) {
    const { id: v } = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    const r = Math.floor(v / g.cols);
    const c = v % g.cols;
    for (const [dr, dc] of NEIGHBOURS) {
      const ur = r + dr;
      const uc = c + dc;
      if (ur < 0 || uc < 0 || ur >= g.rows || uc >= g.cols) continue;
      const u = ur * g.cols + uc;
      if (done[u]) continue;
      if (!Number.isFinite(stepCost(g, STRATEGIES.shortest, u, v))) continue; // u -> v not allowed
      const t = best[v] + moveTimeS(g, u, v);
      if (t < best[u]) {
        best[u] = t;
        heap.push(t, u);
      }
    }
  }
  return best;
}

export interface NoReturn {
  index: number; // first step from which turning back is no longer affordable
  outL: number; // oxygen used getting there
  backL: number; // oxygen needed to walk back from there
}

export interface SafetyCheck {
  pointOfNoReturn: NoReturn | null;
  peakRoundTripL: number; // largest (oxygen used so far + oxygen to return) along the route
  fits: boolean;
}

// Walk along the route: at each cell, oxygen already used plus oxygen needed to
// return must stay within the reserve. The first cell where it does not is the
// point of no return: the astronaut should have turned back BEFORE it.
export function checkRoute(steps: RouteStep[], times: Float64Array, reserveL: number): SafetyCheck {
  let first: NoReturn | null = null;
  let peak = 0;
  steps.forEach((s, index) => {
    const outL = s.oxygenL;
    const backL = oxygenLitres(times[s.cell]);
    peak = Math.max(peak, outL + backL);
    if (first === null && outL + backL > reserveL) first = { index, outL, backL };
  });
  return { pointOfNoReturn: first, peakRoundTripL: peak, fits: first === null };
}
