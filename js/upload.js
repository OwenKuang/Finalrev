// finalREV redesign — CAD upload, in-browser geometry check and quote request.
// STEP files are parsed locally (ISO-10303-21 text): units, bounding box, face/hole counts,
// then checked against each machine envelope. Nothing is sent anywhere yet.
import * as THREE from 'three';

const $ = (s, r = document) => r.querySelector(s);
const MAX_POINTS = 400000;

const ENVELOPES = [
  { key: '3x', name: '3-Axis', spec: '20" × 20" × 6"', fits: (d) => d[0] <= 20 && d[1] <= 20 && d[2] <= 6 },
  { key: 'mt', name: 'Millturn', spec: 'Up to 1" round', fits: (d, r) => r.round && d[1] <= 1.0 && d[2] <= 1.0 },
  { key: '5x', name: '5-Axis', spec: 'Up to 12" × 12" × 12"', fits: (d) => d[0] <= 12 && d[1] <= 12 && d[2] <= 12 },
];
const PROCESS_NAME = { auto: 'Auto', '3x': '3-axis', mt: 'Millturn', '5x': '5-axis' };

export function parseStep(text) {
  if (!/ISO-10303-21/i.test(text.slice(0, 4096))) throw new Error("This doesn't look like a STEP (ISO-10303-21) file.");
  const header = text.slice(0, 30000);
  let partName = '', system = '';
  const fn = header.match(/FILE_NAME\s*\(([\s\S]*?)\)\s*;/i);
  if (fn) {
    const strs = [...fn[1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].trim());
    partName = strs[0] || '';
    system = strs.length >= 3 ? strs[strs.length - 2] || strs[strs.length - 3] : '';
  }
  const unit = /CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text) ? 'in'
    : /SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text) ? 'mm'
    : /SI_UNIT\s*\(\s*\.CENTI\.\s*,\s*\.METRE\.\s*\)/i.test(text) ? 'cm'
    : /SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text) ? 'm' : 'mm';
  const toMM = { mm: 1, cm: 10, m: 1000, in: 25.4 }[unit];

  const re = /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*,\s*([-+\d.eE]+)\s*\)\s*\)/g;
  const buf = [];
  let total = 0, stride = 1;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let m;
  while ((m = re.exec(text))) {
    const x = +m[1] * toMM, y = +m[2] * toMM, z = +m[3] * toMM;
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
    if (total++ % stride === 0) {
      buf.push(x, y, z);
      if (buf.length / 3 >= MAX_POINTS) { // thin out and keep going
        const keep = [];
        for (let i = 0; i < buf.length; i += 6) keep.push(buf[i], buf[i + 1], buf[i + 2]);
        buf.length = 0; buf.push(...keep);
        stride *= 2;
      }
    }
  }
  if (!total) throw new Error('No 3D geometry found in this file.');
  const count = (r) => (text.match(r) || []).length;
  return {
    partName, system, unit,
    points: new Float32Array(buf), pointCount: total,
    min, max, dims: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    faces: count(/=\s*ADVANCED_FACE\s*\(/gi),
    cylinders: count(/=\s*CYLINDRICAL_SURFACE\s*\(/gi),
    freeform: count(/B_SPLINE_SURFACE/gi),
  };
}

export function assess(d) {
  const inch = d.dims.map((v) => v / 25.4).sort((a, b) => b - a);
  const round = d.cylinders > 0 && Math.abs(inch[1] - inch[2]) <= Math.max(0.02, inch[1] * 0.08);
  const fits = Object.fromEntries(ENVELOPES.map((e) => [e.key, e.fits(inch, { round })]));
  const complex = d.freeform > 0 || d.faces > 140;
  let rec = null, note = '';
  if (fits.mt && inch[0] <= 8) { rec = 'mt'; note = 'Round part within the millturn size (up to 1" round).'; }
  else if (complex && fits['5x']) { rec = '5x'; note = 'Complex geometry within the 5-axis work area (up to 12" × 12" × 12").'; }
  else if (fits['3x']) { rec = '3x'; note = 'Within the 3-axis size (20" × 20" × 6").'; }
  else if (fits['5x']) { rec = '5x'; note = 'Within the 5-axis work area (up to 12" × 12" × 12").'; }
  else note = 'Larger than the listed machine sizes.';
  return { inch, fits, rec, note };
}

// ---------------------------------------------------------------- sample part
function sampleStep() {
  const pts = [];
  const add = (x, y, z) => pts.push([x, y, z]);
  const holes = [[20, 32, 4.2], [60, 32, 4.2]];
  const inHole = (x, y) => holes.some(([hx, hy, r]) => (x - hx) ** 2 + (y - hy) ** 2 < r * r);
  const inSlot = (x, z) => { const cx = Math.max(28, Math.min(52, x)); return (x - cx) ** 2 + (z - 38) ** 2 < 25; };
  const step = 1.6;
  for (let x = 0; x <= 80.01; x += step) {
    for (let y = 0; y <= 50.01; y += step) if (!inHole(x, y)) { add(x, y, 0); if (y >= 8) add(x, y, 8); }
    for (let z = 0; z <= 60.01; z += step) if (!inSlot(x, z)) { add(x, 0, z); if (z >= 8) add(x, 8, z); }
    for (let y = 0; y <= 8.01; y += step) add(x, y, 60);
  }
  for (let y = 0; y <= 50.01; y += step) for (let z = 0; z <= (y < 8 ? 60 : 8) + 0.01; z += step) { add(0, y, z); add(80, y, z); }
  for (let x = 0; x <= 80.01; x += step) for (let z = 0; z <= 8.01; z += step) add(x, 50, z);
  for (const [hx, hy, r] of holes) for (let z = 0; z <= 8.01; z += 1) for (let a = 0; a < 40; a++) add(hx + r * Math.cos((a / 40) * 6.283), hy + r * Math.sin((a / 40) * 6.283), z);
  for (let y = 0; y <= 8.01; y += 1) for (let a = 0; a < 60; a++) {
    const t = (a / 60) * 6.283;
    add(40 + Math.cos(t) * 5 + (Math.cos(t) >= 0 ? 12 : -12), y, 38 + Math.sin(t) * 5);
  }
  let id = 10;
  const lines = [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION(('finalREV sample part'),'2;1');",
    "FILE_NAME('sample_bracket','2026-09-25T09:00:00',('finalREV'),('finalREV'),'','finalREV sample generator','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));", 'ENDSEC;', 'DATA;',
    '#1=( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    "#2=MANIFOLD_SOLID_BREP('bracket',#3);",
  ];
  for (let i = 0; i < 4; i++) lines.push(`#${id++}=CYLINDRICAL_SURFACE('',#${id + 400},4.2);`);
  for (let i = 0; i < 18; i++) lines.push(`#${id++}=ADVANCED_FACE('',(#${id + 800}),#${id + 900},.T.);`);
  for (const [x, y, z] of pts) lines.push(`#${id++}=CARTESIAN_POINT('',(${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}));`);
  lines.push('ENDSEC;', 'END-ISO-10303-21;');
  return lines.join('\n');
}

// ---------------------------------------------------------------- preview (point cloud)
function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  const group = new THREE.Group();
  scene.add(group);
  let grid = null;
  function buildGrid() {
    const y = grid ? grid.position.y : 0;
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    grid = new THREE.GridHelper(5, 20, 0x3a423c, 0x222824); // dark viewport in both themes, so the lime box always reads
    grid.position.y = y;
    scene.add(grid);
  }
  buildGrid();

  const dot = document.createElement('canvas');
  dot.width = dot.height = 32;
  const g = dot.getContext('2d');
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 16, 13, 0, Math.PI * 2); g.fill();
  const mat = new THREE.PointsMaterial({ size: 0.03, map: new THREE.CanvasTexture(dot), vertexColors: true, transparent: true, alphaTest: 0.4, depthWrite: true });
  const boxMat = new THREE.LineBasicMaterial({ color: 0xc8ff00, transparent: true, opacity: 0.7 });
  let points = null, boxLines = null, lastData = null;

  let rotY = 0.7, drag = null;
  if (matchMedia('(pointer: fine)').matches) {
    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, r: rotY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (drag) rotY = drag.r + (e.clientX - drag.x) * 0.01; });
    canvas.addEventListener('pointerup', () => { drag = null; });
  }

  let radius = 1.5;
  const viewDir = new THREE.Vector3(0.62, 0.5, 0.72).normalize();
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    camera.position.copy(viewDir).multiplyScalar((radius * 1.15) / Math.sin(Math.min(vfov, hfov) / 2));
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);

  let visible = false, raf = 0, last = 0;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(loop); } }).observe(canvas);
  function loop(now) {
    raf = 0;
    if (!visible) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!drag) rotY += 0.3 * dt;
    group.rotation.y = rotY;
    renderer.render(scene, camera);
  }

  function setData(d) {
    lastData = d;
    boxMat.color.set(0xc8ff00);
    if (points) { group.remove(points); points.geometry.dispose(); }
    if (boxLines) { group.remove(boxLines); boxLines.geometry.dispose(); }
    const src = d.points;
    const n = src.length / 3;
    const stride = Math.max(1, Math.ceil(n / 150000));
    const cnt = Math.floor(n / stride);
    const pos = new Float32Array(cnt * 3), col = new Float32Array(cnt * 3);
    const cx = (d.min[0] + d.max[0]) / 2, cy = (d.min[1] + d.max[1]) / 2, cz = (d.min[2] + d.max[2]) / 2;
    const s = 2 / Math.max(d.dims[0], d.dims[1], d.dims[2], 1e-6);
    const lo = new THREE.Color(0x6f7872), hi = new THREE.Color(0xf2f4ef), c = new THREE.Color();
    for (let i = 0, j = 0; j < cnt; i += stride, j++) {
      // STEP is Z-up; the preview is Y-up
      pos[j * 3] = (src[i * 3] - cx) * s;
      pos[j * 3 + 1] = (src[i * 3 + 2] - cz) * s;
      pos[j * 3 + 2] = -(src[i * 3 + 1] - cy) * s;
      c.lerpColors(lo, hi, d.dims[2] ? (src[i * 3 + 2] - d.min[2]) / d.dims[2] : 0.5);
      c.toArray(col, j * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    mat.size = cnt < 400 ? 0.09 : cnt < 3000 ? 0.05 : cnt < 20000 ? 0.032 : 0.02;
    points = new THREE.Points(geo, mat);
    group.add(points);
    const bx = d.dims[0] * s, by = d.dims[2] * s, bz = d.dims[1] * s;
    boxLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(bx || 0.01, by || 0.01, bz || 0.01)), boxMat);
    group.add(boxLines);
    grid.position.y = -by / 2 - 0.03;
    radius = Math.hypot(bx, by, bz) / 2;
    resize();
  }
  return { setData };
}

