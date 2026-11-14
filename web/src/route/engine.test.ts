import { describe, expect, it } from "vitest";
import { astar } from "./astar";
import { STRATEGIES, makeGrid } from "./cost";
import { createEngine, type InitMsg } from "./engine";

const rows = 6;
const cols = 6;
const init = (slope: Float32Array): InitMsg => ({
  type: "init",
  rows,
  cols,
  elevation: new Float32Array(rows * cols),
  slopeDeg: slope,
  latTop: -5,
  pixelsPerDegree: 32,
  pixelSizeM: 1852.2306687,
});

describe("worker engine", () => {
  it("answers a plan request with the same route as calling astar directly", () => {
    const handle = createEngine();
    const slope = new Float32Array(rows * cols);
    expect(handle(init(slope))).toBeUndefined();
    const out = handle({ type: "plan", id: 7, start: 0, goal: 35, strategy: "balanced" })!;
    const direct = astar(makeGrid(new Int16Array(36), slope, rows, cols, -5, 32, 1852.2306687), STRATEGIES.balanced, 0, 35)!;
    expect(out).toEqual({ type: "result", id: 7, cells: direct.cells, cost: direct.cost });
  });

  it("returns null cells for a blocked destination and keeps the request id", () => {
    const handle = createEngine();
    const slope = new Float32Array(rows * cols);
    slope[35] = 40;
    handle(init(slope));
    expect(handle({ type: "plan", id: 3, start: 0, goal: 35, strategy: "shortest" })).toEqual({
      type: "result",
      id: 3,
      cells: null,
      cost: null,
    });
  });

  it("refuses a plan before init", () => {
    expect(() => createEngine()({ type: "plan", id: 1, start: 0, goal: 1, strategy: "shortest" })).toThrow();
  });
});
