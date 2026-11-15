import type { Terrain } from "../data";
import { astar } from "../route/astar";
import { STRATEGIES, gridFromTerrain, type StrategyName } from "../route/cost";
import { createLearn, type Learn } from "../learn";
import { CAUTION_FRACTION } from "../route/replay";
import { routeTotals } from "../route/sections";
import { CALAMITIES, SCENARIO, Sim, type CalamityKind, type OptionPlan } from "./engine";
import type { SimAudio, Stage, StageLine } from "./stage";

export interface SimSetup {
  stage: Stage; // what draws the world: the map or the 3D scene
  audio?: SimAudio; // sound and voice, if the stage has any
  terrain: Terrain;
  base: number;
  goal: number;
  cells: number[];
  strategy: StrategyName;
  reserveL: number;
  scienceS: number;
  randomCount: number;
  findMode: "off" | "random" | "place"; // one unplanned find: none, at a random place, or placed by mission control
  objective: { name: string; quote?: string; sourceUrl?: string }; // the mission brief from Earth
  seed: number;
  role?: "astronaut" | "capcom"; // who the player is; same engine either way
  // Measured context for the field notes (Curiosity REMS / RAD on a waypoint sol)
  facts?: { sol: string; tempMinC: number; tempMaxC: number; pressurePa: number; radUgyDay: number };
  panel: HTMLElement; // mission control card
  hud: HTMLElement; // astronaut suit display
  fx: HTMLElement; // full-screen effects layer (dust)
  app: HTMLElement;
  onExit: () => void;
  onRestart: (seed: number) => void;
}

const DECISION_SECONDS = 20; // real seconds before the astronaut follows the recommendation
const FIND_SECONDS = 75; // planning an inspection takes longer than reacting to a calamity
const MORE_SECONDS = 15; // one extra grant per decision
const MAX_VIA = 3; // waypoints the user may add to the route
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clock = (s: number) => {
  if (!Number.isFinite(s)) return "--:--";
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};
const litres = (l: number) => (Number.isFinite(l) ? `${(Math.abs(l) < 0.05 ? 0 : l).toFixed(1)} L` : "--");
const PHASE = {
  outbound: "Walking out",
  detour: "Detour to the find",
  inspect: "Inspecting the find",
  science: "Science work",
  inbound: "Returning",
  returned: "Back at base",
  lost: "EVA failed",
} as const;

// Mission Control's radio lines (spoken in 3D). Scenario script, not NASA transcripts.
const RADIO: Record<CalamityKind, string> = {
  rockfall: "Rockfall reported ahead. Part of your route is blocked. Recalculating.",
  leak: "Warning. Suit oxygen leak detected. Watch your reserve.",
  dust: "Dust storm moving in. Visibility is dropping. Reduce pace.",
  injury: "Medical alert. Astronaut injured. Reduce pace.",
  spe: "Solar particle event warning. Return to base within thirty minutes.",
};

// Field notes: one or two sentences of real context when something happens.
// Numbers come from the data files (facts) or the scenario; the rest is
// general Mars knowledge, kept qualitative.
function fieldNote(kind: CalamityKind, f: SimSetup["facts"]): string {
  switch (kind) {
    case "dust":
      return "Dust storms are real on Mars and can grow to cover the whole planet: a global storm in 2018 ended the Opportunity rover's mission. In this drill the storm slows walking, so every remaining metre costs more oxygen.";
    case "spe":
      return `Mars has no global magnetic field and only a thin atmosphere, so particles from solar storms reach the ground.${f ? ` On an ordinary day (sol ${f.sol}) Curiosity's RAD measured ${f.radUgyDay} &micro;Gy/day in its silicon detector.` : ""} A solar particle event can raise that sharply, so the drill gives you a deadline to get under shelter.`;
    case "leak":
      return "A leak drains oxygen on top of breathing. This is exactly why the plan keeps a 20% margin: it is the only buffer for losses nobody planned.";
    case "rockfall":
      return "Part of the route is now blocked. The suit computer replans around it with A* on the real terrain (10 m cells from the USGS HiRISE elevation model), so the new path and its oxygen cost are computed, not guessed.";
    case "injury":
      return "An injured astronaut walks slower, and on a fixed oxygen supply slower walking means more litres for every metre home.";
  }
}

// The observation time at the destination is split into tasks. Each takes a share of
// the planned minutes, so they finish in order and the last ones are the first to be
// cut when oxygen or a deadline forces the walk home. The shares are scenario values.
const SCIENCE_TASKS = [
  { id: "photo", label: "Photograph the surroundings", w: 0.2 },
  { id: "sample", label: "Collect a rock sample", w: 0.35 },
  { id: "sensors", label: "Read the suit weather and radiation sensors", w: 0.25 },
  { id: "report", label: "Radio the science report to Earth", w: 0.2 },
] as const;

function scienceNote(id: string, f: SimSetup["facts"]): string {
  switch (id) {
    case "photo":
      return "Panoramas are how rover teams plan their next move; the NASA text for this waypoint was written from a Navcam image like this. Boxwork is a network of low ridges, and the leading explanation is that groundwater once deposited minerals in cracks that outlasted the softer rock around them (general knowledge, not computed here).";
    case "sample":
      return "Bringing rock samples back to Earth is one of the biggest goals of Mars exploration, and Perseverance is already caching drilled samples for it. Here the sample is a scenario task: it spends observation time, just as a real one would.";
    case "sensors":
      return f
        ? `Curiosity measured ${f.tempMinC} to ${f.tempMaxC} &deg;C, ${Math.round(f.pressurePa)} Pa and ${f.radUgyDay} &micro;Gy/day on sol ${f.sol}. Temperature and radiation are two of the things that decide how long a crew can stay out.`
        : "Temperature and radiation are two of the things that decide how long a crew can stay out.";
    default:
      return "A real report to Earth takes minutes one way (roughly 3 to 22 light-minutes, depending on where the planets are), so crews and rovers work from a plan instead of waiting for answers.";
  }
}

