import { describe, expect, it } from "vitest";
import { oxygenLitres } from "./assumptions";
import type { RouteStep } from "./steps";
import { O2_PER_MIN, assess } from "./verdict";

// A straight two-cell walk: cell 0 (base) -> cell 1 (destination).
function walk(outS: number, backS: number, slopeDeg = 5) {
  const step = (cell: number, timeS: number): RouteStep => ({
    cell, row: 0, col: cell, elevationM: 0, slopeDeg, gradePct: 0, stepM: 0,
    distanceM: cell * 100, timeS, energyKcal: 0, oxygenL: oxygenLitres(timeS),
  });
  const steps = [step(0, 0), step(1, outS)];
  const times = new Float64Array([0, backS]); // seconds back to base per cell
  return { steps, times };
}

describe("assess", () => {
  it("O2_PER_MIN follows the model assumptions (234 kcal/h / 4.8 kcal/L)", () => {
    expect(O2_PER_MIN).toBeCloseTo(234 / 60 / 4.8, 6);
  });

  it("GO for a short trip, with science time = spare oxygen / rate", () => {
    const { steps, times } = walk(300, 300);
    const v = assess(steps, times, 30);
    expect(v.level).toBe("go");
    const spare = 30 - 2 * oxygenLitres(300);
    expect(v.scienceMin).toBeCloseTo(spare / O2_PER_MIN, 6);
    expect(v.pointOfNoReturn).toBeNull();
  });

  it("NO-GO when out + back exceeds the reserve", () => {
    const { steps, times } = walk(1200, 1200); // 2 x 16.25 L > 30 L
    const v = assess(steps, times, 30);
    expect(v.level).toBe("no-go");
    expect(v.scienceMin).toBe(0);
    expect(v.pointOfNoReturn).toBe(1);
  });

  it("NO-GO when there is no way back", () => {
    const { steps, times } = walk(300, Infinity);
    expect(assess(steps, times, 30).level).toBe("no-go");
  });

  it("CAUTION above 80% of the reserve committed", () => {
    const { steps, times } = walk(900, 900); // 24.4 L of 30 L
    expect(assess(steps, times, 30).level).toBe("caution");
  });

  it("CAUTION on slopes at 80% of the limit", () => {
    const { steps, times } = walk(300, 300, 21);
    expect(assess(steps, times, 30).level).toBe("caution");
  });
});
