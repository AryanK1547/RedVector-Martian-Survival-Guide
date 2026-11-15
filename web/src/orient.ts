// Phones: the planner, the airlock and the 3D walk are laid out for a wide screen.
// In portrait on a touch device we show a "turn your phone" gate and, where the
// browser allows it, lock the screen to landscape. Android Chrome only honours
// the lock in fullscreen (so the gate button asks for both); iOS Safari has no
// orientation lock, so there the gate relies on the person turning the phone.
// Everything here is best-effort and never blocks the app: "Continue anyway"
// is always offered (people with rotation lock on need it).

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };

const tryLandscape = async () => {
  const so = screen.orientation as LockableOrientation | undefined;
  if (!so?.lock) return;
  try {
    await so.lock("landscape");
  } catch {
    // not allowed outside fullscreen, or unsupported: the gate text covers it
  }
};

export function setupOrientationGate() {
  if (document.getElementById("rotate-gate")) return;
  const gate = document.createElement("div");
  gate.id = "rotate-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-label", "Turn your phone sideways");
  gate.innerHTML = `
    <div class="rg-card">
      <div class="rg-phone" aria-hidden="true"><i></i></div>
      <b>TURN YOUR PHONE SIDEWAYS</b>
      <p>MarsWalk is a mission-control screen: the map, the suit display and the 3D walk need the width of a landscape screen.</p>
      <button id="rg-go" class="primary">Go landscape &amp; fullscreen</button>
      <small>If nothing turns, switch off your phone's rotation lock and tilt it.</small>
      <button id="rg-skip" class="link">Continue in portrait anyway</button>
    </div>`;
  document.body.append(gate);

  gate.querySelector<HTMLButtonElement>("#rg-go")!.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    } catch {
      // fullscreen refused (iOS Safari): fall through to the lock attempt / the text
    }
    await tryLandscape();
  });
  gate.querySelector<HTMLButtonElement>("#rg-skip")!.addEventListener("click", () => document.documentElement.classList.add("rg-skip"));

  // If the browser already lets us lock (installed web app), do it quietly.
  void tryLandscape();
}
