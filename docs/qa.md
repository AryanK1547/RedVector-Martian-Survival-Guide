# Judge Q&A

## P1 Data

**Q: Where does your elevation data come from?**
A: NASA's Mars Global Surveyor MOLA laser altimeter, the MEGDR topography product (file megt90n000fb) from the PDS Geosciences Node. Elevation is the planet's radius minus a gravity-based reference surface (the areoid), in meters. We crop one region around Gale Crater.

**Q: How good is the resolution?**
A: 32 pixels per degree, about 1.85 km per pixel. That is coarse. Slopes computed at this scale smooth out steep local terrain, so our slope values under-state real hazards. We state this in the app and README.

**Q: How did you calculate slope?**
A: Slope is rise over run. For each cell we take the elevation change to its neighbours and divide by the ground distance. North-south distance per pixel is constant. East-west distance shrinks with the cosine of latitude, so we scale it per row. We tested it on flat and ramp grids with known answers.

**Q: What about missing data? The file header says 0 means "ignore".**
A: We checked. The official PDS label defines no missing-value constant, and the 8,431 zeros in the full file are scattered single pixels (83% isolated), not patches. So 0 m is real elevation and we do not mask it.

**Q: How do you know your latitude/longitude conversion is right?**
A: The grid is equirectangular, so it is a straight scale and offset in degrees. We check that converting a position to a pixel and back lands within one pixel, on 1,000 seeded random points, and that the header's pixel size matches the sphere geometry (3396 km radius). One assumption remains: a pixel's value is taken at its center, which the label does not state.

**Q: Which parts are not yet verified?**
A: Gale Crater's center coordinates were supplied from the USGS Gazetteer by a team member and are not yet independently confirmed in our checks.

## P2 Route + map

**Q: How does the route planner work?**
A: The map is a grid of 1.85 km cells, each connected to its 8 neighbours. A* searches for the cheapest path. Cost is ground distance, plus a penalty that grows with slope squared, plus a penalty for climbing or descending. Shortest, Balanced and Safest just use different penalty weights. The search runs in a Web Worker, so the map never freezes.

**Q: How do you know A* gives the right answer?**
A: We compare it against a plain Dijkstra that shares no code with A*'s priority queue. They give the same total cost on 69 seeded random grids, on a window of the real Gale terrain, and for all three strategies. A* stays exact because its guess of the remaining cost (straight-line distance) can never be more than the real cost.

**Q: Why is 25 degrees the slope limit?**
A: NASA has no single official walking-slope limit that we could find. We used Curiosity's maximum recorded pitch, 25.22 degrees, from a JPL mobility report. It is a rover figure, not an astronaut one, and our slopes are averaged over 1.85 km, so real local slopes are steeper. Only 35 of 65,536 cells exceed it in our crop. The strategies mostly differ through the slope penalties.

**Q: Where do time, energy and oxygen come from?**
A: They are labelled model assumptions. Flat walking speed is 2.5 km/h, below the Apollo nominal maximum of about 3.5 km/h. It slows on grades following Tobler's hiking function, an Earth hiking model. Metabolic rate is 234 kcal/h, the Apollo lunar EVA average from a NASA report. Oxygen uses the textbook 4.8 kcal per litre of O2. These are estimates for planning, not mission values.

**Q: Does the map projection distort your clicks?**
A: MapLibre stretches our image in Web Mercator, but the data rows are evenly spaced in latitude. We measured the worst mismatch at 0.42 of a pixel, so clicks land on the correct cell.

## P3b-P5 Layers, local map, safety, replay

**Q: Which NASA missions and data kinds does MarsWalk combine?**
A: Four missions: Mars Global Surveyor (MOLA topography), Mars Reconnaissance Orbiter (a 1 m elevation model built from HiRISE stereo, by USGS), Mars Odyssey (THEMIS thermal inertia), and Curiosity (rover positions, Navcam images, REMS weather, RAD radiation). That gives six data kinds: topography, thermal, optical images, positions, atmosphere and radiation.

**Q: Why not just use the whole Gale map at 1.85 km?**
A: The brief asks for hyperlocal maps, not regional ones. At 1.85 km per cell, Gale has almost no slopes above 25 degrees (35 of 65,536 cells). On our 10 m boxwork map, 14% of cells are steeper than 25 degrees. A walk planned on the coarse map would miss real hazards.

**Q: How did you get a 1 m elevation model into a static website?**
A: The USGS file is 3.87 GB. It stores each row separately, so we downloaded only every tenth row of our 4 km window with HTTP range requests (31 MB) and kept every tenth column. That gives 10 m cells. We did not average, so features smaller than 10 m can be missed.

**Q: How do you know the waypoints are real?**
A: The positions come from NASA's PLACES rover localization archive. The names come from NASA's Curiosity blog posts for sols 4600-4603, which describe the rover at the base and then the top of the ridge leading to the main boxwork region. The two positions are 22 m apart; the blog planned a 21 m drive. The Navcam image file name for sol 4598 contains the same site and drive number as the waypoint.

