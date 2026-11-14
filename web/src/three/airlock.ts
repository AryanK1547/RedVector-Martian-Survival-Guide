import * as THREE from "three";
import type { Terrain } from "../data";
import { gridFromTerrain } from "../route/cost";
import { makeGrain } from "./stage3d";

// The start screen's 3D airlock: a procedural room (no model files) with a
// door that opens onto the REAL terrain outside: the local USGS DEM, draped
// with the CTX photo, turned to the most open view from the base (computed
// from the DEM skyline). The room, platform, ramp, lights, screens and mist
// are scenery; the dust colour on the greyscale CTX photo is illustrative.

export type AirlockPhase = "off" | "on" | "depress" | "open" | "exit";

export interface AirlockScene {
  setTerrain(t: Terrain, base: number, goal: number, imageUrl: string): void;
  setPhase(p: AirlockPhase): void;
  setPressure(kPa: number, note: string): void; // drawn on the screen above the door
  setUplink(pct: number, lines: string[]): void; // drawn on the side screen
  dispose(): void;
}

const W = 3.4; // room width, m
const HH = 2.8; // room height
const L = 5.6; // room length
const DOOR_W = 1.7;
const DOOR_H = 2.25;
const WALL_T = 0.32;
const EYE = 1.62;
const LIFT = 1.2; // the habitat stands on a platform; a ramp leads down to the ground (scenery)

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, repeat?: [number, number]) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.anisotropy = 4;
  return t;
}