// ---------------------------------------------------------------- UI (one instance per uploader panel)
const panels = [];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmtSize = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B');

// Scroll to an uploader (the one on screen, else the first), keep the chosen process,
// and optionally open the file picker right away.
export function openQuote({ service = null, pick = false } = {}) {
  if (!panels.length) return;
  const onScreen = panels.find((p) => { const r = p.el.getBoundingClientRect(); return r.bottom > 80 && r.top < innerHeight; });
  (onScreen || panels[0]).open(service, pick);
}

export function initUpload({ toast }) {
  const tpl = document.getElementById('quote-panel-tpl');
  document.querySelectorAll('[data-quote-slot]').forEach((slot, idx) => {
    slot.append(tpl.content.cloneNode(true));
    const el = slot.querySelector('.quote-panel');
    if (idx === 0) el.id = 'quote';
    el.dataset.anchor = slot.dataset.anchor || 'start';
    el.dataset.morph = slot.dataset.morph || '';
    el.querySelectorAll('[data-process]').forEach((r) => { r.name = `process-${idx}`; });
    panels.push(createPanel(el, toast));
  });
  // a drop that misses the drop zone shouldn't navigate away from the page
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => {
    e.preventDefault();
    panels.find((p) => p.el.contains(e.target))?.handle([...e.dataTransfer.files]);
  });
}

