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
  findOffsetMinM: 80, // unplanned find: distance from the planned route, min
  findOffsetMaxM: 140, // ... and max
  findMaxInspectMin: 45, // longest inspection the planner offers
  findRevealM: 150, // a placed find is noticed once the astronaut is this close to it
} as const;

// SCENARIO finds, not real Mars observations: a training target to plan for.
export const FIND_LABELS = [
  "an unusual banded outcrop",
  "a cluster of dark, angular boulders",
  "a patch of lighter-toned, cracked ground",
] as const;

export type CalamityKind = "rockfall" | "leak" | "dust" | "injury" | "spe";

export const CALAMITIES: Record<CalamityKind, { label: string; icon: string; detail: string }> = {
  rockfall: { label: "Rockfall ahead", icon: "⛰", detail: `Ground within ${SCENARIO.rockfallRadiusM} m of a point on the route ahead is now impassable.` },
  leak: { label: "Suit O₂ leak", icon: "⚠", detail: `Oxygen is now used ${SCENARIO.leakO2Factor}x faster.` },
  dust: { label: "Dust storm", icon: "☁", detail: `Visibility drops; walking speed x${SCENARIO.dustSpeedFactor}.` },
  injury: { label: "Astronaut injured", icon: "✚", detail: `Twisted ankle; walking speed x${SCENARIO.injurySpeedFactor}.` },
  spe: { label: "Solar particle event", icon: "☢", detail: `Radiation warning: be back at base within ${SCENARIO.speDeadlineMin} min.` },
};

export type Phase = "outbound" | "detour" | "inspect" | "science" | "inbound" | "returned" | "lost";

export interface Find {
  cell: number;
  label: string;
  offsetM: number; // distance from the planned route
  state: "armed" | "found" | "detour" | "inspecting" | "done" | "skipped"; // armed = placed, not yet noticed
}

export interface OptionPlan {
  id: "continue" | "return" | "inspect" | "inspect-return";
  label: string;
  path: number[]; // first leg, from the astronaut's next cell
  fullPath?: number[]; // every leg joined, for drawing
  legs?: { label: string; m: number; s: number }[]; // walking cost of each leg
  atFind?: { o2AfterL: number; homeL: number; homeM: number }; // state at the find after inspecting, and the way home from there
  inspectS?: number; // inspection time included
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
  scheduled: { atS: number; kind: CalamityKind | "discovery" }[] = [];
  find: Find | null = null; // the find once noticed
  armed: Find | null = null; // a find placed by mission control, not yet noticed
  afterFind: "goal" | "base" = "goal"; // where to go once the inspection is done
  inspectLeftS = 0;
  inspectDoneS = 0;
  goalReached = false;
  private rand: () => number;
  private randFind: () => number; // separate stream: finds do not change the calamity schedule

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
    this.randFind = rng((seed ^ 0x9e3779b9) >>> 0);
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

  private get walking(): boolean {
    return this.phase === "outbound" || this.phase === "inbound" || this.phase === "detour";
  }

  // Options start from the next cell; the rest of the current step is added.
  private here(): { cell: number; extraS: number } {
    if (!this.walking) return { cell: this.path[this.idx], extraS: 0 };
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
    this.scheduled = [...this.scheduled.filter((e) => e.kind === "discovery"), ...picks].sort((a, b) => a.atS - b.atS);
  }

  // One unplanned find, noticed 25-45% of the way along the outbound walk.
  scheduleFind(): void {
    const atS = (0.25 + 0.2 * this.randFind()) * this.pathTime(this.path);
    this.scheduled = [...this.scheduled, { atS, kind: "discovery" as const }].sort((a, b) => a.atS - b.atS);
  }

  // Advance the clock by dt seconds. Stops early, and returns the event,
  // if a scheduled one comes due.
  advance(dt: number): CalamityKind | "discovery" | null {
    let left = dt;
    while (left > 1e-9 && !this.done) {
      const next = this.scheduled[0];
      let step = left;
      if (next) step = Math.min(step, Math.max(0, next.atS - this.t));
      if (step > 0) this.move(step);
      left -= step;
      if (this.checkReveal()) return "discovery";
      if (next && this.t >= next.atS - 1e-9 && !this.done) {
        this.scheduled.shift();
        if (next.kind === "discovery") {
          if (this.discover()) return "discovery";
          continue; // passed the spot already (or nothing reachable): the find is missed
        }
        this.apply(next.kind);
        return next.kind;
      }
    }
    return null;
  }

