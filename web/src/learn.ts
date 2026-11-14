import type { StageOverlay } from "./sim/stage";
import { FLAT_SPEED_KMH, KCAL_PER_LITRE_O2, METABOLIC_KCAL_PER_H, oxygenLitres } from "./route/assumptions";
import { MAX_SLOPE_DEG, STRATEGIES, groundDistance, type Grid, type StrategyName } from "./route/cost";
import { CAUTION_FRACTION } from "./route/replay";
import {
  STRATEGY_ORDER,
  compareStrategies,
  maxObservationMin,
  reach,
  routeTotals,
  sensitivity,
  splitSections,
  type Reach,
  type Section,
  type SlopeClass,
  type StrategyRoute,
} from "./route/sections";

// The Educational view: a panel next to the 2D map that explains the trade-offs
// behind the route, how each section's numbers are calculated, what the data
// shows, and how the map was made. Every number comes from the same functions
// the simulation uses (route/sections.ts wraps them), so the panel cannot drift
// from what the astronaut actually experiences.

export interface LiveInfo {
  began: boolean;
  phase: string;
  from: number;
  to: number;
  speedFactor: number; // calamity slow-down (dust, injury)
  o2Factor: number; // calamity oxygen multiplier (leak)
}

export interface LearnOptions {
  grid: Grid;
  base: number;
  goal: number;
  reserveL: number;
  scienceS: number;
  getRoute(): number[];
  getStops(): number[];
  getStrategy(): StrategyName;
  canEdit(): boolean;
  useStrategy(n: StrategyName): void;
  overlay(lines: StageOverlay[]): void;
  live(): LiveInfo;
}

export interface Learn {
  el: HTMLElement;
  refresh(): void; // the route or the strategy changed
  tick(): void; // called a few times a second during the run
  dispose(): void;
}

type Tab = "route" | "trade" | "find" | "maps";

