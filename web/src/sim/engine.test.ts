import { describe, expect, it } from "vitest";
import { oxygenLitres } from "../route/assumptions";
import { astar } from "../route/astar";
import { STRATEGIES, makeGrid } from "../route/cost";
import { SCENARIO, Sim } from "./engine";

// Flat 60 x 60 grid of 10 m cells on the equator: walking speed is the flat
// 2.5 km/h everywhere, so times and oxygen can be checked by hand.
const N = 60;
const grid = makeGrid(new Float32Array(N * N), new Float32Array(N * N), N, N, 0.0, 5927.469752330622, 10);
const at = (r: number, c: number) => r * N + c;
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
});
