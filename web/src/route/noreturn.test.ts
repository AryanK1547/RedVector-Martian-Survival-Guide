import { describe, expect, it } from "vitest";
import { oxygenLitres } from "./assumptions";
import { astar } from "./astar";
import { NEIGHBOURS, STRATEGIES, makeGrid, stepCost, type Grid } from "./cost";
import { checkRoute, moveTimeS, returnTimes } from "./noreturn";
import { buildSteps } from "./steps";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGrid(seed: number, rows = 10, cols = 11): Grid {
  const rnd = mulberry32(seed);
  const n = rows * cols;
  const elevation = Float32Array.from({ length: n }, () => rnd() * 400);
  const slope = Float32Array.from({ length: n }, () => rnd() * 29);
  return makeGrid(elevation, slope, rows, cols, -5, 32, 1852.2306687);
}

// Independent reference with no heap: relax every edge repeatedly until nothing improves.
function bruteReturnTimes(g: Grid, base: number): Float64Array {
  const n = g.rows * g.cols;
  const t = new Float64Array(n).fill(Infinity);
  t[base] = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let u = 0; u < n; u++) {
      const r = Math.floor(u / g.cols);
      const c = u % g.cols;
      for (const [dr, dc] of NEIGHBOURS) {
        const vr = r + dr;
        const vc = c + dc;
        if (vr < 0 || vc < 0 || vr >= g.rows || vc >= g.cols) continue;
        const v = vr * g.cols + vc;
        if (!Number.isFinite(stepCost(g, STRATEGIES.shortest, u, v))) continue;
        const cand = t[v] + moveTimeS(g, u, v);
        if (cand < t[u] - 1e-9) {
          t[u] = cand;
          changed = true;
        }
      }
    }
  }
  return t;
}

describe("return times", () => {
  it("match a brute-force relaxation on 15 seeded random grids", () => {
    for (let seed = 1; seed <= 15; seed++) {
      const g = randomGrid(seed);
      const base = Math.floor(mulberry32(seed * 7)() * g.rows * g.cols);
      const fast = returnTimes(g, base);
      const slow = bruteReturnTimes(g, base);
      for (let i = 0; i < fast.length; i++) {
        if (Number.isFinite(slow[i])) expect(fast[i]).toBeCloseTo(slow[i], 6);
        else expect(fast[i]).toBe(Infinity);
      }
    }
  });

  it("is zero at the base and no more than the time of any walked route back", () => {
    const g = randomGrid(3);
    const t = returnTimes(g, 0);
    expect(t[0]).toBe(0);
    for (let start = 1; start < g.rows * g.cols; start += 9) {
      const route = astar(g, STRATEGIES.shortest, start, 0);
      if (!route || !Number.isFinite(t[start])) continue;
      expect(buildSteps(g, route.cells).at(-1)!.timeS).toBeGreaterThanOrEqual(t[start] - 1e-6);
    }
  });

  it("returning uphill takes longer than the same walk downhill", () => {
    const rows = 3;
    const cols = 6;
    const elevation = Float32Array.from({ length: rows * cols }, (_, i) => (i % cols) * 100); // rises eastward
    const g = makeGrid(elevation, new Float32Array(rows * cols), rows, cols, -5, 32, 1852.2306687);
    const lowBase = returnTimes(g, cols + 0); // base in the low west: the way back from the east is downhill
    const highBase = returnTimes(g, cols + 5); // base in the high east: the way back from the west is uphill
    expect(highBase[cols + 0]).toBeGreaterThan(lowBase[cols + 5]);
  });
});

describe("route safety check", () => {
  const flat = makeGrid(new Float32Array(72), new Float32Array(72).fill(2), 8, 9, -5, 32, 1852.2306687);
  const times = returnTimes(flat, 0);
  const steps = buildSteps(flat, astar(flat, STRATEGIES.shortest, 0, 71)!.cells);
  const peak = checkRoute(steps, times, 1e9).peakRoundTripL;

  it("fits when the reserve is huge, and the peak covers the far end out and back", () => {
    const far = steps.at(-1)!;
    expect(checkRoute(steps, times, 1e9).fits).toBe(true);
    expect(peak).toBeGreaterThanOrEqual(far.oxygenL + oxygenLitres(times[far.cell]) - 1e-9);
  });

  it("finds the first cell where used + return exceeds the reserve", () => {
    const reserve = peak * 0.5;
    const check = checkRoute(steps, times, reserve);
    expect(check.fits).toBe(false);
    const p = check.pointOfNoReturn!;
    expect(p.outL + p.backL).toBeGreaterThan(reserve);
    const before = steps[p.index - 1];
    expect(before.oxygenL + oxygenLitres(times[before.cell])).toBeLessThanOrEqual(reserve + 1e-9);
  });
});
