import { describe, expect, it } from "vitest";
import { FLAT_SPEED_KMH, KCAL_PER_LITRE_O2, METABOLIC_KCAL_PER_H, walkingSpeedKmh } from "./assumptions";
import { astar } from "./astar";
import { STRATEGIES, groundDistance, makeGrid } from "./cost";
import { buildSteps, summarize } from "./steps";

describe("walking speed model", () => {
  it("gives the flat speed on flat ground, slower uphill and on steep downhill", () => {
    expect(walkingSpeedKmh(0)).toBeCloseTo(FLAT_SPEED_KMH, 10);
    expect(walkingSpeedKmh(0.1)).toBeLessThan(FLAT_SPEED_KMH);
    expect(walkingSpeedKmh(-0.05)).toBeGreaterThan(FLAT_SPEED_KMH); // Tobler peak
    expect(walkingSpeedKmh(-0.3)).toBeLessThan(FLAT_SPEED_KMH);
  });
});

describe("route steps", () => {
  const rows = 8;
  const cols = 9;
  const elevation = Int16Array.from({ length: rows * cols }, (_, i) => (i % cols) * 40 + Math.floor(i / cols) * 15);
  const g = makeGrid(elevation, new Float32Array(rows * cols).fill(3), rows, cols, -5, 32, 1852.2306687);
  const route = astar(g, STRATEGIES.balanced, 0, rows * cols - 1)!;
  const steps = buildSteps(g, route.cells);
  const total = summarize(steps);

  it("step distances add up to the route length", () => {
    let length = 0;
    for (let i = 1; i < route.cells.length; i++) length += groundDistance(g, route.cells[i - 1], route.cells[i]);
    expect(steps.reduce((a, s) => a + s.stepM, 0)).toBeCloseTo(length, 6);
    expect(total.distanceM).toBeCloseTo(length, 6);
  });

  it("starts at zero and only grows", () => {
    expect([steps[0].distanceM, steps[0].timeS, steps[0].oxygenL]).toEqual([0, 0, 0]);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].timeS).toBeGreaterThan(steps[i - 1].timeS);
      expect(steps[i].oxygenL).toBeGreaterThan(steps[i - 1].oxygenL);
    }
  });

  it("energy and oxygen follow the stated rates", () => {
    expect(total.energyKcal).toBeCloseTo((METABOLIC_KCAL_PER_H * total.timeS) / 3600, 6);
    expect(total.oxygenL).toBeCloseTo(total.energyKcal / KCAL_PER_LITRE_O2, 6);
  });

  it("ascent minus descent equals the net height change", () => {
    const net = steps[steps.length - 1].elevationM - steps[0].elevationM;
    expect(total.ascentM - total.descentM).toBeCloseTo(net, 6);
  });

  it("a one-cell route has zero totals", () => {
    expect(summarize(buildSteps(g, [5]))).toEqual({
      distanceM: 0, ascentM: 0, descentM: 0, maxSlopeDeg: 3, timeS: 0, energyKcal: 0, oxygenL: 0,
    });
  });
});
