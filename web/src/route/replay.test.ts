import { describe, expect, it } from "vitest";
import { oxygenLitres } from "./assumptions";
import { astar } from "./astar";
import { MAX_SLOPE_DEG, STRATEGIES, makeGrid } from "./cost";
import { alertsFor, stateAt } from "./replay";
import { buildSteps } from "./steps";

const rows = 6;
const cols = 8;
const elevation = Float32Array.from({ length: rows * cols }, (_, i) => (i % cols) * 30);
const g = makeGrid(elevation, new Float32Array(rows * cols).fill(4), rows, cols, -5, 32, 1852.2306687);
const steps = buildSteps(g, astar(g, STRATEGIES.shortest, 0, rows * cols - 1)!.cells);
const end = steps.at(-1)!;

describe("replay state", () => {
  it("starts at the first step and ends at the last", () => {
    const s0 = stateAt(steps, 0);
    expect([s0.index, s0.distanceM, s0.oxygenUsedL, s0.done]).toEqual([0, 0, 0, false]);
    const s1 = stateAt(steps, end.timeS + 10);
    expect([s1.index, s1.done]).toEqual([steps.length - 1, true]);
    expect(s1.distanceM).toBeCloseTo(end.distanceM, 9);
  });

  it("matches each step exactly at its own time and grows monotonically", () => {
    let prev = -1;
    for (const st of steps.slice(0, -1)) {
      const s = stateAt(steps, st.timeS);
      expect(s.distanceM).toBeCloseTo(st.distanceM, 6);
      expect(s.oxygenUsedL).toBeCloseTo(oxygenLitres(st.timeS), 9);
      expect(s.distanceM).toBeGreaterThan(prev - 1e-9);
      prev = s.distanceM;
    }
  });

  it("interpolates halfway between two steps", () => {
    const a = steps[1];
    const b = steps[2];
    const s = stateAt(steps, (a.timeS + b.timeS) / 2);
    expect(s.index).toBe(1);
    expect(s.frac).toBeCloseTo(0.5, 9);
    expect(s.distanceM).toBeCloseTo((a.distanceM + b.distanceM) / 2, 6);
  });
});

describe("HUD alerts", () => {
  const base = stateAt(steps, 0);
  it("is quiet with plenty of oxygen on gentle ground", () => {
    expect(alertsFor({ ...base, oxygenUsedL: 1 }, 1, 100)).toEqual([]);
  });
  it("cautions above 80% committed and demands turn-back above the reserve", () => {
    expect(alertsFor({ ...base, oxygenUsedL: 40 }, 45, 100)[0].level).toBe("caution");
    expect(alertsFor({ ...base, oxygenUsedL: 60 }, 45, 100)[0].level).toBe("turn-back");
  });
  it("warns on steep ground near the slope limit", () => {
    const a = alertsFor({ ...base, slopeDeg: MAX_SLOPE_DEG * 0.9 }, 0, 100);
    expect(a.map((x) => x.level)).toEqual(["caution"]);
  });
});
