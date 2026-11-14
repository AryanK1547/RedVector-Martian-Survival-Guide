import { describe, expect, it } from "vitest";
import { oxygenLitres } from "../route/assumptions";
import { astar } from "../route/astar";
import { STRATEGIES, makeGrid } from "../route/cost";
import { moveTimeS } from "../route/noreturn";
import { SCENARIO, Sim } from "./engine";

// Flat 60 x 60 grid of 10 m cells on the equator: walking speed is the flat
// 2.5 km/h everywhere, so times and oxygen can be checked by hand.
const N = 60;
const grid = makeGrid(new Float32Array(N * N), new Float32Array(N * N), N, N, 0.0, 5927.469752330622, 10);
const at = (r: number, c: number) => r * N + c;
const moveT = (a: number, b: number) => moveTimeS(grid, a, b);
const base = at(30, 5);
const goal = at(30, 50); // 450 m east
const outPath = astar(grid, STRATEGIES.shortest, base, goal)!.cells;
const WALK_S = 450 / (2500 / 3600); // 648 s
const make = (reserveL = 30, scienceS = 300, seed = 1) =>
  new Sim({ grid, base, goal, outPath, reserveL, strategy: STRATEGIES.shortest, scienceS }, seed);
const runToEnd = (s: Sim) => {
  for (let i = 0; i < 10000 && !s.done; i++) s.advance(5);
};

describe("EVA simulation", () => {
  it("nominal EVA: out, science, back, with oxygen = rate x time", () => {
    const s = make();
    runToEnd(s);
    expect(s.phase).toBe("returned");
    expect(s.t).toBeCloseTo(2 * WALK_S + 300, 0);
    expect(s.o2UsedL).toBeCloseTo(oxygenLitres(2 * WALK_S + 300), 3);
  });

  it("runs out of oxygen when the reserve is too small", () => {
    const s = make(10);
    runToEnd(s);
    expect(s.phase).toBe("lost");
    expect(s.o2LeftL).toBe(0);
  });

  it("suit leak: continuing loses the margin, so the engine recommends returning", () => {
    const s = make(30, 300);
    s.advance(60);
    s.apply("leak");
    expect(s.o2Factor).toBe(SCENARIO.leakO2Factor);
    const opts = s.options();
    const ret = opts.find((o) => o.id === "return")!;
    expect(ret.feasible).toBe(true);
    expect(s.recommend(opts)).toBe("return");
    s.choose("return", "Mission control");
    runToEnd(s);
    expect(s.phase).toBe("returned");
  });

  it("rockfall: blocks ground ahead and the continue option routes around it", () => {
    const s = make();
    s.advance(100);
    s.apply("rockfall");
    const blocked = s.blocked.reduce((a, b) => a + b, 0);
    expect(blocked).toBeGreaterThan(10);
    const cont = s.options().find((o) => o.id === "continue")!;
    expect(cont.label).toBe("Continue (rerouted)");
    expect(cont.path.every((c) => s.blocked[c] === 0)).toBe(true);
    expect(cont.path[cont.path.length - 1]).toBe(goal);
    s.choose("continue", "Astronaut");
    runToEnd(s);
    expect(s.phase).toBe("returned");
    expect(s.trail.every((c) => s.blocked[c] === 0)).toBe(true);
  });

  it("solar particle event: science is cut so the astronaut is home by the deadline", () => {
    const s = make(60, 600); // plenty of oxygen; 10 min science would miss a 30 min deadline
    s.apply("spe");
    const cont = s.options().find((o) => o.id === "continue")!;
    expect(cont.scienceS).toBeCloseTo(SCENARIO.speDeadlineMin * 60 - 2 * WALK_S, 0);
    expect(cont.arriveS).toBeLessThanOrEqual(s.deadlineS! + 1e-6);
    expect(cont.feasible).toBe(true);
  });

  it("dust storm slows walking without moving the astronaut backwards", () => {
    const s = make();
    s.advance(100);
    const before = s.position();
    s.apply("dust");
    const after = s.position();
    expect(after.from).toBe(before.from);
    expect(after.frac).toBeCloseTo(before.frac, 9);
    runToEnd(s);
    expect(s.t).toBeGreaterThan(2 * WALK_S + 300);
  });

  it("random calamities are repeatable from the seed", () => {
    const a = make(30, 300, 42);
    const b = make(30, 300, 42);
    a.scheduleRandom(2);
    b.scheduleRandom(2);
    expect(a.scheduled).toEqual(b.scheduled);
    expect(a.scheduled).toHaveLength(2);
    const fired = [];
    for (let i = 0; i < 10000 && !a.done; i++) {
      const k = a.advance(5);
      if (k) {
        fired.push(k);
        a.choose(a.recommend(a.options()), "Suit computer");
      }
    }
    expect(fired).toEqual(b.scheduled.map((e) => e.kind));
  });

  it("science decision keeps the astronaut at the destination (position does not jump back)", () => {
    const s = make(60, 600);
    for (let i = 0; i < 10000 && s.phase !== "science"; i++) s.advance(5);
    s.apply("leak");
    s.choose("continue", "Astronaut");
    expect(s.position().from).toBe(goal);
    s.apply("dust");
    expect(s.options().find((o) => o.id === "return")!.path[0]).toBe(goal);
  });
});

