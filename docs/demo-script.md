# Demo script (about 4 minutes)

Live site: https://aryank1547.github.io/RedVector-Martian-Survival-Guide/

Before you start: open the live URL in a clean window at 1440x900 or larger, sound on (the page asks you to power the suit up, so sound starts only after a click). Have the Educational view and the 3D view both tested once on this machine. If the 3D scene is slow on the judging laptop, use the Educational view for the whole demo; it shows the same decisions.

Every number below was seen in the app on 15 Nov (standard scenario, Shortest strategy). Re-check them on the day; they change only if the data or the scenario changes.

| Time | Say | Show |
|---|---|---|
| 0:00 | "An astronaut walking away from the base on Mars must always be able to walk home on the oxygen left. Where is that true, and what does it cost to be careful?" | Start screen: the airlock. |
| 0:20 | "Everything is real Mars data: a USGS elevation model of the Curiosity area at 1 m, NASA CTX photos, rover positions from NASA PDS, and measured pressure, temperature and radiation from Curiosity's instruments." | Click Power up suit. Point at the uplink list and the outside conditions line (743 Pa). |
| 0:50 | "The suit depressurises to the measured pressure, then the door opens on the real terrain." | Airlock depressurising, door opening. |
| 1:10 | "Pick a role and a scenario. The brief computes the round trip on the real terrain before we leave: 393 m out, 32.7 L of a 45 L reserve." | Brief, role, scenario, Commence. |
| 1:30 | "Two views: a simulated 3D walk, or an educational 2D view." | View choice dialog. Choose the simulated view. |
| 1:40 | "I can edit the route: strategy, or up to three waypoints. Each waypoint becomes a task." | Route editor, add a waypoint, tasks list. Begin EVA. |
| 2:10 | "Mission control injects a calamity. The decision takes over the screen, with a timer. The recommendation is computed from the oxygen left and the way home." | Inject a dust event; show the decision card and timer; choose the recommended option. |
| 2:50 | "Now the educational view, which explains every number." | Back to the start tab, Commence, educational view. |
| 3:00 | "The route is cut into sections by slope. Click one and you see how its time and oxygen are built: grade, Tobler's walking speed, time, then oxygen at 234 kcal an hour." | Route sections tab, click row 2, the how-block. |
| 3:30 | "Shortest, Balanced and Safest side by side. Safest walks 23 m more and uses 0.6 L more, to spend 5 points less of the path on steep ground. The way back is not the way out reversed, so the return reserve is computed backwards from the base." | Trade-offs tab, the three-route overlay on the map. |
| 3:50 | "Limits: the model values are assumptions, not NASA suit figures; the 25 degree slope limit is a rover figure; the 30 and 45 litre reserves are demo values. All of it is in the README, and the AI use is disclosed there." | Findings or Maps & data tab. |

## If something breaks
- 3D blank or slow: say "this is WebGL on a slow machine", press the tab for the start screen and choose the educational view.
- A route will not plan within a few seconds: reload; the route planner falls back to the main thread after 8 s.
- No sound: the browser blocks audio until a click; click Power up suit again or skip sound (the Quiet link).

## Questions to be ready for
See `docs/qa.md` (37 questions at the time of writing). The five most likely: where the numbers come from, why Tobler's function on Mars, what is simulated versus real, what the AI wrote, and why the way back differs from the way out.
