import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTerrain, type Meta } from "../data";
import { astar } from "./astar";
import { MAX_SLOPE_DEG, STRATEGIES, gridFromTerrain, makeGrid, passable, stepCost, type Grid, type StrategyName } from "./cost";
import { dijkstra } from "./dijkstra";
import { MinHeap } from "./heap";

// Small seeded random generator so every run builds the same grids.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGrid(seed: number, rows = 12, cols = 14): Grid {
  const rnd = mulberry32(seed);
  const n = rows * cols;
  const elevation = Int16Array.from({ length: n }, () => Math.floor(rnd() * 300));
  const slope = Float32Array.from({ length: n }, () => rnd() * 29); // about 14% of cells are above 25 deg
  return makeGrid(elevation, slope, rows, cols, -5, 32, 1852.2306687);
}

function pathCost(g: Grid, name: StrategyName, cells: number[]): number {
  let total = 0;
  for (let i = 1; i < cells.length; i++) total += stepCost(g, STRATEGIES[name], cells[i - 1], cells[i]);
  return total;
}

describe("MinHeap", () => {
  it("pops in priority order, ties by smaller id", () => {
    const h = new MinHeap();
    [[5, 1], [2, 9], [2, 3], [9, 0], [1, 4], [2, 5]].forEach(([p, id]) => h.push(p, id));
    const out: number[][] = [];
    while (h.size > 0) {
      const e = h.pop();
      out.push([e.priority, e.id]);
    }
    expect(out).toEqual([[1, 4], [2, 3], [2, 5], [2, 9], [5, 1], [9, 0]]);
  });
});

describe("A* versus Dijkstra", () => {
  it("finds the same total cost on 30 seeded random grids x 3 strategies", () => {
    let compared = 0;
    let unreachable = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const g = randomGrid(seed);
      const rnd = mulberry32(seed * 101);
      const start = Math.floor(rnd() * g.rows * g.cols);
      const goal = Math.floor(rnd() * g.rows * g.cols);
      for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
        const a = astar(g, STRATEGIES[name], start, goal);
        const d = dijkstra(g, STRATEGIES[name], start, goal);
        expect(a === null).toBe(d === null);
        if (a === null || d === null) {
          unreachable++;
          continue;
        }
        expect(a.cost).toBeCloseTo(d.cost, 6);
        expect(pathCost(g, name, a.cells)).toBeCloseTo(a.cost, 6);
        expect(a.cells[0]).toBe(start);
        expect(a.cells[a.cells.length - 1]).toBe(goal);
        compared++;
      }
    }
    console.log(`compared ${compared} routes, ${unreachable} unreachable or blocked`);
    expect(compared).toBeGreaterThan(20);
  });

  it("is deterministic: same input, same path", () => {
    const g = randomGrid(7);
    const first = astar(g, STRATEGIES.balanced, 0, g.rows * g.cols - 1);
    const second = astar(g, STRATEGIES.balanced, 0, g.rows * g.cols - 1);
    expect(second).toEqual(first);
  });
});

