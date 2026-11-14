import { MAX_SLOPE_DEG } from "./cost";
import { oxygenLitres } from "./assumptions";
import type { RouteStep } from "./steps";

// Where the astronaut is, and what the suit reads, t seconds into the walk.
export interface ReplayState {
  index: number; // last step reached
  frac: number; // 0..1 progress from step index to index + 1
  timeS: number;
  distanceM: number;
  elevationM: number;
  slopeDeg: number;
  oxygenUsedL: number;
  done: boolean;
}

// Linear interpolation between the two route cells around time t.
export function stateAt(steps: RouteStep[], t: number): ReplayState {
  const last = steps[steps.length - 1];
  if (t >= last.timeS || steps.length === 1) {
    return { index: steps.length - 1, frac: 0, timeS: last.timeS, distanceM: last.distanceM, elevationM: last.elevationM, slopeDeg: last.slopeDeg, oxygenUsedL: last.oxygenL, done: true };
  }
  const time = Math.max(0, t);
  let i = 0;
  while (steps[i + 1].timeS <= time) i++; // steps are ordered by time
  const a = steps[i];
  const b = steps[i + 1];
  const frac = (time - a.timeS) / (b.timeS - a.timeS);
  const mix = (x: number, y: number) => x + (y - x) * frac;
  return {
    index: i,
    frac,
    timeS: time,
    distanceM: mix(a.distanceM, b.distanceM),
    elevationM: mix(a.elevationM, b.elevationM),
    slopeDeg: frac < 0.5 ? a.slopeDeg : b.slopeDeg,
    oxygenUsedL: oxygenLitres(time),
    done: false,
  };
}

export type AlertLevel = "ok" | "caution" | "turn-back";

export interface Alert {
  level: AlertLevel;
  text: string;
}

// HUD alerts. The thresholds below are display choices, not NASA rules:
// caution at 80% of the reserve committed or at 80% of the slope limit.
export const CAUTION_FRACTION = 0.8;

export function alertsFor(s: ReplayState, returnNeedL: number, reserveL: number): Alert[] {
  const committed = s.oxygenUsedL + returnNeedL;
  const alerts: Alert[] = [];
  if (committed > reserveL) {
    alerts.push({ level: "turn-back", text: `TURN BACK: ${committed.toFixed(0)} L committed (used + return) exceeds the ${reserveL} L reserve` });
  } else if (committed > reserveL * CAUTION_FRACTION) {
    alerts.push({ level: "caution", text: `Oxygen margin low: ${(reserveL - committed).toFixed(0)} L to spare after the walk back` });
  }
  if (s.slopeDeg >= MAX_SLOPE_DEG * CAUTION_FRACTION) {
    alerts.push({ level: "caution", text: `Steep ground: ${s.slopeDeg.toFixed(0)} deg (limit ${MAX_SLOPE_DEG})` });
  }
  return alerts;
}
