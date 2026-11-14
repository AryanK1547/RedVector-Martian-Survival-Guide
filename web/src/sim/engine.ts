import { oxygenLitres } from "../route/assumptions";
import { astar } from "../route/astar";
import { groundDistance, type Grid, type Strategy } from "../route/cost";
import { moveTimeS } from "../route/noreturn";
import { CAUTION_FRACTION } from "../route/replay";

// Live EVA simulation: an astronaut walks base -> destination -> science ->
// base on the real terrain, while calamities change the situation. At each
// calamity the engine works out the options FROM WHERE THE ASTRONAUT IS NOW
// and recommends one; mission control (the user) or the astronaut decides.
// Pure logic, no DOM, so it is unit tested.

// SCENARIO PARAMETERS: demo values for training, NOT NASA data. They set how
// hard each calamity hits; the terrain, routing and oxygen model are unchanged.
export const SCENARIO = {
  rockfallRadiusM: 40, // ground made impassable around a point on the route ahead
  leakO2Factor: 1.5, // suit leak: oxygen used 1.5x faster from then on
  dustSpeedFactor: 0.6, // dust storm: walking speed x0.6 (poor visibility)
  injurySpeedFactor: 0.5, // injury: walking speed x0.5
  speDeadlineMin: 30, // solar particle event warning: be back at base within 30 min
} as const;

export type CalamityKind = "rockfall" | "leak" | "dust" | "injury" | "spe";

export const CALAMITIES: Record<CalamityKind, { label: string; icon: string; detail: string }> = {
  rockfall: { label: "Rockfall ahead", icon: "⛰", detail: `Ground within ${SCENARIO.rockfallRadiusM} m of a point on the route ahead is now impassable.` },
  leak: { label: "Suit O₂ leak", icon: "⚠", detail: `Oxygen is now used ${SCENARIO.leakO2Factor}x faster.` },
  dust: { label: "Dust storm", icon: "☁", detail: `Visibility drops; walking speed x${SCENARIO.dustSpeedFactor}.` },
  injury: { label: "Astronaut injured", icon: "✚", detail: `Twisted ankle; walking speed x${SCENARIO.injurySpeedFactor}.` },
  spe: { label: "Solar particle event", icon: "☢", detail: `Radiation warning: be back at base within ${SCENARIO.speDeadlineMin} min.` },
};

export type Phase = "outbound" | "science" | "inbound" | "returned" | "lost";

export interface OptionPlan {
  id: "continue" | "return";
  label: string;
  path: number[]; // from the astronaut's next cell
  walkS: number; // walking time for the whole option, at current speed
  scienceS: number; // science time included (continue only)
  needL: number; // oxygen the option needs
  spareL: number; // oxygen left at base afterwards (negative = runs out)
  arriveS: number; // mission time of arrival back at base
  feasible: boolean; // oxygen lasts AND the deadline (if any) is met
  note: string;
}

export interface LogEntry {
  t: number;
  kind: "info" | "event" | "decision" | "end";
  text: string;
}

export interface SimConfig {
  grid: Grid;
  base: number;
  goal: number;
  outPath: number[]; // the planned route base -> goal
  reserveL: number;
  strategy: Strategy;
  scienceS: number; // planned science time at the destination
}

