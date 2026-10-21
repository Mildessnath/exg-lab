/**
 * viewer3d.js — Visualisasi 3D model dipol jantung + plot 2D sadapan yang tersinkron.
 *
 * - Three.js (js/vendor/three.min.js, revisi terkunci) dimuat MALAS: hanya saat tab 3D dibuka
 *   pertama kali (modul ini sendiri pun diimpor dinamis oleh ui.js).
 * - Tanpa WebGL (atau berkas Three.js gagal dimuat): pesan jelas ditampilkan, sedangkan plot 2D,
 *   pembacaan numerik, dan animasi waktu tetap berjalan.
 * - requestAnimationFrame hanya berjalan bila tab 3D aktif dan halaman terlihat; saat jeda dan
 *   tak ada interaksi, tidak ada frame yang dirender sama sekali.
 *
 * MODEL SEDERHANA, BUKAN UNTUK PENGGUNAAN KLINIS — lihat cardiac-dipole.js. Sketsa tidak
 * berskala anatomis.
 */

import {
  LEADS, getLead, HEART_POS, ELECTRODES, TORSO, waveVectors, dipoleAt, leadSignal, vcgLoop,
  frontalAngleDeg,
} from './cardiac-dipole.js';
import { fmt } from './format.js';

/** Revisi Three.js yang divendor di js/vendor/three.min.js (diperiksa setelah dimuat). */
export const THREE_REVISION = '149';
const THREE_URL = new URL('./vendor/three.min.js', import.meta.url).href;

// ---------------------------------------------------------------------------
// Pemuatan Three.js & deteksi WebGL
// ---------------------------------------------------------------------------
let threePromise = null;

/** Memuat three.min.js sekali (UMD → globalThis.THREE) dan memeriksa revisinya. */
export function loadThree() {
  if (globalThis.THREE) return Promise.resolve(globalThis.THREE);
  if (!threePromise) {
    threePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = THREE_URL;
      s.async = true;
      s.onload = () => {
        const T = globalThis.THREE;
        if (!T) reject(new Error('Berkas three.min.js termuat tetapi objek THREE tidak ada.'));
        else if (String(T.REVISION) !== THREE_REVISION) reject(new Error(`Revisi Three.js ${T.REVISION} ≠ ${THREE_REVISION} yang diharapkan.`));
        else resolve(T);
      };
      s.onerror = () => { threePromise = null; reject(new Error(`Gagal memuat ${THREE_URL}.`)); };
      document.head.appendChild(s);
    });
  }
  return threePromise;
}

