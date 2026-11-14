// MODEL ASSUMPTIONS, not NASA mission values. Chosen by the lead on 14 Nov from
// sources found by web search (summaries only, full documents NOT yet read).

// Flat-ground walking speed. NASA ICES 2026 Mars suit mass presentation gives
// the Apollo nominal MAXIMUM walking speed as about 2.2 mph (3.5 km/h); we use a
// slower 2.5 km/h because an average is below the maximum.
export const FLAT_SPEED_KMH = 2.5;

// Average metabolic rate during Apollo lunar EVAs, from a NASA report: 234 kcal/h.
// Held constant, so energy = rate x time (slower uphill walking costs more).
export const METABOLIC_KCAL_PER_H = 234;

// Textbook physiology: burning food releases about 4.8 kcal per litre of oxygen used.
export const KCAL_PER_LITRE_O2 = 4.8;

// Tobler's hiking function (W. Tobler, 1993; an EARTH hiking model):
// speed = 6 * exp(-3.5 * |grade + 0.05|) km/h, fastest on a gentle downhill.
// We keep its shape and scale it so flat ground gives FLAT_SPEED_KMH.
// grade = rise / run (positive uphill).
export function walkingSpeedKmh(grade: number): number {
  const tobler = (s: number) => 6 * Math.exp(-3.5 * Math.abs(s + 0.05));
  return (FLAT_SPEED_KMH * tobler(grade)) / tobler(0);
}
