import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { walkDoseUgy, type Conditions } from "./conditions";

const conditions = JSON.parse(
  readFileSync(new URL("../public/data/conditions.json", import.meta.url), "utf8"),
) as Conditions;

it("has REMS and RAD values for both waypoint sols in plausible ranges", () => {
  expect(Object.keys(conditions.sols).sort()).toEqual(["4598", "4602"]);
  for (const s of Object.values(conditions.sols)) {
    expect(s.rems.ambient_temp_min_c).toBeLessThan(s.rems.ambient_temp_max_c);
    expect(s.rems.ambient_temp_min_c).toBeGreaterThan(-140);
    expect(s.rems.pressure_mean_pa).toBeGreaterThan(400);
    expect(s.rems.pressure_mean_pa).toBeLessThan(1200);
    expect(s.rad.dose_rate_b_silicon_ugy_per_day).toBeGreaterThan(50);
    expect(s.rad.dose_rate_b_silicon_ugy_per_day).toBeLessThan(1000);
  }
});

it("walk dose scales with time", () => {
  expect(walkDoseUgy(168, 86400)).toBeCloseTo(168, 10);
  expect(walkDoseUgy(168, 3600)).toBeCloseTo(7, 10);
});