  // Mission control places a find on the map. The astronaut notices it once
  // within findRevealM of it. Returns an error message, or null when placed.
  armFind(cell: number): string | null {
    if (this.find) return "A find was already noticed on this run.";
    if (this.phase !== "outbound") return "A find can only be placed while the astronaut is walking out.";
    if (this.blocked[cell]) return "That ground is blocked by a rockfall.";
    if ([this.cfg.base, this.cfg.goal].some((p) => this.dist(p, cell) < 30)) return "Too close to the base or the destination.";
    const { cell: here } = this.here();
    if (!this.plan(here, cell)) return "The astronaut cannot walk there (too steep or cut off).";
    if (!this.plan(cell, this.cfg.base)) return "There is no walkable way back to base from there.";
    const ahead = this.path.slice(this.idx + 1);
    const offsetM = ahead.length ? Math.min(...ahead.map((p) => this.dist(p, cell))) : 0;
    this.armed = { cell, label: FIND_LABELS[cell % FIND_LABELS.length], offsetM, state: "armed" };
    this.scheduled = this.scheduled.filter((e) => e.kind !== "discovery"); // placed by hand: no random one as well
    this.note("info", `Mission control placed a find about ${Math.round(offsetM)} m off the route. The astronaut will notice it within ${SCENARIO.findRevealM} m.`);
    return null;
  }

  private checkReveal(): boolean {
    const a = this.armed;
    if (!a || this.find || this.phase !== "outbound") return false;
    const p = this.position();
    if (this.dist(p.frac < 0.5 ? p.from : p.to, a.cell) > SCENARIO.findRevealM) return false;
    this.find = { ...a, state: "found" };
    this.armed = null;
    this.note("event", `Unplanned find: the astronaut notices ${a.label}, about ${Math.round(a.offsetM)} m off the route. Scenario target, not a real Mars observation.`);
    return true;
  }

