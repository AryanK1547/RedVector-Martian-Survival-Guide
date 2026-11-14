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
- **Live EVA simulation (astronaut + mission control):** the astronaut walks the route in compressed real time (30x to 120x) with a suit display: mission clock, oxygen left, oxygen needed to get home, margin, walk-home time, active conditions.
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
- **Web app (Vite + TypeScript + MapLibre GL JS, `web/`):**
  - Fully static, with no server and no external map tiles at run time (CTX tiles are fetched once at build time and cut to each region).
  - 58 unit tests (vitest), including A* checked against a reference Dijkstra and the return-time search checked against a brute-force reference.
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
- **Not built:** 3D view.

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