export function webglSupported() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Kontrol orbit sederhana (putar / zoom / pinch / papan ketik)
// ---------------------------------------------------------------------------
function makeOrbit(THREE, camera, dom, target, onChange) {
  const DEF = { theta: 0.55, phi: 1.3, radius: 7.6 };
  let { theta, phi, radius } = DEF;
  const pts = new Map();
  let pinch = 0;

  const apply = () => {
    phi = Math.min(Math.max(phi, 0.12), Math.PI - 0.12);
    radius = Math.min(Math.max(radius, 2.6), 14);
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    camera.lookAt(target);
    onChange();
  };
  const dist = () => {
    const [a, b] = [...pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const down = (e) => { dom.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (pts.size === 2) pinch = dist(); };
  const move = (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    if (pts.size === 1) {
      theta -= (e.clientX - p.x) * 0.008;
      phi -= (e.clientY - p.y) * 0.008;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size === 2) { const d = dist(); if (pinch > 0 && d > 0) radius *= pinch / d; pinch = d; }
    apply();
  };
  const up = (e) => { pts.delete(e.pointerId); pinch = 0; };
  const wheel = (e) => { e.preventDefault(); radius *= Math.exp(e.deltaY * 0.001); apply(); };
  const key = (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') theta -= 0.1;
    else if (k === 'ArrowRight') theta += 0.1;
    else if (k === 'ArrowUp') phi -= 0.1;
    else if (k === 'ArrowDown') phi += 0.1;
    else if (k === '+' || k === '=') radius *= 0.9;
    else if (k === '-' || k === '_') radius *= 1.1;
    else return;
    e.preventDefault();
    apply();
  };
  dom.addEventListener('pointerdown', down);
  dom.addEventListener('pointermove', move);
  dom.addEventListener('pointerup', up);
  dom.addEventListener('pointercancel', up);
  dom.addEventListener('wheel', wheel, { passive: false });
  dom.addEventListener('keydown', key);
  apply();
  return { reset() { ({ theta, phi, radius } = DEF); apply(); } };
}

// ---------------------------------------------------------------------------
// Adegan 3D
// ---------------------------------------------------------------------------
const COLOR = {
  torso: 0x7aa7f5, heart: 0xd9455f, dipole: 0xf08c00, vcg: 0x8250df, lead: 0x1f6feb, proj: 0x2f9e44,
  electrode: 0x8a93a3, active: 0x1f6feb,
};

function makeLabel(THREE, text, { color = '#1d2433', height = 0.26 } = {}) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 34px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.9)'; g.strokeText(text, 128, 34);
  g.fillStyle = color; g.fillText(text, 128, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(height * 4, height, 1);
  sp.renderOrder = 10;
  return sp;
}

function buildScene(THREE, host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const dom = renderer.domElement;
  dom.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
  dom.tabIndex = 0;
  dom.setAttribute('aria-label', 'Adegan 3D dipol jantung. Seret untuk memutar, roda atau cubit untuk zoom, tombol panah untuk memutar, + dan − untuk zoom.');
  host.replaceChildren(dom);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(3, 4, 5);
  scene.add(sun);

  const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
  const heart = V(HEART_POS);

  // --- torso transparan: kapsul elips + cincin kontur, kepala + hidung (penanda depan) ---
  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(1, 1.6, 8, 40),
    new THREE.MeshPhongMaterial({ color: COLOR.torso, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }),
  );
  torso.scale.set(TORSO.a, 1, TORSO.b);
  scene.add(torso);
  const ringMat = new THREE.LineBasicMaterial({ color: COLOR.torso, transparent: true, opacity: 0.5 });
  for (const y of [-1.4, -0.7, 0, 0.7, 1.4]) {
    const r = Math.abs(y) <= 0.8 ? 1 : Math.sqrt(Math.max(0, 1 - (Math.abs(y) - 0.8) ** 2));
    const pts = [];
    for (let i = 0; i < 64; i++) { const a = (i / 64) * 2 * Math.PI; pts.push(new THREE.Vector3(TORSO.a * r * Math.cos(a), y, TORSO.b * r * Math.sin(a))); }
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), ringMat));
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 16),
    new THREE.MeshPhongMaterial({ color: COLOR.torso, transparent: true, opacity: 0.12, depthWrite: false }));
  head.position.set(0, 2.2, 0);
  scene.add(head);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 12), new THREE.MeshPhongMaterial({ color: COLOR.torso }));
  nose.rotation.x = Math.PI / 2; // +y → +z (menghadap depan)
  nose.position.set(0, 2.2, 0.4);
  scene.add(nose);

  // --- jantung dan elektrode ---
  const heartMesh = new THREE.Mesh(new THREE.SphereGeometry(0.17, 24, 16),
    new THREE.MeshPhongMaterial({ color: COLOR.heart, transparent: true, opacity: 0.6 }));
  heartMesh.position.copy(heart);
  scene.add(heartMesh);
  const heartLabel = makeLabel(THREE, 'jantung', { color: '#b0243d', height: 0.2 });
  heartLabel.position.set(heart.x - 0.05, heart.y + 0.32, heart.z);
  scene.add(heartLabel);

  const electrodes = {};
  for (const [id, pos] of Object.entries(ELECTRODES)) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), new THREE.MeshBasicMaterial({ color: COLOR.electrode }));
    m.position.copy(V(pos));
    scene.add(m);
    const lb = makeLabel(THREE, id, { color: '#5c6577', height: 0.17 });
    lb.position.set(pos[0] + (pos[0] >= 0 ? 0.13 : -0.13), pos[1] + 0.1, pos[2] + 0.06);
    scene.add(lb);
    electrodes[id] = { mesh: m, label: lb };
  }
  // sisi segitiga Einthoven (redup) — yang terpilih disorot di setLead
  const tri = {};
  for (const [id, [a, b]] of Object.entries({ I: ['RA', 'LA'], II: ['RA', 'LL'], III: ['LA', 'LL'] })) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(ELECTRODES[a]), V(ELECTRODES[b])]),
      new THREE.LineBasicMaterial({ color: 0xb8c0cc, transparent: true, opacity: 0.8 }));
    scene.add(line);
    tri[id] = line;
  }
  // garis pandang pusat jantung → elektrode prekordial terpilih
  const sight = new THREE.Line(new THREE.BufferGeometry().setFromPoints([heart, heart.clone()]),
    new THREE.LineBasicMaterial({ color: COLOR.lead }));
  scene.add(sight);

  // --- sumbu orientasi ---
  const axes = new THREE.AxesHelper(0.5);
  axes.position.set(-1.7, -1.6, 0.6);
  scene.add(axes);
  for (const [txt, p] of [['x kiri', [0.62, 0, 0]], ['y atas', [0, 0.62, 0]], ['z depan', [0, 0, 0.62]]]) {
    const lb = makeLabel(THREE, txt, { color: '#5c6577', height: 0.16 });
    lb.position.set(-1.7 + p[0], -1.6 + p[1], 0.6 + p[2]);
    scene.add(lb);
  }

  // --- panah dipol, ujung, vektor sadapan, proyeksi ---
  const dipoleArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), heart, 0.5, COLOR.dipole, 0.2, 0.12);
  scene.add(dipoleArrow);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), new THREE.MeshBasicMaterial({ color: COLOR.dipole }));
  scene.add(tip);
  const leadArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), heart, 1, COLOR.lead, 0.16, 0.09);
  scene.add(leadArrow);
  let leadLabel = null;
  const projArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), heart, 0.5, COLOR.proj, 0.14, 0.09);
  scene.add(projArrow);
  // garis tegak lurus dari ujung H ke titik proyeksi pada sumbu sadapan; posisi diperbarui di tempat
  const dropPos = new Float32Array(6);
  const dropGeom = new THREE.BufferGeometry();
  dropGeom.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
  const dropLine = new THREE.Line(dropGeom, new THREE.LineBasicMaterial({ color: COLOR.proj, transparent: true, opacity: 0.7 }));
  scene.add(dropLine);

  // --- jejak VCG (statis redup + bagian yang sudah dilalui) ---
  let vcgFull = null, vcgHead = null, loopPts = null;
  const vcgGroup = new THREE.Group();
  scene.add(vcgGroup);

  const hooks = { requestRender: () => {} };
  const target = new THREE.Vector3(0.1, 0.3, 0);
  const orbit = makeOrbit(THREE, camera, dom, target, () => hooks.requestRender());

  let sizeW = 0, sizeH = 0;
  const ctx = {
    hooks,
    /** Mengganti jejak VCG satu denyut (points = [x,y,z,…] volt) dengan skala volt → satuan sketsa. */
    setLoop(loop, scaleV) {
      if (vcgFull) { vcgGroup.remove(vcgFull, vcgHead); vcgFull.geometry.dispose(); vcgHead.geometry.dispose(); }
      loopPts = new Float32Array(loop.n * 3);
      for (let i = 0; i < loop.n; i++) {
        loopPts[3 * i] = heart.x + loop.points[3 * i] * scaleV;
        loopPts[3 * i + 1] = heart.y + loop.points[3 * i + 1] * scaleV;
        loopPts[3 * i + 2] = heart.z + loop.points[3 * i + 2] * scaleV;
      }
      const mk = () => new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(loopPts, 3));
      vcgFull = new THREE.Line(mk(), new THREE.LineBasicMaterial({ color: COLOR.vcg, transparent: true, opacity: 0.28 }));
      vcgHead = new THREE.Line(mk(), new THREE.LineBasicMaterial({ color: COLOR.vcg }));
      vcgHead.geometry.setDrawRange(0, 0);
      vcgGroup.add(vcgFull, vcgHead);
    },
    setVcgVisible(b) { vcgGroup.visible = b; },
    /** Menyorot sadapan terpilih: elektrode, sisi segitiga, garis pandang, panah vektor sadapan. */
    setLead(lead) {
      const L = V(lead.vec);
      const dir = L.clone().normalize();
      leadArrow.setDirection(dir);
      leadArrow.setLength(1.15, 0.16, 0.09);
      if (leadLabel) { scene.remove(leadLabel); leadLabel.material.map.dispose(); leadLabel.material.dispose(); }
      leadLabel = makeLabel(THREE, lead.id, { color: '#1f6feb', height: 0.22 });
      leadLabel.position.copy(heart).addScaledVector(dir, 1.38);
      scene.add(leadLabel);
      for (const [id, e] of Object.entries(electrodes)) {
        const on = lead.elektrode.includes(id);
        e.mesh.material.color.setHex(on ? COLOR.active : COLOR.electrode);
        e.mesh.scale.setScalar(on ? 1.9 : 1);
      }
      for (const [id, line] of Object.entries(tri)) line.material.color.setHex(id === lead.id ? COLOR.active : 0xb8c0cc);
      const sightTo = lead.id.startsWith('V') ? V(ELECTRODES[lead.id]) : heart.clone();
      sight.geometry.setFromPoints([heart, sightTo]);
      sight.visible = lead.id.startsWith('V');
    },
    /** Per frame: H (volt), skala, sadapan, indeks jejak yang sudah dilalui. */
    update({ H, scaleV, lead, loopIdx }) {
      const hv = new THREE.Vector3(H[0], H[1], H[2]).multiplyScalar(scaleV);
      const hl = hv.length();
      dipoleArrow.visible = hl > 0.02;
      if (dipoleArrow.visible) {
        dipoleArrow.setDirection(hv.clone().normalize());
        dipoleArrow.setLength(hl, Math.min(0.2, hl * 0.4), 0.12);
      }
      tip.position.copy(heart).add(hv);
      const Ld = V(lead.vec).normalize();
      const along = hv.dot(Ld); // proyeksi H pada arah sadapan (satuan sketsa, bertanda)
      const pl = Math.abs(along);
      projArrow.visible = pl > 0.02;
      if (projArrow.visible) {
        projArrow.setDirection(Ld.clone().multiplyScalar(Math.sign(along)));
        projArrow.setLength(pl, Math.min(0.14, pl * 0.5), 0.09);
      }
      const foot = heart.clone().addScaledVector(Ld, along);
      dropPos[0] = heart.x + hv.x; dropPos[1] = heart.y + hv.y; dropPos[2] = heart.z + hv.z;
      dropPos[3] = foot.x; dropPos[4] = foot.y; dropPos[5] = foot.z;
      dropGeom.attributes.position.needsUpdate = true;
      if (vcgHead) vcgHead.geometry.setDrawRange(0, Math.max(0, Math.min(loopIdx, vcgHead.geometry.attributes.position.count)));
    },
    resize() {
      const w = host.clientWidth, h = host.clientHeight;
      if (!w || !h) return false;
      if (w !== sizeW || h !== sizeH) {
        sizeW = w; sizeH = h;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      return true;
    },
    render() { renderer.render(scene, camera); },
    resetCamera() { orbit.reset(); },
    dispose() { renderer.dispose(); },
    dom,
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Plot 2D sinyal sadapan dengan penanda waktu
// ---------------------------------------------------------------------------
function niceStep(raw) {
  const e = Math.floor(Math.log10(raw));
  const f = raw / 10 ** e;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * 10 ** e;
}

function makePlot(canvas) {
  const cache = document.createElement('canvas');
  const M = { l: 46, r: 10, t: 22, b: 34 };
  let geom = null;

  function drawBase(sig, fs, duration, leadId) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) { geom = null; return; }
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    cache.width = canvas.width; cache.height = canvas.height;
    const g = cache.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const pw = W - M.l - M.r, ph = H - M.t - M.b;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < sig.length; i++) { const v = sig[i] * 1e3; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!(hi - lo > 1e-9)) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const xOf = (t) => M.l + (t / duration) * pw;
    const yOf = (v) => M.t + (1 - (v - lo) / (hi - lo)) * ph;
    g.font = '11px system-ui, sans-serif';
    g.lineWidth = 1;
    // grid + label Y (mV)
    const ys = niceStep((hi - lo) / 5);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let v = Math.ceil(lo / ys) * ys; v <= hi; v += ys) {
      const y = Math.round(yOf(v)) + 0.5;
      g.strokeStyle = Math.abs(v) < ys * 1e-6 ? '#b8c0cc' : '#eceff4';
      g.beginPath(); g.moveTo(M.l, y); g.lineTo(M.l + pw, y); g.stroke();
      g.fillStyle = '#5c6577'; g.fillText(fmt(Math.abs(v) < ys * 1e-6 ? 0 : v, ys < 1 ? 1 : 0), M.l - 5, y);
    }
    // grid + label X (s)
    const xs = niceStep(duration / 6);
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let t = 0; t <= duration + 1e-9; t += xs) {
      const x = Math.round(xOf(t)) + 0.5;
      g.strokeStyle = '#eceff4';
      g.beginPath(); g.moveTo(x, M.t); g.lineTo(x, M.t + ph); g.stroke();
      g.fillStyle = '#5c6577'; g.fillText(fmt(t, xs < 1 ? 1 : 0), x, M.t + ph + 4);
    }
    g.strokeStyle = '#8a93a3'; g.strokeRect(M.l + 0.5, M.t + 0.5, pw, ph);
    g.fillStyle = '#1d2433'; g.font = '12px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText('Waktu (s)', M.l + pw / 2, H - 3);
    g.save(); g.translate(12, M.t + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle'; g.fillText('Tegangan sadapan (mV)', 0, 0); g.restore();
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#1f6feb'; g.font = '600 12px system-ui, sans-serif';
    g.fillText(`Sadapan ${leadId} (model dipol, tanpa gangguan)`, M.l + 4, 4);
    // kurva
    g.save();
    g.beginPath(); g.rect(M.l, M.t, pw, ph); g.clip();
    g.strokeStyle = '#1f6feb'; g.lineWidth = 1.4; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < sig.length; i++) {
      const x = xOf(i / fs), y = yOf(sig[i] * 1e3);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.restore();
    geom = { W, H, dpr, xOf, yOf, pw, ph };
  }

  function drawFrame(t, value) {
    if (!geom) return;
    const c = canvas.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(cache, 0, 0);
    c.setTransform(geom.dpr, 0, 0, geom.dpr, 0, 0);
    const x = geom.xOf(t), y = geom.yOf(value * 1e3);
    c.strokeStyle = '#f08c00'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, M.t); c.lineTo(x, M.t + geom.ph); c.stroke();
    c.fillStyle = '#f08c00';
    c.beginPath(); c.arc(x, y, 4, 0, 2 * Math.PI); c.fill();
  }
  return { drawBase, drawFrame };
}

