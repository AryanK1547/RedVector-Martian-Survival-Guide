import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { oxygenLitres } from "./route/assumptions";
import { alertsFor, stateAt } from "./route/replay";
import type { RouteStep } from "./route/steps";

type LonLat = [number, number];

const PLAYBACK_SECONDS = 20; // every walk is replayed in about this long, whatever its real duration

function clock(s: number): string {
  const t = Math.round(s);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

const metres = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

// Level 1 mission replay: moves an astronaut marker along the route and fills
// a helmet-style HUD from the same RouteStep list the stats panel uses.
export class Player {
  private frame = 0;

  constructor(
    private map: MapLibreMap,
    private hud: HTMLElement,
    private lonLatOf: (cell: number) => LonLat,
    private follow: () => boolean,
  ) {}

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.hud.hidden = true;
    (this.map.getSource("astronaut") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] } as never);
  }

  get playing(): boolean {
    return this.frame !== 0;
  }

  start(steps: RouteStep[], returnTimes: Float64Array, reserveL: number): void {
    this.stop();
    if (steps.length < 2) return;
    const total = steps[steps.length - 1].timeS;
    const speed = Math.max(1, total / PLAYBACK_SECONDS);
    const t0 = performance.now();
    this.hud.hidden = false;

    const tick = (now: number) => {
      const s = stateAt(steps, ((now - t0) / 1000) * speed);
      const a = this.lonLatOf(steps[s.index].cell);
      const b = this.lonLatOf(steps[Math.min(s.index + 1, steps.length - 1)].cell);
      const pos: LonLat = [a[0] + (b[0] - a[0]) * s.frac, a[1] + (b[1] - a[1]) * s.frac];
      (this.map.getSource("astronaut") as GeoJSONSource).setData({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pos } } as never);
      if (this.follow()) this.map.setCenter(pos);

      const returnL = oxygenLitres(returnTimes[steps[s.index].cell]);
      const alerts = alertsFor(s, returnL, reserveL);
      const worst = alerts.some((x) => x.level === "turn-back") ? "turn-back" : alerts.length ? "caution" : "ok";
      this.hud.className = `hud ${worst}`;
      this.hud.innerHTML = `
        <div class="hud-row"><span>EVA ${clock(s.timeS)}</span><span>x${Math.round(speed)} replay</span></div>
        <div class="hud-grid">
          <div><b>${metres(s.distanceM)}</b><small>walked</small></div>
          <div><b>${Math.round(s.elevationM)} m</b><small>elevation</small></div>
          <div><b>${s.slopeDeg.toFixed(0)}&deg;</b><small>slope</small></div>
          <div><b>${Math.max(0, reserveL - s.oxygenUsedL).toFixed(1)} L</b><small>O<sub>2</sub> left*</small></div>
          <div><b>${returnL.toFixed(1)} L</b><small>O<sub>2</sub> to return*</small></div>
        </div>
        <div class="hud-alerts">${alerts.map((x) => `<div class="${x.level}">${x.text}</div>`).join("") || "<div class=\"ok\">All nominal</div>"}</div>
        <div class="hud-note">* model assumptions; reserve is a demo value</div>`;
      this.frame = s.done ? 0 : requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
}
