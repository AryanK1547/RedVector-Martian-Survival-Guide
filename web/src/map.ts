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

// Relief (hillshade) is always drawn at the bottom; the CTX photo sits on top
// of it when chosen as the base, so gaps in the photo mosaic show relief, not
// an empty background. Slope and thermal are semi-transparent overlays.
export type Base = "photo" | "relief";
export type Overlay = "slope" | "thermal";
type Layer = "hillshade" | "ctx" | Overlay;
const LAYERS: Layer[] = ["hillshade", "ctx", "thermal", "slope"];
const PAINT: Record<Layer, Record<string, unknown>> = {
  hillshade: { "raster-resampling": "linear" },
  ctx: { "raster-resampling": "linear", "raster-contrast": 0.15 },
  // THEMIS pixels are 100 m: smooth them rather than drawing 10x10-cell blocks.
  thermal: { "raster-resampling": "linear", "raster-opacity": 0.55 },
  slope: { "raster-resampling": "nearest", "raster-opacity": 0.6 },
};

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
    // Keep the map between the left plan card and the right verdict card.
    fitBoundsOptions: { padding: { top: 70, bottom: 20, left: 330, right: 360 } },
    maxBounds: [c.lon_left - padLon, c.lat_bottom - padLat, c.lon_right + padLon, c.lat_top + padLat],
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  // No ScaleControl: MapLibre measures on an Earth-sized globe, so on Mars
  // coordinates its scale bar would be wrong by a factor of about 1.9.
  map.addControl(new maplibregl.AttributionControl({ customAttribution: attribution, compact: true }), "bottom-right");
  map.on("load", () => {
    for (const name of LAYERS) {
      map.addSource(name, { type: "image", url: `${base}${name}.png`, coordinates: imageCorners(meta) });
      map.addLayer({
        id: name,
        type: "raster",
        source: name,
        layout: { visibility: name === "hillshade" ? "visible" : "none" },
        paint: PAINT[name] as never,
      });
    }
    raiseOverlays(map);
  });
  return map;
}

// A photo that covers the whole map replaces the relief completely, so nothing
// ghosts through. A partial photo (the Gale mosaic covers about 24%) sits on a
// dimmed relief, so the rest of the map is not left empty.
export function setBase(map: maplibregl.Map, base: Base, coveragePercent = 100): void {
  const photo = base === "photo";
  const full = coveragePercent >= 99;
  map.setLayoutProperty("ctx", "visibility", photo ? "visible" : "none");
  map.setLayoutProperty("hillshade", "visibility", photo && full ? "none" : "visible");
  map.setPaintProperty("hillshade", "raster-opacity", photo && !full ? 0.4 : 1);
}

export function setOverlay(map: maplibregl.Map, overlay: Overlay, on: boolean): void {
  map.setLayoutProperty(overlay, "visibility", on ? "visible" : "none");
}

// Layers draw in the order they were added. Whichever of the raster layers and
// the route layers is added second would otherwise end up on top, so both
// setup paths call this to put the route line and markers last.
export function raiseOverlays(map: maplibregl.Map): void {
  for (const id of ["return", "route-glow", "route-line", "points", "astronaut"]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }
}

const escapeHtml = (t: string) =>
  t.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

// One labelled pin per science waypoint, with its NASA sources in a popup.
// The two boxwork stops are 22 m apart, so labels alternate sides to stay readable.
export function addWaypointMarkers(map: maplibregl.Map, waypoints: Waypoint[], dataBase = "data/"): maplibregl.Marker[] {
  const markers: maplibregl.Marker[] = [];
  for (const [i, w] of waypoints.entries()) {
    const el = document.createElement("div");
    el.className = `poi ${i % 2 ? "poi-right" : "poi-left"}`;
    el.title = w.name;
    el.innerHTML = `<span class="poi-dot"></span><span class="poi-label">${escapeHtml(w.name)}</span>`;
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
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.AttributionControl({ customAttribution: attribution, compact: true }), "bottom-right");
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
    el.className = `poi poi-right${s.region ? "" : " poi-muted"}`;
    el.title = s.name;
    el.innerHTML = `<span class="poi-dot"></span><span class="poi-label">${escapeHtml(s.name)}</span>`;
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
