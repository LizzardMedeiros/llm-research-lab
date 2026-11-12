// 3D world for run videos (browser module, copied next to index.html).
//
// The 2D composition built by build.mjs stays the source of truth: its GSAP
// timeline still animates the (hidden) board tokens, the board camera and the
// viewport. On every HyperFrames seek, this module reads those proxies and
// draws the same state as a 3D set with robotic lab rats:
//   token position  -> rat on that cell (walking while a logged move plays)
//   logged speech   -> speaker ring, rats face each other   token opacity 0.25 -> powered down
//   token shake     -> rat shake          tense face         -> amber eyes
//   board camera    -> 3D camera target and zoom
// Decorative motion (backdrop grid, camera sway, idle breathing) carries no
// meaning. Everything is a pure function of timeline time (deterministic).

import * as THREE from "./three.module.min.js";

const CELL = 1.1; // world units per grid cell
const RAT_SCALE = 0.5;
const GREY = new THREE.Color("#6b7280");
const BOW = new THREE.Color("#ff6fa8");
const EYE = new THREE.Color("#5ffbf1");
const EYE_TENSE = new THREE.Color("#ffb020");
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** A humanoid robotic lab rat built from primitives (facing +z). */
export function makeRat(hex, feminine) {
  const color = new THREE.Color(hex);
  const root = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: color.clone(), roughness: 0.5, metalness: 0.1 });
  const lightMat = new THREE.MeshStandardMaterial({ color: color.clone().lerp(new THREE.Color("#ffffff"), 0.55), roughness: 0.55 });
  const jointMat = new THREE.MeshStandardMaterial({ color: "#2b3140", roughness: 0.4, metalness: 0.5 });
  const visorMat = new THREE.MeshStandardMaterial({ color: "#11151f", roughness: 0.15, metalness: 0.6 });
  const eyesMat = new THREE.MeshStandardMaterial({ color: "#000000", emissive: EYE.clone(), emissiveIntensity: 2.2 });
  const tipMat = new THREE.MeshStandardMaterial({ color: "#000000", emissive: "#ff5f8f", emissiveIntensity: 2 });
  const bowMat = new THREE.MeshStandardMaterial({ color: BOW.clone(), roughness: 0.45 });
  const add = (parent, geo, mat, pos, rot, scale) => {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(...pos);
    if (rot) m.rotation.set(...rot);
    if (scale) m.scale.set(...scale);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  const legs = [-1, 1].map((s) => {
    const hip = new THREE.Group();
    hip.position.set(0.085 * s, 0.24, 0);
    root.add(hip);
    add(hip, new THREE.CapsuleGeometry(0.055, 0.1, 6, 12), jointMat, [0, -0.1, 0]);
    add(hip, new THREE.SphereGeometry(0.075, 16, 12), bodyMat, [0, -0.2, 0.035], null, [1, 0.55, 1.45]);
    return hip;
  });
  const torso = new THREE.Group();
  torso.position.y = 0.24;
  root.add(torso);
  add(torso, new THREE.SphereGeometry(0.2, 24, 18), bodyMat, [0, 0.17, 0], null, [1, 1.15, 0.9]);
  add(torso, new THREE.SphereGeometry(0.13, 20, 14), lightMat, [0, 0.14, 0.095], null, [1, 1.2, 0.5]);
  add(torso, new THREE.TorusGeometry(0.125, 0.018, 8, 24), jointMat, [0, 0.33, 0], [Math.PI / 2, 0, 0]);
  const arms = [-1, 1].map((s) => {
    const sh = new THREE.Group();
    sh.position.set(0.2 * s, 0.27, 0);
    torso.add(sh);
    add(sh, new THREE.SphereGeometry(0.045, 12, 10), jointMat);
    add(sh, new THREE.CapsuleGeometry(0.042, 0.11, 6, 12), bodyMat, [0.02 * s, -0.1, 0], [0, 0, 0.15 * s]);
    add(sh, new THREE.SphereGeometry(0.05, 12, 10), lightMat, [0.035 * s, -0.2, 0.01]);
    return sh;
  });
  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.08, -0.16), new THREE.Vector3(0, 0.02, -0.32),
    new THREE.Vector3(0.06, 0.1, -0.45), new THREE.Vector3(0.1, 0.28, -0.46), new THREE.Vector3(0.06, 0.38, -0.38),
  ]);
  add(torso, new THREE.TubeGeometry(tailCurve, 40, 0.017, 8, false), jointMat);
  add(torso, new THREE.SphereGeometry(0.03, 10, 8), tipMat, [0.06, 0.38, -0.38]);

  const head = new THREE.Group();
  head.position.set(0, 0.36, 0);
  torso.add(head);
  add(head, new THREE.SphereGeometry(0.21, 28, 20), bodyMat, [0, 0.19, 0], null, [0.95, 0.9, 1.08]);
  add(head, new THREE.SphereGeometry(0.1, 18, 14), lightMat, [0, 0.13, 0.2], null, [0.85, 0.72, 1.55]);
  add(head, new THREE.SphereGeometry(0.038, 12, 10), new THREE.MeshStandardMaterial({ color: "#ff7aa2", roughness: 0.4 }), [0, 0.15, 0.355]);
  const toothMat = new THREE.MeshStandardMaterial({ color: "#f5f1e6", roughness: 0.3 });
  for (const s of [-1, 1]) add(head, new THREE.BoxGeometry(0.022, 0.035, 0.012), toothMat, [0.013 * s, 0.075, 0.31]);
  const whiskerMat = new THREE.MeshStandardMaterial({ color: "#d9dde8", roughness: 0.3, metalness: 0.4 });
  for (const s of [-1, 1]) for (const k of [-1, 0, 1]) {
    add(head, new THREE.CylinderGeometry(0.004, 0.004, 0.17, 6), whiskerMat, [0.1 * s, 0.13 + k * 0.022, 0.27], [0, 0, Math.PI / 2 + k * 0.18 * s]);
  }
  add(head, new THREE.TorusGeometry(0.205, 0.034, 10, 28, Math.PI * 0.62), visorMat, [0, 0.23, 0], [Math.PI / 2, 0, Math.PI * 0.19], [1, 1.08, 1]);
  for (const s of [-1, 1]) add(head, new THREE.SphereGeometry(0.028, 12, 10), eyesMat, [0.07 * s, 0.235, 0.238], null, [1.3, 1, 0.5]);
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(0.17 * s, 0.31, -0.07);
    ear.rotation.set(-0.15, 0.75 * s, 0.35 * s);
    head.add(ear);
    add(ear, new THREE.CylinderGeometry(0.11, 0.11, 0.025, 24), bodyMat, null, [Math.PI / 2, 0, 0], [0.85, 1, 1.25]);
    add(ear, new THREE.CylinderGeometry(0.078, 0.078, 0.027, 24), lightMat, [0, 0, 0.004], [Math.PI / 2, 0, 0], [0.85, 1, 1.25]);
  }
  if (feminine) {
    const bow = new THREE.Group();
    bow.position.set(-0.1, 0.4, 0.08);
    bow.rotation.set(0.35, 0.15, 0.35);
    bow.scale.setScalar(1.6);
    head.add(bow);
    for (const s of [-1, 1]) add(bow, new THREE.ConeGeometry(0.055, 0.1, 16), bowMat, [0.055 * s, 0, 0], [0, 0, s * Math.PI / 2], [1, 1, 0.45]);
    add(bow, new THREE.SphereGeometry(0.03, 12, 10), bowMat, [0, 0, 0], null, [1, 1, 0.8]);
  }
  add(head, new THREE.CylinderGeometry(0.013, 0.013, 0.15, 8), jointMat, [0.04, 0.44, -0.05], [-0.15, 0, -0.2]);
  add(head, new THREE.SphereGeometry(0.03, 10, 8), tipMat, [0.056, 0.52, -0.06]);

  root.userData = { legs, arms, torso, head, color, bodyMat, lightMat, eyesMat, tipMat, bowMat };
  return root;
}

