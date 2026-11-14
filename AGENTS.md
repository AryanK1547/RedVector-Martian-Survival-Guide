# AGENTS.md

MarsWalk: NASA Space Apps Challenge, Nagpur, 14-15 Nov 2026
Challenge: "Interplanetary Survival Guide: Martian Map"

Single source of truth for any AI assistant in this repo (Claude Code, Claude chat, Codex, Gemini, Copilot). Read it fully before acting. The human team's instructions override this file; record any change in `log.txt`.

The lead is Aryan Khode, 3rd-year B.Tech. He is here to LEARN while shipping, and judges will question him on this code. Teaching quality matters as much as working code.

---

## 0. TLDR For The Agent

1. Read this file, then the last entries of `log.txt`.
2. Reply with a 5-line state summary (§10): where we are, current phase (§7), open issues, next step. Wait for a go.
3. Work in the current phase only. At each COMMIT POINT, tell the human it is time to commit.
4. **Never run `git commit`, `git push`, or anything that creates commits.** Only the human commits (§3).
5. Never read or print the raw `.img` file or any large array. Use scripts and small summaries (§6).
6. Teach as you build (§4). Log each work block (§5).

---

## 1. Project

MarsWalk helps an astronaut plan a Marswalk: pick a start, a destination and a strategy on a real Mars terrain map, get a route with statistics, and watch it replayed as a mission.

Scope (decided 9 Nov, still valid):
- Level 1: 2D mission replay on the map with a HUD (slope, elevation, oxygen, suit power, sol clock, alerts).
- Level 2: 3D terrain walk-through (Three.js) built from the same elevation grid and route.
- Level 1 is the safety net. A first-person physics game is out of scope.
- One cropped region (about 400-600 km wide, around Gale Crater), not the whole planet.

Stack (revised 14 Nov, because GitHub Pages is static-only): Python + NumPy for offline data preparation; a fully static web app (Vite + TypeScript, MapLibre GL JS, Three.js) that runs A* in the browser inside a Web Worker. No FastAPI server. Reason: nothing to host, deploy or keep alive in 24 hours.

---

## 2. Event Rules That Govern Everything (NASA Space Apps Nagpur handbook)

| Rule | What it means here |
|---|---|
| Hacking window | 12:00 Sat 14 Nov to 14:00 Sun 15 Nov 2026 (IST). Hard code freeze at 14:00: no commits, merges or edits after. |
| Fresh code | All source code, models and assets must be created during the window. Public open-source libraries, NASA open datasets and public APIs are allowed. Pre-event code is NOT copied into the repo; re-create it in the repo during the window. |
| Repository | New PUBLIC GitHub repo created after 12:00 on 14 Nov. Submission link is given on-site before the deadline. |
| Hourly pushes | At least one push every hour until freeze, including overnight. Each push must be genuine incremental work. |
| Human authors only | Every commit authored and pushed by a registered human team member from their own GitHub account. No AI or bot authors, no AI co-author tags, no automated commit scripts. |
| Every member | Every team member appears in Contributors with their own commits. Teams are 1 to 5 members. |
| Live hosting | Host on GitHub Pages (or comparable). Live URL at the top of `README.md`. |
| AI disclosure | README heading "AI Usage Disclosure": which AI tools, which modules they helped generate, what the team did on top. Undisclosed AI use is penalized. |
| README | Six sections: title and problem, team details, solution and architecture, live demo and screenshots, install and setup, AI usage disclosure. |
| Judging | 14:00-17:00 Sun: live demo and Q&A. Pillars: problem alignment, technical execution and live hosting, innovation, GitHub discipline and docs, presentation and Q&A. |
| Venue | Night gate closes 21:00. Bring a mobile hotspot, a charged laptop and a multi-plug board: 2-3 minute power cuts happen. Save often. |

Open questions for the organising desk (ask early, record the answer in `log.txt`):
1. Is re-creating our own earlier learning code inside the window acceptable if we disclose it?
2. How are hourly pushes expected overnight for small teams?

---

## 3. Human And Claude Code Roles (commits)

- Claude Code writes and edits files and runs scripts and tests. It does NOT commit or push. `.claude/settings.json` denies those commands; do not work around the denial.
- The human reviews the diff, then commits and pushes from their own terminal: `git add -A` (or `git add -p`), `git commit -m "<human-written message>"`, `git push`.
- Commit messages are written or edited by the human. Claude may suggest one in chat.
- Before every push the human runs `git log -3 --format=%B` and confirms there is no "Claude", "Co-Authored-By" or session-link text.
- Never rewrite pushed history (no force push). Undo with `git revert`, so the hourly record stays intact.
- Tag good states with `git tag ok-<phase>`. Roll back by checking out a tag into a new branch.
- Deploy with the official GitHub Pages workflow (`actions/upload-pages-artifact` + `actions/deploy-pages`), which does not create commits. No bot pushing a `gh-pages` branch.

---

## 4. Teaching Contract