  // Places a find 80-140 m off the route ahead, on ground the suit can walk to.
  private discover(): boolean {
    if (this.phase !== "outbound" || this.find || this.armed) return false;
    const ahead = this.path.slice(this.idx + 1);
    if (ahead.length < 8) return false;
    const g = this.cfg.grid;
    const anchor = ahead[Math.floor(ahead.length * 0.3)];
    const ar = Math.floor(anchor / g.cols);
    const ac = anchor % g.cols;
    const { cell } = this.here();
    for (let attempt = 0; attempt < 80; attempt++) {
      const ang = this.randFind() * 2 * Math.PI;
      const d = SCENARIO.findOffsetMinM + (SCENARIO.findOffsetMaxM - SCENARIO.findOffsetMinM) * this.randFind();
      const r = Math.round(ar + (Math.sin(ang) * d) / g.dy);
      const c = Math.round(ac + (Math.cos(ang) * d) / g.dx[ar]);
      if (r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
      const target = r * g.cols + c;
      // True distance from the route ahead, so "off the route" means off the route.
      const offsetM = Math.min(...ahead.map((p) => this.dist(p, target)));
      if (offsetM < SCENARIO.findOffsetMinM || offsetM > SCENARIO.findOffsetMaxM) continue;
      if (this.blocked[target] || [this.cfg.base, this.cfg.goal, cell].some((p) => this.dist(p, target) < 40)) continue;
      if (!this.plan(cell, target)) continue;
      const label = FIND_LABELS[Math.floor(this.randFind() * FIND_LABELS.length)];
      this.find = { cell: target, label, offsetM, state: "found" };
      this.note("event", `Unplanned find: the astronaut notices ${label}, about ${Math.round(offsetM)} m off the route. Scenario target, not a real Mars observation.`);
      return true;
    }
    return false;
  }

  private move(dt: number) {
    let left = dt;
    while (left > 1e-9 && !this.done) {
      if (this.phase === "inspect") {
        const s = Math.min(left, this.inspectLeftS);
        this.burn(s);
        this.inspectLeftS -= s;
        this.inspectDoneS += s;
        left -= s;
        if (this.inspectLeftS <= 1e-9 && !this.done) this.afterInspect();
        continue;
      }
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
    if (this.phase === "detour" && this.find && at === this.find.cell) {
      this.phase = "inspect";
      this.find.state = "inspecting";
      this.note("info", `Reached the find. Inspection: ${Math.round(this.inspectLeftS / 60)} min planned.`);
      if (this.inspectLeftS <= 0) this.afterInspect();
    } else if (this.phase === "outbound" && at === this.cfg.goal) {
      this.goalReached = true;
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

  // Inspection finished: carry on to the destination, or head home.
  private afterInspect() {
    if (this.find) this.find.state = "done";
    this.inspectLeftS = 0;
    const from = this.path[this.idx] ?? this.path[this.path.length - 1];
    const next = this.afterFind === "goal" ? this.plan(from, this.cfg.goal) : null;
    if (!next) {
      this.note("info", "Inspection complete. Heading back to base.");
      this.startInbound();
      return;
    }
    this.phase = "outbound";
    this.path = next;
    this.idx = 0;
    this.segS = 0;
    this.note("info", "Inspection complete. Continuing to the destination.");
    if (next.length === 1) this.arrive();
  }

  private startInbound() {
    const from = this.path[this.idx] ?? this.path[this.path.length - 1];
    const back = this.plan(from, this.cfg.base);
    this.phase = "inbound";
    this.scienceLeftS = 0;
    this.inspectLeftS = 0;
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
    if (this.phase === "science" || this.phase === "inspect") ahead = this.plan(cell, this.cfg.base);
    else ahead = this.path.slice(this.idx + 1);
    if (!ahead || ahead.length < 4) return null;
    const k = Math.floor(ahead.length * (0.35 + 0.25 * this.rand()));
    const centre = ahead[Math.min(k, ahead.length - 2)];
    const g = this.cfg.grid;
    const protect = [cell, this.cfg.base, this.cfg.goal, ...(this.find ? [this.find.cell] : [])];
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

  // ---- planning: a route is a list of stops, then base ----
  // Walk to each stop in turn, work there, then walk home. Inspection time is
  // fixed once planned; science time is the flexible part and is cut back to
  // whatever the oxygen (and any deadline) still allows.
  private evalStops(id: OptionPlan["id"], label: string, cell: number, extraS: number, stops: Stop[]): OptionPlan | null {
    let from = cell;
    let walkS = extraS;
    let fixedWork = 0;
    let wantScience = 0;
    let inspectS = 0;
    let first: number[] | null = null;
    const full = [cell];
    const legs: { label: string; m: number; s: number }[] = [];
    let fromName = "here";
    for (const st of stops) {
      const p = this.plan(from, st.cell);
      if (!p) return null;
      first ??= p;
      legs.push({ label: `${fromName} \u2192 ${st.name}`, m: this.pathLength(p), s: this.pathTime(p) + (legs.length === 0 ? extraS : 0) });
      fromName = st.name;
      walkS += this.pathTime(p);
      full.push(...p.slice(1));
      from = st.cell;
      if (st.kind === "inspect") {
        fixedWork += st.workS;
        inspectS += st.workS;
      } else wantScience += st.workS;
    }
    const back = this.plan(from, this.cfg.base);
    if (!back) return null;
    legs.push({ label: `${fromName} \u2192 base`, m: this.pathLength(back), s: this.pathTime(back) + (legs.length === 0 ? extraS : 0) });
    walkS += this.pathTime(back);
    full.push(...back.slice(1));
    const left = this.o2LeftL;
    // At the find, after inspecting: oxygen left, and what the way straight home from there costs.
    let atFind: OptionPlan["atFind"];
    if (stops[0]?.kind === "inspect") {
      const home = this.plan(stops[0].cell, this.cfg.base);
      if (home) atFind = { o2AfterL: left - this.litres(legs[0].s + stops[0].workS), homeL: this.litres(this.pathTime(home)), homeM: this.pathLength(home) };
    }
    const fixedS = walkS + fixedWork;
    const o2Room = (left - this.litres(fixedS)) / this.litres(1);
    const timeRoom = this.deadlineS === null ? Infinity : this.deadlineS - this.t - fixedS;
    const scienceS = Math.max(0, Math.min(wantScience, o2Room, timeRoom));
    const needL = this.litres(fixedS + scienceS);
    const arriveS = this.t + fixedS + scienceS;
    const science = stops.some((st) => st.kind === "science");
    const cut = scienceS < wantScience - 1;
    const parts = [
      ...(inspectS > 0 ? [`${Math.round(inspectS / 60)} min inspection`] : []),
      ...(science ? [`${Math.floor(scienceS / 60)} min science${cut ? " (cut short)" : ""}`] : []),
    ];
    return {
      id,
      label,
      path: first ?? [cell],
      fullPath: full,
      legs,
      atFind,
      inspectS,
      walkS,
      scienceS,
      needL,
      spareL: left - needL,
      arriveS,
      feasible: needL <= left && (this.deadlineS === null || arriveS <= this.deadlineS) && (!science || wantScience === 0 || scienceS > 0 || this.phase === "science"),
      note: parts.join(", ") || `${Math.round(this.pathLength(full))} m round trip`,
    };
  }

  // What the astronaut still has to do on the way to a successful return.
  private plannedStops(): Stop[] | null {
    const sci = (workS: number): Stop => ({ name: "destination", cell: this.cfg.goal, kind: "science", workS });
    if (this.phase === "outbound") return [sci(this.cfg.scienceS)];
    if (this.phase === "science") return [sci(this.scienceLeftS)];
    if ((this.phase === "detour" || this.phase === "inspect") && this.find) {
      return [{ name: "the find", cell: this.find.cell, kind: "inspect", workS: this.inspectLeftS }, ...(this.afterFind === "goal" ? [sci(this.cfg.scienceS)] : [])];
    }
    return null;
  }

  private returnOption(cell: number, extraS: number): OptionPlan {
    const left = this.o2LeftL;
    const home = this.plan(cell, this.cfg.base);
    const homeS = home ? extraS + this.pathTime(home) : Infinity;
    const needL = this.litres(homeS);
    return {
      id: "return",
      label: this.phase === "inbound" ? "Return to base (replanned)" : "Abort: return to base now",
      path: home ?? [cell],
      walkS: homeS,
      scienceS: 0,
      needL,
      spareL: left - needL,
      arriveS: this.t + homeS,
      feasible: !!home && needL <= left && (this.deadlineS === null || this.t + homeS <= this.deadlineS),
      note: home ? `${Math.round(this.pathLength(home))} m to base` : "no way back",
    };
  }

  // The choices from where the astronaut is now.
  options(): OptionPlan[] {
    const { cell, extraS } = this.here();
    const out: OptionPlan[] = [];
    const stops = this.plannedStops();
    if (stops) {
      const working = this.phase === "detour" || this.phase === "inspect";
      const label = (rerouted: boolean) =>
        this.phase === "science"
          ? "Continue science, then return"
          : working
            ? this.afterFind === "goal" ? "Finish inspection, then the destination" : "Finish inspection, then return"
            : rerouted ? "Continue (rerouted)" : "Continue to destination";
      const probe = this.evalStops("continue", label(false), cell, this.phase === "science" || this.phase === "inspect" ? 0 : extraS, stops);
      if (probe) {
        const rerouted = this.phase === "outbound" && !sameTail(probe.path, this.path, this.idx + 1);
        probe.label = label(rerouted);
        out.push(probe);
      } else {
        out.push({ id: "continue", label: "Continue to destination", path: [cell], walkS: Infinity, scienceS: 0, needL: Infinity, spareL: -Infinity, arriveS: Infinity, feasible: false, note: "destination cut off" });
      }
    }
    out.push(this.returnOption(cell, extraS));
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

  // ---- the unplanned find: plan an inspection against the oxygen budget ----
  // The four ways to answer a find, for an inspection of inspectS seconds.
  findOptions(inspectS: number): OptionPlan[] {
    const f = this.find;
    if (!f || this.phase !== "outbound") return [];
    const { cell, extraS } = this.here();
    const insp: Stop = { name: "the find", cell: f.cell, kind: "inspect", workS: inspectS };
    const sci: Stop = { name: "destination", cell: this.cfg.goal, kind: "science", workS: this.cfg.scienceS };
    const unreachable = (id: OptionPlan["id"], label: string): OptionPlan => ({
      id, label, path: [cell], walkS: Infinity, scienceS: 0, needL: Infinity, spareL: -Infinity, arriveS: Infinity, feasible: false, note: "no walkable route for one of the legs",
    });
    const mk = (id: OptionPlan["id"], label: string, stops: Stop[]) => this.evalStops(id, label, cell, extraS, stops) ?? unreachable(id, label);
    return [
      mk("inspect", "Inspect it, then continue to the destination", [insp, sci]),
      mk("continue", "Skip it, continue as planned", [sci]),
      mk("inspect-return", "Inspect it, then return (destination skipped)", [insp]),
      this.returnOption(cell, extraS),
    ];
  }

  // Longest inspection (seconds) that still keeps the whole plan (full science
  // for "goal", or just the inspection for "base") inside the 80% oxygen caution
  // line and any deadline. 0 means there is no spare time for it.
  inspectBudgetS(after: "goal" | "base"): number {
    const f = this.find;
    if (!f) return 0;
    const { cell, extraS } = this.here();
    const insp: Stop = { name: "the find", cell: f.cell, kind: "inspect", workS: 0 };
    const sci: Stop = { name: "destination", cell: this.cfg.goal, kind: "science", workS: this.cfg.scienceS };
    const o = this.evalStops("inspect", "", cell, extraS, after === "goal" ? [insp, sci] : [insp]);
    if (!o || !o.feasible || (after === "goal" && o.scienceS < this.cfg.scienceS - 1)) return 0;
    const margin = this.cfg.reserveL * (1 - CAUTION_FRACTION);
    const o2Room = (o.spareL - margin) / this.litres(1);
    const timeRoom = this.deadlineS === null ? Infinity : this.deadlineS - o.arriveS;
    return Math.max(0, Math.min(o2Room, timeRoom, SCENARIO.findMaxInspectMin * 60));
  }

  // Suggested answer to a find. Display rule, not a NASA rule: keep the main
  // goal and the 20% oxygen margin first; give up the goal only for the find.
  recommendFind(opts: OptionPlan[]): OptionPlan["id"] {
    const margin = this.cfg.reserveL * (1 - CAUTION_FRACTION);
    const ok = (id: OptionPlan["id"]) => {
      const o = opts.find((x) => x.id === id);
      return !!o && o.feasible && o.spareL >= margin - 1e-6 ? o : null; // tolerance: the budget lands exactly on the margin
    };
    const full = ok("inspect");
    if (full && full.scienceS >= this.cfg.scienceS - 1) return "inspect";
    if (ok("continue")) return "continue";
    if (ok("inspect-return")) return "inspect-return";
    return "return";
  }

  // Apply the astronaut's answer to a find. "continue" means skip it.
  answerFind(id: OptionPlan["id"], inspectS: number, by: string): void {
    const f = this.find;
    if (!f || f.state !== "found") return;
    const opt = this.findOptions(inspectS).find((o) => o.id === id);
    if (!opt) return;
    if (id === "continue") {
      f.state = "skipped";
      this.note("decision", `${by}: skip the find, continue as planned.`);
      return;
    }
    if (id === "return") {
      f.state = "skipped";
      this.choose("return", by);
      return;
    }
    this.finishStep();
    if (this.done) return;
    this.afterFind = id === "inspect" ? "goal" : "base";
    this.inspectLeftS = inspectS;
    if (id === "inspect") {
      this.cfg.scienceS = opt.scienceS;
      this.scienceLeftS = opt.scienceS;
    }
    f.state = "detour";
    this.phase = "detour";
    this.path = opt.path;
    this.idx = 0;
    this.segS = 0;
    this.note("decision", `${by}: ${opt.label} (${Math.round(inspectS / 60)} min inspection).`);
  }

  // Finish the current step first, so a new path starts where we are going.
  private finishStep() {
    if (this.walking && this.idx + 1 < this.path.length) {
      const rest = this.segTime(this.path, this.idx) - this.segS;
      this.idx++;
      this.segS = 0;
      this.trail.push(this.path[this.idx]);
      this.burn(Math.max(0, rest));
    }
  }

  choose(id: OptionPlan["id"], by: string): void {
    const opt = this.options().find((o) => o.id === id);
    if (!opt) return;
    this.finishStep();
    if (this.done) return;
    const cellNow = this.path[this.idx];
    if (id === "continue" && (this.phase === "outbound" || this.phase === "detour")) {
      this.path = opt.path;
      if (this.afterFind === "goal" || this.phase === "outbound") {
        this.cfg.scienceS = opt.scienceS;
        this.scienceLeftS = opt.scienceS;
      }
    } else if (id === "continue" && this.phase === "science") {
      this.scienceLeftS = opt.scienceS;
      this.path = [cellNow]; // stay put: working phases keep the position in path[idx]
    } else if (id === "continue" && this.phase === "inspect") {
      if (this.afterFind === "goal") {
        this.cfg.scienceS = opt.scienceS;
        this.scienceLeftS = opt.scienceS;
      }
      this.path = [cellNow];
    } else {
      this.phase = "inbound";
      this.scienceLeftS = 0;
      this.inspectLeftS = 0;
      if (this.find && this.find.state !== "done") this.find.state = "skipped";
      this.path = opt.path;
    }
    this.idx = 0;
    this.segS = 0;
    this.note("decision", `${by}: ${opt.label}.`);
    if (this.path.length === 1 && this.walking) this.arrive();
  }
}

interface Stop {
  name: string;
  cell: number;
  kind: "inspect" | "science";
  workS: number;
}

// True if `a` follows the same cells as `path` from index `from` onward.
function sameTail(a: number[], path: number[], from: number): boolean {
  const tail = path.slice(from);
  return a.length === tail.length && a.every((c, i) => c === tail[i]);
}
