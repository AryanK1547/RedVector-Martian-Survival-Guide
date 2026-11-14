export interface Meta {
  crop: {
    name: string;
    rows: number;
    cols: number;
    lat_top: number;
    lat_bottom: number;
    lon_left: number;
    lon_right: number;
  };
  grid: { pixels_per_degree: number; pixel_size_m: number };
  source: { dataset: string };
  files: {
    "elevation.bin": { dtype: "<i2" | "<f4" };
    "slope.bin": { degrees_per_step: number };
    "hillshade.png": { vertical_exaggeration: number };
  };
}

export interface Terrain {
  meta: Meta;
  rows: number;
  cols: number;
  elevation: Float32Array; // metres, row-major, north row first
  slopeDeg: Float32Array; // degrees, same layout
}

// Turn the raw bytes into typed arrays. Shape, dtype and units come from
// meta.json. Typed arrays read in the machine's byte order; the files are
// little-endian ("<") and every browser we target is little-endian too.
export function parseTerrain(meta: Meta, elevBytes: ArrayBuffer, slopeBytes: ArrayBuffer): Terrain {
  const { rows, cols } = meta.crop;
  const dtype = meta.files["elevation.bin"].dtype;
  const raw = dtype === "<i2" ? new Int16Array(elevBytes) : dtype === "<f4" ? new Float32Array(elevBytes) : null;
  if (!raw) throw new Error(`unsupported elevation dtype ${dtype}`);
  const steps = new Uint8Array(slopeBytes);
  if (raw.length !== rows * cols) throw new Error("elevation.bin size does not match meta.json");
  if (steps.length !== rows * cols) throw new Error("slope.bin size does not match meta.json");
  const k = meta.files["slope.bin"].degrees_per_step;
  return { meta, rows, cols, elevation: Float32Array.from(raw), slopeDeg: Float32Array.from(steps, (s) => s * k) };
}

export async function loadTerrain(base: string): Promise<Terrain> {
  const [meta, elev, slope] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json() as Promise<Meta>),
    fetch(base + "elevation.bin").then((r) => r.arrayBuffer()),
    fetch(base + "slope.bin").then((r) => r.arrayBuffer()),
  ]);
  return parseTerrain(meta, elev, slope);
}

// Straight scale-and-offset (equirectangular), relative to the crop's
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

// Human-readable cell size, e.g. "10 m" or "1.85 km".
export function cellSizeLabel(meta: Meta): string {
  const m = meta.grid.pixel_size_m;
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
