import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { SuitAudio } from "../audio";
import type { Terrain } from "../data";
import { gridFromTerrain } from "../route/cost";
import { nearestPassable } from "../route/snap";
import { rng } from "../sim/engine";
import type { Stage, StageLine, StagePick, StagePos } from "../sim/stage";

// The 3D world. Geometry: one vertex per DEM cell (10 m), so the ground you
// walk on IS the measured elevation model, drawn at true vertical scale. The
// CTX photo is draped on it. Rocks and the fine surface grain are VISUAL
// ENHANCEMENT ONLY: they are not measured terrain (the DEM cannot resolve
// anything smaller than 10 m). The sun direction and sky colours are chosen
// for looks, not computed for a real Mars date and place.

export interface Stage3DOptions {
  container: HTMLElement;
  terrain: Terrain;
  base: number;
  goal: number;
  objectiveName: string;
  imageUrl: string; // CTX photo of the same area
  audio: SuitAudio | null;
  initialMode?: Mode; // astronaut role starts in first person, mission control in the overview
}

export interface Stage3D extends Stage {
  ready: Promise<void>;
}

export type Mode = "fp" | "chase" | "orbit";
const LINE_COLOURS: Record<string, number> = { continue: 0xffd23f, inspect: 0x3ddc84, "inspect-return": 0xb388ff, return: 0x39c6ff };
const FIND_COLOURS: Record<string, number> = { armed: 0xb388ff, found: 0xffd23f, detour: 0xffd23f, inspecting: 0xffd23f, done: 0x3ddc84, skipped: 0x8b93a0 };
const EYE_HEIGHT = 1.62; // metres above the ground
const WALKING = new Set(["outbound", "inbound", "detour"]);