// ---- mid-route find: plan an inspection against the oxygen budget ----
const PER_S = oxygenLitres(1);
const found = (reserveL = 45, scienceS = 300, seed = 3) => {
  const s = make(reserveL, scienceS, seed);
  s.scheduleFind();
  let k: ReturnType<Sim["advance"]> = null;
  for (let i = 0; i < 10000 && !k && !s.done; i++) k = s.advance(5);
  expect(k).toBe("discovery");
  return s;
};

describe("unplanned find and inspection planning", () => {
  it("the find appears 25-45% into the outbound walk, 80-140 m off the route, on open ground", () => {
    const s = found();
    expect(s.phase).toBe("outbound");
    expect(s.find!.state).toBe("found");
    expect(s.find!.offsetM).toBeGreaterThanOrEqual(SCENARIO.findOffsetMinM);
    expect(s.find!.offsetM).toBeLessThanOrEqual(SCENARIO.findOffsetMaxM);
    expect(s.blocked[s.find!.cell]).toBe(0);
    expect(s.t).toBeGreaterThanOrEqual(0.25 * WALK_S - 5);
    expect(s.t).toBeLessThanOrEqual(0.45 * WALK_S + 5);
  });

  it("the find is repeatable from the seed and does not change the calamity schedule", () => {
    const a = found(45, 300, 7);
    const b = found(45, 300, 7);
    expect(a.find).toEqual(b.find);
    const c = make(30, 300, 7);
    const d = make(30, 300, 7);
    c.scheduleRandom(2);
    d.scheduleRandom(2);
    d.scheduleFind();
    expect(d.scheduled.filter((e) => e.kind !== "discovery")).toEqual(c.scheduled);
  });

  it("budget: inspecting for exactly the budget leaves the 20% oxygen margin, one second more does not", () => {
    const s = found(45, 300);
    const budget = s.inspectBudgetS("goal");
    expect(budget).toBeGreaterThan(60);
    const margin = 45 * 0.2;
    const at = (x: number) => s.findOptions(x).find((o) => o.id === "inspect")!;
    expect(at(budget).spareL).toBeCloseTo(margin, 1);
    expect(at(budget).scienceS).toBeCloseTo(300, 3);
    expect(at(budget + 60).spareL).toBeLessThan(margin);
    expect(s.recommendFind(s.findOptions(budget))).toBe("inspect");
    expect(s.recommendFind(s.findOptions(budget + 120))).not.toBe("inspect");
  });

  it("a tight reserve leaves no budget and the planner recommends skipping the find", () => {
    const s = found(28, 300); // nominal plan leaves 6.4 L, the margin is 5.6 L: not enough for a detour
    expect(s.inspectBudgetS("goal")).toBe(0);
    expect(s.recommendFind(s.findOptions(300))).toBe("continue");
  });

  it("an inspection longer than the oxygen allows cuts science, then becomes infeasible", () => {
    const s = found(45, 300);
    const opts = (x: number) => s.findOptions(x).find((o) => o.id === "inspect")!;
    expect(opts(1800).scienceS).toBeLessThan(300);
    expect(opts(1800).feasible).toBe(true);
    expect(opts(4000).feasible).toBe(false);
    expect(opts(1800).needL).toBeLessThanOrEqual(45 + 1e-9);
  });

  it("inspect, then destination, then home: every leg is walked and oxygen = rate x time", () => {
    const s = found(45, 300);
    const inspectS = 240;
    s.answerFind("inspect", inspectS, "Mission control");
    expect(s.phase).toBe("detour");
    const phases = new Set<string>();
    for (let i = 0; i < 10000 && !s.done; i++) {
      s.advance(5);
      phases.add(s.phase);
    }
    expect(s.phase).toBe("returned");
    expect([...phases]).toEqual(expect.arrayContaining(["detour", "inspect", "outbound", "science", "inbound"]));
    expect(s.inspectDoneS).toBeCloseTo(inspectS, 3);
    expect(s.scienceDoneS).toBeCloseTo(300, 3);
    expect(s.goalReached).toBe(true);
    expect(s.find!.state).toBe("done");
    expect(s.o2UsedL).toBeCloseTo(PER_S * s.t, 3);
  });

  it("inspect then return: the destination is skipped and the astronaut gets home", () => {
    const s = found(45, 300);
    s.answerFind("inspect-return", 300, "Astronaut");
    runToEnd(s);
    expect(s.phase).toBe("returned");
    expect(s.goalReached).toBe(false);
    expect(s.scienceDoneS).toBe(0);
    expect(s.inspectDoneS).toBeCloseTo(300, 3);
  });

  it("skipping the find leaves the mission exactly as planned", () => {
    const s = found(30, 300);
    s.answerFind("continue", 0, "Astronaut");
    expect(s.find!.state).toBe("skipped");
    runToEnd(s);
    expect(s.t).toBeCloseTo(2 * WALK_S + 300, 0);
    expect(s.inspectDoneS).toBe(0);
  });

  it("a calamity during the inspection keeps the astronaut at the find and replans from there", () => {
    const s = found(45, 300);
    s.answerFind("inspect", 600, "Astronaut");
    for (let i = 0; i < 10000 && s.phase !== "inspect"; i++) s.advance(5);
    expect(s.phase).toBe("inspect");
    s.advance(60);
    s.apply("leak");
    expect(s.position().from).toBe(s.find!.cell);
    const opts = s.options();
    expect(opts[0].label).toBe("Finish inspection, then the destination");
    expect(opts[0].path[0]).toBe(s.find!.cell);
    s.choose("return", "Suit computer");
    runToEnd(s);
    expect(s.phase).toBe("returned");
    expect(s.find!.state).not.toBe("done"); // abandoned part-way
  });

  it("a find is missed (no event) if the astronaut is already on the way home", () => {
    const s = make(45, 0, 3);
    s.scheduled = [{ atS: 2 * WALK_S - 5, kind: "discovery" }];
    runToEnd(s);
    expect(s.find).toBeNull();
    expect(s.phase).toBe("returned");
  });
});

