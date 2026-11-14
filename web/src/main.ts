import { loadTerrain } from "./data";
import { createMap, showLayer, type Layer } from "./map";
import { RouteClient } from "./route/client";
import { drawProfile, renderStats } from "./stats";
import { summarize } from "./route/steps";
import { setupRouting, strategyNames } from "./ui";
import "./style.css";

async function start() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  const terrain = await loadTerrain();
  app.textContent = "";
  const mapEl = document.createElement("div");
  mapEl.id = "map";
  app.append(mapEl);
  const map = createMap(mapEl, terrain.meta);

  const options = strategyNames.map((n) => `<option value="${n}">${n[0].toUpperCase()}${n.slice(1)}</option>`).join("");
  const panel = document.createElement("div");
  panel.id = "panel";
  panel.innerHTML = `<strong>MarsWalk</strong><br>Gale Crater region<br>
    <label>Layer <select id="layer"><option value="hillshade">Hillshade</option><option value="slope">Slope</option></select></label><br>
    <label>Strategy <select id="strategy">${options}</select></label>
    <button id="reset">Reset</button>
    <p id="status"></p>
    <div id="stats"></div>
    <canvas id="profile" width="236" height="90" hidden></canvas>
    <p class="note">Data: 1.85 km per pixel. Hillshade uses 3x vertical exaggeration for contrast (visualization only).</p>`;
  app.append(panel);
  panel.querySelector<HTMLSelectElement>("#layer")!.addEventListener("change", (e) => {
    showLayer(map, (e.target as HTMLSelectElement).value as Layer);
  });

  setupRouting(map, terrain, new RouteClient(terrain), {
    status: panel.querySelector<HTMLElement>("#status")!,
    strategy: panel.querySelector<HTMLSelectElement>("#strategy")!,
    reset: panel.querySelector<HTMLButtonElement>("#reset")!,
  }, (steps) => {
    const statsEl = panel.querySelector<HTMLElement>("#stats")!;
    const profile = panel.querySelector<HTMLCanvasElement>("#profile")!;
    profile.hidden = !steps;
    drawProfile(profile, steps);
    if (steps) renderStats(statsEl, summarize(steps));
    else statsEl.innerHTML = "";
  });
}

start().catch((err) => {
  document.querySelector("#app")!.textContent = `Failed to load: ${err}`;
});
