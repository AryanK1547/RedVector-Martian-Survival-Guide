import { oxygenLitres } from "./assumptions";
import { MAX_SLOPE_DEG } from "./cost";
import { checkRoute } from "./noreturn";
import { CAUTION_FRACTION } from "./replay";
import type { RouteStep } from "./steps";

// Turns route numbers into the decision an astronaut actually needs:
// can I go there, how long can I work there, and can I get back?
// Thresholds: the oxygen reserve is the user's input (demo value); the slope
// limit is MAX_SLOPE_DEG; CAUTION_FRACTION (80%) is a display choice, not a NASA rule.

export type VerdictLevel = "go" | "caution" | "no-go";

export interface Verdict {
  level: VerdictLevel;
  reasons: string[];
  reserveL: number;
  outL: number; // oxygen used walking to the destination
  backL: number; // oxygen needed to walk back from the destination (Infinity if no way back)
  backS: number; // walking time back from the destination, seconds
  peakL: number; // worst (used so far + needed to return) anywhere along the route
  maxSlopeDeg: number;
  scienceMin: number; // minutes at the destination before the walk back must start
  pointOfNoReturn: number | null; // step index where turning back is no longer affordable
}

// Litres of oxygen per minute at the assumed metabolic rate (same rate as
// walking; time spent working at the site is assumed to cost the same).
export const O2_PER_MIN = oxygenLitres(60);

export function assess(steps: RouteStep[], times: Float64Array, reserveL: number): Verdict {
  const last = steps[steps.length - 1];
  const outL = last.oxygenL;
  const backS = times[last.cell];
  const backL = oxygenLitres(backS);
  const check = checkRoute(steps, times, reserveL);
  const maxSlopeDeg = steps.reduce((m, s) => Math.max(m, s.slopeDeg), 0);
  const spare = reserveL - outL - backL;
  const reasons: string[] = [];
  let level: VerdictLevel = "go";

  if (!Number.isFinite(backS)) {
    level = "no-go";
    reasons.push("No walkable way back from the destination below the slope limit.");
  } else if (check.pointOfNoReturn) {
    level = "no-go";
    reasons.push(
      `Out and back needs ${(outL + backL).toFixed(0)} L, more than the ${reserveL} L reserve. Pick a closer stop or raise the reserve.`,
    );
  } else {
    if (check.peakRoundTripL > reserveL * CAUTION_FRACTION) {
      level = "caution";
      reasons.push(`Thin oxygen margin: up to ${check.peakRoundTripL.toFixed(0)} of ${reserveL} L committed.`);
    }
    if (maxSlopeDeg >= MAX_SLOPE_DEG * CAUTION_FRACTION) {
      level = "caution";
      reasons.push(`Steep ground: ${maxSlopeDeg.toFixed(0)} deg on the route (limit ${MAX_SLOPE_DEG} deg).`);
    }
    if (level === "go") reasons.push(`Round trip fits with ${spare.toFixed(0)} L to spare.`);
  }

  return {
    level,
    reasons,
    reserveL,
    outL,
    backL,
    backS,
    peakL: check.peakRoundTripL,
    maxSlopeDeg,
    scienceMin: level === "no-go" ? 0 : Math.max(0, spare) / O2_PER_MIN,
    pointOfNoReturn: check.pointOfNoReturn?.index ?? null,
  };
}