/** Pose for time t: idle breathing, walk (0..1), talk (0..1), power-down (0..1), tense (0..1). */
export function poseRat(r, t, { walk = 0, talk = 0, off = 0, tense = 0, seed = 0 }) {
  const u = r.userData;
  const ph = t * 7 + seed;
  const swing = walk * Math.sin(ph) * 0.55;
  u.legs[0].rotation.x = swing;
  u.legs[1].rotation.x = -swing;
  const gesture = talk * Math.sin(t * 9 + seed) * 0.35;
  const armRest = 0.12 + off * 0.1;
  u.arms[0].rotation.set(-swing * 0.8 - talk * 0.5 + gesture, 0, -armRest - talk * 0.25);
  u.arms[1].rotation.set(swing * 0.8 - talk * 0.3 - gesture, 0, armRest + talk * 0.15);
  const alive = 1 - off;
  u.torso.position.y = 0.24 + Math.sin(t * 2.2 + seed) * 0.012 * alive + walk * Math.abs(Math.sin(ph)) * 0.03 - off * 0.05;
  u.torso.rotation.x = off * 0.18;
  u.head.rotation.set(
    off * 0.45 + Math.sin(t * 1.3 + seed) * 0.04 * alive + talk * Math.sin(t * 11 + seed) * 0.08,
    Math.sin(t * 0.9 + seed) * 0.12 * alive,
    0,
  );
  const lightBase = u.color.clone().lerp(new THREE.Color("#ffffff"), 0.55);
  u.bodyMat.color.copy(u.color).lerp(GREY, off * 0.75);
  u.lightMat.color.copy(lightBase).lerp(GREY, off * 0.75);
  u.bowMat.color.copy(BOW).lerp(GREY, off * 0.75);
  u.eyesMat.emissive.copy(EYE).lerp(EYE_TENSE, tense);
  u.eyesMat.emissiveIntensity = 2.2 * alive;
  u.tipMat.emissiveIntensity = 2 * alive;
}

