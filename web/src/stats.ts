import { MAX_SLOPE_DEG } from "./route/cost";
import type { RouteStep, RouteSummary } from "./route/steps";

const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function hoursMinutes(s: number): string {
  const total = Math.round(s / 60);
  return `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`;
}

export function renderStats(el: HTMLElement, s: RouteSummary, cellSize: string): void {
  el.innerHTML = `
    <table>
      <tr><td>Distance</td><td>${dist(s.distanceM)}</td></tr>
      <tr><td>Ascent / descent</td><td>${Math.round(s.ascentM)} / ${Math.round(s.descentM)} m</td></tr>
      <tr><td>Steepest cell</td><td>${s.maxSlopeDeg.toFixed(1)}&deg; (limit ${MAX_SLOPE_DEG}&deg;)</td></tr>
      <tr><td>Walking time*</td><td>${hoursMinutes(s.timeS)}</td></tr>
      <tr><td>Energy*</td><td>${Math.round(s.energyKcal)} kcal</td></tr>
      <tr><td>Oxygen used*</td><td>${Math.round(s.oxygenL)} L</td></tr>
    </table>
    <p class="note">* Model assumptions, not NASA mission values: 2.5 km/h on flat ground slowed on grades (Tobler),
    234 kcal/h (Apollo EVA average), 4.8 kcal per litre O<sub>2</sub>. Slopes are averaged over ${cellSize} cells.</p>`;
}

// Elevation (y) against distance along the route (x), drawn on a canvas.
export function drawProfile(canvas: HTMLCanvasElement, steps: RouteStep[] | null): void {
  const ctx = canvas.getContext("2d")!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (!steps || steps.length < 2) return;
  const pad = { l: 44, r: 6, t: 8, b: 18 };
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of steps) {
    lo = Math.min(lo, s.elevationM);
    hi = Math.max(hi, s.elevationM);
  }
  if (hi - lo < 1) hi = lo + 1;
  const total = steps[steps.length - 1].distanceM;
  const x = (d: number) => pad.l + ((w - pad.l - pad.r) * d) / total;
  const y = (e: number) => pad.t + ((h - pad.t - pad.b) * (hi - e)) / (hi - lo);

  ctx.fillStyle = "rgba(255, 210, 63, 0.18)";
  ctx.beginPath();
  ctx.moveTo(x(0), y(lo));
  for (const s of steps) ctx.lineTo(x(s.distanceM), y(s.elevationM));
  ctx.lineTo(x(total), y(lo));
  ctx.fill();

  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  steps.forEach((s, i) => (i === 0 ? ctx.moveTo(x(s.distanceM), y(s.elevationM)) : ctx.lineTo(x(s.distanceM), y(s.elevationM))));
  ctx.stroke();

  ctx.fillStyle = "#f0d9c8";
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(`${Math.round(hi)} m`, 2, pad.t + 8);
  ctx.fillText(`${Math.round(lo)} m`, 2, h - pad.b);
  ctx.fillText("0", pad.l, h - 4);
  ctx.textAlign = "right";
  ctx.fillText(dist(total), w - pad.r, h - 4);
  ctx.textAlign = "left";
}
