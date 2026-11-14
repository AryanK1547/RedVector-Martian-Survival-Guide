export interface Meta {
  crop: {
    rows: number;
    cols: number;
    lat_top: number;
    lat_bottom: number;
    lon_left: number;
    lon_right: number;
    row0: number;
  };
  grid: { pixels_per_degree: number; pixel_size_m: number };
  files: { "slope.bin": { degrees_per_step: number } };
}

export interface Terrain {
  meta: Meta;
  rows: number;
  cols: number;
  elevation: Int16Array; // metres, row-major, north row first
  slopeDeg: Float32Array; // degrees, same layout
}

// Turn the raw bytes into typed arrays. Shape and units come from meta.json.
// Int16Array reads in the machine's byte order; elevation.bin is little-endian
// ("<i2") and every browser we target is little-endian too.
export function parseTerrain(meta: Meta, elevBytes: ArrayBuffer, slopeBytes: ArrayBuffer): Terrain {
  const { rows, cols } = meta.crop;
  const elevation = new Int16Array(elevBytes);
  const steps = new Uint8Array(slopeBytes);
  if (elevation.length !== rows * cols) throw new Error("elevation.bin size does not match meta.json");
  if (steps.length !== rows * cols) throw new Error("slope.bin size does not match meta.json");
  const k = meta.files["slope.bin"].degrees_per_step;
  const slopeDeg = Float32Array.from(steps, (s) => s * k);
  return { meta, rows, cols, elevation, slopeDeg };
}

export async function loadTerrain(base = "data/"): Promise<Terrain> {
  const [meta, elev, slope] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json() as Promise<Meta>),
    fetch(base + "elevation.bin").then((r) => r.arrayBuffer()),
    fetch(base + "slope.bin").then((r) => r.arrayBuffer()),
  ]);
  return parseTerrain(meta, elev, slope);
}

// Same straight scale-and-offset as tools/coords.py, relative to the crop's
// top-left corner. Returns null outside the crop.
export function latlonToCell(meta: Meta, lat: number, lon: number): { row: number; col: number } | null {
  const { crop, grid } = meta;
  const row = Math.floor((crop.lat_top - lat) * grid.pixels_per_degree);
  const col = Math.floor((lon - crop.lon_left) * grid.pixels_per_degree);
  if (row < 0 || col < 0 || row >= crop.rows || col >= crop.cols) return null;
  return { row, col };
}

// Latitude and longitude of the CENTER of a cell.
export function cellToLatlon(meta: Meta, row: number, col: number): { lat: number; lon: number } {
  const { crop, grid } = meta;
  return {
    lat: crop.lat_top - (row + 0.5) / grid.pixels_per_degree,
    lon: crop.lon_left + (col + 0.5) / grid.pixels_per_degree,
  };
}
