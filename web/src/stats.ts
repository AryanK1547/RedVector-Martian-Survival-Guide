import { walkDoseUgy } from "./conditions";
import { MAX_SLOPE_DEG } from "./route/cost";
import { CAUTION_FRACTION } from "./route/replay";
import { summarize, type RouteStep } from "./route/steps";
import type { Verdict } from "./route/verdict";

const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);
const mins = (s: number) => (Number.isFinite(s) ? `${Math.round(s / 60)} min` : "no way back");

const LABEL = { go: "GO", caution: "CAUTION", "no-go": "NO-GO" } as const;

// A horizontal gauge: fill = value / limit, tick at the caution line.
function bar(label: string, value: string, frac: number, tone: string): string {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return `<div class="gauge"><div class="gauge-head"><span>${label}</span><b>${value}</b></div>
    <div class="gauge-track"><i class="${tone}" style="width:${pct.toFixed(1)}%"></i><em style="left:${CAUTION_FRACTION * 100}%"></em></div></div>`;
}

const tone = (frac: number) => (frac > 1 ? "bad" : frac > CAUTION_FRACTION ? "warn" : "ok");

// The decision card: verdict first, then the margins that drive it, then detail.
export function renderVerdict(el: HTMLElement, steps: RouteStep[], v: Verdict, doseRatePerDay: number, cellSize: string): void {
  const s = summarize(steps);
  const o2Frac = (v.outL + v.backL) / v.reserveL;
  const slopeFrac = v.maxSlopeDeg / MAX_SLOPE_DEG;
  const dose = walkDoseUgy(doseRatePerDay, s.timeS + (Number.isFinite(v.backS) ? v.backS : 0));
  el.innerHTML = `
    <div class="verdict ${v.level}"><span>${LABEL[v.level]}</span><small>EVA assessment</small></div>
    <ul class="reasons">${v.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>
    <div class="science ${v.level}">
      <b>${v.level === "no-go" ? "0" : Math.floor(v.scienceMin)}<small> min</small></b>
      <span>science time at the destination<br>before you must start back*</span>
    </div>
    ${bar("Oxygen, out + back*", `${(v.outL + (Number.isFinite(v.backL) ? v.backL : 0)).toFixed(1)} / ${v.reserveL} L`, o2Frac, tone(o2Frac))}
    ${bar("Steepest ground", `${v.maxSlopeDeg.toFixed(1)}&deg; / ${MAX_SLOPE_DEG}&deg;`, slopeFrac, tone(slopeFrac))}
    <div class="kpis">
      <div><b>${dist(s.distanceM)}</b><small>one way</small></div>
      <div><b>${mins(s.timeS)}</b><small>walk out*</small></div>
      <div><b>${mins(v.backS)}</b><small>walk back*</small></div>
      <div><b>+${Math.round(s.ascentM)} / -${Math.round(s.descentM)} m</b><small>climb / descent</small></div>
      <div><b>${Math.round(s.energyKcal)} kcal</b><small>energy out*</small></div>
      <div><b>${dose.toFixed(1)} &micro;Gy</b><small>radiation&dagger;</small></div>
    </div>
    <details class="assumptions"><summary>How this is calculated</summary>
      <p>* Model assumptions, not NASA suit values: 2.5 km/h on flat ground, slowed on grades (Tobler);
      234 kcal/h (Apollo EVA average), also used for time at the site; 4.8 kcal per litre of O<sub>2</sub>.
      The oxygen reserve is a demo value. Slopes are averaged over ${cellSize} cells; the ${MAX_SLOPE_DEG}&deg; limit is
      Curiosity's maximum recorded pitch. CAUTION at ${CAUTION_FRACTION * 100}% of a limit is a display choice.</p>
      <p>&dagger; Out-and-back walking time x ${doseRatePerDay.toFixed(0)} &micro;Gy/day, the dose rate Curiosity's RAD measured
      in its silicon detector here (July 2025). Not a body dose; suit shielding ignored.</p>
    </details>`;
}

// Elevation (y) against distance (x). Marks the point of no return and is
// sized to its element so it can run as a full-width strip.
export function drawProfile(canvas: HTMLCanvasElement, steps: RouteStep[] | null, pnrIndex: number | null = null): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 90;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  ctx.clearRect(0, 0, w, h);
  if (!steps || steps.length < 2) return;
  const pad = { l: 56, r: 12, t: 12, b: 20 };
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

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, "rgba(255, 210, 63, 0.35)");
  grad.addColorStop(1, "rgba(255, 210, 63, 0.02)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x(0), y(lo));
  for (const s of steps) ctx.lineTo(x(s.distanceM), y(s.elevationM));
  ctx.lineTo(x(total), y(lo));
  ctx.fill();

  ctx.strokeStyle = "#ffd23f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  steps.forEach((s, i) => (i === 0 ? ctx.moveTo(x(s.distanceM), y(s.elevationM)) : ctx.lineTo(x(s.distanceM), y(s.elevationM))));
  ctx.stroke();

  ctx.font = "11px system-ui, sans-serif";
  if (pnrIndex !== null) {
    const px = x(steps[pnrIndex].distanceM);
    ctx.strokeStyle = "#b266ff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.t);
    ctx.lineTo(px, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d4a6ff";
    ctx.fillText("turn back here", Math.min(px + 4, w - 90), pad.t + 10);
  }

  ctx.fillStyle = "rgba(240, 217, 200, 0.75)";
  ctx.fillText(`${Math.round(hi)} m`, 4, pad.t + 8);
  ctx.fillText(`${Math.round(lo)} m`, 4, h - pad.b);
  ctx.fillText("base", pad.l, h - 5);
  ctx.textAlign = "right";
  ctx.fillText(`destination, ${dist(total)}`, w - pad.r, h - 5);
  ctx.textAlign = "left";
}
