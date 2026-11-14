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
- **Layers:** hillshade, slope, and THEMIS thermal inertia (qualitative; generally low over dust and sand, high over rock).
- **Route planning:** click a base, then a destination. A* plans the route in a Web Worker on an 8-neighbour grid.
  - Cost is ground distance plus slope and elevation-change penalties. Cells steeper than 25 degrees are impassable.
  - There are three strategies: Shortest, Balanced and Safest.
- **Route stats:** distance, ascent and descent, steepest cell, walking time, energy, oxygen and radiation dose, plus an elevation profile.
- **Point-of-no-return map:** every cell is shaded by the oxygen needed to walk back to base, against an editable reserve. Along a route, a purple marker shows where to turn back.
- **Level 1 mission replay:** an astronaut marker walks the route with a helmet-style HUD. It shows the clock, distance, elevation, slope, oxygen left and oxygen to return, with caution and TURN BACK alerts.
- **Science waypoints:** two verified Curiosity positions at the boxwork ridge. Each has a Navcam point-of-view image and the NASA text that identifies it.
- **Measured conditions:** air temperature, pressure and radiation dose rate recorded by Curiosity on the sols it stood at the waypoints.

**NASA data used: four missions, six data kinds**

| Data kind | Mission / instrument | Source |
|---|---|---|
| Topography, regional | Mars Global Surveyor, MOLA MEGDR | PDS Geosciences Node |
| Topography, local 1 m | MRO HiRISE stereo, USGS MSL Gale Merged DEM v3 | USGS / PDS Annex (read by HTTP range requests) |
| Thermal | Mars Odyssey THEMIS, qualitative thermal inertia (Gale) | ASU THEMIS archive |
| Rover positions | Curiosity, PLACES localizations | PDS Imaging Node |
| Optical, point of view | Curiosity Navcam | NASA Curiosity blog / raw images |
| Atmosphere and radiation | Curiosity REMS (MODRDR) and RAD (RDR) | PDS Atmospheres and PPI Nodes |

**How it is built**
- **Data preparation (Python + NumPy, `tools/`):**
  - `prepare_data.py` (Gale overview) and `prepare_local.py` (boxwork 10 m map).
  - `prepare_themis.py`, `prepare_mars.py`, `build_waypoints.py` and `prepare_conditions.py`.
  - `validate.py` runs 8 checks on the regional data.
  - Every output is small and deterministic.
- **Web app (Vite + TypeScript + MapLibre GL JS, `web/`):**
  - Fully static, with no server and no external map tiles.
  - 44 unit tests (vitest), including A* checked against a reference Dijkstra and the return-time search checked against a brute-force reference.
- **Deploy:** a GitHub Actions workflow runs the tests, builds, and publishes to GitHub Pages.

**Limits we state openly**
- **Model assumptions, not suit specifications:**
  - walking speed 2.5 km/h on flat ground, slowed on grades (Tobler, an Earth hiking model);
  - 234 kcal/h (the Apollo EVA average);
  - 4.8 kcal per litre of O2;
  - the 30 L oxygen reserve is a demo value.
- **Slope limit:** 25 degrees is Curiosity's maximum recorded pitch, a rover figure.
- **10 m cells:** they are point-sampled, so features smaller than 10 m (individual boxwork ridges) can be missed. The Gale overview at 1.85 km under-states slopes.
- **Elevation offset:** the 1 m DEM reads about 55 m below the PLACES rover elevations. The cause is not confirmed, so the two are never mixed.
- **Conditions:** these are historical measurements at Curiosity's position, not forecasts. The radiation figure is a detector dose, not a body dose.
- **Not built:** CTX optical imagery layer, injected-hazard replanning, 3D view.

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
- Curiosity PLACES (PDS Imaging Node), Navcam images (NASA/JPL-Caltech), REMS (PDS Atmospheres Node) and RAD (PDS PPI Node).

Map rendering: MapLibre GL JS.