export function createAirlockScene(container: HTMLElement): AirlockScene | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  const host = document.createElement("div");
  host.className = "st-3d";
  host.append(renderer.domElement);
  container.prepend(host);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T): T => (disposables.push(d), d);

  const scene = new THREE.Scene();
  const HORIZON = new THREE.Color(0xe2b78e);
  scene.fog = new THREE.Fog(HORIZON.clone(), 600, 4200);
  const camera = new THREE.PerspectiveCamera(66, 1, 0.05, 12000);
  camera.rotation.order = "YXZ";
  const camBase = new THREE.Vector3(0, EYE, 3.4);
  camera.position.copy(camBase);

  // ---- textures (drawn in code) ----
  const panelTex = track(
    canvasTex(512, 512, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, "#b4b8b6");
      grd.addColorStop(1, "#959a99");
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? "0,0,0" : "255,255,255"},${Math.random() * 0.04})`;
        g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 1 + Math.random() * 2);
      }
      g.strokeStyle = "rgba(40,44,48,0.55)";
      g.lineWidth = 3;
      for (const x of [0, w / 2]) g.strokeRect(x + 4, 4, w / 2 - 8, h - 8);
      g.strokeRect(10, h * 0.62, w - 20, 2);
      g.fillStyle = "rgba(40,44,48,0.6)";
      for (const x of [16, w / 2 - 16, w / 2 + 16, w - 16]) for (const y of [16, h / 2, h - 16]) g.beginPath(), g.arc(x, y, 3.5, 0, 6.3), g.fill();
      g.fillStyle = "rgba(60,64,70,0.75)";
      g.font = "bold 18px monospace";
      g.fillText("HAB-01", 30, h * 0.58);
      g.font = "12px monospace";
      g.fillText("PANEL 4C  DO NOT PAINT", w / 2 + 30, h * 0.58);
    }, [2, 1]),
  );
  const floorTex = track(
    canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = "#2a2e32";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 16)
        for (let x = (y / 16) % 2 ? 8 : 0; x < w; x += 16) {
          g.fillStyle = "rgba(255,255,255,0.10)";
          g.fillRect(x + 2, y + 2, 10, 3);
          g.fillStyle = "rgba(0,0,0,0.35)";
          g.fillRect(x + 2, y + 5, 10, 2);
        }
      g.strokeStyle = "rgba(0,0,0,0.6)";
      g.lineWidth = 3;
      g.strokeRect(0, 0, w, h);
    }, [4, 7]),
  );
  const hazardTex = track(
    canvasTex(256, 64, (g, w, h) => {
      g.fillStyle = "#16181a";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#f2c200";
      for (let x = -h; x < w + h; x += 40) {
        g.beginPath();
        g.moveTo(x, h);
        g.lineTo(x + 20, h);
        g.lineTo(x + 20 + h, 0);
        g.lineTo(x + h, 0);
        g.fill();
      }
    }),
  );
  hazardTex.wrapS = hazardTex.wrapT = THREE.RepeatWrapping;
  const doorTex = track(
    canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = "#8c9399";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(0,0,0,0.18)";
      for (let y = 40; y < h; y += 90) g.fillRect(14, y, w - 28, 4);
      g.fillStyle = "#f2c200";
      g.fillRect(0, h - 60, w, 22);
      g.fillStyle = "#16181a";
      g.font = "bold 22px monospace";
      g.fillText("EVA EGRESS", 40, h - 80);
      g.font = "bold 14px monospace";
      g.fillStyle = "rgba(20,20,20,0.75)";
      g.fillText("CHECK SUIT SEAL", 50, 200);
      g.fillText("BEFORE DEPRESS", 54, 220);
    }),
  );

  // ---- materials ----
  const wallMat = track(new THREE.MeshStandardMaterial({ map: panelTex, roughness: 0.62, metalness: 0.25 }));
  const floorMat = track(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.55, metalness: 0.6 }));
  const darkMat = track(new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.5, metalness: 0.5 }));
  const hazardMat = track(new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.5 }));
  const doorMat = track(new THREE.MeshStandardMaterial({ map: doorTex, roughness: 0.45, metalness: 0.55 }));
  const railMat = track(new THREE.MeshStandardMaterial({ color: 0xe8b400, roughness: 0.4, metalness: 0.3 }));
  const pipeMat = track(new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.35, metalness: 0.8 }));

  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat);
    m.position.set(x, y, z);
    scene.add(m);
    return m;
  };

  // ---- the room ----
  box(W, 0.1, L, floorMat, 0, -0.05, L / 2);
  box(W, 0.1, L, wallMat, 0, HH + 0.05, L / 2);
  box(0.1, HH, L, wallMat, -W / 2 - 0.05, HH / 2, L / 2);
  box(0.1, HH, L, wallMat, W / 2 + 0.05, HH / 2, L / 2);
  box(W, HH, 0.1, wallMat, 0, HH / 2, L + 0.05);
  // front wall with the doorway
  const sideW = (W - DOOR_W) / 2;
  box(sideW, HH, WALL_T, wallMat, -(DOOR_W / 2 + sideW / 2), HH / 2, -WALL_T / 2);
  box(sideW, HH, WALL_T, wallMat, DOOR_W / 2 + sideW / 2, HH / 2, -WALL_T / 2);
  box(DOOR_W, HH - DOOR_H, WALL_T, wallMat, 0, DOOR_H + (HH - DOOR_H) / 2, -WALL_T / 2);
  // striped frame
  const fr = 0.09;
  box(fr, DOOR_H, 0.06, hazardMat, -DOOR_W / 2 - fr / 2, DOOR_H / 2, 0.03);
  box(fr, DOOR_H, 0.06, hazardMat, DOOR_W / 2 + fr / 2, DOOR_H / 2, 0.03);
  box(DOOR_W + fr * 2, fr, 0.06, hazardMat, 0, DOOR_H + fr / 2, 0.03);
  box(DOOR_W + fr * 2, 0.04, 0.5, hazardMat, 0, 0.02, 0.1); // threshold
  {
    // platform outside the door and a ramp down to the ground
    box(DOOR_W + 0.6, 0.12, 1.4, floorMat, 0, -0.06, -WALL_T - 0.7);
    const rampLen = 5.2;
    const ramp = box(DOOR_W + 0.2, 0.1, rampLen, floorMat, 0, 0, 0);
    const ang = Math.asin(LIFT / rampLen);
    ramp.rotation.x = -ang;
    ramp.position.set(0, -LIFT / 2 - 0.05, -WALL_T - 1.4 - (rampLen * Math.cos(ang)) / 2);
    for (const sx of [-1, 1]) {
      const rail = box(0.05, 0.05, rampLen, railMat, sx * (DOOR_W / 2 + 0.1), 0.9, 0);
      rail.rotation.x = -ang;
      rail.position.set(sx * (DOOR_W / 2 + 0.1), -LIFT / 2 + 0.9, ramp.position.z);
    }
  }
  // door leaves: slide sideways into the wall
  const leafW = DOOR_W / 2;
  const leaves = [-1, 1].map((s) => {
    const g = new THREE.Group();
    const leaf = new THREE.Mesh(track(new THREE.BoxGeometry(leafW, DOOR_H, 0.12)), doorMat);
    g.add(leaf);
    const port = new THREE.Mesh(track(new THREE.CircleGeometry(0.16, 32)), track(new THREE.MeshStandardMaterial({ color: 0x1b1612, emissive: 0xffa860, emissiveIntensity: 0.35, roughness: 0.1, metalness: 0.9 })));
    port.position.set(-s * 0.08, 0.35, 0.062);
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.17, 0.025, 8, 32)), darkMat);
    ring.position.copy(port.position);
    g.add(port, ring);
    g.position.set((s * leafW) / 2, DOOR_H / 2, -WALL_T / 2);
    scene.add(g);
    return { g, s };
  });
  // handrails, pipes, lockers
  for (const s of [-1, 1]) {
    const rail = new THREE.Mesh(track(new THREE.CylinderGeometry(0.025, 0.025, L - 1.2, 10)), railMat);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(s * (W / 2 - 0.08), 1.08, L / 2 + 0.3);
    scene.add(rail);
    for (const z of [0.9, L - 0.3]) box(0.06, 0.06, 0.06, darkMat, s * (W / 2 - 0.04), 1.08, z);
    for (const [r, y] of [[0.05, HH - 0.1], [0.035, HH - 0.24]] as const) {
      const p = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, L + 0.3, 12)), pipeMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(s * (W / 2 - 0.12), y, L / 2);
      scene.add(p);
    }
    box(0.55, 1.9, 0.9, darkMat, s * (W / 2 - 0.3), 0.95, 4.6);
    box(0.02, 1.7, 0.02, pipeMat, s * (W / 2 - 0.58), 0.95, 4.62);
  }
  // ceiling light strips
  const stripMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfe9ff, emissiveIntensity: 1.2 }));
  for (const x of [-0.85, 0.85]) box(0.16, 0.03, L - 1.2, stripMat, x, HH - 0.02, L / 2 + 0.3);
  const lampA = new THREE.PointLight(0xdfe9ff, 8, 9, 1.6);
  lampA.position.set(0, HH - 0.3, 3.4);
  const lampB = new THREE.PointLight(0xdfe9ff, 5, 7, 1.6);
  lampB.position.set(0, HH - 0.3, 1.0);
  const ambient = new THREE.HemisphereLight(0xcfd9e6, 0x2a2420, 0.35);
  scene.add(lampA, lampB, ambient);
  // status lamp above the door and a rotating beacon
  const statusMat = track(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a2a, emissiveIntensity: 2 }));
  for (const sx of [-1, 1]) box(0.1, 0.1, 0.05, statusMat, sx * (DOOR_W / 2 + 0.32), 1.95, 0.03);
  const beaconMat = track(new THREE.MeshStandardMaterial({ color: 0x331a00, emissive: 0xff9a1a, emissiveIntensity: 0.2, transparent: true, opacity: 0.9 }));
  const beacon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 16)), beaconMat);
  beacon.position.set(W / 2 - 0.35, HH - 0.12, 0.5);
  scene.add(beacon);
  const beaconLight = new THREE.SpotLight(0xff8a1a, 0, 8, 0.5, 0.6, 1.2);
  beaconLight.position.copy(beacon.position);
  scene.add(beaconLight, beaconLight.target);

  // ---- screens: above the door (pressure) and on the right wall (uplink) ----
  const screen = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = Math.round((512 * h) / w);
    const tex = track(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = track(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), mat);
    return { c, tex, mesh, g: c.getContext("2d")! };
  };
  const pScreen = screen(1.0, 0.32);
  pScreen.mesh.position.set(0, DOOR_H + 0.27, 0.045);
  scene.add(pScreen.mesh);
  box(1.06, 0.38, 0.04, darkMat, 0, DOOR_H + 0.27, 0.02);
  const uScreen = screen(0.9, 0.62);
  uScreen.mesh.position.set(W / 2 - 0.035, 1.55, 1.9);
  uScreen.mesh.rotation.y = -Math.PI / 2;
  scene.add(uScreen.mesh);
  box(0.03, 0.68, 0.96, darkMat, W / 2 - 0.0, 1.55, 1.9);
  let pressure = { kPa: 101.3, note: "" };
  let uplink = { pct: 0, lines: [] as string[] };
  let warn = false;
  const drawScreens = () => {
    {
      const { g, c } = pScreen;
      g.fillStyle = "#03080c";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = warn ? "#ffb347" : "#7ee2a8";
      g.font = "bold 26px monospace";
      g.fillText("AIRLOCK PRESSURE", 18, 38);
      g.font = "bold 64px monospace";
      g.fillText(`${pressure.kPa >= 10 ? pressure.kPa.toFixed(1) : pressure.kPa.toFixed(2)} kPa`, 18, 112);
      g.font = "18px monospace";
      g.fillStyle = "rgba(200,230,245,0.75)";
      g.fillText(pressure.note, 18, 146);
      const frac = Math.max(0, Math.min(1, pressure.kPa / 101.3));
      g.fillStyle = "rgba(255,255,255,0.1)";
      g.fillRect(18, 156, c.width - 36, 10);
      g.fillStyle = warn ? "#ffb347" : "#7ee2a8";
      g.fillRect(18, 156, (c.width - 36) * frac, 10);
      pScreen.tex.needsUpdate = true;
    }
    {
      const { g, c } = uScreen;
      g.fillStyle = "#03080c";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#9fd6f2";
      g.font = "bold 24px monospace";
      g.fillText(`MISSION UPLINK  ${Math.round(uplink.pct)}%`, 16, 36);
      g.fillStyle = "rgba(255,255,255,0.1)";
      g.fillRect(16, 48, c.width - 32, 8);
      g.fillStyle = "#7ee2a8";
      g.fillRect(16, 48, ((c.width - 32) * uplink.pct) / 100, 8);
      g.font = "17px monospace";
      uplink.lines.slice(-12).forEach((l, i) => {
        g.fillStyle = l.startsWith("!") ? "#ff7b7b" : l.startsWith("+") ? "#7ee2a8" : "rgba(200,230,245,0.8)";
        g.fillText(l.replace(/^[!+]/, "").slice(0, 40), 16, 86 + i * 25);
      });
      uScreen.tex.needsUpdate = true;
    }
  };
  drawScreens();

  // ---- outside: sky, then the real terrain once the uplink delivers it ----
  const sunDir = new THREE.Vector3(-0.35, 0.42, -0.84).normalize();
  const sky = new THREE.Mesh(
    track(new THREE.SphereGeometry(9000, 24, 16)),
    track(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { top: { value: new THREE.Color(0x8e6652) }, horizon: { value: HORIZON.clone() }, sunDir: { value: sunDir } },
        vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader: `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir;
          void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(horizon, top, pow(h, 0.5));
            float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
            c += vec3(1.0, 0.93, 0.78) * (pow(s, 1200.0) * 4.0 + pow(s, 40.0) * 0.32);
            gl_FragColor = vec4(c, 1.0); }`,
      }),
    ),
  );
  sky.renderOrder = -10;
  scene.add(sky);
  // plain ground until the DEM arrives
  const ground = new THREE.Mesh(track(new THREE.PlaneGeometry(9000, 9000)), track(new THREE.MeshBasicMaterial({ color: 0x8a6448 })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.4;
  scene.add(ground);
  const outside = new THREE.Group();
  scene.add(outside);

  // light pouring in when the door opens
  const flood = new THREE.SpotLight(0xffd7a8, 0, 14, 0.75, 0.7, 1.1);
  flood.position.set(0, 3.2, -3.5);
  flood.target.position.set(0, 0, 3.5);
  scene.add(flood, flood.target);
  const shaftTex = track(
    canvasTex(64, 256, (g, w, h) => {
      const grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, "rgba(255,226,180,0.9)");
      grd.addColorStop(1, "rgba(255,226,180,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }),
  );
  const shaftMat = track(new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const shaft = new THREE.Mesh(track(new THREE.PlaneGeometry(DOOR_W, 3.4)), shaftMat);
  shaft.rotation.x = -Math.PI / 2;
  shaft.position.set(0, 0.012, 1.7);
  scene.add(shaft);

  // ---- particles: dust motes in the room, mist from the vents while depressurising ----
  const speck = track(
    canvasTex(32, 32, (g) => {
      const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 32, 32);
    }),
  );
  const MOTES = 180;
  const moteGeo = track(new THREE.BufferGeometry());
  const moteP = new Float32Array(MOTES * 3);
  for (let i = 0; i < MOTES; i++) moteP.set([(Math.random() - 0.5) * W, Math.random() * HH, Math.random() * L], i * 3);
  moteGeo.setAttribute("position", new THREE.BufferAttribute(moteP, 3));
  const moteMat = track(new THREE.PointsMaterial({ size: 0.012, map: speck, transparent: true, opacity: 0.5, depthWrite: false, color: 0xfff2dc }));
  scene.add(new THREE.Points(moteGeo, moteMat));
  const MIST = 260;
  const mistGeo = track(new THREE.BufferGeometry());
  const mistP = new Float32Array(MIST * 3);
  const mistV = new Float32Array(MIST * 3);
  const mistLife = new Float32Array(MIST).fill(-1);
  mistGeo.setAttribute("position", new THREE.BufferAttribute(mistP, 3));
  const mistMat = track(new THREE.PointsMaterial({ size: 0.22, map: speck, transparent: true, opacity: 0, depthWrite: false, color: 0xe8f2ff }));
  const mist = new THREE.Points(mistGeo, mistMat);
  mist.frustumCulled = false;
  scene.add(mist);
  const vents = [new THREE.Vector3(-1.2, HH - 0.05, 1.2), new THREE.Vector3(1.2, HH - 0.05, 1.2), new THREE.Vector3(0, HH - 0.05, 3.0)];
  for (const v of vents) box(0.4, 0.02, 0.25, darkMat, v.x, HH - 0.01, v.z);

  // ---- state & animation ----
  let phase: AirlockPhase = "off";
  let phaseT = 0;
  let doorOpen = 0; // 0 closed .. 1 open
  let lookX = 0;
  let lookY = 0;
  const onMove = (e: PointerEvent) => {
    lookX = (e.clientX / window.innerWidth - 0.5) * 2;
    lookY = (e.clientY / window.innerHeight - 0.5) * 2;
  };
  window.addEventListener("pointermove", onMove);

  const resize = () => {
    const w = Math.max(2, host.clientWidth);
    const h = Math.max(2, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let alive = true;
  let last = performance.now();
  let t = 0;
  const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const loop = () => {
    if (!alive) return;
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    phaseT += dt;

    // lights per phase
    const on = phase !== "off";
    const depress = phase === "depress";
    const pulse = depress ? 0.55 + 0.45 * Math.sin(t * 6) : 1;
    const base = on ? 1 : 0.18;
    lampA.intensity = THREE.MathUtils.lerp(lampA.intensity, 8 * base * (depress ? 0.55 : 1), 0.08);
    lampB.intensity = THREE.MathUtils.lerp(lampB.intensity, 5 * base * (depress ? 0.45 : 1), 0.08);
    lampA.color.lerp(new THREE.Color(depress ? 0xff9a7a : 0xdfe9ff), 0.05);
    stripMat.emissiveIntensity = THREE.MathUtils.lerp(stripMat.emissiveIntensity, on ? (depress ? 0.5 * pulse : 1.2) : 0.15, 0.1);
    beaconMat.emissiveIntensity = depress || phase === "open" ? 2.5 * (0.5 + 0.5 * Math.sin(t * 8)) : 0.2;
    beaconLight.intensity = depress ? 14 : 0;
    beaconLight.target.position.set(beacon.position.x + Math.cos(t * 4) * 3, 0.5, beacon.position.z + Math.sin(t * 4) * 3);
    statusMat.emissive.set(phase === "open" || phase === "exit" ? 0x3ddc84 : depress ? 0xffa21a : 0xff2a2a);
    statusMat.emissiveIntensity = depress ? 1 + Math.sin(t * 10) : 2;

    // the door
    const target = phase === "open" || phase === "exit" ? 1 : 0;
    doorOpen += (target - doorOpen) * Math.min(1, dt * 1.4);
    const d = ease(Math.min(1, doorOpen * 1.05));
    for (const l of leaves) l.g.position.x = (l.s * leafW) / 2 + l.s * leafW * 1.02 * d;
    flood.intensity = 60 * d;
    shaftMat.opacity = 0.32 * d;
    moteMat.opacity = 0.35 + 0.5 * d;

    // motes drift
    for (let i = 0; i < MOTES; i++) {
      moteP[i * 3] += Math.sin(t * 0.3 + i) * 0.0008;
      moteP[i * 3 + 1] += 0.0006 * Math.sin(t * 0.21 + i * 1.7) + (phase === "open" ? 0.0015 : 0);
      if (moteP[i * 3 + 1] > HH) moteP[i * 3 + 1] = 0.05;
    }
    moteGeo.attributes.position.needsUpdate = true;
    // vent mist (condensation as the pressure drops)
    mistMat.opacity = THREE.MathUtils.lerp(mistMat.opacity, depress ? 0.28 : 0, 0.05);
    for (let i = 0; i < MIST; i++) {
      if (mistLife[i] <= 0) {
        if (!depress || Math.random() > 0.25) continue;
        const v = vents[i % vents.length];
        mistP.set([v.x + (Math.random() - 0.5) * 0.3, v.y, v.z + (Math.random() - 0.5) * 0.2], i * 3);
        mistV.set([(Math.random() - 0.5) * 0.5, -0.6 - Math.random() * 0.8, -0.3 - Math.random() * 0.6], i * 3);
        mistLife[i] = 1.5 + Math.random();
      }
      mistLife[i] -= dt;
      for (let a = 0; a < 3; a++) mistP[i * 3 + a] += mistV[i * 3 + a] * dt;
      mistV[i * 3] *= 0.99;
      mistV[i * 3 + 1] *= 0.97;
      if (mistLife[i] <= 0) mistP[i * 3 + 1] = -50;
    }
    mistGeo.attributes.position.needsUpdate = true;

    // camera: breathing bob, a little look toward the pointer, and the walk out
    let z = camBase.z;
    let y = camBase.y + Math.sin(t * 1.5) * 0.008;
    let pitch = -0.02 - lookY * 0.06;
    if (phase === "exit") {
      const k = ease(Math.min(1, phaseT / 2.6));
      z = THREE.MathUtils.lerp(camBase.z, -4.5, k);
      y += Math.sin(phaseT * 7) * 0.025 * (1 - k * 0.5); // footsteps
      pitch -= 0.06 * k;
    }
    camera.position.set(Math.sin(t * 0.4) * 0.02, y, z);
    camera.rotation.set(pitch, -lookX * 0.1, Math.sin(t * 0.5) * 0.004);
    renderer.render(scene, camera);
  };
  requestAnimationFrame(loop);

  return {
    setTerrain(terrain, baseCell, goalCell, imageUrl) {
      const grid = gridFromTerrain(terrain);
      const cols = terrain.cols;
      const rows = terrain.rows;
      const dxM = grid.dx.reduce((a, b) => a + b, 0) / grid.dx.length;
      const dyM = grid.dy;
      const br = Math.floor(baseCell / cols);
      const bc = baseCell % cols;
      const gr = Math.floor(goalCell / cols);
      const gc = goalCell % cols;
      const ref = terrain.elevation[baseCell];
      // every second cell is plenty for the view through a door
      const S = 2;
      const nc = Math.floor((cols - 1) / S) + 1;
      const nr = Math.floor((rows - 1) / S) + 1;
      const pos = new Float32Array(nr * nc * 3);
      const uv = new Float32Array(nr * nc * 2);
      for (let r = 0; r < nr; r++)
        for (let c = 0; c < nc; c++) {
          const i = r * nc + c;
          const R = r * S;
          const C = c * S;
          pos[i * 3] = (C - bc) * dxM;
          pos[i * 3 + 1] = terrain.elevation[R * cols + C] - ref - 0.25;
          pos[i * 3 + 2] = (R - br) * dyM;
          uv[i * 2] = C / (cols - 1);
          uv[i * 2 + 1] = 1 - R / (rows - 1);
        }
      const idx = new Uint32Array((nr - 1) * (nc - 1) * 6);
      let k = 0;
      for (let r = 0; r < nr - 1; r++)
        for (let c = 0; c < nc - 1; c++) {
          const a = r * nc + c;
          idx.set([a, a + nc, a + 1, a + 1, a + nc, a + nc + 1], k);
          k += 6;
        }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      // The CTX photo already carries the real light and shadow; add only a soft
      // slope shade (vertex colours), unlit, so the room's lamps do not touch it.
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      const col = new Float32Array(nr * nc * 3);
      for (let i = 0; i < nr * nc; i++) {
        const sh = 0.5 + 0.75 * Math.max(0, nrm.getX(i) * sunDir.x + nrm.getY(i) * sunDir.y + nrm.getZ(i) * sunDir.z);
        col.set([sh * 1.0, sh * 0.74, sh * 0.56], i * 3); // CTX is greyscale: tint it the colour of Martian dust (illustrative)
      }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      const mat = track(new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }));
      // fine surface grain, as in the walk (visual detail only)
      const grain = track(makeGrain());
      mat.onBeforeCompile = (sh) => {
        sh.uniforms.grain = { value: grain };
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform sampler2D grain;")
          .replace(
            "#include <map_fragment>",
            `#include <map_fragment>
             #ifdef USE_MAP
             float g1 = texture2D(grain, vMapUv * 60.0).r;
             float g2 = texture2D(grain, vMapUv * 520.0).r;
             diffuseColor.rgb *= 0.62 + 0.76 * (0.55 * g1 + 0.45 * g2);
             #endif`,
          );
      };
      const mesh = new THREE.Mesh(geo, mat);
      outside.add(mesh);
      // Turn the land so the door frames the most open view: for 24 headings,
      // find how high the real terrain rises above eye level within 2.5 km, and
      // pick the lowest skyline, preferring headings near the destination.
      const goalAng = Math.atan2((gc - bc) * dxM, (gr - br) * dyM);
      const eye = ref + LIFT + EYE - 0.25;
      let best = { ang: goalAng, score: Infinity };
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        let maxEl = -Infinity;
        for (let d = 30; d <= 2500; d += 20) {
          const c = Math.round(bc + (Math.sin(a) * d) / dxM);
          const r = Math.round(br + (Math.cos(a) * d) / dyM);
          if (c < 0 || r < 0 || c >= cols || r >= rows) break;
          maxEl = Math.max(maxEl, Math.atan2(terrain.elevation[r * cols + c] - eye, d));
        }
        const off = Math.abs(Math.atan2(Math.sin(a - goalAng), Math.cos(a - goalAng)));
        const score = (maxEl * 180) / Math.PI + off * 1.5; // degrees of skyline, plus a little for turning away
        if (score < best.score) best = { ang: a, score };
      }
      outside.rotation.y = Math.PI - best.ang;
      outside.position.set(0, -LIFT, -WALL_T - 0.2);
      // a faint light pillar marks the destination
      const gx = (gc - bc) * dxM;
      const gz = (gr - br) * dyM;
      const pillar = new THREE.Mesh(track(new THREE.CylinderGeometry(1.4, 1.4, 160, 12, 1, true)), track(new THREE.MeshBasicMaterial({ color: 0x8fe3ff, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })));
      pillar.position.set(gx, terrain.elevation[goalCell] - ref + 80, gz);
      outside.add(pillar);
      ground.visible = false;
      new THREE.TextureLoader().load(imageUrl, (tex) => {
        if (!alive) return tex.dispose();
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        track(tex);
        mat.map = tex;
        mat.needsUpdate = true;
      }, undefined, () => mat.color.set(0xa07a60));
    },
    setPhase(p) {
      if (p !== phase) phaseT = 0;
      phase = p;
      warn = p === "depress";
      drawScreens();
    },
    setPressure(kPa, note) {
      pressure = { kPa, note };
      drawScreens();
    },
    setUplink(pct, lines) {
      uplink = { pct, lines };
      drawScreens();
    },
    dispose() {
      alive = false;
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.forceContextLoss(); // give the GPU context back now; browsers cap how many can be alive
      host.remove();
    },
  };
}