const CLASS_COLOUR: Record<SlopeClass, string> = { flat: "#7ee2a8", gentle: "#c8e86a", moderate: "#ffd23f", steep: "#ff7b5c" };
const CLASS_TEXT: Record<SlopeClass, string> = { flat: "flat (under 5 deg)", gentle: "gentle (5 to 10 deg)", moderate: "moderate (10 to 15 deg)", steep: "steep (15 deg and up)" };
const STRAT_COLOUR: Record<StrategyName, string> = { shortest: "#ff9d3d", balanced: "#7ee2a8", safest: "#b388ff" };
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
const m0 = (x: number) => `${Math.round(x)} m`;
const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
const L1 = (x: number) => `${(Math.abs(x) < 0.05 ? 0 : x).toFixed(1)} L`;
const sgn = (x: number, unit: string) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}${unit}`;

export function createLearn(o: LearnOptions): Learn {
  const g = o.grid;
  const el = document.createElement("aside");
  el.id = "learn";
  el.innerHTML = `
    <div class="ln-head"><div><b>EDUCATIONAL VIEW</b><small>how every number on this map is made</small></div><button id="ln-hide" title="Hide this panel">&#9664;</button></div>
    <div class="ln-tabs" role="tablist">
      <button data-tab="route" class="active">Route sections</button><button data-tab="trade">Trade-offs</button><button data-tab="find">Findings</button><button data-tab="maps">Maps &amp; data</button>
    </div>
    <div class="ln-live" id="ln-live"></div>
    <div class="ln-body" id="ln-body"></div>
    <p class="ln-foot">Same functions as the simulation: nothing here is a separate estimate. Model values (speed, energy, oxygen) are assumptions, not NASA suit figures.</p>`;
  const body = el.querySelector<HTMLElement>("#ln-body")!;
  const liveEl = el.querySelector<HTMLElement>("#ln-live")!;

  let tab: Tab = "route";
  let selected = -1;
  let showAll = true;
  let cmp: StrategyRoute[] | null = null;
  let cmpKey = "";
  let reachCache: Reach | null = null;

  const sections = () => splitSections(g, o.getRoute());
  const totals = () => routeTotals(g, o.getRoute());
  const comparison = () => {
    const key = o.getStops().join(",");
    if (!cmp || key !== cmpKey) {
      cmp = compareStrategies(g, o.getStops());
      cmpKey = key;
    }
    return cmp;
  };

  // ---------------- Route sections ----------------
  const budgetBar = (t: ReturnType<typeof totals>) => {
    const outL = oxygenLitres(t.outS);
    const backL = oxygenLitres(t.backS);
    const sciL = oxygenLitres(o.scienceS);
    const marginL = o.reserveL * (1 - CAUTION_FRACTION);
    const spare = Math.max(0, o.reserveL - outL - backL - sciL - marginL);
    const over = outL + backL + sciL > o.reserveL;
    const w = (l: number) => `${Math.max(0, (100 * l) / Math.max(o.reserveL, outL + backL + sciL)).toFixed(2)}%`;
    return `<div class="budget ${over ? "over" : ""}"><i class="b-walk" style="width:${w(outL)}"></i><i class="b-sci" style="width:${w(sciL)}"></i><i class="b-insp" style="width:${w(backL)}"></i><i class="b-spare" style="width:${w(spare)}"></i><i class="b-margin" style="width:${w(marginL)}"></i></div>
      <div class="budget-key"><span class="k-walk">walk out ${L1(outL)}</span><span class="k-sci">observe ${L1(sciL)}</span><span class="k-insp">walk back ${L1(backL)}</span><span class="k-margin">20% margin ${L1(marginL)}</span><span class="k-spare">spare ${L1(spare)}</span></div>`;
  };

  const how = (s: Section, n: number) => {
    const outKmh = (s.lengthM / s.outS) * 3.6;
    const backKmh = (s.lengthM / s.backS) * 3.6;
    const perMin = oxygenLitres(60);
    const oOut = oxygenLitres(s.outS);
    const oBack = oxygenLitres(s.backS);
    const climbing = s.ascentM > s.descentM;
    const insight =
      Math.abs(s.outS - s.backS) < 0.04 * s.outS
        ? "On near-flat ground the way out and the way back cost about the same."
        : climbing
          ? `This section climbs, so the way out is slower. Tobler's function is fastest on a gentle downhill (around −5%), so the way home is ${L1(oOut - oBack)} cheaper. A plan that priced only the outward walk would over-state the return here.`
          : `This section descends on the way out, so the way back is uphill and costs ${L1(oBack - oOut)} more. This is why the return reserve is computed backwards from the base, not by doubling the outward trip.`;
    return `<div class="how"><h5>How section ${n + 1} is calculated</h5>
      <ol>
        <li><b>Grade.</b> The path rises ${sgn(s.endElevM - s.startElevM, " m")} over ${m0(s.lengthM)}, a grade of ${sgn(s.meanGradePct, "%")} (plus is uphill). The terrain slope of its cells averages ${s.meanSlopeDeg.toFixed(1)}&deg; and peaks at ${s.maxSlopeDeg.toFixed(1)}&deg;. Slope is the steepest direction of a cell; grade is along your path, so they differ.</li>
        <li><b>Grade to speed.</b> Tobler's hiking function (an <em>Earth</em> hiking model), scaled so flat ground is ${FLAT_SPEED_KMH} km/h: speed = ${FLAT_SPEED_KMH} &times; exp(&minus;3.5 &times; |grade + 0.05|) &divide; exp(&minus;3.5 &times; 0.05). It is applied to every 10 m step and summed, so this section averages <b>${outKmh.toFixed(2)} km/h</b> out (${(outKmh / FLAT_SPEED_KMH).toFixed(2)}&times; flat) and <b>${backKmh.toFixed(2)} km/h</b> back.</li>
        <li><b>Speed to time.</b> time = distance &divide; speed: <b>${mins(s.outS)}</b> out, <b>${mins(s.backS)}</b> back.</li>
        <li><b>Time to oxygen.</b> oxygen = time &times; ${METABOLIC_KCAL_PER_H} kcal/h &divide; ${KCAL_PER_LITRE_O2} kcal per litre = ${perMin.toFixed(2)} L per minute. Out <b>${L1(oOut)}</b>, back <b>${L1(oBack)}</b>.</li>
      </ol><p class="why">${insight}</p></div>`;
  };

  const routeTab = () => {
    const secs = sections();
    const t = totals();
    if (selected >= secs.length) selected = -1;
    const rows = secs
      .map(
        (s, i) => `<tr class="${i === selected ? "sel" : ""}" data-sec="${i}" tabindex="0">
          <td><i class="chip" style="background:${CLASS_COLOUR[s.cls]}"></i>${i + 1}</td><td>${m0(s.lengthM)}</td><td>${sgn(s.meanGradePct, "%")}</td><td>${mins(s.outS)}</td><td>${mins(s.backS)}</td><td>${L1(oxygenLitres(s.outS + s.backS))}</td></tr>
          ${i === selected ? `<tr class="how-row"><td colspan="6">${how(s, i)}</td></tr>` : ""}`,
      )
      .join("");
    return `<p class="ln-intro">The route is cut where the ground's character changes: runs of the same slope class, short runs merged into a neighbour. <b>Click a row</b> to light it up on the map and see how its time and oxygen were built.</p>
      <table class="ln-table"><tr><th>#</th><th>Length</th><th>Grade</th><th>Out</th><th>Back</th><th>O&#8322; both ways</th></tr>${rows}
        <tr class="total"><td>All</td><td>${m0(t.distanceM)}</td><td>${sgn(((o.grid.elevation[o.getRoute()[o.getRoute().length - 1]] - o.grid.elevation[o.getRoute()[0]]) / t.distanceM) * 100, "%")}</td><td>${mins(t.outS)}</td><td>${mins(t.backS)}</td><td>${L1(t.roundTripL)}</td></tr></table>
      <div class="ln-keys">${(Object.keys(CLASS_COLOUR) as SlopeClass[]).map((c) => `<span><i class="chip" style="background:${CLASS_COLOUR[c]}"></i>${CLASS_TEXT[c]}</span>`).join("")}</div>
      <h4>Where the oxygen goes</h4>${budgetBar(t)}
      <p class="ln-note">The reserve is ${o.reserveL} L (a demo value). Walking out and back plus ${Math.round(o.scienceS / 60)} min of observation must fit inside it, and the 20% margin line is a display choice that leaves room for what nobody planned.</p>`;
  };

  // ---------------- Trade-offs ----------------
  const tradeTab = () => {
    const c = comparison();
    if (!c.length) return `<p class="ln-intro">No walkable route to compare.</p>`;
    const by = Object.fromEntries(c.map((r) => [r.name, r])) as Partial<Record<StrategyName, StrategyRoute>>;
    const cur = o.getStrategy();
    const rows = c
      .map((r) => {
        const spare = o.reserveL - r.totals.roundTripL - oxygenLitres(o.scienceS);
        return `<tr class="${r.name === cur ? "sel" : ""}"><td><i class="chip" style="background:${STRAT_COLOUR[r.name]}"></i><b>${cap(r.name)}</b><small>out ${mins(r.totals.outS)}, back ${mins(r.totals.backS)} &middot; climb +${Math.round(r.totals.ascentM)} m &middot; steepest ${r.totals.steepestDeg.toFixed(1)}&deg;</small></td><td>${m0(r.totals.distanceM)}</td><td>${L1(r.totals.roundTripL)}</td><td>${r.totals.steepSharePct.toFixed(0)}%</td><td class="${spare < 0 ? "neg" : ""}">${L1(spare)}</td>
          <td><button class="ghost sm" data-use="${r.name}" ${o.canEdit() && r.name !== cur ? "" : "disabled"} title="${o.canEdit() ? "Use this route" : "Choose before you press Begin"}">${r.name === cur ? "in use" : "Use"}</button></td></tr>`;
      })
      .join("");
    const sh = by.shortest;
    const sf = by.safest;
    let reading = "";
    if (sh && sf) {
      const dm = sf.totals.distanceM - sh.totals.distanceM;
      const dl = sf.totals.roundTripL - sh.totals.roundTripL;
      const dsteep = sh.totals.steepSharePct - sf.totals.steepSharePct;
      reading =
        Math.abs(dm) < 5 && Math.abs(dsteep) < 1
          ? "On this ground the three strategies find almost the same path: there is no cheaper way around the steep part, so safety costs nothing here. That is itself a finding: the trade-off only exists where the map offers an alternative."
          : `<b>The price of caution:</b> Safest walks <b>${m0(Math.max(0, dm))}</b> ${dm >= 0 ? "more" : "less"} than Shortest and uses <b>${L1(Math.abs(dl))}</b> ${dl >= 0 ? "more" : "less"} oxygen for the round trip, in exchange for <b>${Math.abs(dsteep).toFixed(0)}%</b> ${dsteep >= 0 ? "less" : "more"} of the path on ground at 15&deg; or steeper (steepest cell ${sh.totals.steepestDeg.toFixed(1)}&deg; vs ${sf.totals.steepestDeg.toFixed(1)}&deg;). Oxygen follows <em>time</em>, not safety, so a longer safer path costs oxygen even though nothing about it is dangerous to the suit in our model.`;
    }
    const w = (n: StrategyName) => STRATEGIES[n];
    const matrix = c
      .map((r) => `<tr><td><i class="chip" style="background:${STRAT_COLOUR[r.name]}"></i>${cap(r.name)} route</td>${STRATEGY_ORDER.map((f) => {
        const best = Math.min(...c.map((x) => x.cost[f]));
        return `<td class="${Math.abs(r.cost[f] - best) < 1e-6 ? "win" : ""}">${Math.round(r.cost[f])}</td>`;
      }).join("")}</tr>`)
      .join("");
    const limit = o.reserveL * CAUTION_FRACTION;
    const t0 = totals();
    const maxObs = maxObservationMin(t0.roundTripL, o.reserveL);
    const sens = sensitivity(t0, o.scienceS, o.reserveL)
      .map((s) => `<tr><td>${s.label}</td><td>${L1(s.needL)}</td><td class="${s.spareL < 0 ? "neg" : s.spareL < o.reserveL * (1 - CAUTION_FRACTION) ? "warn" : ""}">${L1(s.spareL)}</td></tr>`)
      .join("");
    return `<p class="ln-intro">The same trip, planned three ways. Each strategy changes what A* counts as expensive.</p>
      <label class="check"><input type="checkbox" id="ln-showall" ${showAll ? "checked" : ""}> Draw all three routes on the map</label>
      <table class="ln-table wide"><tr><th>Strategy</th><th>Length</th><th>O&#8322; both ways</th><th>&ge;15&deg;</th><th>Spare</th><th></th></tr>${rows}</table>
      <p class="ln-note">Spare = reserve &minus; walking both ways &minus; observation. ${reading}</p>
      <h4>Why each route wins</h4>
      <p class="ln-note">A* minimises <code>cost = distance &times; (1 + w<sub>slope</sub> &times; (slope &divide; ${MAX_SLOPE_DEG}&deg;)&sup2;) + w<sub>climb</sub> &times; |height change|</code> for each step. The weights are tuning choices, not NASA data: Shortest ${w("shortest").slopeWeight}/${w("shortest").elevationWeight}, Balanced ${w("balanced").slopeWeight}/${w("balanced").elevationWeight}, Safest ${w("safest").slopeWeight}/${w("safest").elevationWeight}. Priced under each formula, every route is cheapest under its own (green): that is A* doing its job.</p>
      <table class="ln-table wide"><tr><th>Cost of&hellip;</th><th>Shortest formula</th><th>Balanced formula</th><th>Safest formula</th></tr>${matrix}</table>
      <p class="ln-note">Units are &ldquo;penalised metres&rdquo;: a flat metre costs 1, a steep or climbing metre costs more. Cells steeper than ${MAX_SLOPE_DEG}&deg; are not allowed at all.</p>
      <h4>Science time against margin</h4>
      <p class="ln-note">In this model a minute costs ${oxygenLitres(60).toFixed(2)} L whether you walk, climb or stand (energy is held at ${METABOLIC_KCAL_PER_H} kcal/h). Keeping the 20% margin means committing at most ${limit.toFixed(1)} L of the ${o.reserveL} L, so on this route you can observe up to <b>${maxObs.toFixed(0)} min</b>; you planned <b>${Math.round(o.scienceS / 60)} min</b>.</p>
      <h4>If an assumption is wrong</h4>
      <table class="ln-table wide"><tr><th>Scenario</th><th>Needs</th><th>Spare</th></tr>${sens}</table>
      <p class="ln-note">Oxygen = rate &times; time, so a higher energy use scales it directly and slower walking stretches the time. The model's walking speed (2.5 km/h flat) and energy (the Apollo lunar EVA average) are borrowed assumptions, so this table shows how much they matter.</p>`;
  };

  // ---------------- Findings ----------------
  const findTab = () => {
    const secs = sections();
    const t = totals();
    const r = o.getRoute();
    const dz = g.elevation[r[r.length - 1]] - g.elevation[r[0]];
    const meanGrade = (dz / t.distanceM) * 100;
    const faster = ((t.outS - t.backS) / t.outS) * 100;
    const pctWalkO2 = secs.map((s) => ({ s, lenShare: s.lengthM / t.distanceM, o2Share: s.outS / t.outS }));
    const top = pctWalkO2.reduce((a, b) => (b.o2Share / b.lenShare > a.o2Share / a.lenShare ? b : a), pctWalkO2[0]);
    if (!reachCache) reachCache = reach(g, o.base, o.reserveL);
    const rc = reachCache;
    const bar = (Object.keys(CLASS_COLOUR) as SlopeClass[]).map((c) => `<i style="background:${CLASS_COLOUR[c]};width:${t.shares[c].toFixed(1)}%" title="${CLASS_TEXT[c]}: ${t.shares[c].toFixed(0)}%"></i>`).join("");
    const ratio = (g.dx.reduce((a, b) => a + b, 0) / g.dx.length / g.dy) * 100;
    return `<p class="ln-intro">What the data says about <em>this</em> route. The tag shows where each finding comes from.</p>
      <ul class="finds">
        <li><span class="tag c">computed</span><b>The route climbs ${Math.round(t.ascentM)} m and drops ${Math.round(t.descentM)} m</b> over ${m0(t.distanceM)} (net ${sgn(dz, " m")}, mean grade ${sgn(meanGrade, "%")}). The walk out takes ${mins(t.outS)} and the walk back ${mins(t.backS)}: ${Math.abs(faster) < 3 ? "about the same" : `${Math.abs(faster).toFixed(0)}% ${faster > 0 ? "faster" : "slower"} coming home`}, because speed depends on the direction of the grade.</li>
        <li><span class="tag c">computed</span><b>Slope along the route</b> (share of the path length):<div class="shares">${bar}</div><div class="ln-keys">${(Object.keys(CLASS_COLOUR) as SlopeClass[]).map((c) => `<span><i class="chip" style="background:${CLASS_COLOUR[c]}"></i>${c} ${t.shares[c].toFixed(0)}%</span>`).join("")}</div>Steepest cell on the path: ${t.steepestDeg.toFixed(1)}&deg; (the no-go limit is ${MAX_SLOPE_DEG}&deg;).</li>
        <li><span class="tag c">computed</span><b>Not all metres cost the same.</b> Section ${secs.indexOf(top.s) + 1} (${top.s.cls}) is ${(top.lenShare * 100).toFixed(0)}% of the distance but ${(top.o2Share * 100).toFixed(0)}% of the walk-out time, and oxygen follows time.</li>
        <li><span class="tag c">computed</span><b>How far could you roam?</b> ${((100 * rc.passableCells) / rc.totalCells).toFixed(0)}% of the mapped 4 km square is walkable (slope at most ${MAX_SLOPE_DEG}&deg;). From ${((100 * rc.reachableCells) / rc.totalCells).toFixed(0)}% of it you could still get back to base on ${o.reserveL} L, using the backwards Dijkstra search that also gives the point of no return.</li>
        <li><span class="tag a">model</span><b>Oxygen depends only on time here.</b> The suit burns ${oxygenLitres(60).toFixed(2)} L a minute walking uphill, downhill or standing. A real suit would burn more going uphill, so the model under-prices climbs; it only captures them through slower walking.</li>
        <li><span class="tag a">model</span><b>The slope limit is a borrowed number.</b> ${MAX_SLOPE_DEG}&deg; is Curiosity's maximum recorded pitch, a rover figure, not an astronaut limit. Each cell's slope also hides what is smaller than the cell.</li>
        <li><span class="tag v">checked 14 Nov</span><b>The destination sits on a ridge narrower than a cell.</b> The two Curiosity waypoints at the boxwork ridge read steeper than ${MAX_SLOPE_DEG}&deg; in the 10 m model, so routes end at the nearest walkable cell (14 m and 20 m away) and the app says so.</li>
        <li><span class="tag c">computed</span><b>East-west cells are slightly narrower.</b> A grid cell is ${((g.dx.reduce((a, b) => a + b, 0) / g.dx.length)).toFixed(2)} m wide east-west against ${g.dy} m north-south (${ratio.toFixed(2)}%), because meridians converge toward the pole; the code uses the true spacing for every step.</li>
      </ul>`;
  };

  // ---------------- Maps & data ----------------
  const mapsTab = () => `
    <h4>From elevation to a route</h4>
    <ol class="pipe">
      <li><b>Elevation.</b> The USGS MSL Gale Merged DEM (1 m, made from MRO HiRISE stereo images) is cut to a 4 km square and point-sampled to 10 m cells.</li>
      <li><b>Slope.</b> For each cell, slope = arctan of the combined east-west and north-south gradient (central differences), in degrees, kept in 0.5&deg; steps.</li>
      <li><b>Passable ground.</b> Cells steeper than ${MAX_SLOPE_DEG}&deg; are blocked, and a diagonal step may not squeeze between two blocked cells.</li>
      <li><b>Cost of a step.</b> Distance, penalised by slope and height change (the formula on the Trade-offs tab).</li>
      <li><b>A* search.</b> Explores the most promising cell first, guided by straight-line distance, which never over-estimates the cost, so the answer is optimal. It runs in a Web Worker so the page stays responsive.</li>
      <li><b>Walking time and oxygen.</b> Tobler's function gives speed from grade; oxygen = time &times; ${METABOLIC_KCAL_PER_H} kcal/h &divide; ${KCAL_PER_LITRE_O2} kcal/L.</li>
      <li><b>The way back.</b> Dijkstra run <em>backwards</em> from the base gives the walking time home from every cell. The point of no return is the first step where oxygen used plus oxygen to get home exceeds the reserve.</li>
      <li><b>Verdict.</b> Reserve against need, with a caution line at 80% of the reserve and a steepness check.</li>
    </ol>
    <h4>Datasets in this app</h4>
    <table class="ln-table wide data"><tr><th>Data</th><th>Detail</th><th>Used for</th></tr>
      <tr><td>Topography, regional<br><small>MGS MOLA, PDS Geosciences</small></td><td>1.85 km cells</td><td>Gale overview. Under-states slopes.</td></tr>
      <tr><td>Topography, local<br><small>USGS MSL Gale Merged DEM v3 (HiRISE)</small></td><td>1 m, used at 10 m cells</td><td>Routes, slopes, the 3D walk</td></tr>
      <tr><td>Imagery<br><small>MRO CTX via NASA Mars Trek</small></td><td>about 10 m per pixel</td><td>Base photo; draped on the 3D terrain</td></tr>
      <tr><td>Thermal inertia<br><small>Mars Odyssey THEMIS (ASU)</small></td><td>qualitative</td><td>Lens: low over dust and sand, high over rock</td></tr>
      <tr><td>Rover positions<br><small>Curiosity PLACES (PDS)</small></td><td>per waypoint</td><td>Science stops; alignment check</td></tr>
      <tr><td>Weather and radiation<br><small>Curiosity REMS and RAD (PDS)</small></td><td>sols 4598 and 4602</td><td>Outside conditions. History, not a forecast.</td></tr>
    </table>
    <h4>Mapping facts worth knowing</h4>
    <details class="fact"><summary>Maps from orbit have to be lined up with the ground <span class="tag v">checked 14 Nov</span></summary><p>Our first cut of the 1 m elevation model sat about 840 m east-west and 60 m north-south from where it belonged, which showed up as a bogus 55 m elevation offset against the rover. We found the shift by correlating the model's relief with the CTX photo, confirmed CTX agrees with MOLA, and corrected it. It now matches Curiosity's own elevations to 9 m and 1.3 m at the two waypoints. Lesson: always check orbital maps against a ground-truth position.</p></details>
    <details class="fact"><summary>Cell size decides what you can see <span class="tag v">checked 14 Nov</span></summary><p>At 10 m per cell, features smaller than a cell (a single boxwork ridge) can be missed, and the 1.85 km overview under-states slopes: the same hill looks gentler the coarser the map. That is why local routes use the 10 m model and why the app warns when a destination sits on a ridge.</p></details>
    <details class="fact"><summary>Photos are not elevation <span class="tag g">general knowledge</span></summary><p>The CTX image is a picture with the sun and shadows already in it; the elevation model is the geometry. The 3D walk drapes the photo over the elevation model, so shadows in the photo and shadows from our sun can disagree.</p></details>
    <details class="fact"><summary>Mars has no sea level <span class="tag g">general knowledge</span></summary><p>Heights are measured from a reference surface defined from the MOLA laser altimeter, so many places read negative (about &minus;3.6 km at this base). Only differences matter for walking.</p></details>
    <details class="fact"><summary>Thermal inertia hints at the surface <span class="tag g">general knowledge</span></summary><p>THEMIS measures how fast the ground heats and cools. Dust and sand change temperature quickly (low inertia); solid rock holds temperature (high inertia). The lens is qualitative and tells you what the ground is made of, not whether you can walk on it.</p></details>
    <h4>More sources we can add</h4>
    <p class="ln-note">Listed from the project's data-source notes. <b>None is downloaded or used by a number in this app yet.</b></p>
    <ul class="srcs">
      <li><a href="https://data.nasa.gov/dataset/?tags=mars" target="_blank" rel="noopener">NASA Open Data portal, datasets tagged &ldquo;mars&rdquo;</a></li>
      <li><a href="https://www.issdc.gov.in/isda.html" target="_blank" rel="noopener">ISRO ISSDC data archive</a>: ISRO hosts Mars Orbiter Mission (MOM) archives and geospatial maps through the ISRO VEDAS Mars Atlas.</li>
      <li>USGS Astrogeology Science Center: planetary cartography and surface databases. <em>Already used: the Gale Merged DEM.</em></li>
      <li>ASU Mars Space Flight Facility: global thermal infrared mosaics, elevation data and mineral maps. <em>Already used: THEMIS thermal inertia.</em></li>
      <li>Mars Climate Database (LMD, ESA, CNES): atmospheric simulations. <em>Not used:</em> our weather is Curiosity's measurements, a history; the database could add modelled conditions for other places and seasons.</li>
    </ul>`;

  // ---------------- live card ----------------
  const live = () => {
    const l = o.live();
    if (!l.began) {
      liveEl.innerHTML = `<b>RIGHT NOW</b><span>Press <em>Begin EVA</em>. This card then explains the ground under the astronaut: slope, grade, speed and oxygen burn.</span>`;
      return;
    }
    const walking = l.phase === "outbound" || l.phase === "inbound" || l.phase === "detour";
    const burn = oxygenLitres(60) * l.o2Factor;
    if (!walking) {
      liveEl.innerHTML = `<b>RIGHT NOW</b><span>${l.phase === "returned" ? "Back at base." : l.phase === "lost" ? "EVA over." : "Standing and working."} Oxygen burn <b>${burn.toFixed(2)} L/min</b>${l.o2Factor > 1 ? ` (&times;${l.o2Factor.toFixed(1)}, a leak)` : ""}: the model burns the same standing as walking.</span>`;
      return;
    }
    const d = groundDistance(g, l.from, l.to) || 1;
    const grade = ((g.elevation[l.to] - g.elevation[l.from]) / d) * 100;
    const f = Math.exp(-3.5 * Math.abs(grade / 100 + 0.05)) / Math.exp(-3.5 * 0.05);
    const kmh = FLAT_SPEED_KMH * f * l.speedFactor;
    liveEl.innerHTML = `<b>RIGHT NOW</b><span>Cell slope <b>${g.slopeDeg[l.from].toFixed(1)}&deg;</b>, grade along the step <b>${sgn(grade, "%")}</b> &rarr; speed &times;${f.toFixed(2)}${l.speedFactor < 1 ? ` &times;${l.speedFactor} (calamity)` : ""} = <b>${kmh.toFixed(2)} km/h</b>. Burn <b>${burn.toFixed(2)} L/min</b>, so each 10 m step costs about <b>${((burn * (10 / ((kmh * 1000) / 60)))).toFixed(2)} L</b>.</span>`;
  };

  // ---------------- wiring ----------------
  const overlayNow = () => {
    if (tab === "route" && selected >= 0) {
      const s = sections()[selected];
      o.overlay(s ? [{ cells: s.cells, colour: "#39c6ff", width: 9 }] : []);
    } else if (tab === "trade" && showAll) {
      o.overlay(comparison().map((r, i) => ({ cells: r.cells, colour: STRAT_COLOUR[r.name], width: 7 - i })));
    } else o.overlay([]);
  };
  const render = () => {
    body.innerHTML = tab === "route" ? routeTab() : tab === "trade" ? tradeTab() : tab === "find" ? findTab() : mapsTab();
    el.querySelectorAll<HTMLButtonElement>(".ln-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    overlayNow();
  };
  el.querySelectorAll<HTMLButtonElement>(".ln-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      tab = b.dataset.tab as Tab;
      body.scrollTop = 0;
      render();
    }),
  );
  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>("[data-sec]");
    if (row) {
      const i = Number(row.dataset.sec);
      selected = selected === i ? -1 : i;
      render();
      return;
    }
    const use = t.closest<HTMLButtonElement>("[data-use]");
    if (use && !use.disabled) o.useStrategy(use.dataset.use as StrategyName);
  });
  body.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === "ln-showall") {
      showAll = t.checked;
      overlayNow();
    }
  });
  body.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).matches("[data-sec]")) {
      e.preventDefault();
      (e.target as HTMLElement).click();
    }
  });
  render();
  live();
  return {
    el,
    refresh() {
      cmp = null;
      selected = -1;
      render();
      live();
    },
    tick: live,
    dispose() {
      o.overlay([]);
      el.remove();
    },
  };
}
