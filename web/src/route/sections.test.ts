import { describe, expect, it } from "vitest";
import { FLAT_SPEED_KMH, oxygenLitres, walkingSpeedKmh } from "./assumptions";
import { astar } from "./astar";
import { STRATEGIES, makeGrid } from "./cost";
import { moveTimeS } from "./noreturn";
import { compareStrategies, maxObservationMin, reach, routeTotals, sensitivity, slopeClass, splitSections, toblerFactor } from "./sections";

// 40 x 40 grid of 10 m cells on the equator with a ramp: the east half climbs, so
// the same route has flat, gentle and steep parts.
const N = 40;
const elev = new Float32Array(N * N);
const slope = new Float32Array(N * N);
for (let r = 0; r < N; r++)
  for (let c = 0; c < N; c++) {
    const rise = c < 12 ? 0 : c < 24 ? (c - 12) * 1.0 : 12 + (c - 24) * 2.5; // metres
    elev[r * N + c] = rise;
    // slope in degrees of that profile (10 m cells)
    slope[r * N + c] = c < 12 ? 1 : c < 24 ? 5.7 : 14;
  }
const grid = makeGrid(elev, slope, N, N, 0, 5927.469752330622, 10);
const at = (r: number, c: number) => r * N + c;
const cells = astar(grid, STRATEGIES.shortest, at(20, 2), at(20, 36))!.cells;

describe("route sections", () => {
  it("slope classes follow the display limits", () => {
    expect([2, 7, 12, 20].map(slopeClass)).toEqual(["flat", "gentle", "moderate", "steep"]);
  });

  it("sections tile the route: lengths, times and climb add up to the totals", () => {
    const secs = splitSections(grid, cells);
    const tot = routeTotals(grid, cells);
    expect(secs.length).toBeGreaterThan(1);
    expect(secs.reduce((a, s) => a + s.lengthM, 0)).toBeCloseTo(tot.distanceM, 6);
    expect(secs.reduce((a, s) => a + s.outS, 0)).toBeCloseTo(tot.outS, 6);
    expect(secs.reduce((a, s) => a + s.backS, 0)).toBeCloseTo(tot.backS, 6);
    expect(secs.reduce((a, s) => a + s.ascentM, 0)).toBeCloseTo(tot.ascentM, 6);
    expect(secs[0].fromM).toBe(0);
    for (let i = 1; i < secs.length; i++) {
      expect(secs[i].fromM).toBeCloseTo(secs[i - 1].toM, 6);
      expect(secs[i].cells[0]).toBe(secs[i - 1].cells[secs[i - 1].cells.length - 1]); // shared joint cell
    }
  });

  it("out time equals the engine's moveTimeS sum, and uphill out is slower than the walk back", () => {
    const tot = routeTotals(grid, cells);
    let s = 0;
    for (let i = 1; i < cells.length; i++) s += moveTimeS(grid, cells[i - 1], cells[i]);
    expect(tot.outS).toBeCloseTo(s, 9);
    expect(tot.outS).toBeGreaterThan(tot.backS); // the route climbs
    expect(tot.roundTripL).toBeCloseTo(oxygenLitres(tot.outS + tot.backS), 9);
  });

  it("no section is shorter than 30 m unless the whole route is, and at most 7 sections", () => {
    const secs = splitSections(grid, cells);
    expect(secs.length).toBeLessThanOrEqual(7);
    for (const s of secs) expect(s.lengthM).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(splitSections(grid, [at(5, 5), at(5, 6)]).length).toBe(1);
    expect(splitSections(grid, [at(5, 5)])).toEqual([]);
  });

  it("slope shares add to 100 percent", () => {
    const t = routeTotals(grid, cells);
    expect(t.shares.flat + t.shares.gentle + t.shares.moderate + t.shares.steep).toBeCloseTo(100, 6);
  });
});

describe("strategy comparison", () => {
  it("each route is the cheapest of the three under its own formula", () => {
    // a field with a steep hump the shortest route crosses and the safest avoids
    const n = 30;
    const e = new Float32Array(n * n);
    const sl = new Float32Array(n * n);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) {
        const hump = r >= 8 && r <= 21 && c >= 10 && c <= 19;
        e[r * n + c] = hump ? 60 : 0;
        sl[r * n + c] = hump ? 22 : 2;
      }
    const g = makeGrid(e, sl, n, n, 0, 5927.469752330622, 10);
    const res = compareStrategies(g, [15 * n + 2, 15 * n + 27]);
    expect(res.map((r) => r.name)).toEqual(["shortest", "balanced", "safest"]);
    for (const r of res) {
      for (const other of res) expect(r.cost[r.name]).toBeLessThanOrEqual(other.cost[r.name] + 1e-6);
    }
    const shortest = res[0].totals;
    const safest = res[2].totals;
    expect(safest.distanceM).toBeGreaterThanOrEqual(shortest.distanceM - 1e-6);
    expect(safest.steepestDeg).toBeLessThanOrEqual(shortest.steepestDeg);
  });
});

describe("what-ifs", () => {
  it("20% more energy scales oxygen by 1.2; 20% slower walking stretches the walking time by 1.25", () => {
    const t = routeTotals(grid, cells);
    const s = sensitivity(t, 600, 45);
    const base = oxygenLitres(t.outS + t.backS + 600);
    expect(s[0].needL).toBeCloseTo(base, 9);
    expect(s[1].needL).toBeCloseTo(base * 1.2, 9);
    expect(s[2].needL).toBeCloseTo(oxygenLitres((t.outS + t.backS) / 0.8 + 600), 9);
    expect(s[3].spareL).toBeCloseTo(45 - s[3].needL, 9);
  });

  it("the longest observation that keeps the 20% margin uses exactly 80% of the reserve", () => {
    const t = routeTotals(grid, cells);
    const m = maxObservationMin(t.roundTripL, 45);
    expect(t.roundTripL + oxygenLitres(m * 60)).toBeCloseTo(0.8 * 45, 9);
    expect(maxObservationMin(100, 45)).toBe(0);
  });

  it("the reachable area shrinks when the reserve shrinks", () => {
    const big = reach(grid, at(20, 2), 60);
    const small = reach(grid, at(20, 2), 5);
    expect(big.reachableCells).toBeGreaterThan(small.reachableCells);
    expect(big.reachableCells).toBeLessThanOrEqual(big.totalCells);
  });

  it("the shown Tobler factor matches the engine's walking speed", () => {
    for (const grade of [-0.2, -0.05, 0, 0.1, 0.3]) expect(FLAT_SPEED_KMH * toblerFactor(grade)).toBeCloseTo(walkingSpeedKmh(grade), 9);
  });
});