/** Taser prop (presentation of a charged item): yellow body, grip, prongs, one LED per charge. */
function makeTaser(maxCharges) {
  const taser = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: "#f5c518", roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: "#1d2330", roughness: 0.5, metalness: 0.4 });
  const part = (geo, mat, pos, rotX = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(...pos); m.rotation.x = rotX; m.castShadow = true; taser.add(m); };
  part(new THREE.BoxGeometry(0.07, 0.07, 0.2), yellow, [0, 0, 0.06]);
  part(new THREE.BoxGeometry(0.06, 0.12, 0.06), black, [0, -0.06, -0.01], 0.25);
  part(new THREE.BoxGeometry(0.08, 0.06, 0.03), black, [0, 0, 0.17]);
  for (const s of [-1, 1]) part(new THREE.CylinderGeometry(0.006, 0.006, 0.04, 6), black, [0.022 * s, 0, 0.2], Math.PI / 2);
  const leds = Array.from({ length: maxCharges }, (_, k) => {
    const m = new THREE.MeshStandardMaterial({ color: "#000", emissive: "#3dff8f", emissiveIntensity: 2 });
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), m);
    led.position.set((k - (maxCharges - 1) / 2) * 0.024, 0.04, 0.03);
    taser.add(led);
    return m;
  });
  const tip = new THREE.Object3D();
  tip.position.set(0, 0, 0.23);
  taser.add(tip);
  taser.position.set(0.035, -0.24, 0.01);
  taser.rotation.x = Math.PI / 2; // points out of the hand: down at rest, forward when the arm is raised
  return { taser, leds, tip };
}

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/**
 * Mounts the 3D world on `canvas` and returns renderAt(t).
 * config: { W, H, view:{x,y,w,h}, cell, token, grid:{w,h,blocked:[[x,y]]},
 *           agents:[{id, name, color, feminine}], moves:{id:[[t0, dur, fx, fy, tx, ty]]},
 *           speeches:[[start, end, speaker, [listeners]]] }
 * (board positions in config are in cell units)
 */
