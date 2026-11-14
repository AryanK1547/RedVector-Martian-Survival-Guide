# MarsWalk: Interplanetary Survival Guide, Martian Map

**Live demo:** https://aryank1547.github.io/RedVector-Martian-Survival-Guide/

NASA Space Apps Challenge 2026, Nagpur, team RedVector. Challenge: "Interplanetary Survival Guide: Martian Map".

## 1. Problem

The first astronauts on Mars will need a map built for one walk, not for the whole planet. It has to show:
- where they can safely go, and how long the walk takes;
- what the walk costs in oxygen, and when they must turn back;
- what conditions to expect, and what science waits at the destination.

Tools like JPL Mars Trek show regional and global views. MarsWalk targets a single Marswalk: the boxwork region on Mount Sharp, Gale Crater. Curiosity explored it in 2025, so we can check our map against real rover data.

## 2. Team

TODO (team): names, roles and GitHub accounts of every member.

## 3. Solution and architecture

**What the astronaut gets**
- **Three map scales:**
  - Mars overview (whole planet, about 15 km per pixel).
  - Gale Crater overview (1.85 km per cell).
  - Boxwork local map (10 m per cell, 4 km square). This is the hyperlocal view the brief asks for.
- **Map:** a base map (CTX optical photo, about 10 m per pixel on the boxwork map, or shaded relief) plus one data lens at a time with an opacity slider and a legend: return range, slope, or THEMIS thermal inertia (qualitative; generally low over dust and sand, high over rock).
- **Route planning:** click a base, then a destination. A* plans the route in a Web Worker on an 8-neighbour grid.
  - Cost is ground distance plus slope and elevation-change penalties. Cells steeper than 25 degrees are impassable.
  - There are three strategies: Shortest, Balanced and Safest.