// ---- a find placed by hand: the user decides where, the astronaut notices it when close ----
describe("placed find", () => {
  const spot = at(40, 28); // 100 m south of the route (row 30), 230 m along it
  const dist = (a: number, b: number) => Math.hypot(((a % N) - (b % N)) * 10, (Math.floor(a / N) - Math.floor(b / N)) * 10);

  it("is noticed only once the astronaut is within the reveal distance, and never twice", () => {
    const s = make(45, 300, 3);
    expect(s.armFind(spot)).toBeNull();
    expect(s.armed!.offsetM).toBeCloseTo(100, 0);
    expect(s.find).toBeNull();
    let k: ReturnType<Sim["advance"]> = null;
    for (let i = 0; i < 10000 && !k && !s.done; i++) k = s.advance(2);
    expect(k).toBe("discovery");
    expect(s.find!.cell).toBe(spot);
    expect(s.armed).toBeNull();
    const p = s.position();
    expect(dist(p.frac < 0.5 ? p.from : p.to, spot)).toBeLessThanOrEqual(SCENARIO.findRevealM + 1);
    expect(dist(p.frac < 0.5 ? p.from : p.to, spot)).toBeGreaterThan(SCENARIO.findRevealM - 15);
    s.answerFind("continue", 0, "t");
    for (let i = 0; i < 10000 && !s.done; i++) expect(s.advance(5)).not.toBe("discovery");
  });

  it("replaces the random find, and can be moved before it is noticed", () => {
    const s = make(45, 300, 3);
    s.scheduleFind();
    s.armFind(spot);
    expect(s.scheduled.some((e) => e.kind === "discovery")).toBe(false);
    s.armFind(at(20, 28));
    expect(s.armed!.cell).toBe(at(20, 28));
  });

  it("rejects places the astronaut cannot use", () => {
    const s = make(45, 300, 3);
    expect(s.armFind(at(30, 8))).toMatch(/close to the base/);
    expect(s.armFind(at(30, 48))).toMatch(/close to the base or the destination/);
    s.blocked[spot] = 1;
    expect(s.armFind(spot)).toMatch(/blocked/);
    const t = make(45, 300, 3);
    t.apply("rockfall");
    t.choose("return", "x");
    expect(t.armFind(spot)).toMatch(/walking out/);
  });

  it("every leg is priced: legs add up to the walking time, and the way home from the find is shown", () => {
    const s = make(45, 300, 3);
    s.armFind(spot);
    for (let i = 0; i < 10000 && !s.find; i++) s.advance(2);
    const o = s.findOptions(240).find((x) => x.id === "inspect")!;
    expect(o.legs!.map((l) => l.label)).toEqual(["here → the find", "the find → destination", "destination → base"]);
    expect(o.legs!.reduce((a, l) => a + l.s, 0)).toBeCloseTo(o.walkS, 6);
    expect(o.needL).toBeCloseTo(oxygenLitres(o.walkS + 240 + o.scienceS), 6);
    const f = o.atFind!;
    const home = astar(grid, STRATEGIES.shortest, spot, base)!;
    const homeS = home.cells.slice(1).reduce((a, c, i) => a + moveT(home.cells[i], c), 0);
    expect(f.homeL).toBeCloseTo(oxygenLitres(homeS), 6);
    expect(f.o2AfterL).toBeCloseTo(s.o2LeftL - oxygenLitres(o.legs![0].s + 240), 6);
    expect(f.homeM).toBeGreaterThan(200);
  });

  it("a find that cannot be reached is shown as unreachable, not dropped", () => {
    const s = make(45, 300, 3);
    s.armFind(spot);
    for (let i = 0; i < 10000 && !s.find; i++) s.advance(2);
    // Wall off the find after it was placed (as a rockfall would).
    for (let r = 36; r <= 44; r++) for (let c = 24; c <= 32; c++) if (at(r, c) !== spot) s.blocked[at(r, c)] = 1;
    const slope = Float32Array.from(grid.slopeDeg as ArrayLike<number>);
    s.blocked.forEach((b, i) => b && (slope[i] = 90));
    s.hazard = { ...grid, slopeDeg: slope };
    const opts = s.findOptions(120);
    const insp = opts.find((x) => x.id === "inspect")!;
    expect(opts).toHaveLength(4);
    expect(insp.feasible).toBe(false);
    expect(insp.note).toMatch(/no walkable route/);
  });
});