export function mountWorld(canvas, config) {
  const { W, H, view, grid } = config;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#0b0d14");
  scene.fog = new THREE.Fog("#0b0d14", 16, 40);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 120);

  scene.add(new THREE.HemisphereLight("#b8c6ff", "#20152a", 0.85));
  const key = new THREE.DirectionalLight("#ffe6c8", 1.7);
  key.position.set(4, 9, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const half = (Math.max(grid.w, grid.h) * CELL) / 2 + 1;
  Object.assign(key.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.5, far: 30 });
  scene.add(key);
  const rim = new THREE.DirectionalLight("#7c9cff", 1.1);
  rim.position.set(-5, 4, -5);
  scene.add(rim);

  const toWorld = (u, v) => new THREE.Vector3((u - grid.w / 2) * CELL, 0, (v - grid.h / 2) * CELL);

  // Board: a raised platform, one tile per cell, blocked cells as blocks.
  const blocked = new Set(grid.blocked.map(([x, y]) => `${x},${y}`));
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(grid.w * CELL + 0.3, 0.3, grid.h * CELL + 0.3),
    new THREE.MeshStandardMaterial({ color: "#151a26", roughness: 0.9 }),
  );
  plinth.position.y = -0.27;
  plinth.receiveShadow = true;
  scene.add(plinth);
  const tileMat = new THREE.MeshStandardMaterial({ color: "#252e40", roughness: 0.8 });
  const wallMat = new THREE.MeshStandardMaterial({ color: "#4a5578", roughness: 0.6 });
  for (let y = 0; y < grid.h; y++) {
    for (let x = 0; x < grid.w; x++) {
      const wall = blocked.has(`${x},${y}`);
      const h = wall ? 0.7 : 0.1;
      const m = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.94, h, CELL * 0.94), wall ? wallMat : tileMat);
      m.position.copy(toWorld(x + 0.5, y + 0.5)).setY(h / 2 - 0.1);
      m.receiveShadow = true;
      m.castShadow = wall;
      scene.add(m);
    }
  }

  // Decorative backdrop: an undulating neon grid below the board.
  const gridGeo = new THREE.PlaneGeometry(120, 120, 70, 70);
  gridGeo.rotateX(-Math.PI / 2);
  const base = gridGeo.attributes.position.array.slice();
  const backdrop = new THREE.Mesh(gridGeo, new THREE.MeshBasicMaterial({ color: "#7c4dff", wireframe: true, transparent: true, opacity: 0.3 }));
  backdrop.position.y = -3.5;
  scene.add(backdrop);

  // Cast, listener rings and name tags.
  const root = document.getElementById("root");
  const tagLayer = document.createElement("div");
  tagLayer.className = "tags3d";
  root.appendChild(tagLayer);
  const agents = config.agents.map((a, i) => {
    const rat = makeRat(a.color, a.feminine);
    rat.scale.setScalar(RAT_SCALE);
    scene.add(rat);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 32), new THREE.MeshBasicMaterial({ color: "#ffe08a", transparent: true, opacity: 0, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    const tag = document.createElement("div");
    tag.className = "tag3d";
    tag.style.background = a.color;
    tag.textContent = a.name;
    tagLayer.appendChild(tag);
    return { ...a, rat, ring, tag, seed: i * 1.7, el: document.getElementById(`tok-${a.id}`), tenseEl: document.getElementById(`face-${a.id}-tense`) };
  });
  const callouts = [...document.querySelectorAll(".callout3d")];

  // Taser (optional prop): one per rat, shown while the log gives it charges.
  const taserCfg = config.taser;
  if (taserCfg) {
    for (const a of agents) Object.assign(a, makeTaser(Math.min(4, taserCfg.max)));
    for (const a of agents) a.rat.userData.arms[0].add(a.taser);
  }
  const chargesAt = (id, t) => {
    let n = 0;
    for (const [t0, v] of taserCfg?.charges[id] ?? []) if (t0 <= t) n = v;
    return n;
  };
  const bolts = [];
  const boltCore = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, blending: THREE.AdditiveBlending });
  const boltGlow = new THREE.MeshBasicMaterial({ color: "#5fd0ff", transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending });
  const sparks = Array.from({ length: 40 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.008, 6, 4), new THREE.MeshBasicMaterial({ color: i % 3 ? "#fff6c8" : "#7fd8ff", transparent: true }));
    m.visible = false;
    scene.add(m);
    return m;
  });
  const zapLights = [0, 1, 2].map(() => { const l = new THREE.PointLight("#7fd8ff", 0, 2.5); scene.add(l); return l; });
  const viewportEl = document.getElementById("viewport");
  const cameraEl = document.getElementById("camera");
  const get = (el, prop) => Number(window.gsap.getProperty(el, prop)) || 0;
  const v = new THREE.Vector3();
  const project = (p) => {
    v.copy(p).project(camera);
    return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H];
  };

  return function renderAt(t) {
    // Viewport (where the board sits on screen) and board camera (what it frames).
    const vx = get(viewportEl, "x"), vy = get(viewportEl, "y"), vs = get(viewportEl, "scale") || 1;
    canvas.style.opacity = String(window.gsap.getProperty(viewportEl, "opacity"));
    const cx = get(cameraEl, "x"), cy = get(cameraEl, "y"), cs = get(cameraEl, "scale") || 1;
    const screenX = view.x + view.w / 2 + vx;
    const screenY = view.y + view.h / 2 + vy;
    const target = toWorld((view.w / 2 - cx) / cs / config.cell, (view.h / 2 - cy) / cs / config.cell);
    const spanCells = view.w / (cs * config.cell);
    const worldPerPx = (spanCells * CELL) / (view.w * vs);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    // Closer than the 2D board (its window is small) when the board is centered (stage);
    // wider when it sits beside the panel (side). Close-ups push in a little further.
    const centered = clamp01((screenX - (view.x + view.w / 2)) / (W / 2 - (view.x + view.w / 2)));
    const closeness = 1.3 + (0.85 - 1.3) * centered;
    const dist = (closeness * H * worldPerPx) / (2 * Math.tan(fov / 2)) / (1 + 0.3 * (cs - 1));
    const az = 0.55 + 0.32 * Math.sin(t * 0.045) + 0.06 * Math.sin(t * 0.17); // decorative sway
    let el = 0.92;
    let camDist = dist;
    // Taser hits take the camera: a low, tight shot on everyone involved, from the raise to just
    // after the zap (positions come from the token proxies at that moment).
    let shotW = 0;
    const involved = [];
    for (const [r0, , e0, actor, victim, hit] of taserCfg?.strikes ?? []) {
      if (!hit) continue;
      const w = ease((t - (r0 - 0.4)) / 0.6) * (1 - ease((t - (e0 + 0.9)) / 0.7));
      if (w <= 0) continue;
      shotW = Math.max(shotW, w);
      for (const id of [actor, victim]) {
        const el2 = document.getElementById(`tok-${id}`);
        if (el2) involved.push(toWorld((get(el2, "x") + config.token / 2) / config.cell, (get(el2, "y") + config.token / 2) / config.cell));
      }
    }
    if (shotW > 0 && involved.length) {
      const c = involved.reduce((m, q) => m.add(q), new THREE.Vector3()).multiplyScalar(1 / involved.length);
      // Fit the group across the frame width (16:9 with a 30° vertical fov: ~0.95 × distance wide).
      const span = Math.max(...involved.map((q) => q.distanceTo(c))) * 2 + 0.6;
      target.lerp(c.setY(0.4), shotW); // aim a little above the floor: the group sits in the middle of the frame
      camDist = dist + (span * 1.35 - dist) * shotW;
      el = 0.92 + (0.5 - 0.92) * shotW;
    }
    camera.position.set(target.x + camDist * Math.sin(az) * Math.cos(el), target.y + camDist * Math.sin(el), target.z + camDist * Math.cos(az) * Math.cos(el));
    camera.lookAt(target);
    camera.setViewOffset(W, H, W / 2 - screenX, H / 2 - screenY, W, H);
    camera.updateMatrixWorld();

    // Backdrop undulation.
    const p = gridGeo.attributes.position.array;
    for (let j = 0; j < p.length; j += 3) {
      p[j + 1] = base[j + 1] + Math.sin(base[j] * 0.22 + t * 0.9) * 0.4 + Math.cos(base[j + 2] * 0.18 + t * 0.6) * 0.4;
    }
    gridGeo.attributes.position.needsUpdate = true;

    // Rats from the token proxies.
    // Speech at t (from the logged dialogue timing): who speaks, who heard it, and a 0..1 weight
    // that eases in and out so heads turn smoothly.
    let speech = null;
    for (const [t0, t1, speaker, listeners] of config.speeches ?? []) {
      if (t >= t0 - 0.4 && t <= t1 + 0.3) {
        const w = ease(Math.min((t - (t0 - 0.4)) / 0.4, (t1 + 0.3 - t) / 0.3));
        if (!speech || w > speech.w) speech = { speaker, listeners, w };
      }
    }
    const turnTo = (from, to, w) => {
      let d = to - from;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest way round
      return from + d * w;
    };

    // First pass: where each rat stands.
    const placed = new Map();
    for (const a of agents) {
      const scale = get(a.el, "scale");
      if (scale <= 0.01) continue;
      placed.set(a.id, { scale, pos: toWorld((get(a.el, "x") + config.token / 2) / config.cell, (get(a.el, "y") + config.token / 2) / config.cell) });
    }
    const facingTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

    for (const a of agents) {
      const here = placed.get(a.id);
      const visible = Boolean(here);
      a.rat.visible = visible;
      a.ring.visible = visible;
      if (!visible) {
        a.tag.style.opacity = "0";
        continue;
      }
      const { scale, pos } = here;
      let walk = 0, facing = az + (a.seed % 1 - 0.5) * 0.6;
      for (const [t0, dur, fx, fy, tx, ty] of config.moves[a.id] ?? []) {
        if (t >= t0 && t <= t0 + dur && Math.hypot(tx - fx, ty - fy) > 0.05) {
          walk = ease(Math.min(t - t0, t0 + dur - t) / 0.15);
          facing = Math.atan2(tx - fx, ty - fy);
        }
      }
      // In a dialogue, the speaker faces its listeners and each listener faces the speaker.
      let talk = 0, speaking = 0;
      if (speech && !walk) {
        const other = (id) => placed.get(id)?.pos;
        if (speech.speaker === a.id) {
          const targets = speech.listeners.map(other).filter((q) => q && q.distanceTo(pos) > 0.01);
          if (targets.length) {
            const c = targets.reduce((m, q) => m.add(q), new THREE.Vector3()).multiplyScalar(1 / targets.length);
            facing = turnTo(facing, facingTo(pos, c), speech.w);
          }
          talk = speech.w;
          speaking = speech.w;
        } else if (speech.listeners.includes(a.id)) {
          const s = other(speech.speaker);
          if (s && s.distanceTo(pos) > 0.01) facing = turnTo(facing, facingTo(pos, s), speech.w);
        }
      }
      const off = clamp01((1 - Number(window.gsap.getProperty(a.el, "opacity"))) / 0.75);
      const tense = a.tenseEl ? clamp01(Number(window.gsap.getProperty(a.tenseEl, "opacity"))) : 0;
      a.rat.position.copy(pos);
      // Taser beats: the actor turns to its target and raises the taser; the target turns to the actor.
      let raise = 0, shake = 0;
      for (const [r0, z0, e0, actor, target, hit] of taserCfg?.strikes ?? []) {
        const w = ease((t - r0) / 0.3) * (1 - ease((t - e0 - 0.25) / 0.4));
        if (w <= 0) continue;
        const me = actor === a.id, them = target === a.id;
        if (!me && !them) continue;
        const other = placed.get(me ? target : actor)?.pos;
        if (other && other.distanceTo(pos) > 0.01) facing = turnTo(facing, facingTo(pos, other), w);
        if (me) raise = Math.max(raise, w);
        if (them && hit && t >= z0 && t <= e0) shake = (hash(Math.floor(t * 30) + a.seed) - 0.5) * 0.3;
      }
      a.rat.rotation.set(0, facing, (get(a.el, "rotation") * Math.PI) / 180 + shake);
      a.rat.scale.setScalar(RAT_SCALE * Math.min(1, scale));
      poseRat(a.rat, t, { walk, talk, off, tense, seed: a.seed });
      if (a.taser) {
        const charges = chargesAt(a.id, t);
        a.taser.visible = charges > 0; // no charges, no taser: an attempt without one is only a gesture
        if (raise > 0) a.rat.userData.arms[0].rotation.set(-1.45 * raise - 0.1 * (1 - raise), 0.15 * raise, -0.12);
        a.leds.forEach((m, k) => { m.emissiveIntensity = k < charges ? 2 : 0; m.emissive.set("#3dff8f"); });
      }
      // The yellow ring marks who is speaking (listeners are named in the dialogue box).
      a.ring.position.copy(pos).setY(0.02);
      a.ring.material.opacity = speaking;
      a.ring.scale.setScalar(1 + 0.06 * Math.sin(t * 6) * speaking);
      const [sx, sy] = project(pos.clone().setY(0.78 * RAT_SCALE * 1.45));
      a.tag.style.opacity = String(Math.min(1, scale) * (1 - off * 0.5));
      a.tag.style.left = `${sx}px`;
      a.tag.style.top = `${sy}px`;
    }

    // Taser effects: bolts on hits (slowed down at impact), a sputter on rejected attempts.
    for (const m of bolts) { scene.remove(m); m.geometry.dispose(); }
    bolts.length = 0;
    zapLights.forEach((l) => (l.intensity = 0));
    let spark = 0;
    sparks.forEach((m) => (m.visible = false));
    const tipPos = new THREE.Vector3();
    for (const [, z0, e0, actor, target, hit] of taserCfg?.strikes ?? []) {
      if (t < z0 || t > e0 + 0.6) continue;
      const a = agents.find((x) => x.id === actor);
      const goal = placed.get(target)?.pos;
      if (!a?.tip || !placed.get(actor) || !goal) continue;
      a.rat.updateMatrixWorld(true);
      a.tip.getWorldPosition(tipPos);
      const slow = z0 + (t - z0) * 0.5; // impact in slow motion (effects only; audio and log timing untouched)
      const f = Math.floor(slow * 30);
      if (hit && t <= e0) {
        const chest = goal.clone().setY(0.21);
        const bolt = (from, to, n, amp, seed) => {
          const pts = [];
          for (let i = 0; i <= n; i++) {
            const q = from.clone().lerp(to, i / n);
            if (i > 0 && i < n) q.add(new THREE.Vector3((hash(seed + i * 1.3) - 0.5) * amp * 0.5, (hash(seed * 7 + i) - 0.5) * amp, (hash(seed * 3 + i * 5) - 0.5) * amp));
            pts.push(q);
          }
          const path = new THREE.CurvePath();
          for (let i = 0; i < n; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
          return { path, pts };
        };
        const addTube = (path, r, mat) => { const m = new THREE.Mesh(new THREE.TubeGeometry(path, 80, r, 5), mat); scene.add(m); bolts.push(m); };
        const main = bolt(tipPos, chest, 14, 0.09, f * 17 + actor.length);
        addTube(main.path, 0.0028, boltCore);
        addTube(main.path, 0.01, boltGlow);
        for (const k of [4, 9]) {
          const from = main.pts[k];
          const to = from.clone().add(new THREE.Vector3((hash(f + k) - 0.5) * 0.14, (hash(f * 2 + k) - 0.3) * 0.14, (hash(f * 3 + k) - 0.5) * 0.14));
          addTube(bolt(from, to, 4, 0.03, f * 5 + k).path, 0.0018, boltCore);
        }
        boltCore.opacity = 0.75 + 0.25 * hash(f);
        const light = zapLights.find((l) => l.intensity === 0);
        if (light) { light.position.copy(chest); light.intensity = 2 + 1.5 * hash(f + 5); }
      }
      // Sparks: a burst at the target on a hit, a small sputter at the prongs on a rejected attempt.
      if (!hit && chargesAt(actor, z0) === 0) continue; // nothing in hand: no sputter
      const origin = hit ? goal.clone().setY(0.21) : tipPos.clone();
      const count = hit ? 14 : 6;
      const life = hit ? e0 - z0 + 0.6 : 0.4;
      for (let i = 0; i < count && spark < sparks.length; i++, spark++) {
        const age = ((slow - z0) + (i % 5) * 0.03) % 0.45;
        if (t - z0 > life) break;
        const m = sparks[spark];
        const dir = new THREE.Vector3(hash(i * 3.1) - 0.5, hash(i * 5.7) * 0.8, hash(i * 9.3) - 0.5).normalize();
        m.visible = true;
        m.position.copy(origin).addScaledVector(dir, age * (hit ? 0.45 : 0.18)).add(new THREE.Vector3(0, -age * age * 0.8, 0));
        m.material.opacity = 1 - age / 0.45;
      }
      if (!hit && a.leds && t <= e0) a.leds.forEach((m) => m.emissive.set("#ff5050"));
    }

    // Action callouts: above the actor's start-of-turn spot, stacked per cell.
    for (const c of callouts) {
      if (Number(window.gsap.getProperty(c, "opacity")) <= 0) continue;
      const [sx, sy] = project(toWorld(Number(c.dataset.u), Number(c.dataset.v)).setY(0.78 * RAT_SCALE * 1.45));
      const w = Number(c.dataset.w);
      c.style.left = `${Math.min(W - w - 8, Math.max(8, sx - w / 2))}px`;
      c.style.top = `${Math.max(8, sy - 26 - 26 * (Number(c.dataset.k) + 1))}px`;
    }

    renderer.render(scene, camera);
  };
}
