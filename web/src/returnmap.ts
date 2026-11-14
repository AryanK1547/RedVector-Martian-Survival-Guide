import type { ImageSource, Map as MapLibreMap } from "maplibre-gl";
import type { Terrain } from "./data";
import { oxygenLitres } from "./route/assumptions";

// "Spotlight" return-range map: the terrain you can walk to and still get back
// stays clear (lightly tinted); everything beyond the reserve is dimmed, so the
// reachable area stands out without painting most of the map red.
const COMFORT = [61, 220, 132, 45]; // back on under half the reserve
const TIGHT = [255, 200, 50, 70]; // back on half to all of the reserve
const OUT = [8, 4, 4, 150]; // beyond the reserve, or no way back at all

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
      paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 },
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
      const need = Number.isFinite(times[i]) ? oxygenLitres(times[i]) : Infinity;
      img.data.set(need <= reserveL * 0.5 ? COMFORT : need <= reserveL ? TIGHT : OUT, i * 4);
    }
    ctx.putImageData(img, 0, 0);
    (this.map.getSource("return") as ImageSource).updateImage({ url: this.canvas.toDataURL() });
    this.map.setLayoutProperty("return", "visibility", "visible");
  }
}
