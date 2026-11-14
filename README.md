# MarsWalk: Interplanetary Survival Guide, Martian Map

**Live demo:** https://aryank1547.github.io/RedVector-Martian-Survival-Guide/ (TODO: confirm after the first Pages deploy)

NASA Space Apps Challenge 2026, Nagpur, team RedVector. Challenge: "Interplanetary Survival Guide: Martian Map".

## 1. Problem

The first astronauts on Mars will need a map built for one walk, not for the whole planet. It has to show where they can safely go, how long the walk takes, what it costs in oxygen and energy, and what science waits at the destination. Tools like JPL Mars Trek show regional and global views. MarsWalk targets a single Marswalk around Gale Crater, where Curiosity has worked since 2012.

## 2. Team

TODO (team): names, roles and GitHub accounts of every member.

## 3. Solution and architecture

- **Data preparation (Python + NumPy, `tools/`).** Reads the NASA MGS MOLA MEGDR topography (`megt90n000fb`, PDS Geosciences Node). It crops a 256 x 256 pixel window (about 470 km) around Gale Crater, then computes slope with latitude-correct pixel spacing. It exports small files (elevation, slope, hillshade, metadata). `tools/validate.py` checks the data (8 checks).
- **Web app (Vite + TypeScript + MapLibre GL JS, `web/`).** Fully static, with no server.
  - The map shows our own hillshade and slope images, with no external tiles.
  - Click a start and a destination. A* plans the route in a Web Worker on an 8-neighbour grid. Cost combines ground distance, a slope penalty and an elevation-change penalty. Cells steeper than 25 degrees are impassable.
  - There are three strategies: Shortest, Balanced and Safest.
  - The stats panel shows distance, ascent and descent, steepest cell, walking time, energy and oxygen, plus an elevation profile.
  - A* is tested against a reference Dijkstra (vitest).
- **Deploy.** A GitHub Actions workflow builds the app, runs the tests and publishes to GitHub Pages.

**Limits we state openly:**
- The data resolution is about 1.85 km per pixel, so local steep terrain and rocks are not visible.
- Walking speed, energy and oxygen are model assumptions: 2.5 km/h on flat ground, slowed on grades (Tobler), 234 kcal/h (the Apollo EVA average), and 4.8 kcal per litre of O2. They are not NASA mission values.
- The 25 degree limit is Curiosity's maximum recorded pitch, a rover figure.

TODO: add the layered multi-mission data, local high-resolution map, science waypoints and replay as they are built.

## 4. Live demo and screenshots

TODO: screenshots and demo video link.

## 5. Install and setup

Requirements: Node 22+ (web) and Python 3 with NumPy and Pillow (data, optional).

```bash
cd web
npm ci
npm run dev      # http://localhost:5173
npm test         # unit tests
npm run build    # static site in web/dist
```

The prepared data is already in `web/public/data`. To rebuild it, place `megt90n000fb.img` from the PDS MEGDR page in `data-raw/`, then run:

```bash
python tools/prepare_data.py
python tools/validate.py
```

## 6. AI usage disclosure

TODO (team): finalize from `log.txt`. Draft:
- **Tools:** Claude Code (Anthropic; models Sonnet 5.5 and Opus 5.5).
- **AI-generated with human review:** the data pipeline and checks (`tools/`), the web app (`web/src`), tests, the deploy workflow, and drafts of `docs/qa.md` and this README.
- **Done by the team:** chose the problem, region and scope; verified dataset facts against the PDS label; chose the slope limit and the model assumptions from the cited sources; ran and tested everything; reviewed every change; wrote and pushed all commits.

## Credits

Topography: NASA Mars Global Surveyor, MOLA Mission Experiment Gridded Data Records, PDS Geosciences Node (https://pds-geosciences.wustl.edu/missions/mgs/megdr.html). Map rendering: MapLibre GL JS.
