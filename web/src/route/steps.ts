import { METABOLIC_KCAL_PER_H, oxygenLitres, walkingSpeedKmh } from "./assumptions";
import { groundDistance, type Grid } from "./cost";

// One entry per route cell. The stats panel, elevation profile, Level 1 replay
// HUD and Level 2 3D view all read this same list. Cumulative values are
// measured from the start up to and including this cell.
export interface RouteStep {
  cell: number;
  row: number;
  col: number;
  elevationM: number;
  slopeDeg: number; // terrain slope of the cell (steepest direction)
  gradePct: number; // rise/run of the move INTO this cell, positive uphill (0 at start)
  stepM: number; // ground distance of the move into this cell
  distanceM: number;
  timeS: number;
  energyKcal: number;
  oxygenL: number;
}

export interface RouteSummary {
  distanceM: number;
  ascentM: number;
  descentM: number;
  maxSlopeDeg: number;
  timeS: number;
  energyKcal: number;
  oxygenL: number;
}

export function buildSteps(g: Grid, cells: number[]): RouteStep[] {
  const steps: RouteStep[] = [];
  let distanceM = 0;
  let timeS = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    let stepM = 0;
    let grade = 0;
    if (i > 0) {
      stepM = groundDistance(g, cells[i - 1], cell);
      grade = (g.elevation[cell] - g.elevation[cells[i - 1]]) / stepM;
      distanceM += stepM;
      timeS += stepM / ((walkingSpeedKmh(grade) * 1000) / 3600);
    }
    const energyKcal = (METABOLIC_KCAL_PER_H * timeS) / 3600;
    steps.push({
      cell,
      row: Math.floor(cell / g.cols),
      col: cell % g.cols,
      elevationM: g.elevation[cell],
      slopeDeg: g.slopeDeg[cell],
      gradePct: grade * 100,
      stepM,
      distanceM,
      timeS,
      energyKcal,
      oxygenL: oxygenLitres(timeS),
    });
  }
  return steps;
}

export function summarize(steps: RouteStep[]): RouteSummary {
  let ascentM = 0;
  let descentM = 0;
  let maxSlopeDeg = 0;
  for (let i = 0; i < steps.length; i++) {
    maxSlopeDeg = Math.max(maxSlopeDeg, steps[i].slopeDeg);
    if (i > 0) {
      const dz = steps[i].elevationM - steps[i - 1].elevationM;
      if (dz > 0) ascentM += dz;
      else descentM -= dz;
    }
  }
  const last = steps[steps.length - 1];
  return {
    distanceM: last.distanceM,
    ascentM,
    descentM,
    maxSlopeDeg,
    timeS: last.timeS,
    energyKcal: last.energyKcal,
    oxygenL: last.oxygenL,
  };
}
