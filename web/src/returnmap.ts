import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import type { Terrain } from "./data";
import { oxygenLitres } from "./route/assumptions";

// Colours for the return-trip map. Alpha keeps the terrain visible underneath.
const GREEN = [61, 220, 132, 90];
const AMBER = [255, 200, 50, 110];
const RED = [255, 77, 77, 120];

// Shades every cell by the oxygen needed to walk back to the base:
// green = under half the reserve, amber = up to the whole reserve,
// red = more than the reserve (the astronaut could not get back from there),
// clear = no way back (impassable or cut off).
export class ReturnOverlay {
  private canvas = document.createElement("canvas");
  private ready = false;

  constructor(
    private map: MapLibreMap,
    private terrain: Terrain,
  ) {
    this.canvas.width = terrain.cols;
    this.canvas.height = terrain.rows;
    const c = terrain.meta.crop;
    map.addSource("return", {
      type: "image",
      url: this.canvas.toDataURL(),
      coordinates: [
        [c.lon_left, c.lat_top],
        [c.lon_right, c.lat_top],
        [c.lon_right, c.lat_bottom],
        [c.lon_left, c.lat_bottom],
      ],
    });
    map.addLayer({
      id: "return",
      type: "raster",
      source: "return",
      layout: { visibility: "none" },
      paint: { "raster-resampling": "nearest" },
    });
    this.ready = true;
  }

  // times: walking seconds back to the base per cell (null hides the overlay).
  render(times: Float64Array | null, reserveL: number): void {
    if (!this.ready) return;
    if (!times) {
      this.map.setLayoutProperty("return", "visibility", "none");
      return;
    }
    const ctx = this.canvas.getContext("2d")!;
    const img = ctx.createImageData(this.terrain.cols, this.terrain.rows);
    for (let i = 0; i < times.length; i++) {
      if (!Number.isFinite(times[i])) continue;
      const need = oxygenLitres(times[i]);
      const colour = need <= reserveL * 0.5 ? GREEN : need <= reserveL ? AMBER : RED;
      img.data.set(colour, i * 4);
    }
    ctx.putImageData(img, 0, 0);
    (this.map.getSource("return") as ImageSource).updateImage({ url: this.canvas.toDataURL() });
    this.map.setLayoutProperty("return", "visibility", "visible");
  }
}
