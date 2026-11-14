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

**Q: Why does the app give a verdict instead of just showing data?**
A: An astronaut needs a decision, not a layer stack. MarsWalk turns the route, the walk back from every cell and the oxygen reserve into GO, CAUTION or NO-GO, plus the minutes of science time left at the destination before the walk back must start. The thresholds are the reserve (a demo value), the 25 degree slope limit, and an 80% caution line, which is our display choice.
