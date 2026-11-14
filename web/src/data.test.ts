import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cellToLatlon, latlonToCell, parseTerrain, type Meta } from "./data";

const dir = new URL("../public/data/", import.meta.url);
const bytes = (name: string) => {
  const b = readFileSync(new URL(name, dir));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const meta = JSON.parse(readFileSync(new URL("meta.json", dir), "utf8")) as Meta;
const terrain = parseTerrain(meta, bytes("elevation.bin"), bytes("slope.bin"));

describe("terrain data", () => {
  it("matches the values validate.py reported", () => {
    let min = Infinity, max = -Infinity;
    for (const v of terrain.elevation) { min = Math.min(min, v); max = Math.max(max, v); }
    console.log(`shape ${terrain.rows}x${terrain.cols}, elevation ${min}..${max} m`);
    expect([terrain.rows, terrain.cols]).toEqual([256, 256]);
    expect([min, max]).toEqual([-4593, 2373]);
  });

  it("slope stays within 0..90 degrees", () => {
    let max = 0;
    for (const s of terrain.slopeDeg) max = Math.max(max, s);
    console.log(`slope max ${max} deg`);
    expect(max).toBeGreaterThan(30);
    expect(max).toBeLessThanOrEqual(90);
  });

  it("cell -> lat/lon -> cell round-trips exactly", () => {
    for (let row = 0; row < terrain.rows; row += 7) {
      for (let col = 0; col < terrain.cols; col += 5) {
        const { lat, lon } = cellToLatlon(meta, row, col);
        expect(latlonToCell(meta, lat, lon)).toEqual({ row, col });
      }
    }
  });

  it("returns null outside the crop", () => {
    expect(latlonToCell(meta, meta.crop.lat_top + 0.1, meta.crop.lon_left + 1)).toBeNull();
    expect(latlonToCell(meta, meta.crop.lat_top - 1, meta.crop.lon_right + 0.1)).toBeNull();
  });

  it("agrees with the Gale center used by prepare_data.py", () => {
    const c = latlonToCell(meta, -5.37, 137.81)!;
    // crop_window put that pixel at the crop's middle (size // 2 = 128)
    expect(c).toEqual({ row: 128, col: 128 });
  });
});
