// A landscape phone is about 390 px tall and 800 px wide. The plan card, the
// dashboard card and the elevation strip together cover most of the map, so the
// journey itself is hidden. Here each panel gets a small on/off chip, and the
// callers re-fit the route into whatever space is left.
//
// This only adds classes (ph-hide-left / -right / -bottom / -hud) on #app. The
// CSS that reacts to them is in mobile.css, inside the landscape-phone block.

export const isPhoneLandscape = () => window.matchMedia("(orientation: landscape) and (max-height: 520px)").matches;

type Panel = "left" | "right" | "bottom" | "hud";

const CHIPS: { panel: Panel; label: string }[] = [
  { panel: "left", label: "Plan" },
  { panel: "right", label: "Dashboard" },
  { panel: "bottom", label: "Elevation" },
  { panel: "hud", label: "Suit" },
];

// How much room (px) each side panel takes on a landscape phone; the same numbers as mobile.css.
export function panelInsets(app: HTMLElement): { left: number; right: number; bottom: number } {
  const narrow = window.matchMedia("(max-width: 740px)").matches;
  const shown = (p: Panel) => !app.classList.contains(`ph-hide-${p}`);
  return {
    left: shown("left") ? (narrow ? 216 : 252) : 16,
    right: shown("right") ? (narrow ? 242 : 278) : 16,
    bottom: shown("bottom") && app.classList.contains("has-route") ? 74 : 16,
  };
}

// Adds the chips to the app; returns a clean-up function. onChange runs after any panel is shown or hidden.
export function setupPhonePanels(app: HTMLElement, onChange: () => void): () => void {
  const bar = document.createElement("div");
  bar.id = "ph-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Show or hide panels");
  bar.innerHTML = CHIPS.map((c) => `<button type="button" id="ph-${c.panel}" aria-pressed="true">${c.label}</button>`).join("");
  app.append(bar);

  const sync = (p: Panel) => bar.querySelector(`#ph-${p}`)!.setAttribute("aria-pressed", String(!app.classList.contains(`ph-hide-${p}`)));
  const setHidden = (p: Panel, hidden: boolean) => {
    app.classList.toggle(`ph-hide-${p}`, hidden);
    sync(p);
  };
  const changed = () => {
    // The elevation strip and the 3D view measure their own size, so tell them the room changed.
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
      onChange();
    });
  };
  bar.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[id^='ph-']");
    if (!b) return;
    const p = b.id.slice(3) as Panel;
    setHidden(p, !app.classList.contains(`ph-hide-${p}`));
    changed();
  });

  // Sensible defaults when the screen changes: once a route exists the journey needs room (fold the plan card),
  // and the right-hand card is called "Mission control" during the live simulation.
  const dash = bar.querySelector<HTMLElement>("#ph-right")!;
  let hadRoute = false;
  let hadSim = false;
  const watch = new MutationObserver(() => {
    const route = app.classList.contains("has-route");
    const sim = app.classList.contains("sim-mode");
    if (route && !hadRoute) setHidden("left", true);
    if (!route && hadRoute) setHidden("left", false);
    // The live walk is the journey: start with the elevation strip folded away (its chip brings it back).
    if (sim && !hadSim) setHidden("bottom", true);
    if (!sim && hadSim) {
      setHidden("hud", false);
      setHidden("bottom", false);
    }
    dash.textContent = sim ? "Mission ctrl" : "Dashboard";
    const moved = route !== hadRoute || sim !== hadSim;
    hadRoute = route;
    hadSim = sim;
    if (moved) changed();
  });
  watch.observe(app, { attributes: true, attributeFilter: ["class"] });

  return () => {
    watch.disconnect();
    bar.remove();
  };
}