describe("edge cases", () => {
  const flat = (rows: number, cols: number, slope: ArrayLike<number> | null = null) =>
    makeGrid(new Int16Array(rows * cols), slope ?? new Float32Array(rows * cols), rows, cols, -5, 32, 1852.2306687);

  it("start equals goal gives a one-cell route of cost 0", () => {
    expect(astar(flat(3, 3), STRATEGIES.shortest, 4, 4)).toEqual({ cells: [4], cost: 0 });
  });

  it("returns null when an endpoint is steeper than the limit", () => {
    const slope = new Float32Array(9);
    slope[8] = MAX_SLOPE_DEG + 1;
    const g = flat(3, 3, slope);
    expect(passable(g, 8)).toBe(false);
    expect(astar(g, STRATEGIES.shortest, 0, 8)).toBeNull();
  });

  it("returns null when a wall of steep cells separates start and goal", () => {
    const slope = new Float32Array(9);
    [1, 4, 7].forEach((i) => (slope[i] = 40)); // whole middle column
    expect(astar(flat(3, 3, slope), STRATEGIES.shortest, 0, 2)).toBeNull();
  });

  it("does not squeeze a diagonal between two blocked cells", () => {
    const slope = new Float32Array(4);
    slope[1] = 40;
    slope[2] = 40; // cells (0,1) and (1,0) blocked, (0,0) and (1,1) free
    expect(astar(flat(2, 2, slope), STRATEGIES.shortest, 0, 3)).toBeNull();
  });

  it("east-west steps are shorter at higher latitude (cos rule)", () => {
    const g = makeGrid(new Int16Array(4), new Float32Array(4), 2, 2, 60, 32, 1852.2306687);
    const ew = stepCost(g, STRATEGIES.shortest, 0, 1);
    const ns = stepCost(g, STRATEGIES.shortest, 0, 2);
    expect(ew / ns).toBeCloseTo(0.5, 2); // cos(60 deg) = 0.5
  });
});

describe("real Gale crop", () => {
  const dir = new URL("../../public/data/", import.meta.url);
  const bytes = (name: string) => {
    const b = readFileSync(new URL(name, dir));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const meta = JSON.parse(readFileSync(new URL("meta.json", dir), "utf8")) as Meta;
  const terrain = parseTerrain(meta, bytes("elevation.bin"), bytes("slope.bin"));
  const g = gridFromTerrain(terrain);

  it("reports how many cells exceed the slope limit", () => {
    let blocked = 0;
    for (let i = 0; i < g.rows * g.cols; i++) if (!passable(g, i)) blocked++;
    console.log(`blocked ${blocked} of ${g.rows * g.cols} cells (> ${MAX_SLOPE_DEG} deg)`);
    expect(blocked).toBeGreaterThanOrEqual(0);
  });

  it("plans a route corner to corner for every strategy, with consistent cost", () => {
    const start = 10 * g.cols + 10;
    const goal = 245 * g.cols + 245;
    for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
      if (!passable(g, start) || !passable(g, goal)) throw new Error("test endpoints are blocked; pick others");
      const t0 = performance.now();
      const r = astar(g, STRATEGIES[name], start, goal);
      const ms = performance.now() - t0;
      expect(r).not.toBeNull();
      let maxSlope = 0;
      for (const c of r!.cells) maxSlope = Math.max(maxSlope, g.slopeDeg[c]);
      console.log(`${name}: ${r!.cells.length} cells, cost ${r!.cost.toFixed(0)}, max slope ${maxSlope.toFixed(1)} deg, ${ms.toFixed(0)} ms`);
      expect(pathCost(g, name, r!.cells)).toBeCloseTo(r!.cost, 4);
      expect(maxSlope).toBeLessThanOrEqual(MAX_SLOPE_DEG);
    }
  });

  it("A* equals Dijkstra on a 40x40 window of the real crop", () => {
    const size = 40;
    const sub = (src: ArrayLike<number>, Type: Int16ArrayConstructor | Float32ArrayConstructor) => {
      const out = new Type(size * size);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) out[r * size + c] = src[(100 + r) * g.cols + 100 + c];
      return out;
    };
    const w = makeGrid(sub(g.elevation, Int16Array), sub(g.slopeDeg, Float32Array), size, size, meta.crop.lat_top - 100 / 32, 32, 1852.2306687);
    let checked = 0;
    for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
      const a = astar(w, STRATEGIES[name], 0, size * size - 1);
      const d = dijkstra(w, STRATEGIES[name], 0, size * size - 1);
      expect(a === null).toBe(d === null);
      if (a && d) {
        expect(a.cost).toBeCloseTo(d.cost, 6);
        checked++;
      }
    }
    console.log(`real window: ${checked} of 3 strategies had a route and matched`);
  });
});