// Small, seeded random generator (mulberry32): the same seed gives the same
// calamities, so a training run can be repeated exactly.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Sim {
  t = 0;
  o2UsedL = 0;
  phase: Phase = "outbound";
  path: number[];
  idx = 0; // last cell reached on path
  segS = 0; // seconds already spent on the segment path[idx] -> path[idx + 1]
  scienceLeftS: number;
  scienceDoneS = 0;
  speedFactor = 1;
  o2Factor = 1;
  deadlineS: number | null = null;
  deadlineMissed = false;
  active = new Set<CalamityKind>();
  blocked: Uint8Array;
  hazard: Grid;
  log: LogEntry[] = [];
  trail: number[] = [];
  scheduled: { atS: number; kind: CalamityKind }[] = [];
  private rand: () => number;

  constructor(
    private cfg: SimConfig,
    seed = 1,
  ) {
    this.path = cfg.outPath.slice();
    this.trail = [this.path[0]];
    this.scienceLeftS = cfg.scienceS;
    this.blocked = new Uint8Array(cfg.grid.rows * cfg.grid.cols);
    this.hazard = cfg.grid;
    this.rand = rng(seed);
    this.note("info", "EVA started. Walking to the destination.");
  }

  get reserveL(): number {
    return this.cfg.reserveL;
  }
  get o2LeftL(): number {
    return Math.max(0, this.cfg.reserveL - this.o2UsedL);
  }
  get done(): boolean {
    return this.phase === "returned" || this.phase === "lost";
  }

  // Seconds to walk path[i] -> path[i + 1] at the current speed.
  private segTime(path: number[], i: number): number {
    return moveTimeS(this.hazard, path[i], path[i + 1]) / this.speedFactor;
  }
  private pathTime(path: number[]): number {
    let s = 0;
    for (let i = 0; i + 1 < path.length; i++) s += this.segTime(path, i);
    return s;
  }
  private litres(seconds: number): number {
    return oxygenLitres(seconds) * this.o2Factor;
  }
  private note(kind: LogEntry["kind"], text: string) {
    this.log.push({ t: this.t, kind, text });
  }

  // Where the astronaut is: between path[idx] and path[idx + 1].
  position(): { from: number; to: number; frac: number } {
    const to = this.path[Math.min(this.idx + 1, this.path.length - 1)];
    const segT = this.idx + 1 < this.path.length ? this.segTime(this.path, this.idx) : 1;
    return { from: this.path[this.idx], to, frac: Math.min(1, this.segS / segT) };
  }

  // Options start from the next cell; the rest of the current step is added.
  private here(): { cell: number; extraS: number } {
    if (this.phase !== "outbound" && this.phase !== "inbound") return { cell: this.path[this.idx], extraS: 0 };
    if (this.idx + 1 >= this.path.length) return { cell: this.path[this.idx], extraS: 0 };
    return { cell: this.path[this.idx + 1], extraS: Math.max(0, this.segTime(this.path, this.idx) - this.segS) };
  }

  private plan(from: number, to: number): number[] | null {
    if (from === to) return [from];
    return astar(this.hazard, this.cfg.strategy, from, to)?.cells ?? null;
  }

  // Random calamities at random times in the first 70% of the planned mission.
  scheduleRandom(count: number): void {
    const planned = this.pathTime(this.path) * 2 + this.cfg.scienceS;
    const kinds = Object.keys(CALAMITIES) as CalamityKind[];
    const picks: { atS: number; kind: CalamityKind }[] = [];
    for (let i = 0; i < count && kinds.length; i++) {
      const kind = kinds.splice(Math.floor(this.rand() * kinds.length), 1)[0];
      picks.push({ atS: (0.1 + 0.6 * this.rand()) * planned, kind });
    }
    this.scheduled = picks.sort((a, b) => a.atS - b.atS);
  }

  // Advance the clock by dt seconds. Stops early, and returns the calamity,
  // if a scheduled one comes due.
  advance(dt: number): CalamityKind | null {
    let left = dt;
    while (left > 1e-9 && !this.done) {
      const next = this.scheduled[0];
      let step = left;
      if (next) step = Math.min(step, Math.max(0, next.atS - this.t));
      if (step > 0) this.move(step);
      left -= step;
      if (next && this.t >= next.atS - 1e-9 && !this.done) {
        this.scheduled.shift();
        this.apply(next.kind);
        return next.kind;
      }
    }
    return null;
  }

  private move(dt: number) {
    let left = dt;
    while (left > 1e-9 && !this.done) {
      if (this.phase === "science") {
        const s = Math.min(left, this.scienceLeftS);
        this.burn(s);
        this.scienceLeftS -= s;
        this.scienceDoneS += s;
        left -= s;
        if (this.scienceLeftS <= 1e-9 && !this.done) this.startInbound();
        continue;
      }
      if (this.idx + 1 >= this.path.length) {
        this.arrive();
        continue;
      }
      const segT = this.segTime(this.path, this.idx);
      const s = Math.min(left, segT - this.segS);
      this.burn(s);
      this.segS += s;
      left -= s;
      if (this.segS >= segT - 1e-9) {
        this.idx++;
        this.segS = 0;
        this.trail.push(this.path[this.idx]);
        if (this.idx + 1 >= this.path.length) this.arrive();
      }
    }
  }

  private burn(s: number) {
    this.t += s;
    this.o2UsedL += this.litres(s);
    if (this.deadlineS !== null && this.t > this.deadlineS && !this.deadlineMissed) {
      this.deadlineMissed = true;
      this.note("event", "Radiation deadline passed before reaching base.");
    }
    if (this.o2UsedL >= this.cfg.reserveL) {
      this.o2UsedL = this.cfg.reserveL;
      this.phase = "lost";
      const back = this.plan(this.here().cell, this.cfg.base);
      const m = back ? this.pathLength(back) : NaN;
      this.note("end", `Oxygen reserve exhausted${Number.isFinite(m) ? `, ${Math.round(m)} m from base` : ""}. Real suits carry a separate emergency supply; in training this counts as a failed EVA.`);
    }
  }

  private pathLength(path: number[]): number {
    let m = 0;
    for (let i = 0; i + 1 < path.length; i++) m += groundDistance(this.hazard, path[i], path[i + 1]);
    return m;
  }

  private arrive() {
    const at = this.path[this.path.length - 1];
    if (this.phase === "outbound" && at === this.cfg.goal) {
      this.phase = "science";
      this.note("info", `Arrived at the destination. Science work: ${Math.round(this.scienceLeftS / 60)} min planned.`);
      if (this.scienceLeftS <= 0) this.startInbound();
    } else if (at === this.cfg.base) {
      this.phase = "returned";
      this.note("end", `Back at base with ${this.o2LeftL.toFixed(1)} L of oxygen left.`);
    } else {
      this.startInbound(); // reached the end of a path that was not the goal: head home
    }
  }

  private startInbound() {
    const from = this.path[this.idx] ?? this.path[this.path.length - 1];
    const back = this.plan(from, this.cfg.base);
    this.phase = "inbound";
    this.scienceLeftS = 0;
    if (!back) {
      this.phase = "lost";
      this.note("end", "No walkable way back to base.");
      return;
    }
    this.path = back;
    this.idx = 0;
    this.segS = 0;
    if (back.length === 1) this.arrive();
    else this.note("info", "Heading back to base.");
  }

  // Apply a calamity now. Returns a one-line description for the log.
  apply(kind: CalamityKind): string {
    let text = `${CALAMITIES[kind].label}: ${CALAMITIES[kind].detail}`;
    if (kind === "leak") this.o2Factor *= SCENARIO.leakO2Factor;
    // Slower walking stretches the current step too; scale the time already
    // spent on it so the astronaut keeps the same position along the step.
    if (kind === "dust") {
      this.speedFactor *= SCENARIO.dustSpeedFactor;
      this.segS /= SCENARIO.dustSpeedFactor;
    }
    if (kind === "injury") {
      this.speedFactor *= SCENARIO.injurySpeedFactor;
      this.segS /= SCENARIO.injurySpeedFactor;
    }
    if (kind === "spe") this.deadlineS = Math.min(this.deadlineS ?? Infinity, this.t + SCENARIO.speDeadlineMin * 60);
    if (kind === "rockfall") text = this.rockfall() ?? `${CALAMITIES.rockfall.label}: reported, but clear of the route.`;
    this.active.add(kind);
    this.note("event", text);
    return text;
  }

  // Blocks ground around a point 35-60% of the way along the route ahead,
  // keeping the astronaut, the base and the destination themselves clear.
  private rockfall(): string | null {
    const { cell } = this.here();
    let ahead: number[] | null;
    if (this.phase === "science") ahead = this.plan(cell, this.cfg.base);
    else ahead = this.path.slice(this.idx + 1);
    if (!ahead || ahead.length < 4) return null;
    const k = Math.floor(ahead.length * (0.35 + 0.25 * this.rand()));
    const centre = ahead[Math.min(k, ahead.length - 2)];
    const g = this.cfg.grid;
    const protect = [cell, this.cfg.base, this.cfg.goal];
    const cr = Math.floor(centre / g.cols);
    const cc = centre % g.cols;
    const span = Math.ceil(SCENARIO.rockfallRadiusM / g.dxMin) + 1;
    let n = 0;
    for (let r = Math.max(0, cr - span); r <= Math.min(g.rows - 1, cr + span); r++) {
      for (let c = Math.max(0, cc - span); c <= Math.min(g.cols - 1, cc + span); c++) {
        const i = r * g.cols + c;
        if (this.dist(i, centre) > SCENARIO.rockfallRadiusM) continue;
        if (protect.some((p) => this.dist(i, p) < 15)) continue;
        this.blocked[i] = 1;
        n++;
      }
    }
    const slope = Float32Array.from(g.slopeDeg as ArrayLike<number>);
    this.blocked.forEach((b, i) => b && (slope[i] = 90));
    this.hazard = { ...g, slopeDeg: slope };
    let along = 0;
    for (let i = 0; i < Math.min(k, ahead.length - 1); i++) along += groundDistance(g, ahead[i], ahead[i + 1]);
    return `${CALAMITIES.rockfall.label}: ${n} cells blocked about ${Math.round(along)} m ahead on the route.`;
  }

  private dist(a: number, b: number): number {
    const g = this.cfg.grid;
    const ra = Math.floor(a / g.cols), rb = Math.floor(b / g.cols);
    return Math.hypot(((a % g.cols) - (b % g.cols)) * g.dx[ra], (ra - rb) * g.dy);
  }

  // The choices from where the astronaut is now.
  options(): OptionPlan[] {
    const { cell, extraS } = this.here();
    const left = this.o2LeftL;
    const out: OptionPlan[] = [];
    const deadlineOk = (arrive: number) => this.deadlineS === null || arrive <= this.deadlineS;

    const home = this.plan(cell, this.cfg.base);
    const homeS = home ? extraS + this.pathTime(home) : Infinity;
    if (this.phase === "outbound" || this.phase === "science") {
      const toGoal = this.phase === "outbound" ? this.plan(cell, this.cfg.goal) : [cell];
      const fromGoal = this.plan(this.cfg.goal, this.cfg.base);
      if (toGoal && fromGoal) {
        const walkS = (this.phase === "outbound" ? extraS : 0) + this.pathTime(toGoal) + this.pathTime(fromGoal);
        // Science time that still fits the oxygen (and the deadline), capped at the plan.
        const o2Room = (left - this.litres(walkS)) / this.litres(1);
        const timeRoom = this.deadlineS === null ? Infinity : this.deadlineS - this.t - walkS;
        const scienceS = Math.max(0, Math.min(this.phase === "science" ? this.scienceLeftS : this.cfg.scienceS, o2Room, timeRoom));
        const needL = this.litres(walkS + scienceS);
        const arriveS = this.t + walkS + scienceS;
        const rerouted = this.phase === "outbound" && !sameTail(toGoal, this.path, this.idx + 1);
        out.push({
          id: "continue",
          label: this.phase === "science" ? "Continue science, then return" : rerouted ? "Continue (rerouted)" : "Continue to destination",
          path: toGoal,
          walkS,
          scienceS,
          needL,
          spareL: left - needL,
          arriveS,
          feasible: needL <= left && deadlineOk(arriveS) && (scienceS > 0 || this.phase === "science"),
          note: `${Math.floor(scienceS / 60)} min science` + (scienceS < (this.phase === "science" ? this.scienceLeftS : this.cfg.scienceS) - 1 ? " (cut short)" : ""),
        });
      } else {
        out.push({ id: "continue", label: "Continue to destination", path: [cell], walkS: Infinity, scienceS: 0, needL: Infinity, spareL: -Infinity, arriveS: Infinity, feasible: false, note: "destination cut off" });
      }
    }
    const needL = this.litres(homeS);
    out.push({
      id: "return",
      label: this.phase === "inbound" ? "Return to base (replanned)" : "Abort: return to base now",
      path: home ?? [cell],
      walkS: homeS,
      scienceS: 0,
      needL,
      spareL: left - needL,
      arriveS: this.t + homeS,
      feasible: !!home && needL <= left && deadlineOk(this.t + homeS),
      note: home ? `${Math.round(this.pathLength(home))} m to base` : "no way back",
    });
    return out;
  }

  // Rule of thumb (display choice, not a NASA rule): continue only if it is
  // feasible and keeps the same 80% caution line on oxygen; otherwise return.
  recommend(opts: OptionPlan[]): OptionPlan["id"] {
    const cont = opts.find((o) => o.id === "continue");
    const margin = this.cfg.reserveL * (1 - CAUTION_FRACTION);
    if (cont && cont.feasible && cont.spareL >= margin) return "continue";
    return "return";
  }

  choose(id: OptionPlan["id"], by: string): void {
    const opt = this.options().find((o) => o.id === id);
    if (!opt) return;
    // Finish the current step first, so the new path starts where we are going.
    if ((this.phase === "outbound" || this.phase === "inbound") && this.idx + 1 < this.path.length) {
      const rest = this.segTime(this.path, this.idx) - this.segS;
      this.idx++;
      this.segS = 0;
      this.trail.push(this.path[this.idx]);
      this.burn(Math.max(0, rest));
    }
    if (this.done) return;
    if (id === "continue" && this.phase === "outbound") {
      this.path = opt.path;
      this.cfg.scienceS = opt.scienceS;
      this.scienceLeftS = opt.scienceS;
    } else if (id === "continue" && this.phase === "science") {
      this.scienceLeftS = opt.scienceS;
    } else {
      this.phase = "inbound";
      this.scienceLeftS = 0;
      this.path = opt.path;
    }
    this.idx = 0;
    this.segS = 0;
    this.note("decision", `${by}: ${opt.label}.`);
    if (this.path.length === 1 && this.phase !== "science") this.arrive();
  }
}

// True if `a` follows the same cells as `path` from index `from` onward.
function sameTail(a: number[], path: number[], from: number): boolean {
  const tail = path.slice(from);
  return a.length === tail.length && a.every((c, i) => c === tail[i]);
}
