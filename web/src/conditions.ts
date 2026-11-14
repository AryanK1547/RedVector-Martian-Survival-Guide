// Measured conditions from web/public/data/conditions.json (tools/prepare_conditions.py):
// REMS weather and RAD radiation recorded by Curiosity on the waypoint sols.
export interface SolConditions {
  rems: { ambient_temp_min_c: number; ambient_temp_max_c: number; pressure_mean_pa: number };
  rad: { dose_rate_b_silicon_ugy_per_day: number; dose_rate_e_plastic_ugy_per_day: number };
}

export interface Conditions {
  note: string;
  sols: Record<string, SolConditions>;
}

export async function loadConditions(url = "data/conditions.json"): Promise<Conditions> {
  return (await fetch(url)).json() as Promise<Conditions>;
}

// Dose absorbed in RAD's silicon detector over a walk, at the measured rate.
// An estimate for planning context: not a body dose, and it ignores suit shielding.
export function walkDoseUgy(doseRatePerDay: number, walkSeconds: number): number {
  return (doseRatePerDay * walkSeconds) / 86400;
}

export function renderConditions(el: HTMLElement, c: Conditions): void {
  const rows = Object.entries(c.sols)
    .map(
      ([sol, s]) => `<tr><td>Sol ${sol}</td><td>${s.rems.ambient_temp_min_c} to ${s.rems.ambient_temp_max_c} &deg;C</td>
        <td>${Math.round(s.rems.pressure_mean_pa)} Pa</td><td>${s.rad.dose_rate_b_silicon_ugy_per_day} &micro;Gy/day</td></tr>`,
    )
    .join("");
  el.innerHTML = `<details><summary>Measured conditions (Curiosity, July 2025)</summary>
    <table><tr><th></th><th>Air temp</th><th>Pressure</th><th>Radiation</th></tr>${rows}</table>
    <p class="note">REMS weather (MODRDR) and RAD dose rate in its silicon detector, measured at the rover on the sols it was at the
    boxwork waypoints. Historical context only, not a forecast. Source: NASA PDS Atmospheres and PPI nodes.</p></details>`;
}