- **EVA verdict:** GO, CAUTION or NO-GO for the planned walk, with the reasons; the minutes of science time left at the destination before the walk back must start; gauges for oxygen (out + back) and steepest ground.
- **Route stats:** distance, ascent and descent, walk times out and back, energy, oxygen and radiation dose, plus a full-width elevation profile marking where to turn back.
- **Science stops:** one click on **Walk here** plans the route to a verified Curiosity waypoint; **Try an example walk** starts from an illustrative base (not a real landing site).
- **Point-of-no-return map:** every cell is shaded by the oxygen needed to walk back to base, against an editable reserve. Along a route, a purple marker shows where to turn back.
- **Mission start screen (first tab), in 3D:** you stand inside an airlock (a procedural Three.js room: scenery) behind a helmet visor. **Power up suit** starts the sound and the Earth uplink. The mission package that "uploads" is the real set of data files (local 10 m terrain, regional MOLA terrain, 2 rover waypoints, Curiosity conditions, imagery), fetched for real with sizes shown; the timing is paced for effect. The brief shows the objective, the NASA blog quote for the destination, and a round-trip preview computed on the real terrain (393 m out, 32.7 L of a 45 L reserve for the standard scenario); the uplink ends with the measured outside conditions (Curiosity REMS and RAD, sol 4598: 743 Pa, -82.9 to -17.3 C, 167.9 microGy/day). Pick a **scenario** (Training walk, Standard EVA, Crisis drill; demo values) and a **role** (EVA astronaut or Mission Control). **Commence EVA mission** first asks how you want to fly: the **simulated view** (3D, below) or the **educational view** (the 2D map with the same decisions, tasks and notes, no airlock show). The simulated view depressurises the airlock on screen from 101.3 kPa (assumed habitat pressure, Earth sea level) down to the measured 743 Pa, with a note on what that means (under 1% of Earth's pressure, below the 6.3 kPa Armstrong limit), opens the door and walks you out into the 3D walk. Through the door you see the real terrain (local DEM, CTX photo), turned to the most open view from the base, computed from the DEM skyline; the platform, ramp and dust tint on the greyscale CTX photo are illustrative. Suit battery is shown as "not modelled".
- **Live EVA simulation, in 3D (with a 2D map version):** the astronaut walks the route in compressed real time with a suit display: mission clock, oxygen left, oxygen needed to get home, margin, walk-home time, active conditions. The 3D walk (Three.js) uses one mesh vertex per 10 m DEM cell at true vertical scale, draped with the CTX photo; first-person (helmet visor), chase and overview cameras; route, trail and option lines drawn on the ground; the find can be placed by clicking the 3D ground. Rocks, surface grain, sun and sky are visual detail, labelled as such. The 2D map version runs the same engine.
  - **Two roles, one engine:** as the **EVA astronaut** you start in first person, calamities come without warning and CAPCOM (the habitat) advises while you make the call; as **Mission Control** you start in the overview, can inject calamities and advise every decision. Earth is minutes of light-time away, so live calls come from the habitat; Earth sends the brief and the Science Officer calls in the find (radio voices, scripted).
  - **Sound design (synthesised, no recordings):** layered wind with random gusts and drifting stereo position, muffled through a low-pass filter because Mars's thin air carries sound weakly; breathing with varied rhythm that follows exertion and stress; a heartbeat when the margin gets tight; footsteps with left/right variation, scrapes and pebbles; suit fans, valves and servos at random intervals; visor grit and stronger wind in a dust storm; a fluttering leak hiss; caution and turn-back tones; radio with Quindar-style beeps, static and speech for CAPCOM, Science and Earth; an evolving music pad that darkens with the margin. In the airlock the room sounds fade out as the air is pumped away. Sound, Voice and Music toggles; all of it is simulation audio.
  - **Decision screen:** a calamity or a find opens a full-width card over the scene (not the sidebar): what happened, why it matters, big option cards (oxygen needed, left at base, arrival time, a plain verdict), a countdown dial that turns red in the last 5 seconds, an alert chime and a tick each second, and one +15 s extension per decision. If time runs out the suit computer takes the recommendation. 20 s for a calamity, 75 s for a find (scenario values).
  - **Editable route:** before Begin, switch between Shortest, Balanced and Safest, or click the ground to add up to 3 waypoints. Each edit re-plans with A* on the real terrain and updates the oxygen plan; waypoints become tasks with markers on the map and in 3D. A placed find is kept and re-checked against the new route.
  - **Mission tasks:** each objective has tasks. Reach: your waypoints, a slope check-in and an oxygen check-in (numbers computed from the DEM and the live oxygen). Observe: photograph the surroundings, collect a rock sample, read the weather and radiation sensors (shows the measured Curiosity values), radio the report to Earth; they share the planned observation minutes (20/35/25/20%, scenario values), so the last ones are cut first when oxygen runs short. Return: a mid-way oxygen check-in and sealing the airlock. The suit display shows the current task.
  - **Educational view panel (2D map):** a panel beside the map with four tabs, every number computed by the same functions as the simulation (`web/src/route/sections.ts`, 10 unit tests). **Route sections:** the route cut into runs of similar slope (flat under 5 deg, gentle 5-10, moderate 10-15, steep 15 and up: display classes); click a row to highlight it on the map and see the calculation step by step (grade, Tobler speed, time, oxygen) for the walk out and the walk back, plus an oxygen budget bar. **Trade-offs:** Shortest, Balanced and Safest side by side (length, times, oxygen, climb, steepest ground, share at 15 deg or more, spare), drawn on the map and selectable before Begin; the price of caution in metres and litres; the cost formula and its weights; a matrix showing each route is cheapest under its own formula; the longest observation that keeps the 20% margin; what happens if energy use is 20% higher or walking 20% slower. **Findings:** facts about this route, tagged computed, model assumption, checked on 14 Nov, or general knowledge (climb and the out/back asymmetry, slope shares, which section costs most per metre, how much of the 4 km square you could reach and still get home, the limits of the model). **Maps & data:** the pipeline from elevation to route, the datasets in use, mapping facts (registration against the rover, cell size, photos versus elevation, no sea level, thermal inertia) and candidate sources not yet used (NASA Open Data portal, ISRO ISSDC / VEDAS Mars Atlas, Mars Climate Database). A live card explains the ground under the astronaut during the walk (slope, grade, speed, oxygen per step).
  - **Field notes:** short cards of real context when something happens: the measured outside conditions at the start, what a dust storm or a solar particle event means on Mars (with the measured RAD dose rate), why the 20% margin exists, and the NASA blog quote when the destination is reached.
  - **Black box debrief:** at the end, a chart of oxygen left against oxygen needed to get home over the whole EVA with every calamity marked, a table of every call (who made it, and whether it matched the suit computer's recommendation), and the lessons from the run (tightest margin and when, overrides).
  - **Calamities**, injected by mission control or at random (seeded, so a run can be repeated): rockfall that blocks ground ahead, suit oxygen leak, dust storm, injury, solar particle event warning.
  - At each calamity the sim pauses and works out the options **from the astronaut's current position**: continue (rerouted around blocked ground by A*, with science time cut to what still fits) or abort and return to base. Each option shows oxygen needed, spare oxygen at base, arrival time against any radiation deadline, and whether it is survivable; one is recommended.
  - Mission control chooses within 15 seconds, or the astronaut follows the suit computer's recommendation. Everything goes into a timed mission log, and the run ends with an outcome (success, returned safely, or failed).
  - **Mission brief and unplanned find:** the run opens with a brief from the Earth science team (objective, observation time, the NASA blog quote that names the destination, and the plan's oxygen cost). The unplanned find is set before the run: **you place it on the map** (it is noticed once the astronaut is within 150 m of it, and you can move it until then), leave it random (seeded), or turn it off. Each answer shows every leg priced on the real terrain (here to find, find to destination, destination to base), and a check at the find itself: after inspecting, is the way straight home still affordable? A leg with no walkable route is shown as unreachable. Mission control plans the stop with an inspection-time slider against a live oxygen budget bar (walk, inspection, science, spare, 20% margin), and picks one of four answers: inspect then continue, skip it, inspect then return (destination skipped), or abort. The astronaut walks the detour on the real terrain, inspects, and carries on; calamities during the detour or the inspection replan from the find. The find is a scenario target, not a real Mars observation.
  - Calamity strengths (radius 40 m, leak x1.5, dust x0.6 speed, injury x0.5 speed, 30 min radiation deadline) are scenario settings for training, not NASA data.
- **Science waypoints:** two verified Curiosity positions at the boxwork ridge. Each has a Navcam point-of-view image and the NASA text that identifies it.
- **Measured conditions:** air temperature, pressure and radiation dose rate recorded by Curiosity on the sols it stood at the waypoints.

**NASA data used: four missions, seven data kinds**

| Data kind | Mission / instrument | Source |
|---|---|---|
| Topography, regional | Mars Global Surveyor, MOLA MEGDR | PDS Geosciences Node |
| Topography, local 1 m | MRO HiRISE stereo, USGS MSL Gale Merged DEM v3 | USGS / PDS Annex (read by HTTP range requests) |
| Thermal | Mars Odyssey THEMIS, qualitative thermal inertia (Gale) | ASU THEMIS archive |
| Optical, orbital | MRO Context Camera (CTX), Gale mosaic | NASA Mars Trek (WMTS tiles) |
| Rover positions | Curiosity, PLACES localizations | PDS Imaging Node |
| Optical, point of view | Curiosity Navcam | NASA Curiosity blog / raw images |
| Atmosphere and radiation | Curiosity REMS (MODRDR) and RAD (RDR) | PDS Atmospheres and PPI Nodes |

**How it is built**
- **Data preparation (Python + NumPy, `tools/`):**
  - `prepare_data.py` (Gale overview) and `prepare_local.py` (boxwork 10 m map).
  - `prepare_themis.py`, `prepare_ctx.py`, `prepare_mars.py`, `build_waypoints.py` and `prepare_conditions.py`.
  - `validate.py` runs 8 checks on the regional data.
  - Every output is small and deterministic.
- **Web app (Vite + TypeScript + MapLibre GL JS + Three.js, `web/`):**
  - Fully static, with no server and no external map tiles at run time (CTX tiles are fetched once at build time and cut to each region).
  - 84 unit tests (vitest), including A* checked against a reference Dijkstra and the return-time search checked against a brute-force reference.
- **Deploy:** a GitHub Actions workflow runs the tests, builds, and publishes to GitHub Pages.

**Limits we state openly**
- **Model assumptions, not suit specifications:**
  - walking speed 2.5 km/h on flat ground, slowed on grades (Tobler, an Earth hiking model);
  - 234 kcal/h (the Apollo EVA average);
  - 4.8 kcal per litre of O2;
  - the 30 L oxygen reserve is a demo value.
- **Slope limit:** 25 degrees is Curiosity's maximum recorded pitch, a rover figure.
- **10 m cells:** they are point-sampled, so features smaller than 10 m (individual boxwork ridges) can be missed. The Gale overview at 1.85 km under-states slopes.
- **Registration:** our first cut of the 1 m DEM sat about 840 m east-west (and 60 m north-south) away from where it belonged, which also showed up as a "55 m elevation offset" against the rover. We found the shift by correlating the DEM's relief with the CTX photo, confirmed that CTX agrees with MOLA, and corrected it. The DEM now matches Curiosity's own elevations to 9 m and 1.3 m at the two waypoints; the remaining CTX-to-DEM misfit is below what our correlation can measure (about 150 m).
- **Science stops on ridge crests:** the boxwork ridges are narrower than a 10 m cell, so both waypoint cells read over 25 degrees. Routes end at the nearest walkable cell (14 m and 20 m away), and the app says so.
- **Conditions:** these are historical measurements at Curiosity's position, not forecasts. The radiation figure is a detector dose, not a body dose.
- **CTX coverage:** the Mars Trek Gale mosaic covers the whole boxwork map but only about 24% of the Gale overview; elsewhere the layer is transparent.
- **3D walk:** the 3D scene draws the same 10 m cells as the map; sun position, sky colour, rocks and surface grain are illustrative, not measured. The frame rate on slow machines is unknown; the 2D map version is always available.
- **Sound:** designed effects, not recordings from Mars. Speech uses the browser's built-in voices.

## 4. Live demo and screenshots

Live: https://aryank1547.github.io/RedVector-Martian-Survival-Guide/

TODO (team): screenshots (boxwork map with route and return map, HUD replay, Mars overview) and demo video link.

## 5. Install and setup

Requirements: Node 22+ (web), plus Python 3 with the packages in `tools/requirements.txt` (only to rebuild data).

```bash
cd web
npm ci
npm run dev      # http://localhost:5173
npm test         # unit tests
npm run build    # static site in web/dist
```

The prepared data is already in `web/public/data`. To rebuild it:
1. Place `megt90n000fb.img` from the PDS MEGDR page in `data-raw/`.
2. Download the PLACES file to `data-raw/places/` and the THEMIS files to `data-raw/themis/` (URLs in each script's header).
3. Run the following:

```bash
pip install -r tools/requirements.txt
python tools/prepare_data.py
python tools/validate.py
python tools/build_waypoints.py
python tools/prepare_local.py
python tools/prepare_themis.py
python tools/prepare_ctx.py
python tools/prepare_conditions.py
python tools/prepare_mars.py
```

## 6. AI usage disclosure

TODO (team): review and confirm before submission. Full per-step detail is in `log.txt`.

**Tools used**
- **Claude Code** (Anthropic; models Sonnet 5.5, Opus 5.5 and Haiku 5.5): main coding assistant.
- **ChatGPT** (OpenAI): research suggestions for NASA data sources, and drafting some task instructions. Every suggested dataset, URL and number was checked against the original source before use, and several were rejected (see `log.txt`).
- **GitHub Copilot:** one testing and documentation audit of the running app.

**What the AI generated, with human review:** the data pipeline and checks (`tools/`), the web app (`web/src`), tests, the deploy workflow, and drafts of `docs/qa.md` and this README.

**What the team did:**
- chose the problem, the site and the scope;
- verified dataset facts against PDS labels and NASA pages;
- chose the slope limit, the model assumptions and the demo reserve from the presented options;
- ran and tested everything in the browser, and reported bugs;
- reviewed every change, and wrote and pushed all commits.

## Credits

All data: NASA and NASA-funded archives.
- Mars Global Surveyor MOLA (PDS Geosciences Node).
- USGS Astrogeology MSL Gale Merged DEM 1 m (Calef and Parker 2016), from MRO HiRISE.
- Mars Odyssey THEMIS (Arizona State University).
- MRO CTX Gale mosaic (Gale_CTX_BlockAdj_dd), served by NASA Mars Trek (trek.nasa.gov).
- Curiosity PLACES (PDS Imaging Node), Navcam images (NASA/JPL-Caltech), REMS (PDS Atmospheres Node) and RAD (PDS PPI Node).

Map rendering: MapLibre GL JS.
