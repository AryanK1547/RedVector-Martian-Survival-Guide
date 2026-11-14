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
