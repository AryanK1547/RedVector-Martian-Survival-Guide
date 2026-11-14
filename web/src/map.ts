import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { Meta } from "./data";
import type { Waypoint } from "./waypoints";

// MapLibre parses GeoJSON in its own worker file. It normally finds that file
// with new URL(..., import.meta.url), which bundlers cannot see, so the file
// would be missing from the build. Importing it with ?url makes Vite copy it
// and hand us its address.
maplibregl.setWorkerUrl(workerUrl);

export type Layer = "hillshade" | "slope" | "thermal";
const LAYERS: Layer[] = ["hillshade", "slope", "thermal"];

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
export function createMap(container: HTMLElement, meta: Meta, base: string, attribution: string): maplibregl.Map {
  const c = meta.crop;
  const padLat = (c.lat_top - c.lat_bottom) * 0.5;
  const padLon = (c.lon_right - c.lon_left) * 0.5;
  const map = new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#14090a" } }],
    },
    bounds: [c.lon_left, c.lat_bottom, c.lon_right, c.lat_top],
    fitBoundsOptions: { padding: 20 },
    maxBounds: [c.lon_left - padLon, c.lat_bottom - padLat, c.lon_right + padLon, c.lat_top + padLat],
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(
    new maplibregl.AttributionControl({
      customAttribution: attribution,
    }),
    "bottom-right",
  );
  map.on("load", () => {
    for (const name of LAYERS) {
      map.addSource(name, { type: "image", url: `${base}${name}.png`, coordinates: imageCorners(meta) });
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
  for (const id of ["return", "route-line", "points", "astronaut"]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

export function showLayer(map: maplibregl.Map, layer: Layer): void {
  for (const name of LAYERS) {
    map.setLayoutProperty(name, "visibility", name === layer ? "visible" : "none");
  }
}

const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// One marker per science waypoint, with its NASA sources in a popup.
export function addWaypointMarkers(map: maplibregl.Map, waypoints: Waypoint[], dataBase = "data/"): maplibregl.Marker[] {
  const markers: maplibregl.Marker[] = [];
  for (const w of waypoints) {
    const el = document.createElement("div");
    el.className = "waypoint-marker";
    el.title = w.name;
    const popup = new maplibregl.Popup({ offset: 12, maxWidth: "320px" }).setHTML(
      `<strong>${escapeHtml(w.name)}</strong><br>
       Curiosity, sol ${w.sol}<br>
       ${w.lat.toFixed(6)}&deg;, ${w.lon.toFixed(6)}&deg;E<br>
       <img class="pov" src="${escapeHtml(dataBase + w.imageFile)}" alt="${escapeHtml(w.imageCaption)}">
       <small>${escapeHtml(w.imageCaption)}</small><br>
       <em>"${escapeHtml(w.identificationQuote)}"</em><br>
       <a href="${escapeHtml(w.identificationSource)}" target="_blank" rel="noopener">NASA blog</a> &middot;
       position: NASA PDS MSL PLACES`,
    );
    markers.push(new maplibregl.Marker({ element: el }).setLngLat([w.lon, w.lat]).setPopup(popup).addTo(map));
  }
  return markers;
}

export interface OverviewInfo {
  image: string;
  bounds: { lon_left: number; lon_right: number; lat_top: number; lat_bottom: number };
  sites: { id: string; name: string; lat: number; lon: number; region: string | null; source: string }[];
}

// Whole-planet view: one Web Mercator image of Mars and clickable site markers.
export function createOverviewMap(
  container: HTMLElement,
  base: string,
  info: OverviewInfo,
  attribution: string,
  openRegion: (id: string) => void,
): maplibregl.Map {
  const b = info.bounds;
  const map = new maplibregl.Map({
    container,
    style: { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#14090a" } }] },
    center: [137, 0],
    zoom: 1.2,
    renderWorldCopies: false,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ customAttribution: attribution }), "bottom-right");
  map.on("load", () => {
    map.addSource("mars", {
      type: "image",
      url: base + info.image,
      coordinates: [[b.lon_left, b.lat_top], [b.lon_right, b.lat_top], [b.lon_right, b.lat_bottom], [b.lon_left, b.lat_bottom]],
    });
    map.addLayer({ id: "mars", type: "raster", source: "mars" });
  });
  for (const s of info.sites) {
    const el = document.createElement("div");
    el.className = "waypoint-marker";
    el.title = s.name;
    const box = document.createElement("div");
    box.innerHTML = `<strong>${escapeHtml(s.name)}</strong><br><small>${escapeHtml(s.source)}</small><br>`;
    if (s.region) {
      const btn = document.createElement("button");
      btn.textContent = "Open detailed map";
      btn.addEventListener("click", () => openRegion(s.region!));
      box.append(btn);
    } else {
      box.append("No local MarsWalk data yet.");
    }
    // Longitudes are 0-360 east in our data; MapLibre wants -180..180.
    const lon = s.lon > 180 ? s.lon - 360 : s.lon;
    new maplibregl.Marker({ element: el }).setLngLat([lon, s.lat]).setPopup(new maplibregl.Popup({ offset: 12 }).setDOMContent(box)).addTo(map);
  }
  return map;
}
