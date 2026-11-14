import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Meta } from "./data";

// MapLibre parses GeoJSON in its own worker file. It normally finds that file
// with new URL(..., import.meta.url), which bundlers cannot see, so the file
// would be missing from the build. Importing it with ?url makes Vite copy it
// and hand us its address.
maplibregl.setWorkerUrl(workerUrl);

export type Layer = "hillshade" | "slope";

// The image corners in [lon, lat] order: top-left, top-right, bottom-right,
// bottom-left. MapLibre stretches the PNG over this quadrilateral.
export function imageCorners(meta: Meta): [[number, number], [number, number], [number, number], [number, number]] {
  const c = meta.crop;
  return [
    [c.lon_left, c.lat_top],
    [c.lon_right, c.lat_top],
    [c.lon_right, c.lat_bottom],
    [c.lon_left, c.lat_bottom],
  ];
}

// No external tiles: the style is just a dark background; our own PNGs are
// added as image sources once the map has loaded.
export function createMap(container: HTMLElement, meta: Meta): maplibregl.Map {
  const c = meta.crop;
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#14090a" } }],
    },
    bounds: [c.lon_left, c.lat_bottom, c.lon_right, c.lat_top],
    fitBoundsOptions: { padding: 20 },
    maxBounds: [c.lon_left - 2, c.lat_bottom - 2, c.lon_right + 2, c.lat_top + 2],
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution: "Data: NASA MGS / MOLA, PDS Geosciences Node. Hillshade and slope are our own visualization.",
    }),
    "bottom-right",
  );
  map.on("load", () => {
    for (const name of ["hillshade", "slope"] as Layer[]) {
      map.addSource(name, { type: "image", url: `data/${name}.png`, coordinates: imageCorners(meta) });
      map.addLayer({
        id: name,
        type: "raster",
        source: name,
        layout: { visibility: name === "hillshade" ? "visible" : "none" },
        paint: { "raster-resampling": "nearest" },
      });
    }
    raiseOverlays(map);
  });
  return map;
}

// Layers draw in the order they were added. Whichever of the raster layers and
// the route layers is added second would otherwise end up on top, so both
// setup paths call this to put the route line and markers last.
export function raiseOverlays(map: maplibregl.Map): void {
  for (const id of ["route-line", "points"]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

export function showLayer(map: maplibregl.Map, layer: Layer): void {
  for (const name of ["hillshade", "slope"] as Layer[]) {
    map.setLayoutProperty(name, "visibility", name === layer ? "visible" : "none");
  }
}
