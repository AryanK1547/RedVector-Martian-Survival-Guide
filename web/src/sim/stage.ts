// The seam between the simulation logic (engine.ts + view.ts: decisions, HUD,
// find planner) and what draws the world. Two stages implement it: the MapLibre
// map (stage2d.ts) and the Three.js scene (three/stage3d.ts). Everything here
// speaks in grid cell indices, so neither stage needs the other's coordinates.

// Where the astronaut is: between cell `from` and cell `to`, `frac` of the way.
export interface StagePos {
  from: number;
  to: number;
  frac: number;
}

export interface StageLine {
  id: string; // "continue" | "inspect" | "inspect-return" | "return"
  cells: number[];
}

export interface StagePick {
  cell: number;
  distM: number; // how far the click was moved to reach walkable ground
}

// A teaching line: one section of the route, or one of the three strategy routes.
export interface StageOverlay {
  cells: number[];
  colour: string; // CSS colour
  width?: number;
}

// A mission marker on the ground: a route waypoint the user added, or a task checkpoint.
export interface StageMarker {
  cell: number;
  label: string;
  kind: "via" | "task";
  done: boolean;
}

export interface Stage {
  readonly kind: "map" | "3d";
  readonly speeds: number[]; // mission-clock speed-ups offered to the user
  readonly defaultSpeed: number;
  setHazard(blocked: Uint8Array): void; // ground blocked by a rockfall
  setOptions(lines: StageLine[]): void; // candidate routes for a decision; [] clears
  setTrail(cells: number[], pos: StagePos): void; // where the astronaut has been
  setAhead(cells: number[], pos: StagePos): void; // the route still to walk; [] clears
  setPosition(pos: StagePos, o: { follow: boolean; done: boolean; phase: string }): void;
  setFind(f: { cell: number; state: string } | null): void;
  setDust(on: boolean): void;
  setMarkers(list: StageMarker[]): void; // waypoints and task checkpoints; [] clears
  setOverlay(lines: StageOverlay[]): void; // teaching lines from the Educational view; [] clears
  // Wait for one click on the ground. cb(null) = outside the map or no walkable ground nearby.
  pick(cb: (hit: StagePick | null) => void): () => void;
  dispose(): void;
}

// Who is talking on the radio: the habitat's capsule communicator (live, no
// delay), the science officer, Earth (minutes of light-time away), or the suit computer.
export type Speaker = "capcom" | "science" | "earth" | "suit";

// Sound and voice, if the stage has any. Optional so the 2D map stays silent.
export interface SimAudio {
  setState(s: { exertion: number; dust: number; leak: boolean; level: "ok" | "caution" | "turn-back"; active: boolean }): void;
  radio(text: string, urgent?: boolean, who?: Speaker): void;
  chime(): void;
  alert(): void; // a decision needs an answer
  tick(secondsLeft: number): void; // one tick of the decision countdown
  taskDone(): void; // a mission task was completed
  dispose(): void;
}