// ---------------------------------------------------------------------------
// Viewer: logika bersama (animasi, kontrol, pembacaan) — adegan 3D opsional
// ---------------------------------------------------------------------------
const SIG_FS = 1000; // Hz, sinyal plot 2D

/**
 * @param {object} els  { stage, plot, readout, desc, dyn, status, btnPlay, selSpeed, selLead, chkVcg, btnReset, time }
 * @param {{ onLeadChange?: (id:string)=>void }} hooks
 */
export async function createViewer(els, hooks = {}) {
  const S = {
    model: null, wv: null, scaleV: 1, lead: getLead('II'), playing: true, speed: 0.25, t: 0, active: false,
    raf: 0, last: 0, sig: null, loop: null, readoutAt: 0, descAt: 0, scene: null, webgl: false, reason: '', frames: 0,
  };
  const plot = makePlot(els.plot);

  // --- kontrol HTML ---
  if (!els.selLead.options.length) {
    const groups = new Map();
    for (const l of LEADS) {
      if (!groups.has(l.grup)) { const og = document.createElement('optgroup'); og.label = l.grup; els.selLead.appendChild(og); groups.set(l.grup, og); }
      const o = document.createElement('option'); o.value = l.id; o.textContent = l.id; groups.get(l.grup).appendChild(o);
    }
  }
  els.selLead.value = S.lead.id;
  els.selSpeed.value = String(S.speed);
  const syncPlayButton = () => {
    els.btnPlay.textContent = S.playing ? '⏸ Jeda' : '▶ Putar';
    els.btnPlay.setAttribute('aria-pressed', String(S.playing));
  };
  syncPlayButton();

  // --- adegan 3D (opsional) ---
  els.stage.textContent = 'Memuat mesin 3D…';
  try {
    if (!webglSupported()) throw new Error('WebGL tidak tersedia pada peramban atau perangkat ini.');
    const THREE = await loadThree();
    S.scene = buildScene(THREE, els.stage);
    S.scene.hooks.requestRender = () => requestRender();
    S.webgl = true;
    els.status.hidden = true;
  } catch (e) {
    S.reason = e.message;
    els.stage.textContent = '';
    els.status.hidden = false;
    els.status.textContent = `Adegan 3D tidak dapat ditampilkan: ${e.message} Plot 2D sinyal sadapan, pembacaan numerik, dan animasi waktu tetap berfungsi.`;
  }
  els.stage.dataset.webgl = String(S.webgl);

  // --- perhitungan ---
  function recompute() {
    if (!S.model) return;
    const { hr, rAmp, duration } = S.model;
    S.wv = waveVectors(rAmp);
    const vR = S.wv.find((w) => w.nama === 'R');
    S.scaleV = 0.9 / Math.abs(vR.mag); // panjang panah dinormalkan: vektor R terbesar ≈ 0,9 satuan sketsa
    S.loop = vcgLoop({ hr, rAmp });
    const n = Math.round(duration * SIG_FS);
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = i / SIG_FS;
    S.sig = leadSignal(t, { fs: SIG_FS, duration, hr, rAmp }, S.lead.id);
    if (S.scene) { S.scene.setLoop(S.loop, S.scaleV); S.scene.setVcgVisible(els.chkVcg.checked); S.scene.setLead(S.lead); }
    els.time.max = String(duration);
    plot.drawBase(S.sig, SIG_FS, duration, S.lead.id);
  }

  function pose(t) {
    const { hr, rAmp } = S.model;
    const H = dipoleAt(t, { hr, rAmp, wv: S.wv });
    const L = S.lead.vec;
    const value = H[0] * L[0] + H[1] * L[1] + H[2] * L[2];
    // posisi di dalam jendela jejak VCG satu denyut
    // Jendela tiap denyut mulai 0,32 s sebelum R; pilih denyut yang jendelanya sudah dimulai.
    const rr = 60 / hr;
    const start = S.loop.t0 + Math.floor((t - S.loop.t0) / rr) * rr;
    const loopIdx = Math.min(S.loop.n, Math.floor((t - start) / S.loop.dt) + 1);
    return { H, value, loopIdx };
  }

  function writeReadout(t, H, value, force) {
    const now = performance.now();
    if (!force && now - S.readoutAt < 120) return;
    S.readoutAt = now;
    const mag = Math.hypot(H[0], H[1], H[2]);
    const L = S.lead.vec;
    const mv = (v) => fmt(v * 1e3, 3);
    els.readout.innerHTML = `<table><tr><td>Waktu simulasi</td><td>${fmt(t, 3)} s</td></tr>`
      + `<tr><td>Dipol H (x, y, z)</td><td>${mv(H[0])}; ${mv(H[1])}; ${mv(H[2])} mV</td></tr>`
      + `<tr><td>|H| · sudut frontal</td><td>${mv(mag)} mV · ${mag > 1e-5 ? `${fmt(frontalAngleDeg(H), 0)}°` : '–'}</td></tr>`
      + `<tr><td>Vektor sadapan ${S.lead.id}</td><td>(${fmt(L[0], 2)}; ${fmt(L[1], 2)}; ${fmt(L[2], 2)})</td></tr>`
      + `<tr class="sep"><td>Proyeksi H·L = sinyal sadapan ${S.lead.id}</td><td><b>${mv(value)} mV</b></td></tr></table>`;
    if (force || now - S.descAt > 600) {
      S.descAt = now;
      els.dyn.textContent = `Saat t = ${fmt(t, 2)} s: dipol H = (${mv(H[0])}; ${mv(H[1])}; ${mv(H[2])}) mV, panjang ${mv(mag)} mV`
        + `${mag > 1e-5 ? `, sudut frontal ${fmt(frontalAngleDeg(H), 0)}°` : ''}; proyeksi pada sadapan ${S.lead.id} = ${mv(value)} mV.`;
    }
  }

  function draw(force = false) {
    if (!S.model || !S.sig) return;
    const { H, value, loopIdx } = pose(S.t);
    S.frames++;
    plot.drawFrame(S.t, value);
    els.time.value = String(S.t);
    writeReadout(S.t, H, value, force);
    if (S.scene && S.scene.resize()) {
      S.scene.update({ H, scaleV: S.scaleV, lead: S.lead, loopIdx });
      S.scene.render();
    }
  }

  // --- loop animasi: hanya berjalan bila aktif, halaman terlihat, dan (diputar atau ada permintaan) ---
  function frame(now) {
    S.raf = 0;
    if (!S.active || document.hidden || !S.model) return;
    const dt = Math.min(0.1, (now - S.last) / 1000);
    S.last = now;
    if (S.playing) {
      S.t += dt * S.speed;
      if (S.t > S.model.duration) S.t -= S.model.duration;
    }
    draw();
    if (S.playing) S.raf = requestAnimationFrame(frame);
  }
  function requestRender() {
    if (!S.active || document.hidden || S.raf) return;
    S.last = performance.now();
    S.raf = requestAnimationFrame(frame);
  }

  // --- kontrol ---
  els.btnPlay.addEventListener('click', () => { S.playing = !S.playing; syncPlayButton(); requestRender(); });
  els.selSpeed.addEventListener('change', () => { S.speed = Number(els.selSpeed.value); });
  els.selLead.addEventListener('change', () => {
    api.setLead(els.selLead.value);
    if (hooks.onLeadChange) hooks.onLeadChange(S.lead.id);
  });
  els.chkVcg.addEventListener('change', () => { if (S.scene) S.scene.setVcgVisible(els.chkVcg.checked); requestRender(); });
  els.btnReset.addEventListener('click', () => { if (S.scene) S.scene.resetCamera(); requestRender(); });
  els.time.addEventListener('input', () => {
    S.t = Number(els.time.value);
    S.playing = false; syncPlayButton();
    S.last = performance.now(); draw(true); requestRender();
  });
  els.stage.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); els.btnPlay.click(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRender(); else if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (S.active && S.model && S.sig) { plot.drawBase(S.sig, SIG_FS, S.model.duration, S.lead.id); requestRender(); draw(); } }).observe(els.stage);
  }

  const api = {
    get webgl() { return S.webgl; },
    get reason() { return S.reason; },
    get running() { return S.raf !== 0; },
    get frames() { return S.frames; },
    get state() { return { t: S.t, playing: S.playing, speed: S.speed, lead: S.lead.id, active: S.active }; },
    /** Parameter model dari tab 1–4: { hr, rAmp, duration }. */
    setModel(model) {
      const same = S.model && S.model.hr === model.hr && S.model.rAmp === model.rAmp && S.model.duration === model.duration;
      S.model = { ...model };
      if (!same) { if (S.t > model.duration) S.t = 0; recompute(); }
      if (S.active) { draw(true); requestRender(); }
    },
    setLead(id) {
      const lead = getLead(id);
      if (lead.id === S.lead.id && S.sig) return;
      S.lead = lead;
      els.selLead.value = lead.id;
      if (S.model) recompute();
      if (S.active) { draw(true); requestRender(); }
    },
    /** Hanya render saat tab terlihat: false menghentikan requestAnimationFrame sepenuhnya. */
    setActive(active) {
      S.active = !!active;
      if (!S.active) { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } return; }
      if (S.model) { recompute(); draw(true); requestRender(); }
    },
  };
  return api;
}
