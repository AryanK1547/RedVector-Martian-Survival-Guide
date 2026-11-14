import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latlonToCell, parseTerrain, type Meta } from "./data";
import { astar } from "./route/astar";
import { oxygenLitres } from "./route/assumptions";
import { MAX_SLOPE_DEG, STRATEGIES, gridFromTerrain } from "./route/cost";
import { returnTimes } from "./route/noreturn";
import { parseCsv, parseWaypoints } from "./waypoints";

const dir = new URL("../public/data/", import.meta.url);
const bytes = (name: string) => {
  const b = readFileSync(new URL(name, dir));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const meta = JSON.parse(readFileSync(new URL("local/meta.json", dir), "utf8")) as Meta;
const terrain = parseTerrain(meta, bytes("local/elevation.bin"), bytes("local/slope.bin"));
const waypoints = parseWaypoints(readFileSync(new URL("waypoints.csv", dir), "utf8"));

describe("CSV reader", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
});

describe("local boxwork map", () => {
  it("loads float32 elevation with the values prepare_local.py reported", () => {
    let min = Infinity;
    let max = -Infinity;
    for (const v of terrain.elevation) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect([terrain.rows, terrain.cols]).toEqual([400, 400]);
    expect(min).toBeCloseTo(-4092.0, 0);
    expect(max).toBeCloseTo(-3285.3, 0);
  });

  it("contains both verified waypoints on passable cells", () => {
    expect(waypoints.map((w) => w.id)).toEqual(["boxwork_ridge_base", "boxwork_ridge_top"]);
    for (const w of waypoints) {
      const cell = latlonToCell(meta, w.lat, w.lon)!;
      expect(cell).not.toBeNull();
      expect(terrain.slopeDeg[cell.row * terrain.cols + cell.col]).toBeLessThanOrEqual(MAX_SLOPE_DEG);
    }
  });

  it("plans the base-to-top route, about the 22 m NASA reported", () => {
    const g = gridFromTerrain(terrain);
    const [a, b] = waypoints.map((w) => latlonToCell(meta, w.lat, w.lon)!);
    const r = astar(g, STRATEGIES.shortest, a.row * g.cols + a.col, b.row * g.cols + b.col)!;
    expect(r).not.toBeNull();
    expect(r.cost).toBeGreaterThan(15);
    expect(r.cost).toBeLessThan(35);
  });
});

describe("return map on the real local terrain", () => {
  it("is fast and the 30 L demo reserve splits the map into zones", () => {
    const g = gridFromTerrain(terrain);
    const top = latlonToCell(meta, waypoints[1].lat, waypoints[1].lon)!;
    const t0 = performance.now();
    const times = returnTimes(g, top.row * g.cols + top.col);
    const ms = performance.now() - t0;
    let green = 0, amber = 0, red = 0, none = 0;
    for (const s of times) {
      if (!Number.isFinite(s)) none++;
      else if (oxygenLitres(s) <= 15) green++;
      else if (oxygenLitres(s) <= 30) amber++;
      else red++;
    }
    const n = times.length;
    console.log(`return map ${n} cells in ${ms.toFixed(0)} ms: green ${(100 * green / n).toFixed(0)}%, amber ${(100 * amber / n).toFixed(0)}%, red ${(100 * red / n).toFixed(0)}%, no way back ${(100 * none / n).toFixed(0)}%`);
    expect(ms).toBeLessThan(1500);
    expect(green).toBeGreaterThan(0);
    expect(red).toBeGreaterThan(0);
  });
});
