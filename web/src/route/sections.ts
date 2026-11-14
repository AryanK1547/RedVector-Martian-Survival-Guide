import { FLAT_SPEED_KMH, METABOLIC_KCAL_PER_H, oxygenLitres } from "./assumptions";
import { astar } from "./astar";
import { STRATEGIES, groundDistance, stepCost, type Grid, type StrategyName } from "./cost";
import { moveTimeS, returnTimes } from "./noreturn";
import { CAUTION_FRACTION } from "./replay";

// Analysis behind the Educational view: split a route into sections, compare the
// three strategies, and show how each number is built. Everything here is a pure
// function of the grid, so it can be tested and the numbers always match the
// simulation (they call the same moveTimeS, stepCost and oxygenLitres).

export type SlopeClass = "flat" | "gentle" | "moderate" | "steep";

// Display classes for the terrain slope (steepest direction of a cell), in degrees.
// The cut points are a display choice for teaching, not NASA values.
export const SLOPE_CLASS_LIMITS = { flat: 5, gentle: 10, moderate: 15 };
export function slopeClass(deg: number): SlopeClass {
  return deg < SLOPE_CLASS_LIMITS.flat ? "flat" : deg < SLOPE_CLASS_LIMITS.gentle ? "gentle" : deg < SLOPE_CLASS_LIMITS.moderate ? "moderate" : "steep";
}

export interface Section {
  index: number;
  cls: SlopeClass;
  fromM: number; // distance along the route where the section starts
  toM: number;
  lengthM: number;
  startElevM: number;
  endElevM: number;
  ascentM: number; // sum of the upward steps
  descentM: number; // sum of the downward steps
  meanGradePct: number; // net rise over run along the path (signed)
  meanSlopeDeg: number; // terrain slope of the cells, weighted by step length
  maxSlopeDeg: number;
  outS: number; // walking time along the route direction
  backS: number; // walking time over the same ground the other way
  cells: number[]; // cell indices, both ends included
}

const MIN_SECTION_M = 30;
const MAX_SECTIONS = 7;

function stepSlope(g: Grid, a: number, b: number): number {
  return (g.slopeDeg[a] + g.slopeDeg[b]) / 2; // the same average stepCost uses
}

function build(g: Grid, cells: number[], a: number, b: number, index: number, fromM: number): Section {
  let len = 0;
  let asc = 0;
  let desc = 0;
  let outS = 0;
  let backS = 0;
  let slopeSum = 0;
  let maxSlope = 0;
  for (let i = a + 1; i <= b; i++) {
    const d = groundDistance(g, cells[i - 1], cells[i]);
    const dz = g.elevation[cells[i]] - g.elevation[cells[i - 1]];
    len += d;
    if (dz > 0) asc += dz;
    else desc -= dz;
    outS += moveTimeS(g, cells[i - 1], cells[i]);
    backS += moveTimeS(g, cells[i], cells[i - 1]);
    const sl = stepSlope(g, cells[i - 1], cells[i]);
    slopeSum += sl * d;
    maxSlope = Math.max(maxSlope, g.slopeDeg[cells[i]], g.slopeDeg[cells[i - 1]]);
  }
  const meanSlope = len > 0 ? slopeSum / len : 0;
  const startZ = g.elevation[cells[a]];
  const endZ = g.elevation[cells[b]];
  return {
    index,
    cls: slopeClass(meanSlope),
    fromM: fromM,
    toM: fromM + len,
    lengthM: len,
    startElevM: startZ,
    endElevM: endZ,
    ascentM: asc,
    descentM: desc,
    meanGradePct: len > 0 ? ((endZ - startZ) / len) * 100 : 0,
    meanSlopeDeg: meanSlope,
    maxSlopeDeg: maxSlope,
    outS,
    backS,
    cells: cells.slice(a, b + 1),
  };
}

// Split a route into sections of similar slope: group runs of steps with the same
// slope class, then merge any run shorter than MIN_SECTION_M (and the smallest
// runs, until at most MAX_SECTIONS remain) into the longer neighbour.
export function splitSections(g: Grid, cells: number[]): Section[] {
  if (cells.length < 2) return [];
  // runs as [firstStep, lastStep] over step indices 1..n-1
  const runs: { a: number; b: number; len: number }[] = [];
  let cls: SlopeClass | null = null;
  for (let i = 1; i < cells.length; i++) {
    const c = slopeClass(stepSlope(g, cells[i - 1], cells[i]));
    const d = groundDistance(g, cells[i - 1], cells[i]);
    if (c === cls && runs.length) {
      runs[runs.length - 1].b = i;
      runs[runs.length - 1].len += d;
    } else {
      runs.push({ a: i, b: i, len: d });
      cls = c;
    }
  }
  while (runs.length > 1) {
    let k = 0;
    for (let i = 1; i < runs.length; i++) if (runs[i].len < runs[k].len) k = i;
    if (runs[k].len >= MIN_SECTION_M && runs.length <= MAX_SECTIONS) break;
    const nb = k === 0 ? 1 : k === runs.length - 1 ? k - 1 : runs[k - 1].len >= runs[k + 1].len ? k - 1 : k + 1;
    const lo = Math.min(k, nb);
    const hi = Math.max(k, nb);
    runs.splice(lo, 2, { a: runs[lo].a, b: runs[hi].b, len: runs[lo].len + runs[hi].len });
  }
  const out: Section[] = [];
  let from = 0;
  runs.forEach((r, i) => {
    const s = build(g, cells, r.a - 1, r.b, i, from);
    out.push(s);
    from += s.lengthM;
  });
  return out;
}

