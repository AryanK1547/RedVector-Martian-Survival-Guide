import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Meta } from "./data";

// MapLibre stretches the image linearly in Web Mercator y, but our PNG rows are
// linear in latitude. Measure the worst row offset this causes, in image rows.
it("mercator stretch error is under one image row", () => {
  const meta = JSON.parse(readFileSync(new URL("../public/data/meta.json", import.meta.url), "utf8")) as Meta;
  const { lat_top, lat_bottom, rows } = meta.crop;
  const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const lat = lat_top + ((lat_bottom - lat_top) * i) / 100;
    const shown = ((mercY(lat_top) - mercY(lat)) / (mercY(lat_top) - mercY(lat_bottom))) * rows;
    const real = ((lat_top - lat) / (lat_top - lat_bottom)) * rows;
    worst = Math.max(worst, Math.abs(shown - real));
  }
  console.log(`worst offset ${worst.toFixed(4)} rows`);
  expect(worst).toBeLessThan(1);
});