function createPanel(panel, toast) {
  const q = (name) => panel.querySelector(`[data-el="${name}"]`);
  const dz = q('dropzone'), input = q('file'), list = q('files'), errEl = q('error'), form = q('form'), statusEl = q('status');
  const body = panel.querySelector('.qp-body');
  const hero = panel.closest('.hero');
  const entries = [];
  let active = null, preview = null, expanded = false, anim = 0;

  const process = () => panel.querySelector('[data-process]:checked')?.value || 'auto';
  const showErr = (t) => { errEl.textContent = t; errEl.hidden = !t; };
  const setStatus = (text, state = '') => { statusEl.textContent = text; panel.dataset.state = state; };

  // Resize tween: measure before/after, then animate width + height from the old box to the new one.
  // The hero centres the panel vertically, so the height grows upwards and downwards at once;
  // the body is held at its final width and anchored so existing content doesn't reflow mid-way.
  function tween(mutate) {
    cancelAnimationFrame(anim);
    const r0 = panel.getBoundingClientRect();
    Object.assign(panel.style, { width: '', height: '', overflow: '' });
    Object.assign(body.style, { width: '', marginLeft: '', opacity: '' });
    mutate();
    if (reduceMotion) return;
    const r1 = panel.getBoundingClientRect();
    if (Math.abs(r1.width - r0.width) < 1 && Math.abs(r1.height - r0.height) < 1) return;
    const anchorEnd = panel.dataset.anchor === 'end' && innerWidth >= 1024;
    // 'fade' panels rearrange into a different layout, so the body cross-fades in while the frame resizes
    const fade = panel.dataset.morph === 'fade' && innerWidth >= 1024;
    Object.assign(body.style, { width: body.getBoundingClientRect().width + 'px', marginLeft: anchorEnd ? 'auto' : '0', opacity: fade ? '0' : '' });
    Object.assign(panel.style, { overflow: 'hidden', width: r0.width + 'px', height: r0.height + 'px' });
    const t0 = performance.now(), D = 560;
    const frame = (now) => {
      const t = Math.min(1, (now - t0) / D);
      const k = 1 - Math.pow(1 - t, 3);
      panel.style.width = r0.width + (r1.width - r0.width) * k + 'px';
      panel.style.height = r0.height + (r1.height - r0.height) * k + 'px';
      if (fade) body.style.opacity = String(Math.max(0, (t - 0.3) / 0.7));
      if (t < 1) anim = requestAnimationFrame(frame);
      else {
        Object.assign(panel.style, { width: '', height: '', overflow: '' });
        Object.assign(body.style, { width: '', marginLeft: '', opacity: '' });
      }
    };
    anim = requestAnimationFrame(frame);
  }
  function setExpanded(on) {
    if (on === expanded) return;
    expanded = on;
    tween(() => {
      panel.classList.toggle('expanded', on);
      hero?.classList.toggle('panel-open', on);
    });
  }

  function open(service, pick) {
    if (service) {
      const r = panel.querySelector(`[data-process][value="${service}"]`);
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    panel.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    panel.classList.remove('flash');
    void panel.offsetWidth;
    panel.classList.add('flash');
    setTimeout(() => panel.classList.remove('flash'), 1600);
    if (pick) input.click();
    else setTimeout(() => input.focus({ preventScroll: true }), 500);
  }

  let depth = 0;
  dz.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dz.classList.add('over'); });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  dz.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('over'); } });
  dz.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); depth = 0; dz.classList.remove('over'); handle([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { handle([...input.files]); input.value = ''; });
  // picking a machine card the part fits sets the process, same as the selector above the drop zone
  q('fit').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-fit]');
    if (!b || b.disabled) return;
    const r = panel.querySelector(`[data-process][value="${b.dataset.fit}"]`);
    if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  q('sample').addEventListener('click', () => {
    // clicking again re-selects the sample instead of stacking copies (which would grow the panel)
    const loaded = entries.find((x) => x.sample);
    if (loaded) return select(loaded);
    const text = sampleStep();
    handle([{ name: 'sample_bracket.step', size: text.length, sample: text }]);
  });
  panel.querySelectorAll('[data-process]').forEach((r) => r.addEventListener('change', () => active && render(active)));

  function handle(files) {
    if (!files.length) return;
    const ok = files.filter((f) => /\.(step|stp)$/i.test(f.name));
    const bad = files.filter((f) => !ok.includes(f));
    showErr(bad.length ? `${bad.map((f) => f.name).join(', ')} — we accept STEP and STP files.` : '');
    if (!ok.length) return;
    if (expanded) { ok.forEach(addFile); return; }
    // add the rows inside the tween so it measures the panel's real final size in one go
    expanded = true;
    tween(() => {
      panel.classList.add('expanded');
      hero?.classList.add('panel-open');
      ok.forEach(addFile);
    });
  }

  function readText(f, onProgress) {
    if (f.sample) return Promise.resolve(f.sample);
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      r.onload = () => res(r.result);
      r.onerror = () => rej(new Error('Could not read the file.'));
      r.readAsText(f);
    });
  }

  function addFile(f) {
    const e = { name: f.name, size: f.size, sample: !!f.sample, state: 'reading', data: null, error: '' };
    entries.push(e);
    e.el = document.createElement('li');
    e.el.className = 'file-row';
    e.el.innerHTML = `
      <span class="ficon">${/\.stp$/i.test(f.name) ? 'STP' : 'STEP'}</span>
      <div style="min-width:0"><div class="fname"></div><div class="fmeta"></div><div class="fprog"><i></i></div></div>
      <div class="fend"><span class="fstate">…</span><button class="fx" type="button" aria-label="Remove file"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
    e.el.querySelector('.fname').textContent = f.name;
    e.el.addEventListener('click', (ev) => { if (!ev.target.closest('.fx')) select(e); });
    e.el.querySelector('.fx').addEventListener('click', () => remove(e));
    list.append(e.el);
    const bar = e.el.querySelector('.fprog i');
    const meta = e.el.querySelector('.fmeta');
    const state = e.el.querySelector('.fstate');
    meta.textContent = `${fmtSize(f.size)} · uploading…`;
    setStatus('Uploading', 'busy');
    select(e);

    let shown = 0;
    const tick = setInterval(() => { shown = Math.min(shown + 7 + Math.random() * 9, e.state === 'reading' ? 88 : 100); bar.style.width = shown + '%'; }, 90);
    readText(f, (p) => { shown = Math.max(shown, p * 80); })
      .then((text) => new Promise((res) => setTimeout(() => res(text), f.sample ? 600 : 250)))
      .then((text) => {
        meta.textContent = `${fmtSize(f.size)} · analyzing geometry…`;
        setStatus('Analyzing', 'busy');
        return new Promise((res) => setTimeout(() => res(parseStep(text)), 30));
      })
      .then((data) => {
        e.data = data;
        e.state = 'ready';
        state.textContent = 'READY';
        meta.textContent = `${fmtSize(f.size)} · ${data.pointCount.toLocaleString()} points · ${data.unit}`;
        setStatus('Part loaded');
      })
      .catch((err) => {
        e.state = 'error';
        e.error = err.message;
        state.textContent = 'ERROR';
        state.classList.add('err');
        meta.textContent = err.message;
        setStatus('Check file', 'error');
      })
      .finally(() => {
        setTimeout(() => { clearInterval(tick); bar.style.width = '100%'; }, 200);
        if (active === e) render(e);
      });
  }

  function select(e) {
    active = e;
    entries.forEach((x) => x.el.classList.toggle('active', x === e));
    render(e);
  }

  function remove(e) {
    entries.splice(entries.indexOf(e), 1);
    e.el.remove();
    if (!entries.length) {
      active = null;
      setStatus('Ready');
      setExpanded(false);
      return;
    }
    if (active === e) select(entries.at(-1));
  }

  // The detail column keeps the same rows whether it's loading, loaded or showing an error,
  // so the panel doesn't jump in size after the expand tween.
  function render(e) {
    const facts = q('facts'), fit = q('fit'), dims = q('dims');
    const row = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
    const d = e.data;
    q('name').textContent = d && d.partName && !/^(untitled|part)?$/i.test(d.partName) ? d.partName : e.name.replace(/\.(step|stp)$/i, '');
    if (!d) {
      facts.innerHTML = row('Size (in)', '—') + row('Size (mm)', '—') + row('Faces', '—') + row('Holes / cyl.', '—');
      fit.innerHTML = ENVELOPES.map((env) => `<div class="fit no"><b><i>·</i>${env.name}</b><small>${env.spec}</small></div>`).join('') +
        `<p class="fit-note ${e.state === 'error' ? 'warn' : ''}">${e.state === 'error' ? escapeHtml(e.error) : 'Reading geometry…'}</p>`;
      dims.textContent = '';
      return;
    }
    const a = assess(d);
    const pick = process();
    const [x, y, z] = d.dims;
    const inch = (v) => (v / 25.4).toFixed(2);
    facts.innerHTML =
      row('Size (in)', `${inch(x)} × ${inch(y)} × ${inch(z)}`) +
      row('Size (mm)', `${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)}`) +
      row('Faces', d.faces ? d.faces.toLocaleString() : '—') +
      row('Holes / cyl.', d.cylinders ? d.cylinders.toLocaleString() : '—');
    let note = a.note;
    let warn = false;
    if (pick !== 'auto' && !a.fits[pick]) {
      warn = true;
      const fitting = ENVELOPES.filter((v) => a.fits[v.key]).map((v) => v.name);
      note = `This part is outside the ${PROCESS_NAME[pick]} size.${fitting.length ? ` It fits: ${fitting.join(', ')}.` : ''}`;
    } else if (pick !== 'auto') {
      note = `Within the ${PROCESS_NAME[pick]} size (${ENVELOPES.find((v) => v.key === pick).spec}).`;
    }
    fit.innerHTML = ENVELOPES.map((env) => {
      const ok = a.fits[env.key];
      const isRec = a.rec === env.key;
      const isPick = pick === env.key;
      const tag = isPick ? '<span class="fit-tag">Your pick</span>' : isRec ? '<span class="fit-tag">Best fit</span>' : '';
      const label = ok ? `Quote on ${env.name}` : `This part is outside the ${env.name} size`;
      return `<button type="button" class="fit ${ok ? 'ok' : 'no'} ${isRec ? 'rec' : ''} ${isPick ? 'pick' : ''}" data-fit="${env.key}" aria-pressed="${isPick}" title="${label}"${ok ? '' : ' disabled'}>${tag}<b><i>${ok ? '✓' : '×'}</i>${env.name}</b><small>${env.spec}</small></button>`;
    }).join('') + `<p class="fit-note ${warn ? 'warn' : ''}">${note}</p>`;
    dims.textContent = `${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm`;
    try {
      preview ||= createPreview(q('preview'));
      preview.setData(d);
    } catch (err) {
      console.warn('Preview unavailable', err);
    }
  }

  // requirements
  const qty = q('qty');
  form.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
    qty.value = Math.max(1, Math.min(9999, (parseInt(qty.value, 10) || 1) + +b.dataset.step));
  }));
  qty.addEventListener('change', () => { qty.value = Math.max(1, Math.min(9999, parseInt(qty.value, 10) || 1)); });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const ready = entries.filter((x) => x.state === 'ready');
    if (!ready.length) return toast('Add a valid STEP file first.');
    const del = { 'same-day': 'same-day Uber', '2-day': '2-day shipping', pickup: 'Berkeley pickup' }[fd.get('delivery')];
    toast(`Quote requested: ${ready.length} file${ready.length > 1 ? 's' : ''} · ${PROCESS_NAME[process()]} · ${fd.get('material')} · qty ${fd.get('qty')} · ${del}. (Prototype — not connected to a quoting backend.)`);
  });

  return { el: panel, open, handle };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