export function createStage3D(o: Stage3DOptions): Stage3D {
  const { terrain, container } = o;
  const grid = gridFromTerrain(terrain);
  const cols = terrain.cols;
  const rows = terrain.rows;
  const dxM = grid.dx.reduce((a, b) => a + b, 0) / grid.dx.length;
  const dyM = grid.dy;
  const ref = terrain.elevation[o.base];
  const H = Float32Array.from(terrain.elevation, (e) => e - ref); // metres relative to the base

  // ---- grid <-> world ----
  const X = (c: number) => (c - (cols - 1) / 2) * dxM;
  const Z = (r: number) => (r - (rows - 1) / 2) * dyM;
  const cellX = (i: number) => X(i % cols);
  const cellZ = (i: number) => Z(Math.floor(i / cols));
  // Same triangle split as the mesh below, so things lie exactly on the surface.
  const heightAt = (x: number, z: number) => {
    const gc = Math.min(cols - 1.0001, Math.max(0, x / dxM + (cols - 1) / 2));
    const gr = Math.min(rows - 1.0001, Math.max(0, z / dyM + (rows - 1) / 2));
    const c0 = Math.floor(gc);
    const r0 = Math.floor(gr);
    const u = gc - c0;
    const v = gr - r0;
    const ha = H[r0 * cols + c0];
    const hb = H[r0 * cols + c0 + 1];
    const hc = H[(r0 + 1) * cols + c0];
    const hd = H[(r0 + 1) * cols + c0 + 1];
    return u + v <= 1 ? ha + u * (hb - ha) + v * (hc - ha) : hd + (1 - u) * (hc - hd) + (1 - v) * (hb - hd);
  };

  // ---- renderer, scene ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const root = document.createElement("div");
  root.className = "sim3d";
  root.append(renderer.domElement);
  container.prepend(root);

  const scene = new THREE.Scene();
  const HORIZON = new THREE.Color(0xe2b78e);
  const DUST = new THREE.Color(0xb98660);
  scene.fog = new THREE.Fog(HORIZON.clone(), 700, 4800);
  const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 12000);
  camera.rotation.order = "YXZ";

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(d: T): T => (disposables.push(d), d);

  // ---- lights: low sun with shadows that follow the astronaut ----
  const az = (250 * Math.PI) / 180;
  const el = (30 * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
  const hemi = new THREE.HemisphereLight(0xe6c3a4, 0x5b3a2b, 0.75);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -110, right: 110, top: 110, bottom: -110, near: 1, far: 900 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.35;
  scene.add(hemi, sun, sun.target);

  // ---- sky ----
  const skyMat = track(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x8e6652) },
        horizon: { value: HORIZON.clone() },
        dustCol: { value: DUST.clone() },
        sunDir: { value: sunDir },
        dust: { value: 0 },
      },
      vertexShader: "varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 dustCol; uniform vec3 sunDir; uniform float dust;
        void main(){
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 c = mix(horizon, top, pow(h, 0.5));
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          c += vec3(1.0, 0.93, 0.78) * (pow(s, 1200.0) * 4.0 + pow(s, 40.0) * 0.32);
          c = mix(c, dustCol, dust * 0.9);
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  const sky = new THREE.Mesh(track(new THREE.SphereGeometry(9000, 24, 16)), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);

  // ---- terrain ----
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      pos[i * 3] = X(c);
      pos[i * 3 + 1] = H[i];
      pos[i * 3 + 2] = Z(r);
      uv[i * 2] = c / (cols - 1);
      uv[i * 2 + 1] = 1 - r / (rows - 1);
    }
  }
  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      idx.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], k);
      k += 6;
    }
  }
  const tGeo = track(new THREE.BufferGeometry());
  tGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  tGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  tGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  tGeo.computeVertexNormals();

  // Fine surface grain: a tiling noise texture multiplied into the photo. Visual only.
  const grain = track(makeGrain());
  const tMat = track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
  tMat.onBeforeCompile = (sh) => {
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
  const terrainMesh = new THREE.Mesh(tGeo, tMat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  const ready = new Promise<void>((resolve) => {
    new THREE.TextureLoader().load(
      o.imageUrl,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        track(tex);
        tMat.map = tex;
        tMat.needsUpdate = true;
        resolve();
      },
      undefined,
      () => {
        tMat.color.set(0xa07a60); // no photo: plain rock colour, still lit and shadowed
        resolve();
      },
    );
  });

  // ---- scattered rocks (visual only) ----
  {
    const rand = rng(20251115);
    const N = 2600;
    const rockGeo = track(new THREE.IcosahedronGeometry(1, 0));
    const rocks = new THREE.InstancedMesh(rockGeo, track(new THREE.MeshLambertMaterial({ color: 0xffffff })), N);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const col = new THREE.Color();
    let placed = 0;
    for (let tries = 0; tries < N * 6 && placed < N; tries++) {
      const r = Math.floor(rand() * (rows - 2));
      const c = Math.floor(rand() * (cols - 2));
      const slope = terrain.slopeDeg[r * cols + c];
      if (rand() > 0.3 + slope / 30) continue;
      const x = X(c) + rand() * dxM;
      const z = Z(r) + rand() * dyM;
      if (Math.hypot(x - cellX(o.base), z - cellZ(o.base)) < 7) continue; // keep the landing area clear
      const s = 0.1 + Math.pow(rand(), 3.2) * 1.15;
      e.set(rand() * 3, rand() * 6, rand() * 3);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(x, heightAt(x, z) + s * 0.25, z), q, new THREE.Vector3(s, s * (0.55 + rand() * 0.3), s * (0.8 + rand() * 0.4)));
      rocks.setMatrixAt(placed, m);
      const shade = 0.34 + rand() * 0.2;
      rocks.setColorAt(placed, col.setRGB(shade * 1.08, shade * 0.78, shade * 0.62));
      placed++;
    }
    rocks.count = placed;
    rocks.castShadow = true;
    scene.add(rocks);
  }

  // ---- labels ----
  const labels = new Set<THREE.Sprite>();
  const tmp = new THREE.Vector3();
  const label = (text: string, sub: string, colour: string, scale = 1) => {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 144;
    const g = cv.getContext("2d")!;
    g.fillStyle = "rgba(8,12,18,0.72)";
    g.beginPath();
    g.roundRect(4, 4, 504, 136, 18);
    g.fill();
    g.strokeStyle = colour;
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = colour;
    g.font = "bold 46px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(text.length > 26 ? `${text.slice(0, 25)}…` : text, 256, 68);
    g.fillStyle = "#cfe3f0";
    g.font = "28px system-ui, sans-serif";
    g.fillText(sub, 256, 112);
    const tex = track(new THREE.CanvasTexture(cv));
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false })));
    sp.scale.set(26 * scale, 7.3 * scale, 1);
    sp.userData.base = scale;
    sp.renderOrder = 20;
    labels.add(sp);
    return sp;
  };
  const beam = (colour: number, height: number, radius: number) => {
    const m = new THREE.Mesh(
      track(new THREE.CylinderGeometry(radius, radius, height, 12, 1, true)),
      track(new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    );
    m.position.y = height / 2;
    return m;
  };
  const place = (obj: THREE.Object3D, cell: number, lift = 0) => obj.position.set(cellX(cell), heightAt(cellX(cell), cellZ(cell)) + lift, cellZ(cell));

  // ---- base habitat ----
  const habitat = new THREE.Group();
  let blink: THREE.Mesh;
  {
    const white = track(new THREE.MeshStandardMaterial({ color: 0xe9e6df, roughness: 0.7, metalness: 0.15 }));
    const dark = track(new THREE.MeshStandardMaterial({ color: 0x2d3640, roughness: 0.6, metalness: 0.4 }));
    const dome = new THREE.Mesh(track(new THREE.SphereGeometry(3.2, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), white);
    const tube = new THREE.Mesh(track(new THREE.CylinderGeometry(2.2, 2.2, 7, 20)), white);
    tube.rotation.z = Math.PI / 2;
    tube.position.set(6.6, 2.2, 0);
    const lock = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 2.8, 2.6)), dark);
    lock.position.set(-3.6, 1.4, 0);
    const panel = new THREE.Mesh(track(new THREE.BoxGeometry(7, 0.12, 3.6)), track(new THREE.MeshStandardMaterial({ color: 0x1c2a4a, roughness: 0.3, metalness: 0.6 })));
    panel.position.set(6.6, 4.6, 4.8);
    panel.rotation.x = -0.45;
    const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.08, 0.1, 7, 8)), dark);
    mast.position.set(2, 3.5, -3);
    const dish = new THREE.Mesh(track(new THREE.SphereGeometry(1.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4)), white);
    dish.position.set(2, 7, -3);
    dish.rotation.x = -2.2;
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.22, 8, 8)), track(new THREE.MeshBasicMaterial({ color: 0xff3b30, fog: false })));
    lamp.position.set(2, 7.3, -3);
    habitat.add(dome, tube, lock, panel, mast, dish, lamp);
    habitat.traverse((c) => ((c as THREE.Mesh).isMesh && ((c as THREE.Mesh).castShadow = true, (c as THREE.Mesh).receiveShadow = true)));
    place(habitat, o.base);
    habitat.rotation.y = 0.5;
    const tag = label("BASE", "habitat · return point", "#7ee2a8", 0.8);
    tag.position.set(0, 11, 0);
    habitat.add(tag);
    const ret = beam(0x3ddc84, 70, 0.5);
    habitat.add(ret);
    scene.add(habitat);
    blink = lamp;
  }

  // ---- destination beacon ----
  const dest = new THREE.Group();
  {
    place(dest, o.goal);
    dest.add(beam(0x39c6ff, 110, 0.6));
    const ring = new THREE.Mesh(track(new THREE.RingGeometry(3.4, 4, 40)), track(new THREE.MeshBasicMaterial({ color: 0x39c6ff, side: THREE.DoubleSide, transparent: true, opacity: 0.8, fog: false })));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.4;
    dest.add(ring);
    const tag = label(o.objectiveName, "DESTINATION · NASA PLACES waypoint", "#7fd8ff");
    tag.position.y = 16;
    dest.add(tag);
    scene.add(dest);
  }

  // ---- the find marker ----
  const findGroup = new THREE.Group();
  findGroup.visible = false;
  const findBeam = beam(0xffd23f, 60, 0.5);
  const findRing = new THREE.Mesh(track(new THREE.RingGeometry(2.6, 3.2, 40)), track(new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide, transparent: true, opacity: 0.85, fog: false })));
  findRing.rotation.x = -Math.PI / 2;
  findRing.position.y = 0.35;
  let findTag = label("UNPLANNED FIND", "scenario target, not a real observation", "#ffd23f", 0.9);
  findTag.position.y = 13;
  findGroup.add(findBeam, findRing, findTag);
  scene.add(findGroup);
  let findState = "";

  // ---- waypoints and task checkpoints ----
  const markGroup = new THREE.Group();
  scene.add(markGroup);
  const markCache = new Map<string, THREE.Group>();
  const markGeo = track(new THREE.ConeGeometry(0.9, 2.4, 4));
  const markRing = track(new THREE.RingGeometry(2.0, 2.5, 32));


  // ---- astronaut ----
  const astro = new THREE.Group();
  const swing: { l: THREE.Object3D; r: THREE.Object3D; al: THREE.Object3D; ar: THREE.Object3D } = (() => {
    const suit = track(new THREE.MeshStandardMaterial({ color: 0xf2efe8, emissive: 0x3a3630, roughness: 0.85 }));
    const gold = track(new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.25, metalness: 0.9 }));
    const limb = (len: number, rad: number, x: number, y: number) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      const mesh = new THREE.Mesh(track(new THREE.CylinderGeometry(rad, rad * 0.9, len, 10)), suit);
      mesh.position.y = -len / 2;
      pivot.add(mesh);
      return pivot;
    };
    const torso = new THREE.Mesh(track(new THREE.CapsuleGeometry(0.3, 0.5, 6, 12)), suit);
    torso.position.y = 1.18;
    const pack = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.72, 0.28)), suit);
    pack.position.set(0, 1.25, 0.34);
    const helmet = new THREE.Mesh(track(new THREE.SphereGeometry(0.24, 16, 12)), suit);
    helmet.position.y = 1.78;
    const visor = new THREE.Mesh(track(new THREE.SphereGeometry(0.2, 16, 12, -Math.PI / 2.4, Math.PI / 1.2, Math.PI / 4, Math.PI / 2.2)), gold);
    visor.position.set(0, 1.78, -0.06);
    visor.rotation.y = Math.PI;
    const l = limb(0.78, 0.12, -0.14, 0.78);
    const r = limb(0.78, 0.12, 0.14, 0.78);
    const al = limb(0.62, 0.09, -0.38, 1.48);
    const ar = limb(0.62, 0.09, 0.38, 1.48);
    astro.add(torso, pack, helmet, visor, l, r, al, ar);
    astro.traverse((c) => ((c as THREE.Mesh).isMesh && ((c as THREE.Mesh).castShadow = true)));
    return { l, r, al, ar };
  })();
  scene.add(astro);

  // ---- route ribbons, hazards ----
  const ribbonMat = (colour: number, opacity = 0.95) =>
    track(new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, fog: false }));
  const ribbon = (mat: THREE.Material) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.frustumCulled = false;
    m.renderOrder = 5;
    scene.add(m);
    return m;
  };
  const buildRibbon = (pts: { x: number; z: number }[], width: number, lift: number): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const samples: THREE.Vector3[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2.5));
      for (let j = 0; j < n; j++) {
        const x = a.x + ((b.x - a.x) * j) / n;
        const z = a.z + ((b.z - a.z) * j) / n;
        samples.push(new THREE.Vector3(x, heightAt(x, z) + lift, z));
      }
    }
    if (pts.length) {
      const l = pts[pts.length - 1];
      samples.push(new THREE.Vector3(l.x, heightAt(l.x, l.z) + lift, l.z));
    }
    if (samples.length < 2) return g;
    const v = new Float32Array(samples.length * 6);
    for (let i = 0; i < samples.length; i++) {
      const p0 = samples[Math.max(0, i - 1)];
      const p1 = samples[Math.min(samples.length - 1, i + 1)];
      let tx = p1.x - p0.x;
      let tz = p1.z - p0.z;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      const s = samples[i];
      v.set([s.x - tz * (width / 2), s.y, s.z + tx * (width / 2), s.x + tz * (width / 2), s.y, s.z - tx * (width / 2)], i * 6);
    }
    const ix: number[] = [];
    for (let i = 0; i + 1 < samples.length; i++) ix.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    g.setAttribute("position", new THREE.BufferAttribute(v, 3));
    g.setIndex(ix);
    return g;
  };
  const setGeo = (m: THREE.Mesh, g: THREE.BufferGeometry) => {
    m.geometry.dispose();
    m.geometry = g;
  };
  const trailMesh = ribbon(ribbonMat(0xffffff, 0.9));
  const aheadMesh = ribbon(ribbonMat(0xffe27a, 0.72));
  let overMeshes: THREE.Mesh[] = [];
  let optionMeshes: THREE.Mesh[] = [];
  let hazard: THREE.Group | null = null;

  // ---- dust: drifting specks around the camera; thicker in a storm ----
  const DUST_N = 700;
  const dustOff = new Float32Array(DUST_N * 3);
  for (let i = 0; i < DUST_N; i++) dustOff.set([(Math.random() - 0.5) * 90, Math.random() * 28 - 4, (Math.random() - 0.5) * 90], i * 3);
  const dustGeo = track(new THREE.BufferGeometry());
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(DUST_N * 3), 3));
  const speck = document.createElement("canvas");
  speck.width = speck.height = 32;
  {
    const g = speck.getContext("2d")!;
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 32, 32);
  }
  const dustMat = track(new THREE.PointsMaterial({ color: 0xf0d2b0, size: 0.2, map: track(new THREE.CanvasTexture(speck)), transparent: true, opacity: 0.3, depthWrite: false, fog: false, sizeAttenuation: true }));
  const dustPts = new THREE.Points(dustGeo, dustMat);
  dustPts.frustumCulled = false;
  scene.add(dustPts);
  let dustTarget = 0;
  let dustNow = 0;

  // ---- camera control, overlay ----
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.495;
  let mode: Mode = o.initialMode ?? "fp";
  let lookYaw = 0;
  let lookPitch = 0;
  let dragging = false;
  let moved = 0;
  const fpVisor = document.createElement("div");
  fpVisor.className = "s3-visor";
  const gloves = document.createElement("div");
  gloves.className = "s3-gloves";
  gloves.innerHTML = '<span class="glove l"></span><span class="glove r"></span>';
  const ui = document.createElement("div");
  ui.className = "s3-ui";
  ui.innerHTML = `<div class="s3-row" role="group" aria-label="Camera">
      <button data-m="fp" class="${mode === "fp" ? "active" : ""}" title="First person (V cycles)">First person</button><button data-m="chase" class="${mode === "chase" ? "active" : ""}" title="Chase camera">Chase</button><button data-m="orbit" class="${mode === "orbit" ? "active" : ""}" title="Overview, drag to orbit">Overview</button>
    </div>
    <div class="s3-row">
      <button id="s3-snd" class="${o.audio ? "" : "off"}" title="Sound on/off (M)">${o.audio ? "&#128266; Sound" : "No audio"}</button>
      <button id="s3-voice" class="${o.audio && !o.audio.voice ? "off" : ""}" title="Radio voice on/off">&#128483; Voice</button>
      <button id="s3-music" class="${o.audio && !o.audio.music ? "off" : ""}" title="Music on/off">&#9835; Music</button>
    </div>
    <small class="s3-hint">Drag to look &middot; V changes view &middot; M mutes</small>
    <details class="s3-about"><summary>About this view</summary><small>Sound and music are synthesised simulation audio (outside sounds are muffled: Mars's thin air carries sound weakly). Rocks and surface grain are visual detail, not measured terrain. Terrain: USGS MSL Gale Merged DEM 1 m (from NASA MRO HiRISE). Imagery: NASA MRO CTX via NASA Mars Trek. Sun and sky are illustrative.</small></details>`;
  root.append(fpVisor, gloves, ui);

  const setMode = (m: Mode) => {
    mode = m;
    ui.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => b.classList.toggle("active", b.dataset.m === m));
    controls.enabled = m !== "fp";
    astro.visible = m !== "fp";
    fpVisor.style.display = gloves.style.display = m === "fp" ? "" : "none";
    if (m !== "fp") {
      const d = m === "chase" ? 7 : 150;
      const back = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(d);
      camera.position.set(ax + back.x, ay + (m === "chase" ? 3 : d * 0.55), az2 + back.z);
      controls.target.set(ax, ay + 1.4, az2);
      controls.minDistance = m === "chase" ? 3 : 25;
      controls.maxDistance = m === "chase" ? 45 : 1400;
    }
  };
  ui.querySelectorAll<HTMLButtonElement>("[data-m]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.m as Mode)));
  const sndBtn = ui.querySelector<HTMLButtonElement>("#s3-snd")!;
  const voiceBtn = ui.querySelector<HTMLButtonElement>("#s3-voice")!;
  const toggleSound = () => {
    if (!o.audio) return;
    o.audio.setMuted(!o.audio.muted);
    sndBtn.innerHTML = o.audio.muted ? "&#128263; Muted" : "&#128266; Sound";
    sndBtn.classList.toggle("off", o.audio.muted);
  };
  sndBtn.addEventListener("click", toggleSound);
  voiceBtn.addEventListener("click", () => {
    if (!o.audio) return;
    o.audio.setVoice(!o.audio.voice);
    voiceBtn.classList.toggle("off", !o.audio.voice);
  });
  const musicBtn = ui.querySelector<HTMLButtonElement>("#s3-music")!;
  musicBtn.addEventListener("click", () => {
    if (!o.audio) return;
    o.audio.setMusic(!o.audio.music);
    musicBtn.classList.toggle("off", !o.audio.music);
  });
  if (o.audio?.muted) {
    sndBtn.innerHTML = "&#128263; Muted";
    sndBtn.classList.add("off");
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.matches?.("input, select, textarea")) return;
    if (e.key === "v" || e.key === "V") setMode(mode === "fp" ? "chase" : mode === "chase" ? "orbit" : "fp");
    if (e.key === "m" || e.key === "M") toggleSound();
  };
  window.addEventListener("keydown", onKey);

  const canvas = renderer.domElement;
  let downX = 0;
  let downY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = 0;
    downX = e.clientX;
    downY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || mode !== "fp") return;
    moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    lookYaw += e.movementX * 0.004;
    lookPitch = Math.max(-1.1, Math.min(1.0, lookPitch - e.movementY * 0.004));
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  });

  // ---- state ----
  let ax = cellX(o.base);
  let az2 = cellZ(o.base);
  let ay = heightAt(ax, az2);
  let yaw = 0;
  let targetYaw = 0;
  let walkPhase = 0;
  let stride = 0;
  let phase = "outbound";
  let speedMs = 0;
  let lastPosMs = performance.now();
  let initialised = false;
  let alive = true;
  setMode(mode); // apply the starting camera (re-applied once the walk direction is known)

  const worldOf = (p: StagePos) => {
    const x0 = cellX(p.from);
    const z0 = cellZ(p.from);
    return { x: x0 + (cellX(p.to) - x0) * p.frac, z: z0 + (cellZ(p.to) - z0) * p.frac };
  };

  // ---- resize ----
  const resize = () => {
    const w = Math.max(2, root.clientWidth);
    const h = Math.max(2, root.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(root);
  resize();

  // ---- render loop ----
  let lastFrameMs = performance.now();
  let t = 0;
  const loop = () => {
    if (!alive) return;
    requestAnimationFrame(loop);
    const nowFrame = performance.now();
    const dt = Math.min(0.1, (nowFrame - lastFrameMs) / 1000);
    lastFrameMs = nowFrame;
    t += dt;

    // dust and sky mood
    dustNow += (dustTarget - dustNow) * Math.min(1, dt * 0.8);
    const fog = scene.fog as THREE.Fog;
    fog.near = 700 - 680 * dustNow;
    fog.far = 4800 - 4560 * dustNow;
    fog.color.copy(HORIZON).lerp(DUST, dustNow);
    skyMat.uniforms.dust.value = dustNow;
    sun.intensity = 2.3 * (1 - 0.55 * dustNow);
    hemi.intensity = 0.75 + 0.2 * dustNow;
    dustMat.opacity = 0.22 + 0.55 * dustNow;
    dustMat.size = 0.14 + 0.2 * dustNow;

    // heading eases toward the direction of travel
    let dy = targetYaw - yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    yaw += dy * Math.min(1, dt * 4);
    ay = heightAt(ax, az2);

    // walk cycle
    const moving = WALKING.has(phase) && speedMs > 0.05;
    const bobAmp = moving ? Math.min(1, speedMs / 1.2) : 0;
    walkPhase += moving ? dt * 2 * Math.PI * Math.min(2.1, 0.9 + speedMs * 0.25) : 0;
    const s = Math.sin(walkPhase);
    astro.position.set(ax, ay, az2);
    astro.rotation.y = -yaw;
    const sw = 0.7 * bobAmp;
    swing.l.rotation.x = s * sw;
    swing.r.rotation.x = -s * sw;
    swing.al.rotation.x = -s * sw * 0.8;
    swing.ar.rotation.x = s * sw * 0.8;
    astro.position.y += Math.abs(s) * 0.05 * bobAmp;

    // light and shadow follow the astronaut
    sun.position.set(ax + sunDir.x * 450, ay + sunDir.y * 450, az2 + sunDir.z * 450);
    sun.target.position.set(ax, ay, az2);
    sky.position.copy(camera.position);
    blink.visible = Math.floor(t * 1.2) % 2 === 0;

    // labels grow with distance so they stay readable from far away
    labels.forEach((sp) => {
      sp.getWorldPosition(tmp);
      const k = Math.min(2.5, Math.max(1, tmp.distanceTo(camera.position) / 100)) * (sp.userData.base as number);
      sp.scale.set(26 * k, 7.3 * k, 1);
    });

    // markers breathe
    findRing.scale.setScalar(1 + 0.18 * Math.sin(t * 3));
    findBeam.material.opacity = 0.3 + 0.12 * Math.sin(t * 3);

    // camera
    if (mode === "fp") {
      lookYaw *= dragging ? 1 : Math.exp(-dt * 0.5);
      lookPitch *= dragging ? 1 : Math.exp(-dt * 0.5);
      const fx = Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const slope = Math.atan2(heightAt(ax + fx * 2.5, az2 + fz * 2.5) - ay, 2.5);
      camera.position.set(ax, ay + EYE_HEIGHT + Math.abs(s) * 0.045 * bobAmp, az2);
      camera.rotation.set(Math.max(-1.3, Math.min(1.2, lookPitch + slope * 0.4 - 0.03)), -(yaw + lookYaw), Math.sin(walkPhase * 0.5) * 0.006 * bobAmp, "YXZ");
      gloves.style.transform = `translateY(${Math.abs(s) * 7 * bobAmp}px)`;
    } else {
      const delta = new THREE.Vector3(ax, ay + 1.4, az2).sub(controls.target);
      camera.position.add(delta);
      controls.target.add(delta);
      controls.update();
    }
    camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 0.6);

    // dust specks stay in a box around the camera and drift with the wind
    const arr = dustGeo.attributes.position.array as Float32Array;
    const wind = 1.2 + 4 * dustNow;
    for (let i = 0; i < DUST_N; i++) {
      dustOff[i * 3] += wind * dt;
      dustOff[i * 3 + 1] += Math.sin(t + i) * 0.01;
      if (dustOff[i * 3] > 45) dustOff[i * 3] -= 90;
      arr[i * 3] = camera.position.x + dustOff[i * 3];
      arr[i * 3 + 1] = camera.position.y + dustOff[i * 3 + 1] - 2;
      arr[i * 3 + 2] = camera.position.z + dustOff[i * 3 + 2];
    }
    dustGeo.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
  };
  setMode(mode);
  loop();

  // ---- Stage interface ----
  let cancelPick: (() => void) | null = null;
  const stage: Stage3D = {
    kind: "3d",
    speeds: [5, 15, 60],
    defaultSpeed: 15,
    ready,
    setHazard(blocked) {
      if (hazard) {
        scene.remove(hazard);
        hazard.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      }
      const g = new THREE.Group();
      const cells: number[] = [];
      blocked.forEach((b, i) => b && cells.push(i));
      const zone = new THREE.InstancedMesh(
        track(new THREE.BoxGeometry(dxM, 3, dyM)),
        track(new THREE.MeshBasicMaterial({ color: 0xff3c28, transparent: true, opacity: 0.28, depthWrite: false, fog: false })),
        Math.max(1, cells.length),
      );
      const stones = new THREE.InstancedMesh(track(new THREE.IcosahedronGeometry(1, 0)), track(new THREE.MeshLambertMaterial({ color: 0x6a5648 })), Math.max(1, cells.length));
      const m = new THREE.Matrix4();
      const rand = rng(77);
      cells.forEach((i, n) => {
        const x = cellX(i);
        const z = cellZ(i);
        const h = heightAt(x, z);
        m.makeTranslation(x, h + 1.5, z);
        zone.setMatrixAt(n, m);
        const sc = 0.8 + rand() * 1.7;
        m.compose(new THREE.Vector3(x + (rand() - 0.5) * dxM * 0.6, h + sc * 0.3, z + (rand() - 0.5) * dyM * 0.6), new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 3, rand() * 6, 0)), new THREE.Vector3(sc, sc * 0.7, sc));
        stones.setMatrixAt(n, m);
      });
      zone.count = stones.count = cells.length;
      stones.castShadow = true;
      g.add(zone, stones);
      scene.add(g);
      hazard = g;
    },
    setOptions(lines: StageLine[]) {
      optionMeshes.forEach((m) => {
        scene.remove(m);
        m.geometry.dispose();
      });
      optionMeshes = lines
        .filter((l) => l.cells.length > 1)
        .map((l, i) => {
          const mesh = ribbon(ribbonMat(LINE_COLOURS[l.id] ?? 0x39c6ff, 0.85));
          mesh.renderOrder = 6 + i;
          setGeo(mesh, buildRibbon(l.cells.map((c) => ({ x: cellX(c), z: cellZ(c) })), 1.3, 0.55 + i * 0.12));
          return mesh;
        });
    },
    setOverlay(lines) {
      overMeshes.forEach((m) => {
        scene.remove(m);
        m.geometry.dispose();
      });
      overMeshes = lines
        .filter((l) => l.cells.length > 1)
        .map((l, i) => {
          const mesh = ribbon(ribbonMat(new THREE.Color(l.colour).getHex(), 0.9));
          mesh.renderOrder = 9 + i;
          setGeo(mesh, buildRibbon(l.cells.map((c) => ({ x: cellX(c), z: cellZ(c) })), (l.width ?? 6) * 0.35, 0.9 + i * 0.12));
          return mesh;
        });
    },
    setTrail(cells, p) {
      setGeo(trailMesh, buildRibbon([...cells.map((c) => ({ x: cellX(c), z: cellZ(c) })), worldOf(p)], 0.55, 0.2));
    },
    setAhead(cells, p) {
      setGeo(aheadMesh, cells.length ? buildRibbon([worldOf(p), ...cells.map((c) => ({ x: cellX(c), z: cellZ(c) }))], mode === "fp" ? 0.55 : 1.1, 0.32) : new THREE.BufferGeometry());
    },
    setPosition(p, opt) {
      const w = worldOf(p);
      const dx = w.x - ax;
      const dz = w.z - az2;
      const d = Math.hypot(dx, dz);
      phase = opt.phase;
      const nowMs = performance.now();
      const dtp = Math.max(0.001, (nowMs - lastPosMs) / 1000);
      lastPosMs = nowMs;
      speedMs += (d / dtp - speedMs) * 0.25; // metres per second on screen, smoothed
      ax = w.x;
      az2 = w.z;
      if (d > 0.001 && WALKING.has(opt.phase)) {
        // The footstep rate follows distance walked on screen, capped at about 2 steps a second.
        stride += d;
        const strideLen = Math.max(1.5, speedMs / 2.2);
        if (stride >= strideLen) {
          stride = 0;
          o.audio?.footstep(Math.min(1, 0.55 + d * 2));
        }
      }
      // Face the direction of travel.
      const tx = cellX(p.to) - cellX(p.from);
      const tz = cellZ(p.to) - cellZ(p.from);
      if (Math.hypot(tx, tz) > 0.01) {
        targetYaw = Math.atan2(tx, -tz);
        if (!initialised) {
          yaw = targetYaw;
          initialised = true;
          setMode(mode);
        }
      }
    },
    setMarkers(list) {
      const keep = new Set<string>();
      list.forEach((m, i) => {
        const key = `${m.kind}:${m.cell}:${i}:${m.label}`;
        keep.add(key);
        let g = markCache.get(key);
        if (!g) {
          g = new THREE.Group();
          const col = m.kind === "via" ? 0xff9d3d : 0x7ee2a8;
          const cone = new THREE.Mesh(markGeo, track(new THREE.MeshBasicMaterial({ color: col, fog: false })));
          cone.rotation.x = Math.PI;
          cone.position.y = 4.4;
          const ring = new THREE.Mesh(markRing, track(new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.8, fog: false })));
          ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.35;
          const b = beam(col, 14, 0.18);
          const tag = label(m.label, m.kind === "via" ? "your waypoint" : "mission task", m.kind === "via" ? "#ffb35c" : "#7ee2a8", 0.55);
          tag.position.y = 8;
          g.add(cone, ring, b, tag);
          g.userData.done = m.done;
          place(g, m.cell);
          markGroup.add(g);
          markCache.set(key, g);
        }
        g.visible = true;
        g.scale.setScalar(m.done ? 0.7 : 1);
        g.children.forEach((c) => {
          const mat = (c as THREE.Mesh).material as THREE.Material | undefined;
          if (mat && "opacity" in mat && !(c instanceof THREE.Sprite)) (mat as THREE.Material).opacity = m.done ? 0.3 : 0.8;
        });
      });
      for (const [key, g] of markCache) {
        if (!keep.has(key)) {
          markGroup.remove(g);
          g.traverse((c) => {
            if (c instanceof THREE.Sprite) labels.delete(c);
          });
          markCache.delete(key);
        }
      }
    },
    setFind(f) {
      if (!f) {
        findGroup.visible = false;
        return;
      }
      findGroup.visible = true;
      place(findGroup, f.cell);
      const colour = FIND_COLOURS[f.state] ?? 0xffd23f;
      (findBeam.material as THREE.MeshBasicMaterial).color.set(colour);
      (findRing.material as THREE.MeshBasicMaterial).color.set(colour);
      if (f.state !== findState) {
        findState = f.state;
        findGroup.remove(findTag);
        labels.delete(findTag);
        findTag = label(f.state === "armed" ? "PLACED FIND" : "UNPLANNED FIND", f.state === "armed" ? "not noticed yet · scenario" : f.state === "done" ? "inspected" : f.state === "skipped" ? "skipped" : "scenario target, not a real observation", `#${colour.toString(16).padStart(6, "0")}`, 0.9);
        findTag.position.y = 13;
        findGroup.add(findTag);
      }
    },
    setDust(on) {
      dustTarget = on ? 1 : 0;
    },
    pick(cb: (hit: StagePick | null) => void) {
      cancelPick?.();
      canvas.style.cursor = "crosshair";
      const ray = new THREE.Raycaster();
      const done = () => {
        canvas.removeEventListener("click", onClick);
        canvas.style.cursor = "";
        cancelPick = null;
      };
      const onClick = (e: MouseEvent) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // that was a drag, not a click
        done();
        const r = canvas.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const hit = ray.intersectObject(terrainMesh)[0];
        if (!hit) return cb(null);
        const col = Math.round(hit.point.x / dxM + (cols - 1) / 2);
        const row = Math.round(hit.point.z / dyM + (rows - 1) / 2);
        const snap = nearestPassable(terrain, row, col, 6);
        cb(snap ? { cell: snap.row * cols + snap.col, distM: snap.distM } : null);
      };
      canvas.addEventListener("click", onClick);
      cancelPick = done;
      return done;
    },
    dispose() {
      alive = false;
      cancelPick?.();
      ro.disconnect();
      window.removeEventListener("keydown", onKey);
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      scene.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      renderer.dispose();
      renderer.forceContextLoss(); // give the GPU context back now; browsers cap how many can be alive
      root.remove();
    },
  };
  return stage;
}

// Tileable value-noise texture used only to break up the photo's smoothness.
export function makeGrain(): THREE.Texture {
  const N = 256;
  const rand = rng(4242);
  const octave = (cells: number) => {
    const g = new Float32Array(cells * cells).map(() => rand());
    const at = (x: number, y: number) => g[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
    return (u: number, v: number) => {
      const x = u * cells;
      const y = v * cells;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      return at(x0, y0) * (1 - sx) * (1 - sy) + at(x0 + 1, y0) * sx * (1 - sy) + at(x0, y0 + 1) * (1 - sx) * sy + at(x0 + 1, y0 + 1) * sx * sy;
    };
  };
  const o = [octave(8), octave(16), octave(32), octave(64)];
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const val = (o[0](u, v) * 0.45 + o[1](u, v) * 0.3 + o[2](u, v) * 0.15 + o[3](u, v) * 0.1);
      const b = Math.max(0, Math.min(255, Math.round(val * 255)));
      data.set([b, b, b, 255], (y * N + x) * 4);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
