// finalREV redesign — interactive CNC simulator: 3-axis mill, millturn and 5-axis trunnion.
// The stock is a signed-distance voxel field polygonised with marching cubes, so every tool move
// really removes material. Milling carves a capsule (ball end mill); turning carves the tool's
// profile revolved around the spindle axis.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const wrapPi = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

export function initCNC({ machine: initialMachine = '5x' } = {}) {
  const stage = $('#cnc-stage');
  const canvas = $('#cnc-canvas');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LOW = coarse || (navigator.hardwareConcurrency || 8) <= 4;

  // ------------------------------------------------------------------ constants
  const S = 1.35; // world units per part unit
  const TOOL_R = 0.065; // tool nose / ball radius, part units
  const TOOL_LEN = 1.2; // carve length up the tool axis, part units
  const RES = LOW ? 52 : 68;
  const HALF = RES / 2;
  const R2 = RES * RES;
  const MM = 40; // DRO millimetres per world unit
  const RAPID_V = 5.2, A_RAPID = 2.6, C_RAPID = 5.0, A_FEED = 1.8, C_FEED = 5.2;
  const LATHE_W = 16; // lathe spindle speed while turning, rad per program-second
  const X_AXIS = new V3(1, 0, 0), Y_AXIS = new V3(0, 1, 0);
  const GREEN = new THREE.Color(0xc8ff00);

  // ------------------------------------------------------------------ renderer
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    $('#stage-fallback').hidden = false;
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, LOW ? 1.5 : 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = !LOW;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d0b);
  scene.fog = new THREE.Fog(0x0b0d0b, 22, 48);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.42;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 120);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.rotateSpeed = 0.55;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.48;
  controls.enabled = !coarse;
  canvas.style.touchAction = coarse ? 'pan-y' : 'none';

  const VIEWS = {
    iso: { pos: new V3(13.2, 10.6, 17.6), target: new V3(0, 4.0, 0) },
    front: { pos: new V3(0, 7.0, 27), target: new V3(0, 4.9, 0) },
    top: { pos: new V3(0.01, 26, 5.5), target: new V3(0, 3.0, 0.4) },
  };
  camera.position.copy(VIEWS.iso.pos);
  controls.target.copy(VIEWS.iso.target);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: LOW ? 0 : 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.4, 0.95));
  composer.addPass(new OutputPass());

  // ------------------------------------------------------------------ lights
  scene.add(new THREE.HemisphereLight(0xe4e8e2, 0x040504, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(7, 14, 9);
  key.castShadow = !LOW;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 10, bottom: -6, near: 1, far: 40 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe8ff, 1.0);
  rim.position.set(-9, 7, -8);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x9ab8ff, 0.35);
  fill.position.set(-8, 3, 10);
  scene.add(fill);
  const toolLight = new THREE.PointLight(0xc8ff00, 0, 4, 2);
  scene.add(toolLight);

  // ------------------------------------------------------------------ materials
  const M = {
    body: new THREE.MeshStandardMaterial({ color: 0x141816, metalness: 0.55, roughness: 0.42 }),
    body2: new THREE.MeshStandardMaterial({ color: 0x1e2421, metalness: 0.6, roughness: 0.34 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xaab3b6, metalness: 1, roughness: 0.24 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x060808, metalness: 0.2, roughness: 0.8 }),
    glow: new THREE.MeshBasicMaterial({ color: GREEN.clone().multiplyScalar(2.4) }),
    glowDim: new THREE.MeshBasicMaterial({ color: GREEN.clone().multiplyScalar(0.8) }),
    tool: new THREE.MeshStandardMaterial({ color: 0xe4eaed, metalness: 1, roughness: 0.16, map: stripeTexture() }),
    shank: new THREE.MeshStandardMaterial({ color: 0xc9d0d3, metalness: 1, roughness: 0.2 }),
    insert: new THREE.MeshStandardMaterial({ color: 0x3a4044, metalness: 0.9, roughness: 0.3 }),
    stock: new THREE.MeshStandardMaterial({ color: 0xc6ced2, metalness: 0.9, roughness: 0.3 }),
    chip: new THREE.MeshStandardMaterial({ color: 0xdbe2e5, metalness: 1, roughness: 0.22 }),
  };

  function stripeTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#eef2f4';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#4c5559';
    for (let i = -64; i < 128; i += 16) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i + 7, 0); g.lineTo(i + 39, 64); g.lineTo(i + 32, 64);
      g.closePath(); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ------------------------------------------------------------------ geometry helpers
  function box(w, h, d, mat, x, y, z, { r = 0.05, parent = scene, cast = true } = {}) {
    const rr = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
    const g = rr > 0.004 ? new RoundedBoxGeometry(w, h, d, 2, rr) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = cast && mat !== M.glow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function cyl(rTop, rBot, h, mat, x, y, z, { parent = scene, seg = 40, axis = 'y' } = {}) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat);
    m.position.set(x, y, z);
    if (axis === 'x') m.rotation.z = Math.PI / 2;
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.castShadow = mat !== M.glow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  function ring(r, tube, mat, x, y, z, { parent = scene, axis = 'y' } = {}) {
    const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 72), mat);
    m.position.set(x, y, z);
    if (axis === 'y') m.rotation.x = Math.PI / 2;
    if (axis === 'x') m.rotation.y = Math.PI / 2;
    parent.add(m);
    return m;
  }

  // ------------------------------------------------------------------ room (theme-aware)
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshStandardMaterial({ color: 0x0d100e, roughness: 0.92, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  let grid = null;
  let glow = null;
  function applyTheme(theme) {
    const light = theme === 'light';
    const room = new THREE.Color(light ? 0xe6e9e2 : 0x0b0d0b);
    scene.background = room;
    scene.fog.color.copy(room);
    floor.material.color.set(light ? 0xdde1d9 : 0x0d100e);
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(80, 80, light ? 0xa9afa7 : 0x2e3530, light ? 0xc6cbc3 : 0x1a1f1b);
    grid.material.transparent = true;
    grid.material.opacity = light ? 0.7 : 0.4;
    grid.position.y = 0.003;
    scene.add(grid);
    if (glow) glow.visible = !light;
  }
  {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(242,244,239,0.16)');
    grad.addColorStop(0.4, 'rgba(242,244,239,0.05)');
    grad.addColorStop(1, 'rgba(242,244,239,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    glow = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.006;
    scene.add(glow);
  }
  applyTheme(document.documentElement.dataset.theme);
  document.addEventListener('themechange', (e) => applyTheme(e.detail.theme));

  // ------------------------------------------------------------------ shared gantry
  box(9.6, 1.1, 7.2, M.body, 0, 0.55, 0, { r: 0.14 });
  box(9.3, 0.1, 6.9, M.body2, 0, 1.15, 0, { r: 0.04 });
  box(8.6, 0.035, 0.035, M.glow, 0, 0.92, 3.61, { r: 0 });
  for (const sx of [-1, 1]) {
    box(0.035, 0.035, 6.4, M.glow, sx * 4.81, 0.92, 0, { r: 0 });
    for (const sz of [-1, 1]) box(0.8, 0.12, 0.8, M.dark, sx * 4.1, 0.06, sz * 2.9, { r: 0.03 });
    box(0.75, 5.1, 7.0, M.body, sx * 4.3, 3.75, 0, { r: 0.12 });
    box(0.3, 0.12, 6.8, M.steel, sx * 4.3, 6.36, 0, { r: 0.03 });
    box(0.035, 4.5, 0.035, M.glow, sx * 3.94, 3.7, 3.49, { r: 0 });
  }
  const bridge = new THREE.Group();
  scene.add(bridge);
  box(9.4, 0.9, 0.9, M.body, 0, 7.0, -1.1, { r: 0.12, parent: bridge });
  for (const sx of [-1, 1]) box(0.95, 0.3, 1.3, M.body2, sx * 4.3, 6.57, -1.1, { parent: bridge });
  box(8.8, 0.08, 0.1, M.steel, 0, 7.27, -0.61, { r: 0.02, parent: bridge });
  box(8.8, 0.08, 0.1, M.steel, 0, 6.73, -0.61, { r: 0.02, parent: bridge });
  box(8.2, 0.03, 0.03, M.glow, 0, 6.53, -0.72, { r: 0, parent: bridge });

  const carriage = new THREE.Group();
  bridge.add(carriage);
  box(1.3, 1.25, 0.2, M.body2, 0, 7.0, -0.52, { parent: carriage });
  box(0.95, 3.6, 0.95, M.body, 0, 8.4, 0, { r: 0.12, parent: carriage });
  box(0.03, 3.1, 0.03, M.glow, 0.3, 8.45, 0.48, { r: 0, parent: carriage });
  box(0.6, 0.06, 0.6, M.steel, 0, 6.58, 0, { r: 0.02, parent: carriage });

  // ram (Z) — its origin is the tool's nose / ball centre
  const ram = new THREE.Group();
  carriage.add(ram);
  const TR = TOOL_R * S;
  box(0.5, 3.4, 0.5, M.body2, 0, 1.75 + 1.7, 0, { r: 0.05, parent: ram });
  cyl(0.34, 0.34, 0.7, M.body, 0, 1.4, 0, { parent: ram });
  for (let i = 0; i < 4; i++) cyl(0.37, 0.37, 0.035, M.body2, 0, 1.2 + i * 0.15, 0, { parent: ram });
  const ledRing = ring(0.35, 0.024, M.glow, 0, 1.06, 0, { parent: ram });
  cyl(0.24, 0.27, 0.1, M.steel, 0, 1.0, 0, { parent: ram });
  cyl(0.2, 0.13, 0.23, M.steel, 0, 0.835, 0, { parent: ram });
  cyl(0.13, 0.13, 0.1, M.steel, 0, 0.67, 0, { parent: ram });
  // milling tool
  const spinner = new THREE.Group();
  ram.add(spinner);
  cyl(0.075, 0.075, 0.22, M.shank, 0, 0.51, 0, { parent: spinner, seg: 24 });
  const flute = cyl(TR, TR, 0.4, M.tool, 0, 0.2, 0, { parent: spinner, seg: 24 });
  flute.material.map.repeat.set(2, 1);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(TR, 24, 12, 0, TAU, Math.PI / 2, Math.PI / 2), M.tool);
  ball.castShadow = true;
  spinner.add(ball);
  // turning tool: square holder with a diamond insert whose nose sits at the ram origin
  const turnTool = new THREE.Group();
  ram.add(turnTool);
  box(0.17, 0.58, 0.17, M.body2, 0, 0.33, 0, { r: 0.02, parent: turnTool });
  const insert = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), M.insert);
  insert.scale.set(1, 0.42, 0.62);
  insert.position.y = -TR + 0.046;
  insert.castShadow = true;
  turnTool.add(insert);
  turnTool.visible = false;

  // ------------------------------------------------------------------ fixtures (one per machine)
  // 5-axis: trunnion A + rotary C
  const fix5 = new THREE.Group();
  scene.add(fix5);
  const PIVOT5 = new V3(0, 3.0, 0);
  for (const sx of [-1, 1]) {
    box(0.55, 2.55, 1.3, M.body, sx * 2.25, 2.475, 0, { r: 0.08, parent: fix5 });
    cyl(0.36, 0.36, 0.24, M.body2, sx * 1.95, PIVOT5.y, 0, { axis: 'x', parent: fix5 });
  }
  ring(0.3, 0.018, M.glow, 2.54, PIVOT5.y, 0, { axis: 'x', parent: fix5 });
  ring(0.3, 0.018, M.glowDim, -2.54, PIVOT5.y, 0, { axis: 'x', parent: fix5 });
  const aGroup = new THREE.Group();
  aGroup.position.copy(PIVOT5);
  fix5.add(aGroup);
  for (const sx of [-1, 1]) {
    box(0.26, 1.8, 1.25, M.body2, sx * 1.7, -0.72, 0, { parent: aGroup });
    cyl(0.3, 0.3, 0.1, M.steel, sx * 1.86, 0, 0, { parent: aGroup, axis: 'x' });
  }
  box(3.66, 0.28, 1.9, M.body2, 0, -1.46, 0, { parent: aGroup });
  box(3.2, 0.025, 0.025, M.glow, 0, -1.46, 0.96, { r: 0, parent: aGroup });
  cyl(0.62, 0.62, 0.14, M.body, 0, -1.25, 0, { parent: aGroup });
  const cGroup = new THREE.Group();
  cGroup.position.set(0, -0.89, 0);
  aGroup.add(cGroup);
  cyl(1.02, 1.02, 0.3, M.steel, 0, -0.15, 0, { parent: cGroup, seg: 64 });
  for (let i = 0; i < 3; i++) {
    const slot = box(1.9, 0.02, 0.07, M.dark, 0, 0.002, 0, { r: 0, parent: cGroup, cast: false });
    slot.rotation.y = (i * Math.PI) / 3;
  }
  ring(1.005, 0.016, M.glow, 0, -0.03, 0, { parent: cGroup });
  for (let i = 0; i < 24; i++) {
    const t = box(0.012, 0.012, 0.09, i % 6 ? M.glowDim : M.glow, 0, -0.1, 0, { r: 0, parent: cGroup });
    const a = (i / 24) * TAU;
    t.position.set(Math.sin(a) * 1.03, -0.1, Math.cos(a) * 1.03);
    t.rotation.y = a;
  }
  cyl(0.4, 0.46, 0.35, M.body2, 0, 0.175, 0, { parent: cGroup });

  // 3-axis: table + vise on parallels
  const fix3 = new THREE.Group();
  scene.add(fix3);
  const PIVOT3 = new V3(0, 2.9, 0);
  box(5.2, 0.24, 3.2, M.body2, 0, 1.32, 0, { r: 0.04, parent: fix3 });
  for (let i = -3; i <= 3; i++) box(5.0, 0.02, 0.09, M.dark, 0, 1.445, i * 0.42, { r: 0, parent: fix3, cast: false });
  box(4.9, 0.03, 0.03, M.glow, 0, 1.3, 1.61, { r: 0, parent: fix3 });
  box(2.6, 0.3, 1.5, M.body, 0, 1.59, 0, { r: 0.05, parent: fix3 });
  box(2.4, 0.7, 1.1, M.body2, 0, 2.09, 0, { r: 0.04, parent: fix3 });
  for (const sz of [-1, 1]) box(2.3, 0.18, 0.1, M.steel, 0, 2.54, sz * 0.25, { r: 0.01, parent: fix3 });
  for (const sz of [-1, 1]) box(2.4, 0.5, 0.24, M.body, 0, 2.64, sz * 0.87, { r: 0.03, parent: fix3 });
  cyl(0.06, 0.06, 0.9, M.steel, 0, 2.2, 1.45, { axis: 'z', parent: fix3 });
  box(0.9, 0.06, 0.06, M.steel, 0, 2.2, 1.92, { r: 0.02, parent: fix3 });

  // millturn: headstock + rotating 3-jaw chuck (spindle axis along world X)
  const fixMT = new THREE.Group();
  scene.add(fixMT);
  const PIVOTM = new V3(-0.1, 3.0, 0);
  box(1.3, 2.9, 2.0, M.body, -2.4, 2.65, 0, { r: 0.1, parent: fixMT });
  cyl(0.82, 0.82, 0.12, M.steel, -1.69, PIVOTM.y, 0, { axis: 'x', parent: fixMT });
  ring(0.84, 0.02, M.glow, -1.74, PIVOTM.y, 0, { axis: 'x', parent: fixMT });
  box(0.03, 2.4, 0.03, M.glow, -1.76, 2.6, 1.01, { r: 0, parent: fixMT });
  const chuck = new THREE.Group();
  chuck.position.set(0, PIVOTM.y, PIVOTM.z);
  fixMT.add(chuck);
  cyl(0.72, 0.72, 0.3, M.body2, -1.48, 0, 0, { axis: 'x', parent: chuck, seg: 48 });
  cyl(0.74, 0.74, 0.04, M.steel, -1.33, 0, 0, { axis: 'x', parent: chuck, seg: 48 });
  for (let i = 0; i < 3; i++) {
    const jaw = new THREE.Group();
    jaw.rotation.x = (i * TAU) / 3;
    chuck.add(jaw);
    box(0.32, 0.18, 0.2, M.steel, -1.17, 0.66, 0, { r: 0.02, parent: jaw });
  }

  // part frames: partHolder carries the machine's part rotation; turnFrame does not rotate
  const partHolder = new THREE.Group();
  scene.add(partHolder);
  const partFrame = new THREE.Group();
  partFrame.scale.setScalar(S);
  partHolder.add(partFrame);
  const turnFrame = new THREE.Group();
  turnFrame.scale.setScalar(S);
  scene.add(turnFrame);

  // ------------------------------------------------------------------ stock (marching cubes)
  const mc = new MarchingCubes(RES, M.stock, false, false, LOW ? 90000 : 160000);
  mc.isolation = 0;
  mc.castShadow = !LOW;
  mc.receiveShadow = true;
  mc.frustumCulled = false;
  mc.geometry.boundingSphere = new THREE.Sphere(new V3(), 1.8);
  partFrame.add(mc);
  const field = mc.field;
  // grid ↔ part mapping, per axis so each stock shape uses the full grid
  let KX = 1, KY = 1, KZ = 1;
  const PX = new Float32Array(RES), PY = new Float32Array(RES), PZ = new Float32Array(RES);
  const SB = { x0: 1, x1: RES - 2, y0: 1, y1: RES - 2, z0: 1, z1: RES - 2 };
  const gIdx = (v, k) => (v * k + 1) * HALF;
  let mcDirty = true;

  function setGrid(h) {
    KX = 0.93 / h.x; KY = 0.93 / h.y; KZ = 0.93 / h.z;
    for (let i = 0; i < RES; i++) {
      const u = i / HALF - 1;
      PX[i] = u / KX; PY[i] = u / KY; PZ[i] = u / KZ;
    }
    SB.x0 = Math.max(1, Math.floor(gIdx(-h.x, KX)) - 2); SB.x1 = Math.min(RES - 2, Math.ceil(gIdx(h.x, KX)) + 2);
    SB.y0 = Math.max(1, Math.floor(gIdx(-h.y, KY)) - 2); SB.y1 = Math.min(RES - 2, Math.ceil(gIdx(h.y, KY)) + 2);
    SB.z0 = Math.max(1, Math.floor(gIdx(-h.z, KZ)) - 2); SB.z1 = Math.min(RES - 2, Math.ceil(gIdx(h.z, KZ)) + 2);
    mc.scale.set(1 / KX, 1 / KY, 1 / KZ);
  }

  function resetStock() {
    const { shape, half: h } = mach.stock;
    for (let z = 0; z < RES; z++) {
      const Z = PZ[z];
      for (let y = 0; y < RES; y++) {
        const Y = PY[y];
        const row = y * RES + z * R2;
        const side = shape === 'cyl' ? h.y - Math.sqrt(Y * Y + Z * Z) : Math.min(h.y - Math.abs(Y), h.z - Math.abs(Z));
        for (let x = 0; x < RES; x++) {
          const dx = h.x - Math.abs(PX[x]);
          field[row + x] = dx < side ? dx : side;
        }
      }
    }
    mcDirty = true;
  }

  // mill: remove everything inside a capsule (ball centre p, axis n), part units
  function carve(p, n) {
    const r = TOOL_R, L = TOOL_LEN;
    const ax = p.x, ay = p.y, az = p.z, nx = n.x, ny = n.y, nz = n.z;
    const bx = ax + nx * L, by = ay + ny * L, bz = az + nz * L;
    const x0 = Math.max(SB.x0, Math.floor(gIdx(Math.min(ax, bx) - r, KX)) - 1), x1 = Math.min(SB.x1, Math.ceil(gIdx(Math.max(ax, bx) + r, KX)) + 1);
    const y0 = Math.max(SB.y0, Math.floor(gIdx(Math.min(ay, by) - r, KY)) - 1), y1 = Math.min(SB.y1, Math.ceil(gIdx(Math.max(ay, by) + r, KY)) + 1);
    const z0 = Math.max(SB.z0, Math.floor(gIdx(Math.min(az, bz) - r, KZ)) - 1), z1 = Math.min(SB.z1, Math.ceil(gIdx(Math.max(az, bz) + r, KZ)) + 1);
    if (x0 > x1 || y0 > y1 || z0 > z1) return 0;
    let removed = 0;
    for (let z = z0; z <= z1; z++) {
      const pz = PZ[z] - az;
      for (let y = y0; y <= y1; y++) {
        const py = PY[y] - ay;
        const row = y * RES + z * R2;
        for (let x = x0; x <= x1; x++) {
          const px = PX[x] - ax;
          let t = px * nx + py * ny + pz * nz;
          t = t < 0 ? 0 : t > L ? L : t;
          const qx = px - nx * t, qy = py - ny * t, qz = pz - nz * t;
          const d = Math.sqrt(qx * qx + qy * qy + qz * qz) - r;
          const i = row + x;
          const old = field[i];
          if (d < old) { field[i] = d; if (old > 0) removed++; }
        }
      }
    }
    if (removed) mcDirty = true;
    return removed;
  }

  // turn: remove the tool nose (centre at axial xc, radius rc) swept all the way round the part's X axis
  function carveTurn(xc, rc) {
    const r = TOOL_R;
    if (rc - r > mach.stock.half.y + 0.01) return 0;
    const x0 = Math.max(SB.x0, Math.floor(gIdx(xc - r, KX)) - 1), x1 = Math.min(SB.x1, Math.ceil(gIdx(xc + r, KX)) + 1);
    if (x0 > x1) return 0;
    let removed = 0;
    for (let z = SB.z0; z <= SB.z1; z++) {
      const Z = PZ[z];
      for (let y = SB.y0; y <= SB.y1; y++) {
        const Y = PY[y];
        const dr = Math.sqrt(Y * Y + Z * Z) - rc;
        if (dr < -r) continue;
        const row = y * RES + z * R2;
        for (let x = x0; x <= x1; x++) {
          const dx = PX[x] - xc;
          const d = (dr >= 0 ? Math.abs(dx) : Math.sqrt(dx * dx + dr * dr)) - r;
          const i = row + x;
          const old = field[i];
          if (d < old) { field[i] = d; if (old > 0) removed++; }
        }
      }
    }
    if (removed) mcDirty = true;
    return removed;
  }

  function fieldNormal(p) { // outward surface normal from the field gradient
    const gx = clamp(Math.round(gIdx(p.x, KX)), 1, RES - 2), gy = clamp(Math.round(gIdx(p.y, KY)), 1, RES - 2), gz = clamp(Math.round(gIdx(p.z, KZ)), 1, RES - 2);
    const i = gx + gy * RES + gz * R2;
    return new V3((field[i - 1] - field[i + 1]) * KX, (field[i - RES] - field[i + RES]) * KY, (field[i - R2] - field[i + R2]) * KZ).normalize();
  }

  // ------------------------------------------------------------------ machine definitions
  const _qA = new THREE.Quaternion(), _qC = new THREE.Quaternion();
  const MACHINES = {
    '3x': {
      id: '3x', label: '3-axis mill', pivot: PIVOT3, fixture: fix3,
      stock: { shape: 'box', half: new V3(0.85, 0.2, 0.55) },
      safe: 3.75, home: { x: 0, y: 4.0, z: 1.3, a: 0, c: 0 }, ymin: 2.35, axes: ['x', 'y', 'z'],
      quat: (a, c, q) => q.identity(),
      acFor: (n) => (n.y > 0.85 ? { a: 0, c: 0, n: new V3(0, 1, 0) } : null),
      unreachable: '3-axis only reaches faces that point up — switch to 5-axis for the sides.',
      build: build3x,
    },
    mt: {
      id: 'mt', label: 'Millturn', pivot: PIVOTM, fixture: fixMT,
      stock: { shape: 'cyl', half: new V3(0.9, 0.42, 0.42) },
      safe: 4.05, home: { x: 1.8, y: 4.3, z: 0, a: 0, c: 0 }, ymin: 2.3, axes: ['x', 'y', 'z', 'c'],
      quat: (a, c, q) => q.setFromAxisAngle(X_AXIS, c),
      acFor: (n, prevC) => {
        if (Math.abs(n.x) > 0.6) return null;
        const rn = new V3(0, n.y, n.z).normalize();
        const c = Math.atan2(-rn.z, rn.y);
        return { a: 0, c: prevC + wrapPi(c - prevC), n: rn };
      },
      unreachable: 'The end face needs a turret tool — click the side of the shaft.',
      build: buildMT,
    },
    '5x': {
      id: '5x', label: '5-axis trunnion', pivot: PIVOT5, fixture: fix5,
      stock: { shape: 'box', half: new V3(0.6, 0.4, 0.6) },
      safe: 4.75, home: { x: 0, y: 5.0, z: 1.5, a: 0, c: 0 }, ymin: 2.3, axes: ['x', 'y', 'z', 'a', 'c'],
      quat: (a, c, q) => q.copy(_qA.setFromAxisAngle(X_AXIS, a)).multiply(_qC.setFromAxisAngle(Y_AXIS, c)),
      acFor: (n, prevC) => {
        if (n.y < -0.3) return null;
        const a = Math.acos(clamp(n.y, -1, 1));
        if (Math.sin(a) < 1e-4) return { a, c: prevC, n };
        return { a, c: prevC + wrapPi(Math.atan2(n.x, -n.z) - prevC), n };
      },
      unreachable: "That face sits on the fixture — the spindle can't reach it.",
      build: build5x,
    },
  };
  let mach = MACHINES['5x'];

  // ------------------------------------------------------------------ kinematics
  const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
  const partQuat = (a, c) => mach.quat(a, c ?? 0, _q);
  const partToWorld = (p, a, c, out = new V3()) => out.copy(p).multiplyScalar(S).applyQuaternion(partQuat(a, c)).add(mach.pivot);
  const worldToPart = (w, a, c, out = new V3()) => out.copy(w).sub(mach.pivot).applyQuaternion(_qi.copy(partQuat(a, c)).invert()).divideScalar(S);
  const axisInPart = (a, c, out = new V3()) => out.set(0, 1, 0).applyQuaternion(_qi.copy(partQuat(a, c)).invert());
  const z0 = () => mach.pivot.y + mach.stock.half.y * S; // stock top = work Z0

  function stateFor(p, n, prevC, mode = 'feed', feed = 1) {
    const ac = mach.acFor(n, prevC) || { a: 0, c: prevC };
    const w = partToWorld(p, ac.a, ac.c);
    return { x: w.x, y: w.y, z: w.z, a: ac.a, c: ac.c, mode, feed };
  }
  // turning: tool nose directly above the spindle axis at axial x, radius rc (part units); c keeps spinning
  function turnState(x, rc, mode = 'feed', feed = 1) {
    return { x: mach.pivot.x + x * S, y: mach.pivot.y + rc * S, z: mach.pivot.z, a: 0, c: null, mode, feed, turn: true };
  }
  function transition(from, to) {
    const out = [];
    const safe = mach.safe;
    if (from.y < safe - 1e-3) out.push({ x: from.x, y: safe, z: from.z, a: from.a, c: to.c == null ? null : from.c, mode: 'rapid', turn: to.turn });
    out.push({ x: to.x, y: Math.max(safe, to.y), z: to.z, a: to.a, c: to.c, mode: 'rapid', turn: to.turn });
    out.push({ ...to, mode: 'rapid' });
    return out;
  }

  // ------------------------------------------------------------------ CAM programs
  const P = (x, y, z) => new V3(x, y, z);

  function build3x(h) {
    const ops = [];
    const up = P(0, 1, 0), r = TOOL_R;
    const top = h.y - 0.025;
    { // face the top
      const pts = [];
      let dir = 1;
      for (let z = -h.z + 0.05; z <= h.z - 0.05 + 1e-6; z += 0.1) {
        const xs = dir > 0 ? [-h.x - 0.1, h.x + 0.1] : [h.x + 0.1, -h.x - 0.1];
        pts.push({ p: P(xs[0], top + r, z), n: up }, { p: P(xs[1], top + r, z), n: up });
        dir = -dir;
      }
      ops.push({ name: 'Face top', kind: '3-AXIS', feed: 2.6, pts, tool: 'mill', header: ['G17 G90 G54', 'T01 M06 (Ø6 BALL)', 'G43 H01 Z50.'] });
    }
    { // rectangular pocket, centre-out loops at two depths
      const pts = [];
      const hx = 0.5, hz = 0.28;
      let first = true;
      for (const fl of [top - 0.06, top - 0.115]) {
        const yc = fl + r;
        if (first) pts.push({ p: P(0, top + r, 0), n: up });
        pts.push({ p: P(0, yc, 0), n: up, feed: 0.35 });
        for (let k = 2; k >= 0; k--) {
          const ax = hx - r - k * 0.09, az = hz - r - k * 0.09;
          pts.push({ p: P(-ax, yc, -az), n: up }, { p: P(ax, yc, -az), n: up }, { p: P(ax, yc, az), n: up }, { p: P(-ax, yc, az), n: up }, { p: P(-ax, yc, -az), n: up });
        }
        pts.push({ p: P(0, yc, 0), n: up });
        first = false;
      }
      ops.push({ name: 'Rectangular pocket', kind: '3-AXIS', feed: 1.6, pts, tool: 'mill', header: ['G41 (POCKET)'] });
    }
    { // counterbored through holes
      const pts = [];
      const holes = [[-0.66, -0.36], [0.66, -0.36], [0.66, 0.36], [-0.66, 0.36]];
      const cr = 0.07, cbY = top - 0.07 + r;
      holes.forEach(([hx, hz], i) => {
        if (i > 0) pts.push({ p: P(hx + cr, top + 0.18, hz), n: up, mode: 'rapid' });
        pts.push({ p: P(hx + cr, top + r, hz), n: up, feed: 0.6 });
        for (let k = 1; k <= 24; k++) { const th = (k / 24) * TAU; pts.push({ p: P(hx + cr * Math.cos(th), lerp(top + r, cbY, k / 24), hz + cr * Math.sin(th)), n: up }); }
        for (let k = 1; k <= 24; k++) { const th = (k / 24) * TAU; pts.push({ p: P(hx + cr * Math.cos(th), cbY, hz + cr * Math.sin(th)), n: up }); }
        pts.push({ p: P(hx, cbY, hz), n: up });
        pts.push({ p: P(hx, -0.05, hz), n: up, feed: 0.45 });
        pts.push({ p: P(hx, cbY + 0.05, hz), n: up, mode: 'rapid' });
        pts.push({ p: P(hx, -h.y - 0.08, hz), n: up, feed: 0.45 });
        pts.push({ p: P(hx, top + 0.18, hz), n: up, mode: 'rapid' });
      });
      ops.push({ name: 'Counterbored holes', kind: '3-AXIS', feed: 1.2, pts, tool: 'mill', header: ['G83 (PECK DRILL)'] });
    }
    return ops;
  }

  function buildMT(h) {
    const ops = [];
    const r = TOOL_R, R = h.y, xEnd = h.x - 0.03;
    const T = (x, rc, extra = {}) => ({ turn: true, x, rc, ...extra });
    { // face the end
      const xf = xEnd + r;
      ops.push({ name: 'Face end', kind: 'TURNING', feed: 0.9, tool: 'turn', turn: true, header: ['G18 G90 (LATHE)', 'T0101 (TURNING)', 'G96 S180 M03'],
        pts: [T(xf, R + 0.12), T(xf, 0), T(xf + 0.06, 0.1, { mode: 'rapid' })] });
    }
    { // rough turn the stepped diameters, working towards the chuck
      const pts = [];
      const passes = [[0.38, -0.6], [0.34, -0.2], [0.3, -0.2], [0.25, 0.35], [0.2, 0.35]];
      for (const [rr, xTo] of passes) {
        pts.push(T(0.97, rr + r + 0.05, { mode: 'rapid' }), T(0.97, rr + r), T(xTo, rr + r), T(xTo + 0.03, rr + r + 0.04));
      }
      ops.push({ name: 'Rough turn diameters', kind: 'TURNING', feed: 1.1, tool: 'turn', turn: true, header: ['G71 (ROUGH TURN)'], pts });
    }
    { // groove
      const gx = 0.02;
      ops.push({ name: 'Groove', kind: 'TURNING', feed: 0.4, tool: 'turn', turn: true, header: ['G75 (GROOVE)'],
        pts: [T(gx, 0.3 + r + 0.05, { mode: 'rapid' }), T(gx, 0.24 + r), T(gx, 0.3 + r + 0.08, { mode: 'rapid' })] });
    }
    { // 45° chamfer on the end
      const o = r / Math.SQRT2, c = 0.05, er = 0.2;
      ops.push({ name: 'Chamfer end', kind: 'TURNING', feed: 0.6, tool: 'turn', turn: true, header: [],
        pts: [T(xEnd - c - 0.03 + o, er + 0.03 + o), T(xEnd + 0.03 + o, er - c - 0.03 + o), T(xEnd + 0.1, 0.3, { mode: 'rapid' })] });
    }
    { // live tool: cross hole through the small diameter, spindle indexed to C0
      const up = P(0, 1, 0), hx = 0.62;
      ops.push({ name: 'Cross hole', kind: 'LIVE TOOLING', feed: 0.5, tool: 'mill', header: ['M19 C0. (SPINDLE ORIENT)', 'T0505 (LIVE Ø6)'],
        pts: [
          { p: P(hx, 0.2 + r, 0), n: up },
          { p: P(hx, -0.05, 0), n: up, feed: 0.35 },
          { p: P(hx, 0.2 + r + 0.05, 0), n: up, mode: 'rapid' },
          { p: P(hx, -0.28, 0), n: up, feed: 0.35 },
        ] });
    }
    { // live tool: two flats, C0 and C180
      const pts = [];
      const fy = 0.24, xs = [-0.15, 0.3];
      for (const side of [1, -1]) {
        const n = P(0, side, 0);
        [-0.18, -0.09, 0, 0.09, 0.18].forEach((z, k) => {
          const a = k % 2 ? xs[1] : xs[0], b = k % 2 ? xs[0] : xs[1];
          pts.push({ p: P(a, side * (fy + r), z), n }, { p: P(b, side * (fy + r), z), n });
        });
        pts.push({ p: P(xs[1], side * (fy + r + 0.3), 0), n, mode: 'rapid' });
      }
      ops.push({ name: 'Mill flats', kind: 'LIVE TOOLING', feed: 1.2, tool: 'mill', header: ['M19 C0. / C180.'], pts });
    }
    return ops;
  }

  function build5x(h) {
    const ops = [];
    const up = P(0, 1, 0);
    { // trench pocket leaving a central boss, helical entry per level
      const pts = [];
      const Rb = 0.2, Ro = 0.5;
      const radii = [Rb + TOOL_R, (Rb + Ro) / 2, Ro - TOOL_R];
      let top = h.y;
      for (const floorY of [0.2, 0.0]) {
        const y0 = top + TOOL_R, y1 = floorY + TOOL_R;
        for (let k = 0; k <= 56; k++) { const th = (k / 56) * TAU; pts.push({ p: P(radii[1] * Math.cos(th), lerp(y0, y1, k / 56), radii[1] * Math.sin(th)), n: up }); }
        for (const rr of [radii[1], radii[0], radii[2]]) for (let k = 0; k <= 64; k++) { const th = (k / 64) * TAU; pts.push({ p: P(rr * Math.cos(th), y1, rr * Math.sin(th)), n: up }); }
        top = floorY;
      }
      ops.push({ name: 'Helical trench pocket', kind: '3-AXIS', feed: 1.5, pts, tool: 'mill', header: ['G17 G90 G54', 'G43 H04 Z50.'] });
    }
    for (let s = 0; s < 4; s++) { // 3+2 indexed sides: slot, window, chamfer
      const c = (s * Math.PI) / 2;
      const n = P(Math.sin(c), 0, -Math.cos(c));
      const t = P(Math.cos(c), 0, Math.sin(c));
      const face = (u, y, depth) => n.clone().multiplyScalar(h.x - depth + TOOL_R).addScaledVector(t, u).setY(y);
      const pts = [];
      let dir = 1;
      for (const d of [0.05, 0.1]) {
        for (let k = 0; k <= 10; k++) pts.push({ p: face((dir > 0 ? -0.34 : 0.34) + dir * 0.068 * k, -0.2, d), n });
        dir = -dir;
      }
      pts.push({ p: face(-0.34, -0.2, -0.28), n, mode: 'rapid' });
      pts.push({ p: face(0, 0.18, -0.28), n, mode: 'rapid' });
      pts.push({ p: face(0, 0.18, 0.09), n, feed: 0.45 });
      pts.push({ p: face(0, 0.18, -0.04), n, mode: 'rapid' });
      pts.push({ p: face(0, 0.18, 0.17), n, feed: 0.45 });
      pts.push({ p: face(0, 0.18, -0.3), n, mode: 'rapid' });
      const nc = up.clone().add(n).normalize();
      const edge = (u) => n.clone().multiplyScalar(h.x).addScaledVector(t, u).setY(h.y);
      pts.push({ p: edge(-0.72).addScaledVector(nc, TOOL_R + 0.3), n: nc, mode: 'rapid' });
      for (let k = 0; k <= 12; k++) pts.push({ p: edge(-0.72 + (1.44 * k) / 12).addScaledVector(nc, TOOL_R - 0.05), n: nc });
      ops.push({ name: `Side ${'ABCD'[s]} · slot, window, chamfer`, kind: '3+2 INDEXED', feed: 1.0, pts, tool: 'mill', header: [`G68.2 X0 Y0 Z0 I0 J90 K${deg(c).toFixed(0)}`, 'G53.1'] });
    }
    { // continuous 5-axis spiral dome, tool normal to the surface
      const pts = [];
      const Cs = P(0, h.y - 0.2, 0), R = 0.2, turns = 7, N = turns * 56, phiMax = rad(58);
      for (let k = 0; k <= N; k++) {
        const u = k / N, phi = (1 - u) * phiMax, th = u * turns * TAU;
        const m = P(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th));
        pts.push({ p: Cs.clone().addScaledVector(m, R + TOOL_R), n: m });
      }
      ops.push({ name: 'Spiral dome finish', kind: '5-AXIS SIMULTANEOUS', feed: 0.95, pts, tool: 'mill', header: ['G69', 'G43.4 H04 (TCP ON)'] });
    }
    return ops;
  }

  function gcodeLine(s, n) {
    const N = `N${String(n).padStart(4, '0')}`;
    const g = s.mode === 'rapid' ? 'G0' : 'G1';
    const f = s.mode === 'rapid' ? '' : ` F${Math.round((s.feed || 1) * S * MM * 60)}`;
    if (s.turn) return `${N} ${g} X${(2 * (s.y - mach.pivot.y) * MM).toFixed(2)} Z${((s.x - mach.pivot.x) * MM).toFixed(2)}${f}`;
    const X = (s.x * MM).toFixed(2), Y = (-s.z * MM).toFixed(2), Z = ((s.y - z0()) * MM).toFixed(2);
    if (mach.id === '3x') return `${N} ${g} X${X} Y${Y} Z${Z}${f}`;
    if (mach.id === 'mt') return `${N} ${g} X${X} Y${Y} Z${Z} C${deg(s.c).toFixed(1)}${f}`;
    return `${N} ${g} X${X} Y${Y} Z${Z} A${deg(s.a).toFixed(1)} C${deg(s.c).toFixed(1)}${f}`;
  }

  function compile(opsIn) {
    const prog = [];
    let cur = { ...mach.home };
    let prevC = 0;
    opsIn.forEach((op, i) => {
      const states = op.pts.map((pt) => {
        if (pt.turn) return turnState(pt.x, pt.rc, pt.mode || 'feed', pt.feed || op.feed);
        const s = stateFor(pt.p, pt.n, prevC, pt.mode || 'feed', pt.feed || op.feed);
        prevC = s.c;
        return s;
      });
      const f = op.pts[0], l = op.pts.at(-1);
      let appr, ret;
      if (op.turn) {
        appr = turnState(f.x + 0.12, f.rc + 0.25, 'rapid');
        ret = turnState(l.x + 0.1, Math.max(l.rc, mach.stock.half.y + TOOL_R) + 0.25, 'rapid');
      } else {
        appr = stateFor(f.p.clone().addScaledVector(f.n, 0.3), f.n, states[0].c, 'rapid');
        ret = stateFor(l.p.clone().addScaledVector(l.n, 0.3), l.n, states.at(-1).c, 'rapid');
      }
      const tr = transition(cur, appr);
      tr[0].pre = [`(OP${String(i + 1).padStart(2, '0')} · ${op.name.toUpperCase()})`, ...op.header];
      op.first = prog.length + tr.length;
      for (const s of [...tr, ...states, ret]) { s.op = i; prog.push(s); }
      cur = ret;
    });
    const home = { ...mach.home, c: mach.id === '5x' ? Math.round(prevC / TAU) * TAU : prevC };
    const tr = transition(cur, home);
    tr[0].pre = ['(RETURN HOME)'];
    tr.at(-1).post = ['M30 (PROGRAM END)'];
    for (const s of tr) { s.op = opsIn.length - 1; prog.push(s); }
    prog.forEach((s, i) => { s.g = gcodeLine(s, 100 + i * 5); });
    return prog;
  }

  // toolpath preview lines
  const doneMat = new THREE.LineBasicMaterial({ color: GREEN.clone().multiplyScalar(2.2), transparent: true });
  const todoMat = new THREE.LineDashedMaterial({ color: 0x8a9a4a, dashSize: 0.025, gapSize: 0.02, transparent: true, opacity: 0.6 });
  let ops = [];
  let program = [];
  let opLines = [];
  function rebuildLines() {
    for (const l of opLines) { l.done.parent?.remove(l.done); l.todo.parent?.remove(l.todo); l.done.geometry.dispose(); l.todo.geometry.dispose(); }
    opLines = ops.map((op) => {
      const arr = new Float32Array(op.pts.length * 3);
      op.pts.forEach((pt, i) => (pt.turn ? arr.set([pt.x, pt.rc, 0], i * 3) : pt.p.toArray(arr, i * 3)));
      const g1 = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const done = new THREE.Line(g1, doneMat);
      const todo = new THREE.Line(g1.clone(), todoMat);
      todo.computeLineDistances();
      done.visible = todo.visible = false;
      done.renderOrder = 2;
      (op.turn ? turnFrame : partFrame).add(done, todo);
      return { done, todo, n: op.pts.length };
    });
  }

  // ------------------------------------------------------------------ chips
  const CHIPS = LOW ? 160 : 420;
  const chipMesh = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.028), M.chip, CHIPS);
  chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chipMesh.frustumCulled = false;
  scene.add(chipMesh);
  const cP = new Float32Array(CHIPS * 3), cV = new Float32Array(CHIPS * 3), cL = new Float32Array(CHIPS), cR = new Float32Array(CHIPS * 3);
  let chipHead = 0;
  const _o = new THREE.Object3D();
  _o.scale.setScalar(0);
  _o.updateMatrix();
  for (let i = 0; i < CHIPS; i++) chipMesh.setMatrixAt(i, _o.matrix);
  function spawnChips(pos, n) {
    for (let k = 0; k < n; k++) {
      const i = chipHead;
      chipHead = (chipHead + 1) % CHIPS;
      const a = Math.random() * TAU, sp = 1.2 + Math.random() * 2.4;
      cP[i * 3] = pos.x + (Math.random() - 0.5) * 0.1;
      cP[i * 3 + 1] = pos.y - 0.04;
      cP[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.1;
      cV[i * 3] = Math.cos(a) * sp;
      cV[i * 3 + 1] = 0.8 + Math.random() * 2.6;
      cV[i * 3 + 2] = Math.sin(a) * sp;
      cL[i] = 2.5 + Math.random() * 1.5;
      cR[i * 3] = Math.random() * TAU; cR[i * 3 + 1] = Math.random() * TAU; cR[i * 3 + 2] = Math.random() * TAU;
    }
  }
  function updateChips(dt) {
    let any = false;
    for (let i = 0; i < CHIPS; i++) {
      if (cL[i] <= 0) continue;
      any = true;
      cL[i] -= dt;
      const j = i * 3;
      cV[j + 1] -= 9.8 * dt;
      cP[j] += cV[j] * dt; cP[j + 1] += cV[j + 1] * dt; cP[j + 2] += cV[j + 2] * dt;
      const onBase = Math.abs(cP[j]) < 4.7 && Math.abs(cP[j + 2]) < 3.5;
      const floorY = onBase ? 1.215 : 0.01;
      if (cP[j + 1] < floorY) { cP[j + 1] = floorY; cV[j + 1] *= -0.25; cV[j] *= 0.5; cV[j + 2] *= 0.5; }
      cR[j] += cV[j] * dt * 6; cR[j + 1] += cV[j + 2] * dt * 6;
      _o.position.set(cP[j], cP[j + 1], cP[j + 2]);
      _o.rotation.set(cR[j], cR[j + 1], cR[j + 2]);
      _o.scale.setScalar(cL[i] > 0 ? Math.min(1, cL[i] * 1.5) : 0);
      _o.updateMatrix();
      chipMesh.setMatrixAt(i, _o.matrix);
    }
    if (any) chipMesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ hover / drill target marker
  const marker = new THREE.Group();
  const mRing = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.095, 48), new THREE.MeshBasicMaterial({ color: GREEN.clone().multiplyScalar(2.5), side: THREE.DoubleSide, depthTest: false, transparent: true }));
  const mDot = new THREE.Mesh(new THREE.CircleGeometry(0.018, 20), mRing.material);
  const mAxis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(0, 0, 0), new V3(0, 0, 0.55)]), new THREE.LineDashedMaterial({ color: 0xc8ff00, dashSize: 0.03, gapSize: 0.02, depthTest: false, transparent: true }));
  mAxis.computeLineDistances();
  marker.add(mRing, mDot, mAxis);
  marker.traverse((o) => (o.renderOrder = 5));
  marker.visible = false;
  partFrame.add(marker);

  // ------------------------------------------------------------------ machine state + executor
  const st = { x: 0, y: 5, z: 1.5, a: 0, c: 0 };
  let pc = 0;
  let seg = null;
  const interrupt = [];
  let running = !reduceMotion;
  let speed = 2;
  let phase = 'run'; // run | complete | eject
  let jog = false, jogTarget = null, jogResume = null;
  let drillBusy = false;
  let curOp = -1;
  let parts = 0;
  let cycleT = 0;
  let spin = 0;
  let toolKind = 'mill';
  let removalRate = 0;
  let pendingChips = 0;
  let fade = null;
  const gLog = [];
  let gDirty = true;

  function pushG(lines, cls) {
    for (const l of lines) gLog.push({ t: l, cls });
    while (gLog.length > 7) gLog.shift();
    gDirty = true;
  }
  function setTool(kind) {
    toolKind = kind;
    spinner.visible = kind === 'mill';
    turnTool.visible = kind === 'turn';
  }

  const _w1 = new V3(), _w2 = new V3(), _p1 = new V3(), _p2 = new V3(), _n1 = new V3(), _wt = new V3();
  function makeSeg(to, src) {
    const from = { x: st.x, y: st.y, z: st.z, a: st.a, c: st.c };
    const spinning = to.c == null;
    // the lathe spindle may have spun many turns — index to the nearest equivalent angle
    if (!spinning && mach.id === 'mt') { from.c = to.c + wrapPi(from.c - to.c); st.c = from.c; }
    const tc = spinning ? from.c : to.c;
    const dA = Math.abs(to.a - from.a), dC = Math.abs(tc - from.c);
    const dW = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    let dur;
    if (to.mode === 'rapid') dur = Math.max(dW / RAPID_V, dA / A_RAPID, dC / C_RAPID, 0.04);
    else if (to.turn || mach.id === '3x') dur = Math.max(dW / S / (to.feed || 1), 1e-4);
    else {
      const pa = worldToPart(_w1.set(from.x, from.y, from.z), from.a, from.c, _p1);
      const pb = worldToPart(_w2.set(to.x, to.y, to.z), to.a, tc, _p2);
      dur = Math.max(pa.distanceTo(pb) / (to.feed || 1), dA / A_FEED, dC / C_FEED, 1e-4);
    }
    return { from, to, tc, dur, t: 0, src, ease: to.mode === 'rapid', spinning };
  }

  function applySeg(s) {
    const k = s.ease ? smooth(s.t / s.dur) : s.t / s.dur;
    st.x = lerp(s.from.x, s.to.x, k);
    st.y = lerp(s.from.y, s.to.y, k);
    st.z = lerp(s.from.z, s.to.z, k);
    st.a = lerp(s.from.a, s.to.a, k);
    st.c = s.spinning ? s.from.c + LATHE_W * s.t : lerp(s.from.c, s.tc, k);
  }

  // carve the swept volume between two machine states
  const _prev = { x: 0, y: 0, z: 0, a: 0, c: 0 };
  function carveBetween(a, b, turn) {
    let removed = 0;
    if (turn) {
      const pv = mach.pivot;
      const xa = (a.x - pv.x) / S, xb = (b.x - pv.x) / S;
      const ra = Math.hypot(a.y - pv.y, a.z - pv.z) / S, rb = Math.hypot(b.y - pv.y, b.z - pv.z) / S;
      const span = Math.max(Math.abs(xb - xa) * KX, Math.abs(rb - ra) * KY) * HALF;
      const n = clamp(Math.ceil(span / 0.7), 1, 60);
      for (let i = 1; i <= n; i++) removed += carveTurn(lerp(xa, xb, i / n), lerp(ra, rb, i / n));
      return removed;
    }
    const pa = worldToPart(_w1.set(a.x, a.y, a.z), a.a, a.c, _p1).clone();
    const pb = worldToPart(_w2.set(b.x, b.y, b.z), b.a, b.c, _p2);
    const ang = (Math.abs(b.a - a.a) + Math.abs(b.c - a.c)) * 0.6;
    const span = (Math.max(Math.abs(pb.x - pa.x) * KX, Math.abs(pb.y - pa.y) * KY, Math.abs(pb.z - pa.z) * KZ) + ang * Math.max(KX, KZ)) * HALF;
    const n = clamp(Math.ceil(span / 0.7), 1, 60);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const sa = lerp(a.a, b.a, t), sc = lerp(a.c, b.c, t);
      _wt.set(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));
      removed += carve(worldToPart(_wt, sa, sc, _p1), axisInPart(sa, sc, _n1));
    }
    return removed;
  }

  function nextTarget() {
    if (interrupt.length) return { tgt: interrupt.shift(), src: 'int' };
    if (running && phase === 'run' && !jog && pc < program.length) {
      const tgt = program[pc++];
      onProgramTarget(tgt);
      return { tgt, src: 'prog' };
    }
    return null;
  }

  function onProgramTarget(s) {
    if (s.op !== curOp) setOp(s.op);
    if (s.pre) pushG(s.pre, 'cmt');
    pushG([s.g], 'cur');
    if (s.post) pushG(s.post, 'cmt');
  }

  function stepMachine(dt) {
    let removed = 0;
    if (jog) {
      if (jogTarget) {
        Object.assign(_prev, st);
        const k = 1 - Math.exp(-dt * 6);
        const mv = (key, max) => { const d = jogTarget[key] - st[key]; st[key] += clamp(d * k, -max * dt, max * dt); };
        mv('x', 3); mv('y', 3); mv('z', 3); mv('a', 2); mv('c', 3.5);
        removed += carveBetween(_prev, st, false);
      }
      return removed;
    }
    let remaining = dt * speed;
    let guard = 0;
    while (remaining > 1e-6 && guard++ < 600) {
      if (seg && seg.src === 'prog' && (!running || phase !== 'run')) break;
      if (!seg) {
        const nt = nextTarget();
        if (!nt) {
          if (running && phase === 'run' && pc >= program.length) completePart();
          break;
        }
        seg = makeSeg(nt.tgt, nt.src);
      }
      const step = Math.min(seg.dur - seg.t, remaining);
      Object.assign(_prev, st);
      seg.t += step;
      remaining -= step;
      applySeg(seg);
      removed += carveBetween(_prev, st, !!seg.to.turn);
      if (seg.t >= seg.dur - 1e-9) {
        const done = seg;
        seg = null;
        done.to.onArrive?.();
      }
    }
    return removed;
  }

  function completePart() {
    phase = 'complete';
    parts++;
    setStatus();
    msg('Part complete ✓ — unloading, fresh stock next.', true);
    const m = mach;
    setTimeout(() => { if (phase === 'complete' && mach === m) { phase = 'eject'; fade = { t: 0, dir: -1 }; M.stock.transparent = true; } }, 2600);
  }
  function restartProgram(fromCurrent = true) {
    pc = 0;
    seg = null;
    interrupt.length = 0;
    drillBusy = false;
    st.c = mach.id === '5x' ? wrapPi(st.c) : st.c;
    curOp = -1;
    cycleT = 0;
    if (fromCurrent) interrupt.push(...transition(st, { ...mach.home, c: mach.id === 'mt' ? st.c : 0 }));
    phase = 'run';
    setStatus();
  }

  // click-to-drill: the machine re-orients (if it can) so the tool is normal to the clicked surface
  function requestDrill(p, n) {
    if (phase !== 'run') return msg('Hang on — swapping in fresh stock.');
    if (jog) return msg('Exit JOG to use click-to-drill.');
    if (drillBusy) return msg('Drill cycle already queued…');
    const ac = mach.acFor(n, st.c);
    if (!ac) return msg(mach.unreachable);
    const dn = ac.n;
    drillBusy = true;
    const pending = seg && seg.src === 'int' ? [seg.to] : [];
    if (seg && seg.src === 'prog') pc--;
    seg = null;
    const resume = { x: st.x, y: st.y, z: st.z, a: st.a, c: st.c, mode: 'rapid' };
    const at = (off, mode, feed) => stateFor(p.clone().addScaledVector(dn, off), dn, st.c, mode, feed);
    const appr = at(TOOL_R + 0.3, 'rapid');
    const moves = [
      ...transition(st, appr),
      at(TOOL_R - 0.07, 'feed', 0.4),
      at(TOOL_R + 0.04, 'rapid'),
      at(TOOL_R - 0.14, 'feed', 0.4),
      at(TOOL_R + 0.3, 'rapid'),
      ...transition(at(TOOL_R + 0.3, 'rapid'), resume),
    ];
    moves[0].onArrive = () => { setTool('mill'); pushG(moves.slice(1, 5).map((s) => gcodeLine(s, 9000).replace(/^N\d+ /, '')), 'cur'); };
    moves.at(-1).onArrive = () => { drillBusy = false; setTool(ops[curOp]?.tool || 'mill'); msg(''); setStatus(); };
    interrupt.unshift(...moves, ...pending);
    setStatus();
    pushG(['(USER DRILL)', 'G83 Q0.8 (PECK)'], 'cmt');
    if (mach.id === '5x') msg(`Re-orienting A${deg(ac.a).toFixed(0)}° C${deg(wrapPi(ac.c)).toFixed(0)}° to drill normal to the surface…`, true);
    else if (mach.id === 'mt') msg(`Indexing the spindle to C${deg(wrapPi(ac.c)).toFixed(0)}° for a live-tool hole…`, true);
    else msg('Drilling straight down…', true);
  }

  // ------------------------------------------------------------------ HUD
  const hud = $('#hud');
  const H = {
    status: $('#hud-status'), machine: $('#hud-machine'), opNum: $('#hud-op-num'), opKind: $('#hud-op-kind'), opName: $('#hud-op-name'),
    bar: $('#hud-bar'), pct: $('#hud-pct'), time: $('#hud-time'), parts: $('#hud-parts'),
    x: $('#dro-x'), y: $('#dro-y'), z: $('#dro-z'), a: $('#dro-a'), c: $('#dro-c'), s: $('#dro-s'),
    gcode: $('#gcode'), msg: $('#hud-msg'),
  };
  let msgTimer = 0;
  function msg(text, ok = false) {
    H.msg.textContent = text;
    H.msg.style.color = ok ? 'var(--accent)' : '';
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => (H.msg.textContent = ''), 4200);
  }
  function setOp(i) {
    curOp = i;
    const op = ops[i];
    if (!op) return;
    H.opNum.textContent = `OP ${String(i + 1).padStart(2, '0')}/${String(ops.length).padStart(2, '0')}`;
    H.opKind.textContent = op.kind;
    H.opName.textContent = op.name;
    if (!drillBusy) setTool(op.tool);
    opLines.forEach((l, j) => { l.done.visible = l.todo.visible = showPath && j === i; });
  }
  function setStatus() {
    let s = 'RUNNING';
    if (jog) s = 'JOG';
    else if (phase === 'complete') s = 'COMPLETE';
    else if (phase === 'eject') s = 'LOADING';
    else if (!running) s = drillBusy ? 'DRILLING' : 'PAUSED';
    else if (drillBusy) s = 'DRILLING';
    H.status.textContent = s;
    hud.classList.toggle('paused', !running || jog);
    $('#btn-run').setAttribute('aria-label', running ? 'Pause simulation' : 'Run simulation');
  }
  let hudT = 0;
  function updateHUD(dt) {
    hudT += dt;
    if (hudT < 0.06) return;
    hudT = 0;
    H.x.textContent = (st.x * MM).toFixed(3);
    H.y.textContent = (-st.z * MM).toFixed(3);
    H.z.textContent = ((st.y - z0()) * MM).toFixed(3);
    H.a.textContent = mach.axes.includes('a') ? deg(st.a).toFixed(3) : '—';
    H.c.textContent = mach.axes.includes('c') ? (((deg(st.c) % 360) + 360) % 360).toFixed(3) : '—';
    const lathe = mach.id === 'mt' && seg?.spinning;
    H.s.textContent = lathe ? '3,200' : Math.round((spin / 42) * 18000).toLocaleString('en-US');
    const pct = phase === 'run' ? Math.round((pc / program.length) * 100) : 100;
    H.bar.style.width = pct + '%';
    H.pct.textContent = pct;
    const sec = Math.floor(cycleT);
    H.time.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    H.parts.textContent = String(parts).padStart(3, '0');
    if (gDirty) {
      gDirty = false;
      H.gcode.innerHTML = gLog.map((l, i) => `<li class="${l.cls === 'cmt' ? 'cmt' : i === gLog.length - 1 ? 'cur' : ''}">${l.t}</li>`).join('');
    }
  }

  // controls
  const btnRun = $('#btn-run');
  btnRun.addEventListener('click', () => {
    if (jog) setJog(false);
    running = !running;
    if (running && phase === 'run' && pc >= program.length) restartProgram();
    setStatus();
  });
  $('#btn-reset').addEventListener('click', () => {
    if (jog) setJog(false, true);
    resetStock();
    restartProgram();
    running = true;
    setStatus();
    msg('Fresh stock loaded.', true);
  });
  $$('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    speed = +b.dataset.speed;
    $$('[data-speed]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  let showPath = true;
  const btnPath = $('#btn-path');
  btnPath.addEventListener('click', () => {
    showPath = !showPath;
    btnPath.classList.toggle('on', showPath);
    btnPath.setAttribute('aria-pressed', showPath);
    opLines.forEach((l, j) => { l.done.visible = l.todo.visible = showPath && j === curOp; });
  });
  $$('[data-machine]').forEach((b) => b.addEventListener('click', () => setMachine(b.dataset.machine)));

  // jog
  const jogPanel = $('#jog-panel');
  const btnJog = $('#btn-jog');
  const sliders = $$('#jog-panel input');
  const toUI = { x: () => st.x * MM, y: () => -st.z * MM, z: () => (st.y - z0()) * MM, a: () => deg(st.a), c: () => deg(st.c) };
  const fromUI = {
    x: (v) => clamp(v / MM, -3, 3), y: (v) => clamp(-v / MM, -2.2, 2.2), z: (v) => clamp(v / MM + z0(), mach.ymin, 5.2),
    a: (v) => clamp(rad(v), rad(-110), rad(110)), c: (v) => clamp(rad(v), -TAU, TAU),
  };
  const keyOf = { x: 'x', y: 'z', z: 'y', a: 'a', c: 'c' };
  function syncSliders() {
    for (const s of sliders) {
      const ax = s.dataset.axis;
      s.value = toUI[ax]().toFixed(1);
      s.nextElementSibling.textContent = (+s.value).toFixed(ax === 'a' || ax === 'c' ? 0 : 1);
    }
  }
  sliders.forEach((s) => s.addEventListener('input', () => {
    if (!jog) return;
    const ax = s.dataset.axis;
    jogTarget[keyOf[ax]] = fromUI[ax](+s.value);
    s.nextElementSibling.textContent = (+s.value).toFixed(ax === 'a' || ax === 'c' ? 0 : 1);
  }));
  let jogCOff = 0;
  function setJog(on, silent = false) {
    if (on === jog) return;
    if (on && (drillBusy || phase !== 'run' || interrupt.length || (seg && seg.src === 'int'))) return msg('Wait for the current move to finish.');
    jog = on;
    btnJog.classList.toggle('on', on);
    btnJog.setAttribute('aria-pressed', on);
    jogPanel.hidden = !on;
    H.gcode.hidden = on;
    if (on) {
      if (seg && seg.src === 'prog') pc--;
      seg = null;
      setTool('mill');
      jogCOff = st.c - wrapPi(st.c);
      st.c -= jogCOff;
      jogResume = { x: st.x, y: st.y, z: st.z, a: st.a, c: st.c, mode: 'rapid' };
      jogTarget = { ...st };
      syncSliders();
      msg('JOG mode — drag the sliders. Plunge into the stock to cut by hand.', true);
    } else {
      jogTarget = null;
      if (!silent) {
        const tr = transition(st, jogResume);
        const off = jogCOff;
        tr.at(-1).onArrive = () => { st.c += off; setTool(ops[curOp]?.tool || 'mill'); };
        interrupt.push(...tr);
        running = true;
        msg('Resuming program.', true);
      }
    }
    setStatus();
  }
  btnJog.addEventListener('click', () => setJog(!jog));

  // camera views
  let view = 'iso';
  let tween = null;
  let lastInteract = performance.now();
  let dragging = false;
  function setView(v) {
    view = v;
    $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    const tip = new V3(st.x, st.y, st.z);
    const toTarget = v === 'tool' ? tip.clone() : VIEWS[v].target.clone();
    const toPos = v === 'tool' ? tip.clone().add(new V3(3.4, 2.6, 5.4)) : VIEWS[v].pos.clone();
    if (aspect < 1 && v !== 'tool') toPos.sub(toTarget).multiplyScalar(1.1).add(toTarget);
    tween = { t: 0, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toPos, toTarget };
    lastInteract = performance.now();
  }
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  controls.addEventListener('start', () => { tween = null; lastInteract = performance.now(); dragging = true; });
  controls.addEventListener('end', () => { lastInteract = performance.now(); dragging = false; });

  // ------------------------------------------------------------------ pointer: hover + click to drill
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tipEl = $('#drill-tip');
  let hover = null;
  let hoverQueued = false;
  let lastPointer = null;
  let down = null;

  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(mc, false)[0];
    if (!hit) return null;
    const p = partFrame.worldToLocal(hit.point.clone());
    const n = fieldNormal(p);
    if (!isFinite(n.x)) return null;
    return { p, n, x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function showHover(h) {
    hover = h;
    if (!h) {
      marker.visible = false;
      tipEl.classList.remove('show');
      canvas.classList.remove('aim');
      return;
    }
    marker.visible = true;
    marker.position.copy(h.p).addScaledVector(h.n, 0.004);
    marker.quaternion.setFromUnitVectors(new V3(0, 0, 1), h.n);
    canvas.classList.add('aim');
    const ac = mach.acFor(h.n, 0);
    let text;
    if (!ac) text = `<span class="bad">UNREACHABLE</span><br>${mach.id === '3x' ? 'top faces only' : mach.id === 'mt' ? 'end face' : 'fixtured face'}`;
    else if (mach.id === '5x') text = `<b>CLICK TO DRILL</b><br>A ${deg(ac.a).toFixed(1)}°  C ${deg(wrapPi(ac.c)).toFixed(1)}°`;
    else if (mach.id === 'mt') text = `<b>CLICK TO DRILL</b><br>C ${deg(wrapPi(ac.c)).toFixed(1)}°`;
    else text = '<b>CLICK TO DRILL</b><br>top face';
    tipEl.innerHTML = text;
    tipEl.style.transform = `translate(${Math.min(h.x + 18, stage.clientWidth - 170)}px, ${h.y + 18}px)`;
    tipEl.classList.add('show');
  }
  canvas.addEventListener('pointermove', (ev) => {
    if (coarse || dragging) return;
    lastPointer = ev;
    if (!hoverQueued) {
      hoverQueued = true;
      requestAnimationFrame(() => { hoverQueued = false; if (lastPointer && !dragging) showHover(pick(lastPointer)); });
    }
  });
  canvas.addEventListener('pointerleave', () => { lastPointer = null; showHover(null); });
  canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; });
  canvas.addEventListener('pointerup', (ev) => {
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    const quick = performance.now() - down.t < 500;
    down = null;
    if (moved > 6 || !quick) return;
    const h = pick(ev);
    if (h) {
      requestDrill(h.p, h.n);
      if (coarse) { showHover(h); setTimeout(() => showHover(null), 1400); }
    }
  });

  // ------------------------------------------------------------------ axis labels
  const labelEls = Object.fromEntries($$('#axis-labels [data-axis]').map((el) => [el.dataset.axis, el]));
  const anchorsFor = () => ({
    X: [carriage, new V3(0.6, 9.6, 0.4)],
    Y: [bridge, new V3(4.3, 7.6, -1.1)],
    Z: [ram, new V3(0.35, 2.3, 0.3)],
    A: mach.id === '5x' ? [scene, new V3(2.75, PIVOT5.y + 0.5, 0.6)] : null,
    C: mach.id === '5x' ? [aGroup, new V3(0, -0.9, 1.15)] : mach.id === 'mt' ? [scene, new V3(-1.45, PIVOTM.y + 0.95, 0.45)] : null,
  });
  let anchors = anchorsFor();
  const _lv = new V3();
  function updateLabels() {
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const k in labelEls) {
      const el = labelEls[k];
      const an = anchors[k];
      if (!an) { el.classList.add('hide'); continue; }
      _lv.copy(an[1]);
      an[0].localToWorld(_lv);
      _lv.project(camera);
      const off = _lv.z > 1 || Math.abs(_lv.x) > 1.05 || Math.abs(_lv.y) > 1.05;
      el.classList.toggle('hide', off);
      if (!off) el.style.transform = `translate(${((_lv.x + 1) / 2) * w - 12}px, ${((1 - _lv.y) / 2) * h - 12}px)`;
    }
  }

  // ------------------------------------------------------------------ machine switching
  function updateMachineUI() {
    $$('[data-machine]').forEach((b) => {
      const on = b.dataset.machine === mach.id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    });
    H.machine.textContent = mach.label;
    $$('[data-dro]').forEach((el) => el.classList.toggle('na', !mach.axes.includes(el.dataset.dro)));
    $$('[data-jog]').forEach((el) => { el.hidden = !mach.axes.includes(el.dataset.jog); });
    if (labelEls.C) labelEls.C.lastChild.textContent = mach.id === 'mt' ? 'lathe' : 'rotary';
    anchors = anchorsFor();
  }

  function setMachine(id, { silent = false } = {}) {
    const m = MACHINES[id];
    if (!m || (m === mach && ops.length)) return;
    if (jog) setJog(false, true);
    mach = m;
    seg = null;
    interrupt.length = 0;
    drillBusy = false;
    fade = null;
    phase = 'run';
    M.stock.transparent = false;
    M.stock.opacity = 1;
    for (const k in MACHINES) MACHINES[k].fixture.visible = MACHINES[k] === m;
    partHolder.position.copy(m.pivot);
    turnFrame.position.copy(m.pivot);
    setGrid(m.stock.half);
    ops = m.build(m.stock.half);
    program = compile(ops);
    rebuildLines();
    Object.assign(st, m.home);
    pc = 0;
    curOp = -1;
    cycleT = 0;
    gLog.length = 0;
    gDirty = true;
    resetStock();
    showHover(null);
    running = !reduceMotion;
    setOp(0);
    setStatus();
    updateMachineUI();
    if (!silent) msg(`${m.label} loaded.`, true);
    kick();
  }

  // ------------------------------------------------------------------ resize + visibility
  let aspect = 1;
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = aspect = w / h;
    if (w >= 1024) camera.setViewOffset(w, h, w * 0.1, h * 0.03, w, h);
    else camera.clearViewOffset();
    camera.fov = aspect < 1 ? 40 : 30;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);
  resize();
  if (aspect < 1) camera.position.sub(controls.target).multiplyScalar(1.05).add(controls.target);

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }, { threshold: 0.02 }).observe(stage);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let raf = 0;
  let elapsed = 0;
  let mcSkip = 0;
  let labelsShown = false;
  const _tool = new V3();
  function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;

    const removed = stepMachine(dt);
    if (running && phase === 'run' && !jog) cycleT += dt * speed;
    removalRate = lerp(removalRate, removed > 0 ? Math.min(1, removed / 40) : 0, 0.25);

    // eject / load fade
    let lift = 0;
    if (fade) {
      fade.t += dt / 0.7;
      const k = smooth(Math.min(1, fade.t));
      M.stock.opacity = fade.dir < 0 ? 1 - k : k;
      lift = fade.dir < 0 ? k * 0.6 : (1 - k) * -0.4;
      if (fade.t >= 1) {
        if (fade.dir < 0) {
          resetStock();
          restartProgram(false);
          fade = { t: 0, dir: 1 };
        } else {
          fade = null;
          lift = 0;
          M.stock.transparent = false;
          M.stock.opacity = 1;
        }
      }
    }

    // pose the machine
    bridge.position.z = st.z;
    carriage.position.x = st.x;
    ram.position.y = st.y;
    if (mach.id === '5x') { aGroup.rotation.x = st.a; cGroup.rotation.y = st.c; }
    if (mach.id === 'mt') chuck.rotation.x = st.c;
    partHolder.quaternion.copy(partQuat(st.a, st.c));
    partHolder.position.set(mach.pivot.x, mach.pivot.y + lift, mach.pivot.z);

    // spindle + fx
    const spinTarget = toolKind === 'mill' && (running || drillBusy || jog) && phase === 'run' ? 42 : 0;
    spin = lerp(spin, spinTarget, 1 - Math.exp(-dt * 2.2));
    spinner.rotation.y += spin * dt;
    M.glow.color.copy(GREEN).multiplyScalar(1.15 + 0.45 * (spin / 42) + removalRate * 0.8);
    ledRing.scale.setScalar(1 + removalRate * 0.04);
    _tool.set(st.x, st.y - TR * 0.6, st.z);
    toolLight.position.copy(_tool);
    toolLight.intensity = removalRate * 9 * (0.85 + Math.random() * 0.3);
    pendingChips += removed * 0.12;
    if (pendingChips >= 1) {
      const n = Math.min(10, Math.floor(pendingChips));
      pendingChips -= n;
      spawnChips(_tool, n);
    }
    pendingChips = Math.min(pendingChips, 10);
    updateChips(dt);

    if (curOp >= 0 && showPath && opLines[curOp]) {
      const l = opLines[curOp];
      l.done.geometry.setDrawRange(0, clamp(pc - ops[curOp].first, 0, l.n));
    }

    if (mcDirty && (++mcSkip >= (LOW ? 2 : 1))) {
      mcSkip = 0;
      mcDirty = false;
      mc.normal_cache.fill(0);
      mc.update();
    }

    // camera
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / 1.1);
      const k = smooth(tween.t);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
      controls.target.lerpVectors(tween.fromTarget, tween.toTarget, k);
      if (tween.t >= 1) tween = null;
    } else if (view === 'tool') {
      const d = _w1.set(st.x, st.y, st.z).sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 5));
      controls.target.add(d);
      camera.position.add(d);
    } else if (!dragging && !reduceMotion && view === 'iso' && now - lastInteract > 5000) {
      const off = camera.position.clone().sub(controls.target);
      const sph = new THREE.Spherical().setFromVector3(off);
      const base = Math.atan2(VIEWS.iso.pos.x, VIEWS.iso.pos.z);
      sph.theta = lerp(sph.theta, base + Math.sin(elapsed * 0.09) * 0.42, 1 - Math.exp(-dt * 0.6));
      camera.position.copy(controls.target).add(off.setFromSpherical(sph));
    }
    controls.update();
    marker.visible = !!hover && !dragging;
    updateLabels();
    updateHUD(dt);
    composer.render();
    if (!labelsShown) { labelsShown = true; $('#axis-labels').classList.remove('off'); }
  }

  setMachine(MACHINES[initialMachine] ? initialMachine : '5x', { silent: true });
  if (reduceMotion) msg('Paused (reduced motion). Press ▶ to run.', true);
  kick();

  return { setMachine, setView };
}