1. Concept first (short, with a tiny example or diagram), then build, then the human runs it.
2. Explain every tool, library and concept on first use, how and why (e.g. `pathlib`, dtype `>i2`, `np.gradient`, a priority queue, a Web Worker, a heightmap mesh).
3. Do not defer: finish the step in the same message.
4. Small runnable steps with the expected output stated.
5. Mark what is verified (human ran it, NASA documentation says so) versus assumed. Never invent dataset facts, tile URLs, API endpoints, thresholds or numbers. Say "needs checking".
6. Prepare the human for judges: after each phase add 3-5 "judge question and answer" items in plain language to `docs/qa.md`.
7. Keep explanations short when usage is tight (§8). For a deep explanation, give it once; the human saves it to `docs/notes.md`.

---

## 5. Log (`log.txt`): Append-Only

- `log.txt` sits next to this file. Append only; fix errors with a CORRECTION entry. UTF-8, `\n`.
- Log per WORK BLOCK (one task or commit point), not per chat message. This saves usage.
- Never log secrets. This log is the source for the README "AI Usage Disclosure", so be accurate about what the AI generated.

```text
## [ISO-8601 TIMESTAMP IST] <title, max 80 chars>

Phase: <id> | Tool: <Claude Code | Claude chat | other> | Model: <exact model>
Goal: <one line>
AI Generated: <files or modules the AI wrote or changed>
Human Did: <what the human wrote, ran, reviewed, tested, decided>
Concepts Taught: <one line each, or none>
Decisions: <decision and why, or none>
Verified: <evidence, or none>
Assumed / Unverified: <list, or none>
Open Issues: <added or resolved, or none>
Commit Point: <yes/no, suggested message>
Next: <one line>
```

---

## 6. Architecture And Contract

### 6.1 Repository layout

```text
AGENTS.md  CLAUDE.md  README.md  log.txt  .gitignore
.claude/settings.json
data-raw/            (gitignored; raw NASA files, never read by the AI)
tools/               (Python: prepare_data.py, validate.py)
web/                 (Vite + TypeScript app)
  public/data/       (small generated assets: elevation.bin, meta.json, hillshade.png, slope.png)
  src/               (map, route worker, replay, 3d, ui)
docs/                (qa.md, notes.md, screenshots)
.github/workflows/pages.yml
```

`.gitignore` includes: `data-raw/`, `node_modules/`, `__pycache__/`, `.env`, `.claude/settings.local.json`, `*.img`.

### 6.2 Data facts

Verified by the human's own run before the event:
- MOLA MEGDR topography, file `megt90n000fb.img` with an ENVI `.hdr`. Source: https://pds-geosciences.wustl.edu/missions/mgs/megdr.html
- 11520 samples x 5760 lines, 1 band, header offset 0, 16-bit signed integer, most-significant-byte first (NumPy `>i2`), 32 pixels per degree.
- 66,355,200 values read as expected; minimum -8206, maximum 21181 (meters).

From the header or NASA documentation, to be re-verified in this window:
- Pixel size 1852.2306687 m; topography is radius minus areoid.
- NoData ("data ignore value = 0" in the header): confirm whether 0 can also be real elevation.
- Pixel-center convention, longitude wrap, projection parameters.

### 6.3 Data preparation rules (`tools/`)

- Mask NoData BEFORE computing slope. NoData is not zero.
- East-west ground spacing scales with cos(latitude).
- `latlon_to_pixel` and `pixel_to_latlon` must round-trip within one pixel.
- Crop one region and write small deterministic assets: `elevation.bin` (dtype documented in `meta.json`), slope and cost grids or PNGs, `hillshade.png`, `meta.json` (crop bounds, offsets, pixel size, NoData, spacing method, source file, version).
- Keep assets small for GitHub Pages and a fast first load (target under about 5 MB total).
- `tools/validate.py` runs in seconds and prints PASS/FAIL for: value count, min/max range, slope range 0-90 degrees with no spikes on NoData borders, coordinate round trip, crop inside the raster.

### 6.4 Web app rules (`web/`)

- No server. All data loads from `public/data/`; everything runs in the browser.
- Map: MapLibre with our own hillshade or slope image as an `image` source. No external tile URL unless its exact NASA service URL and terms are verified. Never guess a URL.
- Routing: grid graph, 8 neighbours, A* in a Web Worker. Cost = ground distance + slope penalty + elevation-change penalty. Cells above the maximum traversable slope are impassable. The threshold is chosen with a written justification and logged, not invented.
- Strategies: Shortest, Safest, Balanced. A* is checked against Dijkstra on a small grid (same total cost). Deterministic tie-breaking.
- Route output: steps with distance, elevation, slope, energy, oxygen and time. Resource rates are labeled "model assumptions", never presented as NASA values.
- The Level 1 HUD and Level 2 3D both read the same route steps and elevation grid.
- 3D: heightmap to mesh from the same grid. Vertical exaggeration and added detail are labeled as visualization. State the data resolution limit (about 1.85 km per pixel) in the README and demo.
- Science layer (rover or landing-site markers) only with coordinates checked against an official NASA source; cite it.
- No reliance on `localStorage` for required behavior.
- Credit NASA, MGS/MOLA and the PDS in the UI footer and README.

