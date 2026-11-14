import type { Terrain } from "../data";

// Cells steeper than this are impassable.
// Source: JPL "2020 mobility trending" report lists Curiosity's maximum rover
// pitch as 25.22 deg over its first seven years (found by web search, summary
// only, NEEDS CHECKING against the PDF). It is a ROVER figure, not an astronaut
// EVA limit, and our slopes are averaged over 1.85 km per pixel, so real local
// slopes are steeper. Chosen by the lead on 14 Nov, recorded in log.txt.
export const MAX_SLOPE_DEG = 25;

export type StrategyName = "shortest" | "safest" | "balanced";

// cost of one step = ground distance * (1 + slopeWeight * (slope / MAX)^2)
//                    + elevationWeight * |height change in metres|
// The weights are TUNING CHOICES (not NASA data): they set how much a route
// is willing to detour to avoid steep or hilly ground.
export interface Strategy {
  slopeWeight: number;
  elevationWeight: number;
}

export const STRATEGIES: Record<StrategyName, Strategy> = {
  shortest: { slopeWeight: 0, elevationWeight: 0 },
  balanced: { slopeWeight: 2, elevationWeight: 1 },
  safest: { slopeWeight: 10, elevationWeight: 4 },
};

export interface Grid {
  rows: number;
  cols: number;
  elevation: ArrayLike<number>; // metres
  slopeDeg: ArrayLike<number>; // degrees
  dy: number; // ground metres per row step
  dx: Float64Array; // ground metres per column step, one value per row
  dxMin: number; // smallest dx (used by the A* heuristic)
}

export function makeGrid(
  elevation: ArrayLike<number>,
  slopeDeg: ArrayLike<number>,
  rows: number,
  cols: number,
  latTop: number,
  pixelsPerDegree: number,
  pixelSizeM: number,
): Grid {
  const dx = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const lat = latTop - (r + 0.5) / pixelsPerDegree;
    dx[r] = pixelSizeM * Math.cos((lat * Math.PI) / 180); // east-west shrinks with cos(latitude)
  }
  return { rows, cols, elevation, slopeDeg, dy: pixelSizeM, dx, dxMin: Math.min(...dx) };
}

export function gridFromTerrain(t: Terrain): Grid {
  const { crop, grid } = t.meta;
  return makeGrid(t.elevation, t.slopeDeg, t.rows, t.cols, crop.lat_top, grid.pixels_per_degree, grid.pixel_size_m);
}

export function passable(g: Grid, idx: number): boolean {
  return g.slopeDeg[idx] <= MAX_SLOPE_DEG;
}

// Fixed order, so ties are broken the same way every run.
export const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [0, 1], [1, 0], [0, -1], [-1, 1], [1, 1], [1, -1], [-1, -1],
];

// Cost of moving between two neighbouring cells, or Infinity if not allowed.
// A diagonal move may not squeeze between two blocked cells it touches.
export function stepCost(g: Grid, s: Strategy, from: number, to: number): number {
  const r0 = Math.floor(from / g.cols);
  const c0 = from % g.cols;
  const r1 = Math.floor(to / g.cols);
  const c1 = to % g.cols;
  if (!passable(g, to)) return Infinity;
  if (r0 !== r1 && c0 !== c1 && (!passable(g, r0 * g.cols + c1) || !passable(g, r1 * g.cols + c0))) {
    return Infinity;
  }
  const dist = groundDistance(g, from, to);
  const slope = (g.slopeDeg[from] + g.slopeDeg[to]) / 2 / MAX_SLOPE_DEG;
  const dz = Math.abs(g.elevation[to] - g.elevation[from]);
  return dist * (1 + s.slopeWeight * slope * slope) + s.elevationWeight * dz;
}

// Horizontal ground distance in metres between two neighbouring cells.
// East-west distance uses the mean of the two rows' spacing.
export function groundDistance(g: Grid, from: number, to: number): number {
  const r0 = Math.floor(from / g.cols);
  const r1 = Math.floor(to / g.cols);
  const ex = ((g.dx[r0] + g.dx[r1]) / 2) * ((to % g.cols) - (from % g.cols));
  return Math.hypot(ex, g.dy * (r1 - r0));
}

// Lower bound on the true remaining cost: straight-line ground distance using
// the smallest east-west spacing in the grid. Penalties are >= 0, so real cost
// can never be below it ("admissible"), which keeps A* optimal.
export function heuristic(g: Grid, from: number, goal: number): number {
  const dr = Math.floor(goal / g.cols) - Math.floor(from / g.cols);
  const dc = (goal % g.cols) - (from % g.cols);
  return Math.hypot(dc * g.dxMin, dr * g.dy);
}
