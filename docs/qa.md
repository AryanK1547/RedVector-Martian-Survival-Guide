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
