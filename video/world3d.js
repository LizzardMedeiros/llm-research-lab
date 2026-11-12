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
function makeRat(hex, feminine) {
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
function poseRat(r, t, { walk = 0, talk = 0, off = 0, tense = 0, seed = 0 }) {
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
    const el = 0.92;
    camera.position.set(target.x + dist * Math.sin(az) * Math.cos(el), target.y + dist * Math.sin(el), target.z + dist * Math.cos(az) * Math.cos(el));
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
      a.rat.rotation.set(0, facing, (get(a.el, "rotation") * Math.PI) / 180);
      a.rat.scale.setScalar(RAT_SCALE * Math.min(1, scale));
      poseRat(a.rat, t, { walk, talk, off, tense, seed: a.seed });
      // The yellow ring marks who is speaking (listeners are named in the dialogue box).
      a.ring.position.copy(pos).setY(0.02);
      a.ring.material.opacity = speaking;
      a.ring.scale.setScalar(1 + 0.06 * Math.sin(t * 6) * speaking);
      const [sx, sy] = project(pos.clone().setY(0.78 * RAT_SCALE * 1.45));
      a.tag.style.opacity = String(Math.min(1, scale) * (1 - off * 0.5));
      a.tag.style.left = `${sx}px`;
      a.tag.style.top = `${sy}px`;
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
