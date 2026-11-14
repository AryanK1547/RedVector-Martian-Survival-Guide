import { cellToLatlon, type Terrain } from "../data";
import { MAX_SLOPE_DEG } from "./cost";

// Science stops can sit on cells the 10 m model calls too steep: the boxwork
// ridges are narrower than a cell, so the slope of a crest cell mixes both
// flanks. The astronaut walks to the nearest walkable cell instead, and the UI
// says how far that is from the stop.
export function nearestPassable(
  t: Terrain,
  row: number,
  col: number,
  maxCells: number,
): { row: number; col: number; distM: number } | null {
  const rowM = t.meta.grid.pixel_size_m;
  const colM = rowM * Math.cos((cellToLatlon(t.meta, row, col).lat * Math.PI) / 180);
  let best: { row: number; col: number; distM: number } | null = null;
  for (let r = Math.max(0, row - maxCells); r <= Math.min(t.rows - 1, row + maxCells); r++) {
    for (let c = Math.max(0, col - maxCells); c <= Math.min(t.cols - 1, col + maxCells); c++) {
      if (t.slopeDeg[r * t.cols + c] > MAX_SLOPE_DEG) continue;
      const distM = Math.hypot((r - row) * rowM, (c - col) * colM);
      // Ties (equal distance) go to the lower cell index, so the result is deterministic.
      if (!best || distM < best.distM) best = { row: r, col: c, distM };
    }
  }
  return best;
}