**Q: What is the point-of-no-return map?**
A: From the base, we run Dijkstra backwards and get the walking time back from every cell. It runs backwards because walking uphill is slower, so the way back costs differently from the way out. Each cell's colour shows the oxygen needed to return, compared with the reserve. Along a route, the point of no return is the first cell where oxygen already used plus oxygen to return exceeds the reserve.

**Q: Are the oxygen numbers real suit values?**
A: No, and the app says so. Walking speed, metabolic rate and oxygen per kilocalorie are model assumptions with cited sources. The 30 L reserve is a demo value chosen so the effect is visible on a 4 km map.

**Q: What do the conditions and radiation numbers mean?**
A: They are Curiosity's own measurements on the sols it stood at the waypoints (July 2025): air temperature and pressure from REMS, and the dose rate in RAD's silicon detector, about 168 microgray per day. They are historical context, not a forecast, and the radiation figure is a detector dose, not a body dose.

**Q: What is not verified or still uncertain?**
A: The CTX photo and the elevation model agree to within about 150 m; below that our correlation check cannot measure. Near the waypoints the elevation match (9 m and 1.3 m against the rover's records) pins it to tens of metres. Waypoint cells read steeper than the 25 degree limit because a 10 m cell straddles a narrow ridge, so routes end at the nearest walkable cell, and the app says how far that is. THEMIS thermal inertia is the qualitative version and is used for display only.

**Q: You said earlier the elevation model was 55 m off. What happened?**
A: That was a symptom, not a height-reference difference. Correlating the elevation model's relief against the CTX photo showed our extract sat about 840 m east-west from where it belonged. Two independent checks confirmed it: CTX lines up with MOLA (no shift), and at the shifted position the elevation model matches the rover's own elevations to 9 m and 1.3 m. We corrected the extract (REG_ROWS / REG_COLS in tools/prepare_local.py), and the 55 m offset disappeared.

**Q: How does the live simulation decide what to do after a calamity?**
A: It pauses and replans from where the astronaut is at that moment. A rockfall marks the ground ahead impassable, and A* reroutes on the real terrain. A leak raises oxygen use; dust or an injury lowers walking speed; a solar particle event sets a deadline to be back at base. For "continue" and "return to base", it computes oxygen needed, spare oxygen at base and arrival time, cutting science time to whatever still fits. It recommends continuing only if that keeps at least 20% of the reserve spare. Mission control has 15 seconds to decide; otherwise the astronaut follows the recommendation. The calamity strengths are scenario settings for training, not NASA data, and random runs are seeded so a run can be replayed exactly.

**Q: What is the unplanned find, and how does the planner decide how long to inspect?**
A: It is a training scenario: partway out, the astronaut notices something off the route. It is not a real Mars observation and the app says so. The planner treats the walk as stops (find, destination, base). Walking and inspection time are fixed once chosen; science time at the destination is the flexible part, cut back to what the oxygen still allows. The "spare time" figure is the longest inspection that still finishes the destination with the 20% reserve margin intact, found by running the same oxygen model. The recommendation order is: inspect and still do the full destination plan, else skip the find, else inspect and return, else abort. That order is our display rule, not a NASA rule.

**Q: Does the planner check that the destination and the way home are still reachable from the find?**
A: Yes. For each answer it runs A* on the real terrain for every leg (astronaut to find, find to destination, destination to base) and adds up walking time and oxygen. For the find it also shows the state on arrival: oxygen left after inspecting, and what going straight home from the find would cost. If any leg has no walkable route, for example after a rockfall, that answer is shown as unreachable rather than hidden. The find can be placed by hand or left random; both go through the same planner.

**Q: What is the Mars mission start screen, and is any of it real?**
A: It is the entry point: an airlock scene with an Earth uplink, then the EVA tab with the mission loaded. The data files listed in the uplink panel are really fetched (with real sizes), but the timing is paced for effect, the Earth link is simulated and the real Earth to Mars delay is not, and the suit ID, sol number, cabin pressure and scenery are cosmetic. The horizon in the door window is drawn from rows of the local elevation model. Suit battery is shown as "not modelled" because we have no battery data. The round-trip preview is computed on the real terrain with the same A* and oxygen model as the app. The three scenarios are demo settings, not NASA data.

**Q: Why does the app give a verdict instead of just showing data?**
A: An astronaut needs a decision, not a layer stack. MarsWalk turns the route, the walk back from every cell and the oxygen reserve into GO, CAUTION or NO-GO, plus the minutes of science time left at the destination before the walk back must start. The thresholds are the reserve (a demo value), the 25 degree slope limit, and an 80% caution line, which is our display choice.

**Q: Is the 3D walk real terrain, and what in it is invented?**
A: The ground is the local USGS DEM (made from HiRISE stereo) at one vertex per 10 m cell, at true vertical scale, draped with the CTX photo; the route, the oxygen numbers and every decision come from the same engine as the 2D map. Invented for looks, and labelled: rocks, the fine surface grain, the sun position and sky colour, the dust tint on the greyscale CTX photo, the airlock room, the platform and ramp. The view through the airlock door is the real terrain, turned to the most open heading computed from the DEM skyline.

**Q: Why does the airlock depressurise to 743 Pa, and why mention 6.3 kPa?**
A: 743 Pa is the mean air pressure Curiosity's REMS measured on sol 4598 at the boxwork waypoint (conditions.json). The habitat's 101.3 kPa is our assumption (Earth sea level). 6.3 kPa is the Armstrong limit, below which water boils at body temperature; we show it so the viewer sees why the suit is the only thing keeping the astronaut alive. It is general physiology, not a MarsWalk calculation.

**Q: What do the two roles change?**
A: Not the physics. Both run the same Sim engine. As the EVA astronaut you start in first person, calamities strike without warning and you cannot trigger them, and CAPCOM's recommendation is shown while you decide. As Mission Control you start in the overview, can inject calamities, and advise each call. Multiplayer, a separate Science Officer seat and a Mission Director were left out: the app is static with no server, and those roles would add screens without new decisions. The Science Officer and Earth appear as radio voices instead.

**Q: Is the sound what Mars sounds like?**
A: No. It is designed simulation audio made with the Web Audio API, no recordings. One idea from real science shapes it: Mars's thin carbon-dioxide air carries sound weakly, high pitches worst, so outside sounds (wind, grit, the crunch of steps) go through a muffling filter, while sounds that reach you through the suit (breath, boot thumps, fans) stay clear. In the airlock, room sounds fade as the air is pumped out, because sound needs air.

**Q: What is the black box?**
A: The after-action review at the end of a run: oxygen left against oxygen needed to get home over time (the gap is the margin), every calamity marked, every call with who made it and whether it matched the suit computer, and two or three lessons computed from the run, such as the tightest margin and when it happened.

**Q: Why two views (simulated 3D and educational 2D)?**
A: They answer different needs. The 3D walk is for feeling the mission: first person, sound, the airlock. The 2D map is for studying it: top-down terrain, route, trail and the elevation profile side by side, light on the computer. Both run the same engine, so a run, its decisions and its numbers are identical; only the drawing changes. The choice appears when you press Commence.

**Q: How can the route be edited, and what stops a bad edit?**
A: Before Begin you can pick a strategy (Shortest, Balanced, Safest) or add up to 3 waypoints by clicking the ground. Each click is snapped to walkable ground, then A* plans base to waypoint to destination on the real terrain; if any leg has no walkable path the edit is refused with a message. The plan line is recomputed, and it says plainly when the oxygen is not enough. The edit restarts the run from zero (same seed), so random calamities stay the same for comparison.

**Q: What are the mission tasks, and are they real?**
A: They are scenario tasks modelled on what a science EVA involves: check-ins on the way, then observation work (photograph, sample, sensor readings, report), then sealing the airlock. The slope and oxygen numbers in the check-ins are computed from the real terrain and the live simulation. The split of the observation minutes between tasks (20, 35, 25, 20 percent) is a scenario choice, not a NASA timeline. The notes attached to them are general context (for example that Perseverance is caching samples, and why Earth reports take minutes), kept qualitative.

**Q: Why does the decision take over the screen?**
A: A decision with a timer should not be squeezed into a 370 px sidebar. The card shows what happened, why it matters, and each option with three plain numbers and a verdict, with a countdown dial, an alert tone and a tick every second so it cannot be missed. One +15 s extension is allowed per decision; if the timer still runs out, the suit computer takes the recommendation and the black box records that nobody made the call.

**Q: What does the Educational view teach, and can its numbers be trusted?**
A: It explains the route instead of only drawing it: how the route breaks into sections of similar slope, how each section's time and oxygen are built (grade, then Tobler speed, then time, then oxygen at 234 kcal/h and 4.8 kcal per litre), why the way back costs differently from the way out, what the three strategies trade (metres and litres against steep ground), and how the map itself was made. Its numbers come from the same functions the simulation calls (moveTimeS, stepCost, oxygenLitres, the backwards Dijkstra), and unit tests check that section times add up to the route total, that each strategy's route is cheapest under its own formula, and that the shown speed formula matches the engine's.

**Q: Why is the walk back not just the walk out reversed in cost?**
A: Walking speed depends on the grade and its direction. Tobler's hiking function (an Earth model we borrow) is fastest on a gentle downhill of about 5 percent, slower uphill and slower on steep downhill. So a route that climbs on the way out is quicker coming home, and one that descends on the way out costs more coming home. That is why the return reserve is computed backwards from the base for every cell, not by doubling the outward trip.

**Q: What are the "more sources we can add"?**
A: Data portals the team noted for later: the NASA Open Data portal (datasets tagged mars), ISRO's ISSDC archive with Mars Orbiter Mission data and the VEDAS Mars Atlas, the USGS Astrogeology Science Center, the ASU Mars Space Flight Facility, and the Mars Climate Database (LMD, ESA, CNES). The app already uses a USGS elevation model and ASU THEMIS data; the others are listed only, and no number in the app comes from them yet.