### 6.5 Validation (run after relevant changes, log results)

`python tools/validate.py`, A* vs Dijkstra test, route endpoints match, `npm run build` passes, and the LIVE URL works from a clean browser window.

---

## 7. Timeline And Phases (all times IST)

Freeze: Sun 15 Nov 14:00. Push every hour.

| Phase | When | Build | Done when |
|---|---|---|---|
| P0 Setup | Sat 13:45-14:45 | Repo, git email, kit files, attribution check, first human push. Ask the §2 questions. | First push is on GitHub; contributors list shows the human |
| P1 Data | Sat 14:45-17:00 | `tools/prepare_data.py`: read raster, verify NoData, crop Gale region, masked slope, cost, export assets, `validate.py` | `validate.py` all PASS; assets in `web/public/data` |
| P2 Route + map | Sat 17:00-20:00 | Vite app, MapLibre image overlay, click start/end, A* worker, route line, stats panel, elevation profile | A route plans on screen between two clicks |
| P3 Deploy early | Sat 20:00-21:00 | Pages workflow, live URL, README skeleton with URL at top | Live URL works in a clean browser |
| P4 Level 1 replay | Sat 21:00-00:30 | Animated astronaut, follow camera, HUD, alerts | Replay plays on the live site |
| P5 Level 2 3D | Sun 00:30-05:00 | Heightmap mesh, shading, astronaut, follow camera, route ribbon. GO/NO-GO at 05:00. | Astronaut walks the real route in 3D, or we cut it |
| P6 Stabilize | Sun 05:00-09:00 | Bugs, device checks, strategy comparison, tests, `docs/qa.md` | No known crash on the live site |
| P7 Polish + docs | Sun 09:00-12:00 | README (six sections), AI disclosure from `log.txt`, screenshots, science layer if time, demo script | README complete |
| P8 Freeze prep | Sun 12:00-13:45 | FEATURE FREEZE 12:00. Demo video, final deploy check, final push by 13:45. Submit the link from organisers. | Submitted |
| Hard freeze | Sun 14:00 | No edits at all. Judging 14:00-17:00. | |

Cut order if behind: science layer, extra strategies, 3D polish, 3D entirely, sunlight/comms.
Never cut: map, route, stats, deployed URL, Level 1 replay, README with AI disclosure.
If overnight pushes are hard, prefer small genuine steps (tests, docs, one fix per hour) over large risky changes.

---

## 8. Claude Code Usage Policy (Claude Pro)

Pro has a rolling 5-hour window plus a weekly cap, both shared with claude.ai chat. Treat usage as the scarcest resource.

Model by task (switch with `/model`):

| Task | Model |
|---|---|
| Daily work: scripts, UI, A*, worker, deploy workflow, ordinary debugging | Sonnet 5.5 (default) |
| Hard design, or a bug that survived two attempts: 3D mesh to route coordinate sync, algorithm correctness review | Opus 5.5, sparingly (2-3 uses) |
| Tiny edits: renaming, README formatting, boilerplate, commit message suggestions, docs | Haiku 5.5 |
| Anything on Fable | Do not use (on Pro it is billed per token as extra usage) |

Habits:
- Run `/usage` at the start of each phase and note it in `log.txt`.
- Plan mode (Shift+Tab) before big tasks; approve the plan, then build.
- One task per prompt with a clear definition of done, then `/clear`. Use `/compact` when a long task must continue.
- Name paths instead of pasting files. Never let the AI read `data-raw/` or print arrays: summaries only (shape, min, max, counts).
- Keep this file and `CLAUDE.md` short. Batch questions.
- Reserve about 20% of usage for P7-P8.

At a limit: read the reset time in the message, switch to a smaller model, and use the wait for human tasks (README, screenshots, judge Q&A, testing). Paid extra usage is optional and the team's call. Other AI tools are allowed by the handbook if disclosed in the README.

---

## 9. Constraints

- Public data only, no personal data, no secrets in the repo.
- Paths relative to the repo root; works on Windows, macOS, Linux. Do not assume bash.
- Deterministic outputs (fixed ordering, no unseeded randomness).

---

## 10. Current State (edit at each commit point; history lives in `log.txt`)

- Pre-event learning (not repo code): read the real MOLA file, coordinate math, slope v1 with an unresolved NoData problem.
- Repo: created; kit files in place (AGENTS.md, CLAUDE.md, .claude/settings.json, .gitignore, log.txt). First human push pending.
- Next: finish P0 (identity check, organiser questions, first push), then P1 Data.

Open issues: NoData value and masking; cos(latitude) spacing; coordinate convention checks; crop bounds; organiser answers (§2); submission link (given on-site).

---

## 11. Checklist Before Every Reply

- [ ] I read this file and recent `log.txt` entries this session.
- [ ] I stay inside the current phase and flag each commit point.
- [ ] I will not commit or push, and I will not read `data-raw/`.
- [ ] I explain new concepts, mark verified vs assumed, and invent no facts, URLs or numbers.
- [ ] I log the work block with accurate "AI Generated" and "Human Did" lines.
