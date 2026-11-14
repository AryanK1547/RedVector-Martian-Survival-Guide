import type { GeoJSONSource, ImageSource, Map as MapLibreMap } from "maplibre-gl";
import { latlonToCell, type Terrain } from "../data";
import { nearestPassable } from "../route/snap";
import type { Stage, StageLine, StagePick, StagePos } from "./stage";

type LonLat = [number, number];
const empty = { type: "FeatureCollection", features: [] } as never;

// The MapLibre map as a stage: the layers the simulation used to add itself.
export function createMapStage(map: MapLibreMap, terrain: Terrain, lonLat: (idx: number) => LonLat, startCell: number): Stage {
  const c = terrain.meta.crop;
  const hazardCanvas = document.createElement("canvas");
  hazardCanvas.width = terrain.cols;
  hazardCanvas.height = terrain.rows;
  map.addSource("sim-hazard", {
    type: "image",
    url: hazardCanvas.toDataURL(),
    coordinates: [[c.lon_left, c.lat_top], [c.lon_right, c.lat_top], [c.lon_right, c.lat_bottom], [c.lon_left, c.lat_bottom]],
  });
  map.addLayer({ id: "sim-hazard", type: "raster", source: "sim-hazard", paint: { "raster-resampling": "nearest", "raster-fade-duration": 0 } });
  for (const id of ["sim-options", "sim-over", "sim-ahead", "sim-trail", "sim-poi", "sim-marks"]) map.addSource(id, { type: "geojson", data: empty });
  map.addLayer({
    id: "sim-options", type: "line", source: "sim-options",
    paint: {
      "line-color": ["match", ["get", "id"], "continue", "#ffd23f", "inspect", "#3ddc84", "inspect-return", "#b388ff", "#39c6ff"],
      "line-width": 4, "line-dasharray": [1.5, 1.2], "line-opacity": 0.9,
    },
  });
  map.addLayer({
    id: "sim-over", type: "line", source: "sim-over",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "colour"] as never, "line-width": ["get", "width"] as never, "line-opacity": 0.92 },
  });
  const poiColor = ["match", ["get", "state"], "done", "#3ddc84", "skipped", "#8b93a0", "armed", "#b388ff", "#ffd23f"] as never;
  map.addLayer({
    id: "sim-marks",
    type: "circle",
    source: "sim-marks",
    paint: { "circle-radius": 6, "circle-color": ["match", ["get", "kind"], "via", "#ff9d3d", "#7ee2a8"] as never, "circle-opacity": ["case", ["get", "done"], 0.45, 1] as never, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "sim-marks-label",
    type: "symbol",
    source: "sim-marks",
    layout: { "text-field": ["get", "label"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-allow-overlap": true, "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"] },
    paint: { "text-color": "#ffffff", "text-halo-color": "#000000", "text-halo-width": 1.4 },
  });
  map.addLayer({ id: "sim-poi-halo", type: "circle", source: "sim-poi", paint: { "circle-radius": 17, "circle-color": poiColor, "circle-opacity": 0.22 } });
  map.addLayer({ id: "sim-poi", type: "circle", source: "sim-poi", paint: { "circle-radius": 7, "circle-color": poiColor, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "sim-ahead", type: "line", source: "sim-ahead", paint: { "line-color": "#ffe27a", "line-width": 3, "line-opacity": 0.85 }, layout: { "line-join": "round", "line-cap": "round" } });
  map.addLayer({ id: "sim-trail", type: "line", source: "sim-trail", paint: { "line-color": "#ffffff", "line-width": 3, "line-opacity": 0.9 }, layout: { "line-join": "round", "line-cap": "round" } });
  for (const id of ["route-line", "route-glow", "points"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
  if (map.getLayer("astronaut")) map.moveLayer("astronaut");
  map.easeTo({ center: lonLat(startCell), zoom: Math.max(map.getZoom(), 16.3), duration: 1200 });

  const line = (coords: LonLat[]) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } }) as never;
  const at = (p: StagePos): LonLat => {
    const a = lonLat(p.from);
    const b = lonLat(p.to);
    return [a[0] + (b[0] - a[0]) * p.frac, a[1] + (b[1] - a[1]) * p.frac];
  };
  let disposed = false;
  // After dispose the sources are gone; a late call must not throw (it would abort navigation).
  const noop = { setData: () => undefined } as unknown as GeoJSONSource;
  const src = (id: string) => (disposed ? noop : ((map.getSource(id) as GeoJSONSource | undefined) ?? noop));
  let cancelPick: (() => void) | null = null;

  return {
    kind: "map",
    speeds: [30, 60, 120],
    defaultSpeed: 60,
    setHazard(blocked) {
      const ctx = hazardCanvas.getContext("2d")!;
      const img = ctx.createImageData(terrain.cols, terrain.rows);
      blocked.forEach((b, i) => b && img.data.set([255, 60, 40, 175], i * 4));
      ctx.putImageData(img, 0, 0);
      if (!disposed) (map.getSource("sim-hazard") as ImageSource | undefined)?.updateImage({ url: hazardCanvas.toDataURL() });
    },
    setOptions(lines: StageLine[]) {
      src("sim-options").setData({
        type: "FeatureCollection",
        features: lines.filter((l) => l.cells.length > 1).map((l) => ({ type: "Feature", properties: { id: l.id }, geometry: { type: "LineString", coordinates: l.cells.map(lonLat) } })),
      } as never);
    },
    setTrail(cells, pos) {
      src("sim-trail").setData(line([...cells.map(lonLat), at(pos)]));
    },
    setAhead(cells, pos) {
      src("sim-ahead").setData(cells.length ? line([at(pos), ...cells.map(lonLat)]) : empty);
    },
    setPosition(pos, o) {
      const p = at(pos);
      (map.getSource("astronaut") as GeoJSONSource | undefined)?.setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } } as never);
      if (o.follow && !o.done) map.setCenter(p);
    },
    setFind(f) {
      src("sim-poi").setData(f ? ({ type: "Feature", properties: { state: f.state }, geometry: { type: "Point", coordinates: lonLat(f.cell) } } as never) : empty);
    },
    setMarkers(list) {
      src("sim-marks").setData({
        type: "FeatureCollection",
        features: list.map((m) => ({ type: "Feature", properties: { label: m.label, kind: m.kind, done: m.done }, geometry: { type: "Point", coordinates: lonLat(m.cell) } })),
      } as never);
    },
    setOverlay(lines) {
      src("sim-over").setData({
        type: "FeatureCollection",
        features: lines.filter((l) => l.cells.length > 1).map((l) => ({ type: "Feature", properties: { colour: l.colour, width: l.width ?? 6 }, geometry: { type: "LineString", coordinates: l.cells.map(lonLat) } })),
      } as never);
    },
    setDust() {
      /* the dust screen effect is a DOM overlay handled by the simulation view */
    },
    pick(cb: (hit: StagePick | null) => void) {
      cancelPick?.();
      map.getCanvas().style.cursor = "crosshair";
      const done = () => {
        map.off("click", onClick);
        map.getCanvas().style.cursor = "";
        cancelPick = null;
      };
      const onClick = (e: { lngLat: { lng: number; lat: number } }) => {
        done();
        const rc = latlonToCell(terrain.meta, e.lngLat.lat, e.lngLat.lng);
        const snap = rc ? nearestPassable(terrain, rc.row, rc.col, 6) : null;
        cb(snap ? { cell: snap.row * terrain.cols + snap.col, distM: snap.distM } : null);
      };
      map.on("click", onClick);
      cancelPick = done;
      return done;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelPick?.();
      for (const id of ["sim-over", "sim-marks-label", "sim-marks", "sim-poi-halo", "sim-poi", "sim-trail", "sim-ahead", "sim-options", "sim-hazard"]) {
        if (map.getLayer(id)) map.removeLayer(id);
        if (map.getSource(id)) map.removeSource(id);
      }
      for (const id of ["route-line", "route-glow", "points"]) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "visible");
      (map.getSource("astronaut") as GeoJSONSource | undefined)?.setData(empty);
    },
  };
}