export function startSim(s: SimSetup): () => void {
  const { terrain, stage } = s;
  const astronaut = s.role === "astronaut";
  const caller = astronaut ? "Astronaut" : "Mission control";
  // ---- field note toast ----
  const note = document.createElement("div");
  note.className = "field-note";
  note.hidden = true;
  s.app.append(note);
  let noteTimer = 0;
  const showNote = (title: string, html: string, ms = 15000) => {
    note.innerHTML = `<div class="fn-head"><span>FIELD NOTE</span><b>${title}</b><button aria-label="Close">&times;</button></div><p>${html}</p>`;
    note.hidden = false;
    note.querySelector("button")!.addEventListener("click", () => (note.hidden = true));
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note.hidden = true), ms);
  };
  // ---- black box: what happened, for the debrief ----
  const samples: { t: number; o2: number; home: number }[] = [];
  const calls: { t: number; what: string; chosen: string; rec: string; by: string }[] = [];
  let lastSampleT = -Infinity;
  let minMargin = { l: Infinity, t: 0 };
  let wasGoal = false;
  const SPEEDS = stage.speeds;
  const grid = gridFromTerrain(terrain);
  // The route is editable until Begin: another strategy, or up to MAX_VIA waypoints
  // the user adds. Each edit re-plans with A* on the real terrain and restarts the run.
  let strategyName: StrategyName = s.strategy;
  let via: number[] = [];
  let route = s.cells.slice();
  let armedCell: number | null = null;
  const makeSim = () => {
    const m = new Sim({ grid, base: s.base, goal: s.goal, outPath: route, reserveL: s.reserveL, strategy: STRATEGIES[strategyName], scienceS: s.scienceS }, s.seed);
    if (s.randomCount > 0) m.scheduleRandom(s.randomCount);
    if (s.findMode === "random") m.scheduleFind();
    return m;
  };
  let sim = makeSim();
  const plannedScienceS = s.scienceS;
  let learn: Learn | null = null; // the Educational view's panel (2D map only)
  const routeM = () => Math.round(routeTotals(grid, route).distanceM);

  let blockedCount = 0;

  // ---- mission control panel ----
  let speed = stage.defaultSpeed;
  let paused = true; // held on the mission brief until the user presses Begin
  let began = false;
  let follow = true;
  const plan0 = sim.options().find((o) => o.id === "continue");
  const planLine = plan0
    ? `Plan: ${Math.round(plan0.walkS / 60)} min of walking out and back, ${Math.floor(s.scienceS / 60)} min of observation. Needs <b>${litres(plan0.needL)}</b> of the <b>${litres(s.reserveL)}</b> reserve, leaving <b>${litres(plan0.spareL)}</b> spare.`
    : "";
  s.panel.innerHTML = `
    <div class="mc-head"><span class="live"></span>MISSION CONTROL<span class="met" id="mc-met">T+0:00:00</span></div>
    <div class="brief" id="mc-brief">
      <div class="brief-tag">MISSION BRIEF &middot; EARTH SCIENCE TEAM <small>(training scenario)</small></div>
      <p class="role-line">${astronaut ? "<b>You are the EVA astronaut.</b> CAPCOM in the habitat advises; every call is yours." : "<b>You are CAPCOM</b>, Mission Control in the habitat. Earth is minutes of light-time away, so live calls during the walk are yours."}</p>
      <p><b>Objective:</b> reach <b>${esc(s.objective.name)}</b>, observe for ${Math.floor(s.scienceS / 60)} min, and return to base.</p>
      <p><b>Also:</b> report anything notable on the way, but only if the oxygen allows it.</p>
      ${s.objective.quote ? `<blockquote>&ldquo;${esc(s.objective.quote)}&rdquo;<cite>NASA Curiosity team blog${s.objective.sourceUrl ? ` &middot; <a href="${esc(s.objective.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ""}</cite></blockquote>` : ""}
      <p class="note" id="mc-plan">${planLine}</p>
      <div class="route-edit" id="mc-route">
        <h4>Edit the route <small>(before you begin)</small></h4>
        <div class="seg" id="mc-strat">${(["shortest", "balanced", "safest"] as StrategyName[]).map((n) => `<button data-v="${n}" class="${n === strategyName ? "active" : ""}">${n[0].toUpperCase()}${n.slice(1)}</button>`).join("")}</div>
        <div class="route-btns"><button class="ghost sm" id="mc-via">+ Add waypoint</button><button class="ghost sm" id="mc-via-clear" disabled>Clear waypoints</button></div>
        <p class="note" id="mc-route-msg">Pick a strategy, or add up to ${MAX_VIA} waypoints (click the ground). Each waypoint becomes a task on the walk and the route is re-planned on the real terrain.</p>
      </div>
      <button class="primary wide" id="mc-begin">Begin EVA &#9654;</button>
    </div>
    <ul class="objectives" id="mc-obj"></ul>
    ${s.findMode === "place" ? `<div class="place"><button class="ghost wide" id="mc-place">&#9678; Place the find</button><p class="note" id="mc-place-msg">Click the button, then click the ground. The astronaut notices it once within ${SCENARIO.findRevealM} m of it (violet dot = placed, not yet noticed). You can move it until then. Scenario target, not a real Mars observation.</p></div>` : ""}
    <div class="mc-controls">
      <button class="ghost sm" id="mc-pause">Resume</button>
      <div class="seg" id="mc-speed">${SPEEDS.map((v) => `<button data-v="${v}" class="${v === speed ? "active" : ""}">${v}x</button>`).join("")}</div>
      <label class="check"><input type="checkbox" id="mc-follow" checked> Follow</label>
    </div>
    <h3 ${astronaut && s.randomCount > 0 ? "hidden" : ""}>${astronaut ? "Training: trigger an event" : "Inject a calamity"}</h3>
    <div class="mc-inject" ${astronaut && s.randomCount > 0 ? "hidden" : ""}>${(Object.keys(CALAMITIES) as CalamityKind[]).map((k) => `<button class="ghost" data-k="${k}" title="${CALAMITIES[k].detail}"><span>${CALAMITIES[k].icon}</span>${CALAMITIES[k].label}</button>`).join("")}</div>
    <p class="note">${s.randomCount > 0 ? (astronaut ? `${s.randomCount} calamities will strike without warning (seed ${s.seed}). As the astronaut you cannot trigger them.` : `${s.randomCount} random calamities scheduled (seed ${s.seed}); timing hidden.`) : "No random calamities; inject them by hand."}
      Calamity strengths are scenario settings for training, not NASA data.</p>
    <h3>Mission log</h3>
    <ol class="mc-log" id="mc-log"></ol>
    <button class="ghost" id="mc-debrief" hidden>Show the debrief</button>
    <button class="ghost" id="mc-exit">Exit simulation</button>`;
  const $ = <T extends HTMLElement>(sel: string) => s.panel.querySelector<T>(sel)!;
  const pauseBtn = $<HTMLButtonElement>("#mc-pause");
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });
  s.panel.querySelectorAll<HTMLButtonElement>("#mc-speed button").forEach((b) =>
    b.addEventListener("click", () => {
      speed = Number(b.dataset.v);
      s.panel.querySelectorAll("#mc-speed button").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  $<HTMLButtonElement>("#mc-begin").addEventListener("click", () => {
    began = true;
    s.audio?.radio(`Message from Earth, sent several minutes ago. Science team requests observations at ${s.objective.name}. Good luck.`, false, "earth");
    s.audio?.radio(astronaut ? "CAPCOM here. You are go for EVA. We will advise, your call out there." : "EVA, CAPCOM. You are go. Proceed to the destination.");
    if (s.facts)
      showNote(
        "Outside the suit",
        `Measured by Curiosity on sol ${s.facts.sol}: air <b>${s.facts.tempMinC} to ${s.facts.tempMaxC} &deg;C</b>, pressure <b>${Math.round(s.facts.pressurePa)} Pa</b> (under 1% of Earth's). Every breath comes from the suit: the oxygen in the display is all there is.`,
      );
    paused = false;
    pauseBtn.textContent = "Pause";
    cancelPick?.();
    cancelPick = null;
    $("#mc-route").hidden = true;
    learn?.refresh();
    $("#mc-brief").classList.add("started");
    $<HTMLButtonElement>("#mc-begin").hidden = true;
  });
  // ---- placing the find by hand ----
  let cancelPick: (() => void) | null = null;
  const placeBtn = s.panel.querySelector<HTMLButtonElement>("#mc-place");
  const placeMsg = s.panel.querySelector<HTMLElement>("#mc-place-msg");
  placeBtn?.addEventListener("click", () => {
    if (cancelPick) {
      cancelPick();
      cancelPick = null;
      placeBtn.classList.remove("active");
      return;
    }
    placeBtn.classList.add("active");
    if (placeMsg) placeMsg.textContent = "Click the ground where the find should be.";
    cancelPick = stage.pick((hit) => {
      cancelPick = null;
      placeBtn.classList.remove("active");
      if (!hit) {
        if (placeMsg) placeMsg.textContent = "That point is outside the map, or has no walkable ground within 60 m.";
        return;
      }
      const err = sim.armFind(hit.cell);
      if (!err) armedCell = hit.cell;
      if (placeMsg) {
        placeMsg.textContent = err
          ? err
          : `Find placed ${Math.round(sim.armed!.offsetM)} m off the route${hit.distM > 1 ? ` (moved ${Math.round(hit.distM)} m to walkable ground)` : ""}. It is noticed within ${SCENARIO.findRevealM} m. Click the button again to move it.`;
      }
    });
  });
  // 2D map: the camera follows the astronaut until the person drags or zooms the map; a button gives the follow back.
  const followEl = $<HTMLInputElement>("#mc-follow");
  const followBtn = document.createElement("button");
  followBtn.className = "recentre";
  followBtn.type = "button";
  followBtn.hidden = true;
  followBtn.innerHTML = "&#8982; Follow astronaut";
  // Map tools (2D walk only; the 3D walk has its own buttons): sound, voice, music, and Follow.
  const tools = document.createElement("div");
  tools.className = "map-tools";
  const au = s.audio as (SimAudio & { muted?: boolean; voice?: boolean; music?: boolean; setMuted?(m: boolean): void; setVoice?(on: boolean): void; setMusic?(on: boolean): void }) | undefined;
  if (stage.kind === "map" && au?.setMuted && au.setVoice && au.setMusic) {
    const toggle = (html: (on: boolean) => string, get: () => boolean, set: (on: boolean) => void, title: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      const paint = () => {
        b.innerHTML = html(get());
        b.classList.toggle("off", !get());
      };
      b.addEventListener("click", () => {
        set(!get());
        paint();
      });
      paint();
      tools.append(b);
    };
    toggle((on) => (on ? "&#128266; Sound" : "&#128263; Muted"), () => !au.muted, (on) => au.setMuted!(!on), "Sound on/off");
    toggle(() => "&#128483; Voice", () => !!au.voice, (on) => au.setVoice!(on), "Radio voice on/off");
    toggle(() => "&#9835; Music", () => !!au.music, (on) => au.setMusic!(on), "Music on/off");
  }
  tools.append(followBtn);
  if (stage.kind === "map") s.app.append(tools);
  const setFollow = (on: boolean) => {
    follow = on;
    followEl.checked = on;
    followBtn.hidden = on || stage.kind !== "map";
  };
  followEl.addEventListener("change", () => setFollow(followEl.checked));
  followBtn.addEventListener("click", () => setFollow(true));
  const stopUserMove = stage.onUserMove?.(() => follow && setFollow(false));
  $<HTMLButtonElement>("#mc-exit").addEventListener("click", () => s.onExit());
  s.panel.querySelectorAll<HTMLButtonElement>(".mc-inject button").forEach((b) =>
    b.addEventListener("click", () => {
      if (sim.done || decision || findPlan || !began) return;
      const kind = b.dataset.k as CalamityKind;
      sim.apply(kind);
      onCalamity(kind);
    }),
  );

  // ---- the decision screen: a full-width card over the scene, so a call is never squeezed into the sidebar ----
  const overlay = document.createElement("div");
  overlay.className = "dec-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div class="dec-card" id="dec-card"></div>`;
  s.app.append(overlay);
  const decisionEl = overlay.querySelector<HTMLElement>("#dec-card")!;
  let overlayDismissed = false;
  const timerHtml = (secs: number) => `<div class="dec-timer" role="timer" aria-live="off"><b id="dec-secs">${secs}</b><small>seconds</small></div>`;
  const footHtml = `<div class="dec-foot"><button class="ghost sm" id="dec-more">Need more time? +${MORE_SECONDS} s</button><span id="mc-count-text"></span></div>
      <div class="dec-bar"><i id="mc-count"></i></div>`;
  let lastTickSec = -1;

  // ---- mission tasks: each objective has things to do, tied to the mission ----
  type TaskState = "todo" | "done" | "skipped";
  interface Task {
    id: string;
    group: "reach" | "observe" | "return";
    label: string;
    state: TaskState;
    progress: number;
    cell?: number; // place on the ground (checkpoints and waypoints)
    kind?: "via" | "task";
    from?: number; // observe tasks: planned seconds at start and end
    to?: number;
  }
  let tasks: Task[] = [];
  const toast = document.createElement("div");
  toast.className = "task-toast";
  toast.hidden = true;
  s.app.append(toast);
  let toastTimer = 0;
  const cellDistM = (a: number, b: number) => {
    const ra = Math.floor(a / terrain.cols);
    const rb = Math.floor(b / terrain.cols);
    return Math.hypot(((a % terrain.cols) - (b % terrain.cols)) * grid.dx[ra], (ra - rb) * grid.dy);
  };
  const buildTasks = () => {
    const n = route.length;
    const list: Task[] = [];
    via.forEach((c, i) => list.push({ id: `via${i}`, group: "reach", label: `Pass your waypoint ${i + 1}`, state: "todo", progress: 0, cell: c, kind: "via" }));
    if (n > 8) {
      list.push({ id: "slope", group: "reach", label: "Slope check-in", state: "todo", progress: 0, cell: route[Math.floor(n * 0.4)], kind: "task" });
      list.push({ id: "o2out", group: "reach", label: "Oxygen check-in", state: "todo", progress: 0, cell: route[Math.floor(n * 0.75)], kind: "task" });
    }
    let cum = 0;
    if (plannedScienceS > 0) {
      for (const t of SCIENCE_TASKS) {
        list.push({ id: t.id, group: "observe", label: t.label, state: "todo", progress: 0, from: cum * plannedScienceS, to: (cum + t.w) * plannedScienceS });
        cum += t.w;
      }
    }
    if (n > 8) list.push({ id: "o2back", group: "return", label: "Oxygen check-in on the way home", state: "todo", progress: 0, cell: route[Math.floor(n * 0.5)], kind: "task" });
    list.push({ id: "dock", group: "return", label: "Seal the airlock and hand over the samples", state: "todo", progress: 0 });
    tasks = list;
  };
  const markerList = () => tasks.filter((t) => t.cell !== undefined).map((t) => ({ cell: t.cell!, label: t.label, kind: t.kind ?? "task", done: t.state !== "todo" }));
  const syncMarkers = () => stage.setMarkers(markerList());
  const o2Line = () => {
    const h = home ? home.needL : NaN;
    return Number.isFinite(h) ? `${litres(sim.o2LeftL)} left, ${litres(sim.o2LeftL - h)} spare after the walk home` : `${litres(sim.o2LeftL)} left`;
  };
  const taskDone = (t: Task) => {
    t.state = "done";
    t.progress = 1;
    let line = "";
    let note = "";
    if (t.id.startsWith("via")) line = `Waypoint ${Number(t.id.slice(3)) + 1} reached. ${o2Line()}.`;
    else if (t.id === "slope" || t.id === "o2out" || t.id === "o2back") {
      if (t.id === "slope") {
        const i = route.indexOf(t.cell!);
        let steepest = 0;
        for (let k = 0; k <= i; k++) steepest = Math.max(steepest, terrain.slopeDeg[route[k]] ?? 0);
        const gain = terrain.elevation[t.cell!] - terrain.elevation[s.base];
        line = `Slope check: ${Math.abs(Math.round(gain))} m ${gain >= 0 ? "above" : "below"} the habitat, steepest ground so far ${steepest.toFixed(0)} degrees. The limit is 25.`;
        note = "Slope matters twice: steep ground is slow (the walking model slows on grades) and a slower walk burns more oxygen per metre. The 25 degree limit is Curiosity's maximum recorded pitch, a rover figure we borrow.";
      } else line = `Oxygen check-in: ${o2Line()}.`;
    } else if (t.id === "dock") line = "Airlock sealed. Samples handed over.";
    else {
      line = `Task complete: ${t.label}.`;
      note = scienceNote(t.id, s.facts);
    }
    sim.note("info", `Task done: ${t.label}. ${line.startsWith("Task complete") ? "" : line}`.trim());
    s.audio?.taskDone();
    if (t.id !== "dock") s.audio?.radio(line, false, t.id === "report" ? "earth" : "capcom");
    toast.innerHTML = `<span class="tt-tick">&#10003;</span><div><b>${esc(t.label)}</b><small>${line.startsWith("Task complete") ? "Task complete" : esc(line)}</small></div>`;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 7000);
    if (note && !decision && !findPlan) showNote(esc(t.label), note, 20000);
    syncMarkers();
  };
  const updateTasks = () => {
    if (!began) return;
    const pos = sim.position().from;
    const walkingOut = sim.phase === "outbound" || sim.phase === "detour";
    const ended2 = sim.done;
    let changed = false;
    for (const t of tasks) {
      if (t.state !== "todo") continue;
      if (t.group === "reach") {
        if (walkingOut && t.cell !== undefined && cellDistM(pos, t.cell) < 55) taskDone(t), (changed = true);
        else if (sim.goalReached || sim.phase === "inbound" || ended2) (t.state = "skipped"), (changed = true);
      } else if (t.group === "observe") {
        const done = sim.scienceDoneS;
        t.progress = Math.max(0, Math.min(1, (done - t.from!) / Math.max(1, t.to! - t.from!)));
        if (done >= t.to! - 0.5) taskDone(t), (changed = true);
        else if (sim.phase === "inbound" || ended2) (t.state = "skipped"), (changed = true);
      } else if (t.id === "o2back") {
        if (sim.phase === "inbound" && cellDistM(pos, t.cell!) < 55) taskDone(t), (changed = true);
        else if (ended2) (t.state = "skipped"), (changed = true);
      } else if (t.id === "dock") {
        if (sim.phase === "returned") taskDone(t), (changed = true);
        else if (sim.phase === "lost") (t.state = "skipped"), (changed = true);
      }
    }
    if (changed) syncMarkers();
  };
  // What the astronaut is working on right now, for the suit display.
  const currentTask = (): { label: string; progress: number | null } => {
    const todo = (g: Task["group"]) => tasks.find((t) => t.group === g && t.state === "todo");
    if (sim.done) return { label: "EVA over", progress: null };
    if (sim.phase === "inspect") return { label: "Inspecting the find", progress: null };
    if (sim.phase === "science") {
      const t = todo("observe");
      return t ? { label: t.label, progress: t.progress } : { label: "Wrapping up at the destination", progress: null };
    }
    if (sim.phase === "inbound") {
      const t = todo("return");
      return t ? { label: t.label === "Seal the airlock and hand over the samples" ? "Walk home to the airlock" : `Heading for: ${t.label.toLowerCase()}`, progress: null } : { label: "Walk home", progress: null };
    }
    const t = todo("reach");
    return t ? { label: `Heading for: ${t.label.toLowerCase()}`, progress: null } : { label: `Walk to ${s.objective.name}`, progress: null };
  };

  // ---- route editing (before Begin) ----
  const planEl = $("#mc-plan");
  const routeMsg = $("#mc-route-msg");
  const viaBtn = $<HTMLButtonElement>("#mc-via");
  const viaClear = $<HTMLButtonElement>("#mc-via-clear");
  const showPlan = () => {
    const p = sim.options().find((o) => o.id === "continue");
    planEl.innerHTML = p
      ? `Plan: ${Math.round(p.walkS / 60)} min of walking out and back, ${Math.floor(s.scienceS / 60)} min of observation. Needs <b>${litres(p.needL)}</b> of the <b>${litres(s.reserveL)}</b> reserve, leaving <b class="${p.spareL < 0 ? "neg" : ""}">${litres(p.spareL)}</b> spare${p.spareL < 0 ? ". <b class='neg'>Not enough oxygen: shorten the route or the observation.</b>" : p.spareL < s.reserveL * (1 - CAUTION_FRACTION) ? ". Margin is thin." : "."}`
      : "";
  };
  const rebuildRoute = (): string | null => {
    const stops = [s.base, ...via, s.goal];
    const cells: number[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const r = astar(grid, STRATEGIES[strategyName], stops[i], stops[i + 1]);
      if (!r) return i + 1 < stops.length - 1 ? `No walkable route to waypoint ${i + 1}.` : "No walkable route to the destination from the last waypoint.";
      cells.push(...(i ? r.cells.slice(1) : r.cells));
    }
    route = cells;
    sim = makeSim();
    if (armedCell !== null && sim.armFind(armedCell)) armedCell = null;
    lastPoi = "";
    blockedCount = 0;
    stage.setHazard(sim.blocked);
    buildTasks();
    syncMarkers();
    showPlan();
    learn?.refresh();
    viaClear.disabled = via.length === 0;
    viaBtn.disabled = via.length >= MAX_VIA;
    return null;
  };
  const applyStrategy = (name: StrategyName) => {
    if (began) return;
    const prev = strategyName;
    strategyName = name;
    const err = rebuildRoute();
    if (err) {
      strategyName = prev;
      routeMsg.textContent = err;
      return;
    }
    s.panel.querySelectorAll<HTMLButtonElement>("#mc-strat button").forEach((x) => x.classList.toggle("active", x.dataset.v === name));
    routeMsg.textContent = `${name[0].toUpperCase()}${name.slice(1)} route: ${routeM()} m of path. The strategy changes how much the planner will detour around steep ground.`;
  };
  s.panel.querySelectorAll<HTMLButtonElement>("#mc-strat button").forEach((b) => b.addEventListener("click", () => applyStrategy(b.dataset.v as StrategyName)));
  viaBtn.addEventListener("click", () => {
    if (began || via.length >= MAX_VIA) return;
    cancelPick?.();
    viaBtn.classList.add("active");
    routeMsg.textContent = "Click the ground where the route should pass.";
    cancelPick = stage.pick((hit) => {
      cancelPick = null;
      viaBtn.classList.remove("active");
      if (!hit) {
        routeMsg.textContent = "That point is outside the map, or has no walkable ground nearby.";
        return;
      }
      if (hit.cell === s.base || hit.cell === s.goal || via.includes(hit.cell)) {
        routeMsg.textContent = "Pick a different spot: that one is the base, the destination or already a waypoint.";
        return;
      }
      via.push(hit.cell);
      const err = rebuildRoute();
      if (err) {
        via.pop();
        rebuildRoute();
        routeMsg.textContent = err;
        return;
      }
      routeMsg.textContent = `Waypoint ${via.length} added. The route is now ${routeM()} m of path.${via.length < MAX_VIA ? " Add another or press Begin." : ""}`;
    });
  });
  viaClear.addEventListener("click", () => {
    if (began) return;
    via = [];
    rebuildRoute();
    routeMsg.textContent = "Waypoints cleared.";
  });
  buildTasks();
  syncMarkers();

  // ---- the Educational view (2D map): trade-offs, route sections, findings, data ----
  let showLearnBtn: HTMLButtonElement | null = null;
  if (stage.kind === "map") {
    learn = createLearn({
      grid,
      base: s.base,
      goal: s.goal,
      reserveL: s.reserveL,
      scienceS: s.scienceS,
      getRoute: () => route,
      getStops: () => [s.base, ...via, s.goal],
      getStrategy: () => strategyName,
      canEdit: () => !began,
      useStrategy: applyStrategy,
      overlay: (l) => stage.setOverlay(l),
      live: () => {
        const p = sim.position();
        return { began, phase: sim.phase, from: p.from, to: p.to, speedFactor: sim.speedFactor, o2Factor: sim.o2Factor };
      },
    });
    s.app.append(learn.el);
    // On a phone the panel would leave a sliver of map: start it closed; "Learn" reopens it.
    const compactScreen = window.matchMedia("(max-height: 520px), (max-width: 940px)").matches;
    if (!compactScreen) s.app.classList.add("learn-open");
    showLearnBtn = document.createElement("button");
    showLearnBtn.className = "ln-show";
    showLearnBtn.innerHTML = "&#9654; Learn";
    showLearnBtn.hidden = !compactScreen;
    s.app.append(showLearnBtn);
    learn.el.querySelector<HTMLButtonElement>("#ln-hide")!.addEventListener("click", () => {
      s.app.classList.remove("learn-open");
      showLearnBtn!.hidden = false;
    });
    showLearnBtn.addEventListener("click", () => {
      s.app.classList.add("learn-open");
      showLearnBtn!.hidden = true;
    });
  }

  // ---- decisions ----
  let decision: { kind: CalamityKind; opts: OptionPlan[]; rec: OptionPlan["id"]; until: number; total: number; more: boolean } | null = null;

  const lines = (opts: OptionPlan[]): StageLine[] => opts.filter((o) => (o.fullPath ?? o.path).length > 1).map((o) => ({ id: o.id, cells: o.fullPath ?? o.path }));

  const verdictOf = (o: OptionPlan) => (o.feasible ? (o.spareL < s.reserveL * (1 - CAUTION_FRACTION) - 1e-6 ? "Survivable, margin thin" : "Survivable") : "NOT survivable");
  const stat = (label: string, value: string, cls = "") => `<div class="stat"><small>${label}</small><b class="${cls}">${value}</b></div>`;
  const bindMore = () => {
    const btn = decisionEl.querySelector<HTMLButtonElement>("#dec-more");
    btn?.addEventListener("click", () => {
      const d = decision ?? findPlan;
      if (!d || d.more) return;
      d.more = true;
      d.until += MORE_SECONDS * 1000;
      d.total += MORE_SECONDS * 1000;
      btn.disabled = true;
      btn.textContent = `+${MORE_SECONDS} s added`;
    });
  };

  const onCalamity = (kind: CalamityKind) => {
    s.audio?.alert();
    s.audio?.radio(RADIO[kind], true);
    const opts = sim.options();
    const rec = sim.recommend(opts);
    // Already heading home with one way to go: the suit replans without a pause.
    if (opts.length === 1) {
      sim.choose("return", "Suit computer (only option)");
      showNote(CALAMITIES[kind].label, fieldNote(kind, s.facts));
      return;
    }
    decision = { kind, opts, rec, until: performance.now() + DECISION_SECONDS * 1000, total: DECISION_SECONDS * 1000, more: false };
    lastTickSec = -1;
    overlayDismissed = false;
    stage.setOptions(lines(opts));
    const info = CALAMITIES[kind];
    decisionEl.className = "dec-card";
    decisionEl.innerHTML = `<div class="decision dec-calamity">
        <div class="dec-banner">
          <span class="dec-icon">${info.icon}</span>
          <div class="dec-head"><small>${astronaut ? "INCOMING ON YOUR EVA" : "THE CREW NEEDS YOUR CALL"} &middot; T+${clock(sim.t)}</small><h2>${info.label.toUpperCase()}</h2></div>
          ${timerHtml(DECISION_SECONDS)}
        </div>
        <p class="dec-what">${sim.log[sim.log.length - 1].text}</p>
        <p class="dec-why"><b>Why it matters:</b> ${fieldNote(kind, s.facts)}</p>
        <p class="who">${astronaut ? "CAPCOM has run the numbers. <b>Choose how to respond, EVA.</b>" : "The astronaut is waiting. <b>Choose what to advise.</b>"} You have <b>${litres(sim.o2LeftL)}</b> of oxygen now.</p>
        <div class="dec-opts">
        ${opts.map((o) => `<div class="opt ${o.feasible ? "ok" : "bad"} ${o.id === rec ? "rec" : ""}">
            <div class="opt-head"><b>${o.label}</b>${o.id === rec ? `<span class="badge">RECOMMENDED</span>` : ""}</div>
            <p class="opt-note">${o.note}</p>
            <div class="opt-stats">
              ${stat("Oxygen needed", litres(o.needL))}${stat("Left at base", litres(o.spareL), o.spareL < 0 ? "neg" : "")}${stat("Home at", `T+${clock(o.arriveS)}`)}
            </div>
            ${sim.deadlineS !== null ? `<p class="opt-dl">Radiation deadline: T+${clock(sim.deadlineS)}</p>` : ""}
            <div class="opt-foot"><em>${verdictOf(o)}</em><button class="${o.id === rec ? "primary" : "ghost"}" data-id="${o.id}">Choose this</button></div>
          </div>`).join("")}
        </div>
        ${footHtml}
      </div>`;
    decisionEl.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) =>
      b.addEventListener("click", () => decide(b.dataset.id as OptionPlan["id"], caller)),
    );
    bindMore();
  };

  const decide = (id: OptionPlan["id"], by: string) => {
    const chosen = decision?.opts.find((o) => o.id === id);
    if (decision) calls.push({ t: sim.t, what: CALAMITIES[decision.kind].label, chosen: chosen?.label ?? id, rec: decision.opts.find((o) => o.id === decision!.rec)?.label ?? decision.rec, by });
    s.audio?.radio(chosen ? `Copy. ${chosen.label}.` : "Copy.");
    sim.choose(id, by);
    decision = null;
    decisionEl.innerHTML = "";
    stage.setOptions([]);
  };

  // ---- unplanned find: plan an inspection against the oxygen budget ----
  let findPlan: { minutes: number; until: number; total: number; more: boolean } | null = null;
  const findEl = decisionEl;

  // The oxygen on hand, split into what the plan spends and what is left over.
  const budgetBar = (o: OptionPlan) => {
    const left = Math.max(1e-9, sim.o2LeftL);
    const total = Math.max(1e-9, o.walkS + (o.inspectS ?? 0) + o.scienceS);
    const part = (sec: number) => (o.needL * sec) / total;
    const walkL = part(o.walkS);
    const inspL = part(o.inspectS ?? 0);
    const sciL = part(o.scienceS);
    const spare = Math.max(0, left - o.needL);
    const margin = s.reserveL * (1 - CAUTION_FRACTION);
    const marginL = Math.min(spare, margin);
    const w = (l: number) => `${Math.max(0, (100 * l) / left).toFixed(2)}%`;
    return `<div class="budget ${o.needL > left ? "over" : ""}" title="Oxygen on hand, split by use">
        <i class="b-walk" style="width:${w(walkL)}"></i><i class="b-insp" style="width:${w(inspL)}"></i><i class="b-sci" style="width:${w(sciL)}"></i><i class="b-spare" style="width:${w(spare - marginL)}"></i><i class="b-margin" style="width:${w(marginL)}"></i>
      </div>
      <div class="budget-key"><span class="k-walk">walk ${litres(walkL)}</span><span class="k-insp">inspect ${litres(inspL)}</span><span class="k-sci">science ${litres(sciL)}</span><span class="k-spare">spare ${litres(spare)}</span></div>`;
  };

  // Every leg priced on the real terrain, plus the check at the find itself:
  // after inspecting, is the way straight home still affordable?
  const legTable = (o: OptionPlan) => {
    if (!o.legs || !Number.isFinite(o.needL)) return "";
    const total = Math.max(1e-9, o.walkS + (o.inspectS ?? 0) + o.scienceS);
    const perS = o.needL / total;
    const rows = o.legs.map((l) => `<tr><td>${l.label}</td><td>${Math.round(l.m)} m</td><td>${clock(l.s)}</td><td>${litres(l.s * perS)}</td></tr>`).join("");
    const f = o.atFind;
    const esc2 = f
      ? `<div class="escape ${f.o2AfterL >= f.homeL ? "ok" : "bad"}">At the find, after inspecting: <b>${litres(f.o2AfterL)}</b> left; straight home from there needs <b>${litres(f.homeL)}</b> (${Math.round(f.homeM)} m) &rarr; ${f.o2AfterL >= f.homeL ? `<b>can still get home</b>, ${litres(f.o2AfterL - f.homeL)} to spare` : "<b>cannot get home from there</b>"}</div>`
      : "";
    return `<div class="legs"><table>${rows}</table>${esc2}</div>`;
  };

  const renderFindOpts = () => {
    if (!findPlan) return;
    const opts = sim.findOptions(findPlan.minutes * 60);
    const rec = sim.recommendFind(opts);
    stage.setOptions(lines(opts));
    const box = findEl.querySelector<HTMLElement>("#find-opts");
    if (!box) return;
    box.innerHTML = opts
      .map(
        (o) => `<div class="opt ${o.feasible ? "ok" : "bad"} ${o.id === rec ? "rec" : ""}">
          <div class="opt-head"><b>${o.label}</b>${o.id === rec ? `<span class="badge">RECOMMENDED</span>` : ""}</div>
          ${o.id === "return" || !Number.isFinite(o.needL) ? "" : budgetBar(o)}
          ${legTable(o)}
          <div class="opt-grid">
            <span>needs <b>${litres(o.needL)}</b> of ${litres(sim.o2LeftL)}</span>
            <span>spare at base <b class="${o.spareL < 0 ? "neg" : ""}">${litres(o.spareL)}</b></span>
            <span>home at <b>T+${clock(o.arriveS)}</b>${sim.deadlineS !== null ? ` (deadline T+${clock(sim.deadlineS)})` : ""}</span>
            <span>${o.note}</span>
          </div>
          <div class="opt-foot"><em>${verdictOf(o)}</em><button class="${o.id === rec ? "primary" : "ghost"}" data-id="${o.id}">Choose this</button></div>
        </div>`,
      )
      .join("");
    box.querySelectorAll<HTMLButtonElement>("button[data-id]").forEach((b) => b.addEventListener("click", () => decideFind(b.dataset.id as OptionPlan["id"], caller)));
  };

  const onDiscovery = () => {
    s.audio?.alert();
    s.audio?.radio("EVA, Science here. There is something off your route worth a look. Plan the stop against your oxygen.", true, "science");
    lastTickSec = -1;
    overlayDismissed = false;
    const f = sim.find!;
    const bGoal = Math.floor(sim.inspectBudgetS("goal") / 60);
    const bBase = Math.floor(sim.inspectBudgetS("base") / 60);
    findPlan = { minutes: Math.max(5, Math.min(10, bGoal)), until: performance.now() + FIND_SECONDS * 1000, total: FIND_SECONDS * 1000, more: false };
    decisionEl.className = "dec-card wide";
    findEl.innerHTML = `<div class="decision find">
        <div class="dec-banner">
          <span class="dec-icon">&#9678;</span>
          <div class="dec-head"><small>SCIENCE VERSUS SAFETY &middot; T+${clock(sim.t)}</small><h2>UNPLANNED FIND</h2></div>
          ${timerHtml(FIND_SECONDS)}
        </div>
        <p class="dec-what">The astronaut notices ${f.label}, about <b>${Math.round(f.offsetM)} m</b> off the route (gold marker). Worth a look? Every minute there is paid for in oxygen, and the walk home still has to fit.
          <em>Scenario target, not a real Mars observation.</em></p>
        <div class="budget-note">Spare time at the find, keeping the 20% oxygen margin:
          <b>${bGoal > 0 ? `up to ${bGoal} min` : "none"}</b> and still finishing the destination;
          <b>${bBase > 0 ? `up to ${bBase} min` : "none"}</b> if the destination is skipped.</div>
        <label class="check"><input type="checkbox" id="find-legs" checked> Show path costs per leg</label>
        <label class="slider">Inspection time <output id="find-min">${findPlan.minutes} min</output>
          <input type="range" id="find-slider" min="0" max="${SCENARIO.findMaxInspectMin}" step="1" value="${findPlan.minutes}"></label>
        <div id="find-opts" class="dec-opts"></div>
        ${footHtml}
      </div>`;
    bindMore();
    findEl.querySelector<HTMLInputElement>("#find-slider")!.addEventListener("input", (e) => {
      if (!findPlan) return;
      findPlan.minutes = Number((e.target as HTMLInputElement).value);
      if (findPlan.until < performance.now() + 20_000) {
        findPlan.total += performance.now() + 20_000 - findPlan.until;
        findPlan.until = performance.now() + 20_000; // do not cut off a planner mid-drag
      }
      findEl.querySelector("#find-min")!.textContent = `${findPlan.minutes} min`;
      renderFindOpts();
    });
    findEl.querySelector<HTMLInputElement>("#find-legs")!.addEventListener("change", (e) => findEl.querySelector(".decision")!.classList.toggle("hide-legs", !(e.target as HTMLInputElement).checked));
    renderFindOpts();
  };

  const findOptionsLabel = (id: OptionPlan["id"]) => ({ inspect: "Inspecting, then the destination", "inspect-return": "Inspecting, then returning", continue: "Skipping the find", return: "Aborting, returning to base" })[id];
  const decideFind = (id: OptionPlan["id"], by: string) => {
    if (!findPlan) return;
    s.audio?.radio(`Copy. ${findOptionsLabel(id)}.`);
    calls.push({ t: sim.t, what: "Unplanned find", chosen: `${findOptionsLabel(id)}${id.startsWith("inspect") ? ` (${findPlan.minutes} min)` : ""}`, rec: findOptionsLabel(sim.recommendFind(sim.findOptions(findPlan.minutes * 60))), by });
    sim.answerFind(id, findPlan.minutes * 60, by);
    if (sim.find?.state === "found") sim.answerFind("continue", 0, by); // the chosen plan was not possible: skip it
    findPlan = null;
    findEl.innerHTML = "";
    stage.setOptions([]);
  };

  // ---- rendering ----
  let logLen = -1;
  let lastHud = 0;
  let lastLine = 0;
  let lastHome = 0;
  let lastPoi = "";
  let lastTaskCheck = 0;
  let lastLearn = 0;
  let lastLevel: "ok" | "caution" | "turn-back" = "ok";
  let home: OptionPlan | undefined;
  let ended = false;
  const logEl = $("#mc-log");
  const metEl = $("#mc-met");

  const renderLog = () => {
    if (sim.log.length === logLen) return;
    logLen = sim.log.length;
    logEl.innerHTML = sim.log.slice().reverse().map((e) => `<li class="${e.kind}"><time>T+${clock(e.t)}</time>${e.text}</li>`).join("");
  };

  const renderHud = () => {
    const left = sim.o2LeftL;
    const needHome = home ? home.needL : NaN;
    const margin = left - needHome;
    const caution = s.reserveL * (1 - CAUTION_FRACTION);
    const level: "ok" | "caution" | "turn-back" = sim.phase === "lost" || margin < 0 ? "turn-back" : margin < caution ? "caution" : "ok";
    lastLevel = level;
    const chips = [...sim.active].map((k) => `<span class="chip">${CALAMITIES[k].icon} ${CALAMITIES[k].label}</span>`).join("");
    const extra =
      sim.deadlineS !== null && !sim.done
        ? `<div><b>${clock(sim.deadlineS - sim.t)}</b><small>to radiation deadline</small></div>`
        : sim.phase === "inspect"
          ? `<div><b>${clock(sim.inspectLeftS)}</b><small>inspection left</small></div>`
          : sim.phase === "science"
            ? `<div><b>${clock(sim.scienceLeftS)}</b><small>science left</small></div>`
            : `<div><b>x${sim.speedFactor.toFixed(1)}</b><small>walking speed</small></div>`;
    s.hud.className = `hud suit ${level}${sim.active.has("leak") ? " leak" : ""}`;
    s.hud.innerHTML = `
      <div class="hud-row"><span>ASTRONAUT &middot; SUIT DISPLAY</span><span>MET ${clock(sim.t)} &middot; ${PHASE[sim.phase]}</span></div>
      <div class="hud-grid">
        <div><b class="o2">${litres(left)}</b><small>O<sub>2</sub> left</small></div>
        <div><b>${litres(needHome)}</b><small>O<sub>2</sub> to get home</small></div>
        <div><b class="${margin < 0 ? "neg" : ""}">${litres(margin)}</b><small>margin</small></div>
        <div><b>${home && Number.isFinite(home.walkS) ? clock(home.walkS) : "--"}</b><small>walk home</small></div>
        ${extra}
      </div>
      <div class="o2bar"><i style="width:${((100 * left) / s.reserveL).toFixed(1)}%"></i><em style="left:${Math.min(100, (100 * (Number.isFinite(needHome) ? needHome : 0)) / s.reserveL).toFixed(1)}%"></em></div>
      ${began ? (() => {
        const ct = currentTask();
        return `<div class="hud-task"><span>TASK</span><b>${esc(ct.label)}</b>${ct.progress !== null ? `<i class="tp"><u style="width:${(ct.progress * 100).toFixed(0)}%"></u></i>` : ""}</div>`;
      })() : ""}
      <div class="hud-alerts">${chips}${
        level === "turn-back" && !sim.done ? `<div class="turn-back">CANNOT REACH BASE ON REMAINING OXYGEN</div>` : level === "caution" && !sim.done ? `<div class="caution">Oxygen margin low</div>` : ""
      }</div>`;
  };

  const debriefBtn = $<HTMLButtonElement>("#mc-debrief");
  debriefBtn.addEventListener("click", () => {
    overlayDismissed = false;
    debriefBtn.hidden = true;
  });
  const objEl = $("#mc-obj");
  const renderObjectives = () => {
    const taskList = (g: Task["group"]) => {
      const ts = tasks.filter((t) => t.group === g);
      if (!ts.length) return "";
      const next = ts.find((t) => t.state === "todo");
      const icon = (t: Task) => (t.state === "done" ? "&#10003;" : t.state === "skipped" ? "&ndash;" : t === next && began ? "&#9654;" : "&#9675;");
      return `<ul class="tasks">${ts
        .map((t) => `<li class="t ${t.state}${t === next && began ? " next" : ""}"><span class="tk">${icon(t)}</span>${t.label}${t.state === "todo" && t.progress > 0 ? `<i class="tp"><u style="width:${(t.progress * 100).toFixed(0)}%"></u></i>` : ""}${t.state === "skipped" ? "<em>not done</em>" : ""}</li>`)
        .join("")}</ul>`;
    };
    const row = (ok: boolean | null, text: string, extra = "") => `<li class="${ok === true ? "done" : ok === false ? "fail" : ""}">${text}${extra}</li>`;
    const full = sim.goalReached && sim.scienceDoneS >= plannedScienceS - 1;
    const fs = sim.find?.state;
    const findRow = s.findMode === "off"
      ? ""
      : !sim.find
        ? row(null, sim.armed ? "A find is placed: not noticed yet" : s.findMode === "place" ? "Optional: place a find on the map" : "Optional: report anything notable on the way")
        : fs === "done"
          ? row(true, `Find inspected (${Math.round(sim.inspectDoneS / 60)} min)`)
          : fs === "skipped"
            ? row(false, "Find skipped")
            : row(null, fs === "inspecting" ? "Inspecting the find&hellip;" : fs === "detour" ? "Detour to the find&hellip;" : "Find: decision pending");
    objEl.innerHTML = [
      row(sim.goalReached ? true : sim.done ? false : null, `Reach ${esc(s.objective.name)}`, taskList("reach")),
      row(full ? true : sim.done ? false : null, `Observe ${Math.floor(sim.scienceDoneS / 60)} / ${Math.floor(plannedScienceS / 60)} min`, taskList("observe")),
      row(sim.phase === "returned" ? true : sim.phase === "lost" ? false : null, "Return to base", taskList("return")),
      findRow,
    ].join("");
  };

  // After-action black box: oxygen over time, every call, and what it teaches.
  const blackBox = () => {
    samples.push({ t: sim.t, o2: sim.o2LeftL, home: sim.phase === "returned" ? 0 : NaN });
    const W = 300;
    const H = 120;
    const T = Math.max(1, sim.t);
    const Y = (l: number) => H - 14 - (Math.max(0, l) / s.reserveL) * (H - 24);
    const X = (t: number) => 26 + (t / T) * (W - 32);
    const path = (key: "o2" | "home") => samples.filter((p) => Number.isFinite(p[key])).map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p[key]).toFixed(1)}`).join("");
    const caution = s.reserveL * (1 - CAUTION_FRACTION);
    const events = sim.log.filter((e) => e.kind === "event");
    const marks = events.map((e) => `<line x1="${X(e.t).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y1="6" y2="${H - 14}" class="bb-ev"><title>T+${clock(e.t)} ${esc(e.text)}</title></line>`).join("");
    const chart = `<svg viewBox="0 0 ${W} ${H}" class="bb-chart" role="img" aria-label="Oxygen left and oxygen needed to get home, over the EVA">
        <line x1="26" x2="${W - 6}" y1="${Y(0)}" y2="${Y(0)}" class="bb-axis"/>
        <text x="2" y="${Y(s.reserveL) + 4}" class="bb-t">${s.reserveL}L</text><text x="8" y="${Y(0) + 3}" class="bb-t">0</text>
        <text x="${W - 6}" y="${H - 2}" class="bb-t" text-anchor="end">T+${clock(sim.t)}</text>
        ${marks}
        <path d="${path("home")}" class="bb-home"/><path d="${path("o2")}" class="bb-o2"/>
      </svg>
      <div class="bb-key"><span class="k-o2">O&#8322; left</span><span class="k-home">O&#8322; needed to get home</span><span class="k-ev">calamity</span></div>`;
    const followed = calls.filter((c) => c.chosen === c.rec).length;
    const rows = calls.length
      ? `<table class="bb-calls"><tr><th>T+</th><th>Event</th><th>Call</th><th></th></tr>${calls
          .map((c) => `<tr><td>${clock(c.t)}</td><td>${esc(c.what)}</td><td>${esc(c.chosen)}<small>${esc(c.by)}</small></td><td>${c.chosen === c.rec ? `<span class="bb-ok" title="Matched the suit computer's recommendation">&#10003;</span>` : `<span class="bb-over" title="Recommended: ${esc(c.rec)}">override</span>`}</td></tr>`)
          .join("")}</table>`
      : `<p class="note">No decisions were needed on this walk.</p>`;
    const lessons: string[] = [];
    if (Number.isFinite(minMargin.l))
      lessons.push(minMargin.l < 0 ? `At T+${clock(minMargin.t)} the oxygen left was <b>less than the walk home needed</b>. Past that point only luck or a shorter route helps.` : minMargin.l < caution ? `The tightest moment was T+${clock(minMargin.t)}: only <b>${litres(minMargin.l)}</b> spare, inside the 20% safety margin.` : `The margin never dropped below <b>${litres(minMargin.l)}</b>: the 20% safety reserve was never touched.`);
    if (calls.length) lessons.push(`${followed} of ${calls.length} calls matched the suit computer's recommendation${followed < calls.length ? "; check whether the overrides bought science or just risk" : ""}.`);
    if (events.length) lessons.push("Each grey line is a calamity: watch how the gap between the two lines (your margin) changes after it.");
    return `<div class="blackbox"><h3>Black box &middot; after-action review</h3>${chart}${rows}<ul class="bb-lessons">${lessons.map((l) => `<li>${l}</li>`).join("")}</ul></div>`;
  };

  const renderEnd = () => {
    const outcome =
      sim.phase === "lost"
        ? { cls: "no-go", title: "EVA FAILED" }
        : sim.goalReached && sim.scienceDoneS >= plannedScienceS - 1
          ? { cls: "go", title: sim.find?.state === "done" ? "MISSION SUCCESS, FIND INSPECTED" : "MISSION SUCCESS" }
          : !sim.goalReached && sim.inspectDoneS > 0
            ? { cls: "caution", title: "RETURNED SAFELY, FIND INSPECTED, DESTINATION SKIPPED" }
            : { cls: "caution", title: sim.scienceDoneS > 0 ? "RETURNED SAFELY, SCIENCE CUT SHORT" : "ABORTED, RETURNED SAFELY" };
    const events = sim.log.filter((e) => e.kind === "event").length;
    const decisions = sim.log.filter((e) => e.kind === "decision").length;
    decisionEl.className = "dec-card wide end";
    decisionEl.innerHTML = `<button class="dec-close" id="dec-close" aria-label="View the scene">&times; View the scene</button><div class="verdict ${outcome.cls}"><span>${outcome.title}</span></div>
      <div class="kpis">
        <div><b>${clock(sim.t)}</b><small>EVA duration</small></div>
        <div><b>${litres(sim.o2LeftL)}</b><small>O<sub>2</sub> left</small></div>
        <div><b>${Math.floor(sim.scienceDoneS / 60)} / ${Math.floor(plannedScienceS / 60)} min</b><small>science done</small></div>
        <div><b>${sim.find ? (sim.inspectDoneS > 0 ? `${Math.round(sim.inspectDoneS / 60)} min` : sim.find.state === "skipped" ? "skipped" : "none") : "no find"}</b><small>find inspection</small></div>
        <div><b>${tasks.filter((t) => t.state === "done").length} / ${tasks.length}</b><small>tasks done</small></div>
        <div><b>${events}</b><small>calamities</small></div>
        <div><b>${decisions}</b><small>decisions</small></div>
        <div><b>${s.seed}</b><small>seed</small></div>
      </div>
      ${blackBox()}
      <div class="mc-controls"><button class="primary sm" id="mc-again">Run again (same seed)</button><button class="ghost sm" id="mc-new">New random seed</button></div>`;
    decisionEl.querySelector<HTMLButtonElement>("#mc-again")!.addEventListener("click", () => s.onRestart(s.seed));
    decisionEl.querySelector<HTMLButtonElement>("#mc-new")!.addEventListener("click", () => s.onRestart(Math.floor(Math.random() * 1e6)));
    decisionEl.querySelector<HTMLButtonElement>("#dec-close")!.addEventListener("click", () => {
      overlayDismissed = true;
      overlay.hidden = true;
      debriefBtn.hidden = false;
    });
    overlayDismissed = false;
  };

  let raf = 0;
  let last = performance.now();
  s.hud.hidden = false;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (!paused && !decision && !findPlan && !sim.done) {
      const kind = sim.advance(dt * speed);
      if (kind === "discovery") onDiscovery();
      else if (kind) onCalamity(kind);
    }
    const pending = decision ?? findPlan;
    overlay.hidden = overlayDismissed || !decisionEl.firstElementChild;
    if (pending) {
      const leftMs = pending.until - now;
      const secs = Math.max(0, Math.ceil(leftMs / 1000));
      const bar = decisionEl.querySelector<HTMLElement>("#mc-count");
      const txt = decisionEl.querySelector<HTMLElement>("#mc-count-text");
      const num = decisionEl.querySelector<HTMLElement>("#dec-secs");
      if (bar) bar.style.width = `${Math.min(100, Math.max(0, (100 * leftMs) / pending.total))}%`;
      if (num) num.textContent = String(secs);
      decisionEl.classList.toggle("urgent", secs <= 5);
      if (secs !== lastTickSec && !paused) {
        lastTickSec = secs;
        if (secs > 0) s.audio?.tick(secs);
      }
      if (txt) txt.textContent = astronaut ? `No call? The suit computer takes CAPCOM's recommendation when the timer ends.` : `No call? The astronaut follows the recommendation when the timer ends.`;
      if (leftMs <= 0 && !paused) {
        const by = astronaut ? "No call from the astronaut; the suit computer took CAPCOM's recommendation" : "No call from mission control; astronaut followed the suit computer";
        if (decision) decide(decision.rec, by);
        else if (findPlan) decideFind(sim.recommendFind(sim.findOptions(findPlan.minutes * 60)), by);
      }
    }

    const p = sim.position();
    stage.setPosition(p, { follow: follow && !sim.done, done: sim.done, phase: sim.phase });

    if (now - lastLine > 120) {
      lastLine = now;
      stage.setTrail(sim.trail, p);
      stage.setAhead(sim.phase === "outbound" || sim.phase === "inbound" || sim.phase === "detour" ? sim.path.slice(sim.idx + 1) : [], p);
      const n = sim.blocked.reduce((a, b) => a + b, 0);
      if (n !== blockedCount) {
        blockedCount = n;
        stage.setHazard(sim.blocked);
      }
      const poi = sim.find ?? sim.armed;
      const poiKey = poi ? `${poi.cell}:${poi.state}` : "";
      if (poiKey !== lastPoi) {
        lastPoi = poiKey;
        stage.setFind(poi ? { cell: poi.cell, state: poi.state } : null);
      }
    }
    if (now - lastHome > 1000 && !sim.done) {
      lastHome = now;
      home = sim.options().find((o) => o.id === "return");
    }
    if (learn && now - lastLearn > 400) {
      lastLearn = now;
      learn.tick();
    }
    if (now - lastTaskCheck > 250) {
      lastTaskCheck = now;
      updateTasks();
    }
    if (!sim.done && sim.t - lastSampleT >= 10) {
      lastSampleT = sim.t;
      const h = home ? home.needL : NaN;
      samples.push({ t: sim.t, o2: sim.o2LeftL, home: h });
      if (Number.isFinite(h) && sim.o2LeftL - h < minMargin.l) minMargin = { l: sim.o2LeftL - h, t: sim.t };
    }
    if (sim.goalReached && !wasGoal) {
      wasGoal = true;
      showNote("Why this place", s.objective.quote ? `&ldquo;${esc(s.objective.quote)}&rdquo; (NASA Curiosity team blog)` : "Destination reached. Science time starts now; it is cut short automatically if the oxygen or a deadline requires it.");
    }
    if (now - lastHud > 150) {
      lastHud = now;
      metEl.textContent = `T+${clock(sim.t)}`;
      renderHud();
      renderObjectives();
      if (placeBtn) placeBtn.disabled = !!sim.find || sim.phase !== "outbound" || sim.done;
      renderLog();
      const dustOn = sim.active.has("dust") && !sim.done;
      s.fx.classList.toggle("on", dustOn && stage.kind === "map");
      stage.setDust(dustOn);
      if (s.audio) {
        const walking = sim.phase === "outbound" || sim.phase === "inbound" || sim.phase === "detour";
        const slope = terrain.slopeDeg[sim.position().from] ?? 0;
        s.audio.setState({
          exertion: walking ? Math.min(1, 0.5 + slope / 40 + (sim.active.has("injury") ? 0.2 : 0)) : sim.phase === "science" || sim.phase === "inspect" ? 0.2 : 0,
          dust: dustOn ? 1 : 0,
          leak: sim.active.has("leak") && !sim.done,
          level: lastLevel,
          active: began && !paused && !sim.done,
        });
      }
      s.app.classList.toggle("fx-spe", sim.deadlineS !== null && !sim.done);
    }
    if (sim.done && !ended) {
      ended = true;
      s.audio?.radio(sim.phase === "lost" ? "Mission Control. We have lost your oxygen margin. EVA failed." : sim.phase === "returned" ? "Welcome back. EVA complete." : "EVA ended.", sim.phase === "lost");
      home = undefined;
      renderHud();
      renderObjectives();
      renderLog();
      renderEnd();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    cancelPick?.();
    // Clear what this view drew BEFORE the stage goes away: after dispose its layers no longer exist.
    learn?.dispose();
    stage.setMarkers([]);
    stage.dispose();
    s.audio?.dispose();
    s.hud.hidden = true;
    window.clearTimeout(noteTimer);
    window.clearTimeout(toastTimer);
    note.remove();
    toast.remove();
    overlay.remove();
    showLearnBtn?.remove();
    stopUserMove?.();
    tools.remove();
    s.app.classList.remove("learn-open");
    s.fx.classList.remove("on");
    s.app.classList.remove("fx-spe");
  };
}

export { SCENARIO };