export interface RouteTotals {
  distanceM: number;
  outS: number;
  backS: number;
  ascentM: number;
  descentM: number;
  steepestDeg: number;
  steepSharePct: number; // share of the path length on ground at or above 15 degrees
  roundTripL: number; // walking out and back
  shares: Record<SlopeClass, number>; // percent of the path length per slope class
}

export function routeTotals(g: Grid, cells: number[]): RouteTotals {
  let dist = 0;
  let outS = 0;
  let backS = 0;
  let asc = 0;
  let desc = 0;
  let steepest = 0;
  const len: Record<SlopeClass, number> = { flat: 0, gentle: 0, moderate: 0, steep: 0 };
  for (let i = 1; i < cells.length; i++) {
    const d = groundDistance(g, cells[i - 1], cells[i]);
    const dz = g.elevation[cells[i]] - g.elevation[cells[i - 1]];
    dist += d;
    if (dz > 0) asc += dz;
    else desc -= dz;
    outS += moveTimeS(g, cells[i - 1], cells[i]);
    backS += moveTimeS(g, cells[i], cells[i - 1]);
    steepest = Math.max(steepest, g.slopeDeg[cells[i]]);
    len[slopeClass(stepSlope(g, cells[i - 1], cells[i]))] += d;
  }
  const pct = (x: number) => (dist > 0 ? (100 * x) / dist : 0);
  return {
    distanceM: dist,
    outS,
    backS,
    ascentM: asc,
    descentM: desc,
    steepestDeg: steepest,
    steepSharePct: pct(len.steep),
    roundTripL: oxygenLitres(outS + backS),
    shares: { flat: pct(len.flat), gentle: pct(len.gentle), moderate: pct(len.moderate), steep: pct(len.steep) },
  };
}

// Cost of a route under one strategy's formula (what A* minimises), in "penalised metres".
export function routeCost(g: Grid, name: StrategyName, cells: number[]): number {
  let c = 0;
  for (let i = 1; i < cells.length; i++) c += stepCost(g, STRATEGIES[name], cells[i - 1], cells[i]);
  return c;
}

export const STRATEGY_ORDER: StrategyName[] = ["shortest", "balanced", "safest"];

export interface StrategyRoute {
  name: StrategyName;
  cells: number[];
  totals: RouteTotals;
  cost: Record<StrategyName, number>; // this route priced by every strategy's formula
}

// Plan base -> waypoints -> goal under each strategy, and price every route under
// every formula. Each route is cheapest under its own formula: that is A* working.
export function compareStrategies(g: Grid, stops: number[]): StrategyRoute[] {
  const out: StrategyRoute[] = [];
  for (const name of STRATEGY_ORDER) {
    const cells: number[] = [];
    let ok = true;
    for (let i = 0; i + 1 < stops.length && ok; i++) {
      const r = astar(g, STRATEGIES[name], stops[i], stops[i + 1]);
      if (!r) ok = false;
      else cells.push(...(i ? r.cells.slice(1) : r.cells));
    }
    if (!ok) continue;
    out.push({
      name,
      cells,
      totals: routeTotals(g, cells),
      cost: { shortest: routeCost(g, "shortest", cells), balanced: routeCost(g, "balanced", cells), safest: routeCost(g, "safest", cells) },
    });
  }
  return out;
}

export interface Sensitivity {
  label: string;
  needL: number;
  spareL: number;
}

// How the oxygen need moves if two assumptions are wrong. Oxygen = rate x time, so a
// 20% higher metabolic rate scales it by 1.2, and a 20% slower walk stretches the walking time by 1.25.
export function sensitivity(t: RouteTotals, scienceS: number, reserveL: number): Sensitivity[] {
  const mk = (label: string, kcalF: number, speedF: number): Sensitivity => {
    const need = oxygenLitres((t.outS + t.backS) / speedF + scienceS) * kcalF;
    return { label, needL: need, spareL: reserveL - need };
  };
  return [mk("As modelled", 1, 1), mk("Suit and load use 20% more energy", 1.2, 1), mk("Walking 20% slower", 1, 0.8), mk("Both", 1.2, 0.8)];
}

// Longest observation that still keeps the 20% margin (the CAUTION line at 80% of the reserve).
export function maxObservationMin(roundTripL: number, reserveL: number): number {
  return Math.max(0, (CAUTION_FRACTION * reserveL - roundTripL) / oxygenLitres(60));
}

export interface Reach {
  totalCells: number;
  passableCells: number;
  reachableCells: number; // passable cells from which the base can still be reached on the reserve
}

// How much of the mapped square you could walk to and still get home on the reserve:
// Dijkstra run backwards from the base (the same search the Return map uses).
export function reach(g: Grid, base: number, reserveL: number): Reach {
  const times = returnTimes(g, base);
  let passable = 0;
  let reachable = 0;
  for (let i = 0; i < times.length; i++) {
    if (g.slopeDeg[i] <= 25) passable++;
    if (Number.isFinite(times[i]) && oxygenLitres(times[i]) <= reserveL) reachable++;
  }
  return { totalCells: times.length, passableCells: passable, reachableCells: reachable };
}

// Numbers for "how is this row calculated": speed from the grade, oxygen from the time.
export function toblerFactor(grade: number): number {
  // walkingSpeedKmh(grade) / FLAT_SPEED_KMH, written out so the panel can show it
  const f = (s: number) => Math.exp(-3.5 * Math.abs(s + 0.05));
  return f(grade) / f(0);
}
export const MODEL = { FLAT_SPEED_KMH, METABOLIC_KCAL_PER_H };
