/**
 * ui.js — Antarmuka: membaca kontrol, menjalankan pipeline, menggambar plot canvas
 * dan panel info. Seluruh perhitungan sinyal didelegasikan ke modul murni lain;
 * file ini hanya berurusan dengan DOM dan penggambaran.
 */

import { runPipeline, STAGE_DEFS } from './pipeline.js';
import { FS_ANALOG, ecgCharacteristics, signalStats, snrDb, detectRPeaks } from './signal.js';
import { V_SAT } from './amplifier.js';
import {
  FILTER_PRESETS, logspace, frequencyResponse, magnitudeDb, measureMinus3dB,
  amplitudeSpectrum, filterQualityMetrics,
} from './filters.js';
import { analyzeAliasing, powerAboveNyquist, toBinary, adcToCsv } from './adc.js';
import { validateAmplifier, validateRc, validateAdc, validateAdcSignal } from './validation.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Format angka (gaya Indonesia: koma desimal, titik ribuan)
// ---------------------------------------------------------------------------
function fmt(v, digits = 2) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '−∞';
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const mV = (v, d = 2) => `${fmt(v * 1e3, d)} mV`;
const ms = (v) => `${fmt(v * 1e3, 0)} ms`;
/** Tiga angka penting: 40 → "40,0", 0.5 → "0,500", 100 → "100". */
function fmtSig(v) {
  if (!Number.isFinite(v) || v <= 0) return fmt(v, 2);
  v = Number(v.toPrecision(3)); // 9,998 → 10,0 (bukan 10,00)
  return fmt(v,Math.min(3, Math.max(0, 2 - Math.floor(Math.log10(v)))));
}
const hz = (v) => `${fmtSig(v)} Hz`;
const sig3 = (v) => Number(v.toPrecision(3));

// ---------------------------------------------------------------------------
// Membaca parameter dari kontrol
// ---------------------------------------------------------------------------
function currentGain() {
  const preset = document.querySelector('input[name=gainPreset]:checked').value;
  if (preset === 'custom') return Math.round(10 ** Number($('gainLog').value));
  return Number(preset);
}

/** Nilai dari grup radio preset + slider "Bebas" (pola yang sama dengan gain). */
function presetOrFree(name, sliderId) {
  const v = document.querySelector(`input[name=${name}]:checked`).value;
  return Number(v === 'custom' ? $(sliderId).value : v);
}
const currentFs = () => presetOrFree('fsPreset', 'fsFree');
const currentBits = () => presetOrFree('bitsPreset', 'bitsFree');

/** Slider filter memakai skala log10; nilai dibulatkan ke 3 angka penting. */
const logVal = (id) => sig3(10 ** Number($(id).value));

/** Pemetaan field preset → id slider. */
const PRESET_FIELDS = {
  lpf: { fc: 'lpfFc' },
  hpf: { fc: 'hpfFc' },
  bpf: { fLow: 'bpfLow', fHigh: 'bpfHigh' },
  notch: { f0: 'notchF0', q: 'notchQ' },
};

function readFilterParams() {
  return {
    type: $('fType').value,
    lpf: { fc: logVal('lpfFc') },
    hpf: { fc: logVal('hpfFc') },
    bpf: { fLow: logVal('bpfLow'), fHigh: logVal('bpfHigh') },
    notch: { f0: logVal('notchF0'), q: logVal('notchQ') },
  };
}

function readParams() {
  const num = (id) => Number($(id).value);
  const on = (id) => $(id).checked;
  return {
    signal: {
      source: $('source').value,
      duration: num('duration'),
      fs: FS_ANALOG,
      hr: num('hr'),
      rAmp: 1e-3,
      sineFreq: num('sineFreq'),
      sineAmp: num('sineAmp') * 1e-3,
      disturbances: {
        baseline: { on: on('bwOn'), amp: num('bwAmp') * 1e-3, freq: 0.3 },
        mains: { on: on('mainsOn'), amp: num('mainsAmp') * 1e-3, freq: 50 },
        hf: { on: on('hfOn'), rms: num('hfRms') * 1e-3, seed: 12345 },
        alias: { on: on('aliasOn'), amp: num('aliasAmp') * 1e-3, freq: num('aliasFreq') },
      },
    },
    amplifier: { gain: currentGain(), vSat: V_SAT },
    filter: readFilterParams(),
    adc: {
      fs: currentFs(),
      bits: currentBits(),
      vRef: num('vRef'),
      antiAlias: on('aaOn'),
      aaOrder: 8,
      aaRatio: 0.4,
    },
  };
}

function presetMatches(type, preset) {
  return Object.entries(PRESET_FIELDS[type]).every(([k, id]) => Math.abs(logVal(id) - preset[k]) <= preset[k] * 0.005);
}

function renderPresets(type) {
  const box = $('fPresets');
  if (box.dataset.type === type) return;
  box.dataset.type = type;
  box.innerHTML = (FILTER_PRESETS[type] || [])
    .map((p, i) => `<button type="button" data-preset="${i}">${p.label}</button>`).join('');
}

function applyPreset(type, idx) {
  const p = FILTER_PRESETS[type][idx];
  for (const [k, id] of Object.entries(PRESET_FIELDS[type])) $(id).value = Math.log10(p[k]);
}

/** Memperbarui label nilai slider dan status tampil/sembunyi kontrol. */
function syncControls() {
  $('hrVal').textContent = `${$('hr').value} bpm`;
  $('sineFreqVal').textContent = `${fmt(Number($('sineFreq').value), 1)} Hz`;
  $('sineAmpVal').textContent = `${fmt(Number($('sineAmp').value), 2)} mV`;
  $('bwAmpVal').textContent = `${fmt(Number($('bwAmp').value), 2)} mV`;
  $('mainsAmpVal').textContent = `${fmt(Number($('mainsAmp').value), 2)} mV`;
  $('hfRmsVal').textContent = `${fmt(Number($('hfRms').value), 3)} mV`;
  $('aliasFreqVal').textContent = `${$('aliasFreq').value} Hz`;
  $('aliasAmpVal').textContent = `${fmt(Number($('aliasAmp').value), 2)} mV`;
  $('gainLogVal').textContent = `×${Math.round(10 ** Number($('gainLog').value)).toLocaleString('id-ID')}`;
  $('gainVal').textContent = `×${currentGain().toLocaleString('id-ID')}`;

  const isSine = $('source').value === 'sine';
  document.querySelectorAll('.only-ecg').forEach((el) => { el.hidden = isSine; });
  document.querySelectorAll('.only-sine').forEach((el) => { el.hidden = !isSine; });

  for (const k of ['bw', 'mains', 'hf', 'alias']) {
    $(`${k}Box`).classList.toggle('off', !$(`${k}On`).checked);
  }

  // --- Filter ---
  const f = readFilterParams();
  $('lpfFcVal').textContent = hz(f.lpf.fc);
  $('hpfFcVal').textContent = hz(f.hpf.fc);
  $('bpfLowVal').textContent = hz(f.bpf.fLow);
  $('bpfHighVal').textContent = hz(f.bpf.fHigh);
  $('notchF0Val').textContent = hz(f.notch.f0);
  $('notchQVal').textContent = fmtSig(f.notch.q);
  document.querySelectorAll('[data-ftype]').forEach((el) => {
    el.hidden = !el.dataset.ftype.split(' ').includes(f.type);
  });
  renderPresets(f.type);
  document.querySelectorAll('#fPresets button').forEach((b) => {
    b.classList.toggle('active', presetMatches(f.type, FILTER_PRESETS[f.type][Number(b.dataset.preset)]));
  });
  const hints = {
    none: 'Sinyal diteruskan tanpa perubahan.',
    lpf: 'Butterworth orde 2 (Q = 0,707 tetap), kemiringan 12 dB/oktaf.',
    hpf: 'Butterworth orde 2 (Q = 0,707 tetap), kemiringan 12 dB/oktaf.',
    bpf: f.bpf.fLow < f.bpf.fHigh
      ? 'Kaskade HPF + LPF Butterworth (2 biquad, total orde 4).'
      : '⚠ Tepi bawah harus lebih kecil dari tepi atas — pita kosong, hampir semua sinyal teredam.',
    notch: `Lebar pita −3 dB ≈ f0/Q = ${hz(f.notch.f0 / f.notch.q)}.`,
  };
  $('fHint').textContent = hints[f.type];

  // --- ADC ---
  const fsAdc = currentFs(), bits = currentBits();
  $('fsVal').textContent = `${fsAdc.toLocaleString('id-ID')} Hz`;
  $('bitsVal').textContent = `${bits} bit · ${(2 ** bits).toLocaleString('id-ID')} level`;
  $('vRefVal').textContent = `±${fmt(Number($('vRef').value), 2)} V`;
  $('aaHint').textContent = `Butterworth orde 8, fc = 0,4·fs = ${hz(0.4 * fsAdc)}: ≈ −15,6 dB di fs/2, ≈ −48 dB baru di 0,8·fs.`;
}

// ---------------------------------------------------------------------------
// Primitif plot canvas
// ---------------------------------------------------------------------------
const COLORS = {
  grid: '#eceff4',
  gridMinor: '#f5f6f9',
  axis: '#8a93a3',
  text: '#5c6577',
  title: '#1d2433',
  signal: '#1f6feb',
  clean: '#e8590c',
  amp: '#0f8a5f',
  ideal: '#9aa3b2',
  clip: '#cf222e',
  before: '#a3abb9',
  after: '#1f6feb',
  resp: '#1f6feb',
  marker: '#cf222e',
  vline: '#8250df',
};
const MARGIN = { l: 64, r: 14, t: 24, b: 42 };

/** Menyesuaikan resolusi canvas dengan ukuran CSS × devicePixelRatio. */
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return null; // canvas tersembunyi (tab lain)
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const m = MARGIN;
  return { ctx, cssW, cssH, m, W: cssW - m.l - m.r, H: cssH - m.t - m.b };
}

/** Pembulatan "cantik" untuk jarak tick (1, 2, 5 × 10^n). */
function niceStep(raw) {
  const e = Math.floor(Math.log10(raw));
  const f = raw / 10 ** e;
  const n = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return n * 10 ** e;
}

function niceTicks(min, max, target) {
  const step = niceStep((max - min) / target);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return { ticks, decimals: Math.max(0, -Math.floor(Math.log10(step))) };
}

/** Tick sumbu log: mayor di 10^n (berlabel), minor di 2..9 × 10^n. */
function logTicks(min, max) {
  const major = [], minor = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
    for (let k = 1; k < 10; k++) {
      const v = k * 10 ** e;
      if (v < min * 0.9999 || v > max * 1.0001) continue;
      (k === 1 ? major : minor).push(v);
    }
  }
  return { major, minor };
}

/** Grid dan label sumbu Y. */
function drawYGrid(c, yMin, yMax, yOf) {
  const { ctx, m, W } = c;
  const yt = niceTicks(yMin, yMax, 5);
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yt.ticks) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + W, y); ctx.stroke();
    ctx.fillText(fmt(v, yt.decimals), m.l - 6, y);
  }
}

/** Grid vertikal + label sumbu X untuk daftar tick tertentu. */
function drawXGrid(c, ticks, xOf, label, color = COLORS.grid) {
  const { ctx, m, H } = c;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const v of ticks) {
    const x = Math.round(xOf(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + H); ctx.stroke();
    if (label) ctx.fillText(label(v), x, m.t + H + 5);
  }
}

/** Bingkai area plot dan label kedua sumbu. */
function drawFrame(c, xLabel, yLabel) {
  const { ctx, m, W, H, cssH } = c;
  ctx.strokeStyle = COLORS.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(m.l + 0.5, m.t + 0.5, W, H);
  ctx.fillStyle = COLORS.title;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(xLabel, m.l + W / 2, cssH - 4);
  ctx.save();
  ctx.translate(14, m.t + H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText(yLabel, 0, 0);
  ctx.restore();
}

/** Garis horizontal putus-putus berlabel (mis. batas saturasi, −3 dB). */
function drawHLines(c, hLines, yMin, yMax, yOf) {
  const { ctx, m, W } = c;
  for (const hl of hLines) {
    if (hl.y < yMin || hl.y > yMax) continue;
    const y = Math.round(yOf(hl.y)) + 0.5;
    ctx.strokeStyle = hl.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + W, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = hl.color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    const below = hl.labelBelow ?? hl.y > 0;
    ctx.textBaseline = below ? 'top' : 'bottom';
    ctx.fillText(hl.label, m.l + W - 4, below ? y + 3 : y - 3);
  }
}

function drawLegend(c, series) {
  const { ctx, m } = c;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let lx = m.l;
  for (const s of series) {
    if (!s.label) continue;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dash || []);
    if (s.style === 'stem' || s.style === 'dots') {
      ctx.beginPath(); ctx.arc(lx + 9, m.t / 2, 3, 0, 2 * Math.PI); ctx.fill();
    } else {
      ctx.beginPath(); ctx.moveTo(lx, m.t / 2); ctx.lineTo(lx + 18, m.t / 2); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(s.label, lx + 22, m.t / 2);
    lx += 22 + ctx.measureText(s.label).width + 16;
  }
}

/**
 * Menggambar satu deret titik i0..i1 (x terurut naik). Bila titik jauh lebih banyak
 * daripada piksel, dipakai desimasi min–maks per kolom piksel agar puncak sempit
 * (QRS, noise, garis spektrum) tidak hilang.
 */
function strokeSeries(c, s, i0, i1, px, py) {
  if (i1 < i0) return;
  const { ctx, W } = c;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width || 1.4;
  ctx.setLineDash(s.dash || []);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (i1 - i0 + 1 <= W * 2) {
    for (let i = i0; i <= i1; i++) {
      if (i === i0) ctx.moveTo(px(i), py(i)); else ctx.lineTo(px(i), py(i));
    }
  } else {
    let col = null, mn = 0, mx = 0, first = true;
    const flush = () => {
      const x = col + 0.5;
      if (first) { ctx.moveTo(x, mn); first = false; } else ctx.lineTo(x, mn);
      ctx.lineTo(x, mx);
    };
    for (let i = i0; i <= i1; i++) {
      const cx = Math.floor(px(i));
      const y = py(i);
      if (cx !== col) {
        if (col !== null) flush();
        col = cx; mn = y; mx = y;
      } else {
        if (y < mn) mn = y;
        if (y > mx) mx = y;
      }
    }
    if (col !== null) flush();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * Sampel diskret: stem (garis dari 0 V + titik) bila cukup renggang, titik saja
 * bila lebih rapat, dan garis biasa bila sudah lebih rapat dari piksel.
 * Nilai non-finite (mis. sampel ter-clip pada plot error) dilewati.
 */
function drawMarks(c, s, i0, i1, px, py, yZero) {
  const { ctx, W } = c;
  const count = i1 - i0 + 1;
  if (count > W * 1.5) { strokeSeries(c, s, i0, i1, px, py); return; }
  const stem = s.style === 'stem' && count <= W / 4;
  const r = stem ? 2.6 : 1.6;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = 1;
  for (let i = i0; i <= i1; i++) {
    const y = py(i);
    if (!Number.isFinite(y)) continue;
    const x = px(i);
    if (stem) { ctx.beginPath(); ctx.moveTo(x, yZero); ctx.lineTo(x, y); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  }
}

/** Rekonstruksi zero-order hold (tangga): tiap nilai ditahan hingga sampel berikutnya. */
function drawStep(c, s, i0, i1, px, py) {
  const { ctx, W } = c;
  if (i1 - i0 + 1 > W) { strokeSeries(c, s, i0, i1, px, py); return; }
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width || 1.2;
  ctx.setLineDash(s.dash || []);
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const y = py(i);
    if (i === i0) ctx.moveTo(px(i), y); else ctx.lineTo(px(i), y);
    ctx.lineTo(i < s.y.length - 1 ? px(i + 1) : px(i), y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Rentang indeks sampel deret waktu yang jatuh di jendela [tMin, tMax]. */
function visibleRange(s, tMin, tMax) {
  const i0 = Math.max(0, Math.floor(tMin * s.fs));
  const i1 = Math.min(s.y.length - 1, Math.ceil(tMax * s.fs));
  return [i0, i1];
}

/**
 * Plot domain waktu.
 * series: [{ y, fs, scale, color, width, dash, label, style?: 'line'|'stem'|'dots'|'step' }]
 * hLines: [{ y, color, label }]; yInclude: nilai yang wajib masuk rentang Y
 * levels: { step } — garis tipis tiap level kuantisasi (hanya bila cukup renggang)
 */
function drawPlot(canvas, { series, tMin, tMax, xLabel, yLabel, hLines = [], yInclude = [], levels = null }) {
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, m, W, H } = c;

  // Rentang Y otomatis dari data yang terlihat
  let yMin = Infinity, yMax = -Infinity;
  for (const s of series) {
    const [i0, i1] = visibleRange(s, tMin, tMax);
    for (let i = i0; i <= i1; i++) {
      const v = s.y[i] * s.scale;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  for (const v of yInclude) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); }
  if (!Number.isFinite(yMin)) { yMin = -1; yMax = 1; }
  if (yMax - yMin < 1e-9) { const k = yMin; yMin = k - 1e-3 - Math.abs(k) * 0.1; yMax = k + 1e-3 + Math.abs(k) * 0.1; }
  const pad = (yMax - yMin) * 0.08;
  yMin -= pad; yMax += pad;

  const xOf = (t) => m.l + ((t - tMin) / (tMax - tMin)) * W;
  const yOf = (v) => m.t + (1 - (v - yMin) / (yMax - yMin)) * H;

  drawYGrid(c, yMin, yMax, yOf);
  const xt = niceTicks(tMin, tMax, Math.max(3, Math.floor(W / 80)));
  drawXGrid(c, xt.ticks, xOf, (v) => fmt(v, xt.decimals));
  drawFrame(c, xLabel, yLabel);

  ctx.save();
  ctx.beginPath(); ctx.rect(m.l, m.t, W, H); ctx.clip();
  // Garis level kuantisasi: hanya bila jaraknya ≥ ±4 px agar tidak menjadi blok abu-abu.
  if (levels && levels.step > 0 && (H * levels.step) / (yMax - yMin) >= 4) {
    ctx.strokeStyle = '#b9cdf3';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (let v = Math.ceil(yMin / levels.step) * levels.step; v <= yMax; v += levels.step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(m.l + W, y); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  drawHLines(c, hLines, yMin, yMax, yOf);
  const yZero = yOf(Math.min(Math.max(0, yMin), yMax));
  for (const s of series) {
    const [i0, i1] = visibleRange(s, tMin, tMax);
    const px = (i) => xOf(i / s.fs), py = (i) => yOf(s.y[i] * s.scale);
    if (s.style === 'stem' || s.style === 'dots') drawMarks(c, s, i0, i1, px, py, yZero);
    else if (s.style === 'step') drawStep(c, s, i0, i1, px, py);
    else strokeSeries(c, s, i0, i1, px, py);
  }
  ctx.restore();
  drawLegend(c, series);
}

/**
 * Plot XY umum (untuk domain frekuensi), mendukung sumbu X logaritmik.
 * series: [{ x, y, color, width, dash, label }] — x terurut naik
 * vLines: [{ x, color, label, faint }]; markers: [{ x, y, color, label }]
 */
function drawXY(canvas, {
  series, xMin, xMax, yMin, yMax, xLog = false, xLabel, yLabel, hLines = [], vLines = [], markers = [],
}) {
  const c = setupCanvas(canvas);
  if (!c) return;
  const { ctx, m, W, H } = c;
  const tx = xLog ? Math.log10 : (v) => v;
  const X0 = tx(xMin), X1 = tx(xMax);
  const xOf = (v) => m.l + ((tx(v) - X0) / (X1 - X0)) * W;
  const yOf = (v) => m.t + (1 - (Math.max(Math.min(v, yMax + 1e3), yMin - 1e3) - yMin) / (yMax - yMin)) * H;

  drawYGrid(c, yMin, yMax, yOf);
  if (xLog) {
    const lt = logTicks(xMin, xMax);
    drawXGrid(c, lt.minor, xOf, null, COLORS.gridMinor);
    // 0,100 → 0,1 ; 10,0 → 10
    drawXGrid(c, lt.major, xOf, (v) => fmtSig(v).replace(/(,\d*?)0+$/, '$1').replace(/,$/, ''));
  } else {
    const xt = niceTicks(xMin, xMax, Math.max(3, Math.floor(W / 80)));
    drawXGrid(c, xt.ticks, xOf, (v) => fmt(v, xt.decimals));
  }
  drawFrame(c, xLabel, yLabel);

  ctx.save();
  ctx.beginPath(); ctx.rect(m.l, m.t, W, H); ctx.clip();
  drawHLines(c, hLines, yMin, yMax, yOf);

  // Garis vertikal penanda frekuensi gangguan
  ctx.font = '11px system-ui, sans-serif';
  vLines.forEach((vl, k) => {
    if (vl.x < xMin || vl.x > xMax) return;
    const x = Math.round(xOf(vl.x)) + 0.5;
    ctx.globalAlpha = vl.faint ? 0.35 : 0.9;
    ctx.strokeStyle = vl.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, m.t + H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = vl.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(vl.label, x + 3, m.t + 3 + (k % 2) * 13);
    ctx.globalAlpha = 1;
  });

  for (const s of series) {
    // Batasi ke titik dalam rentang X (dan x > 0 untuk sumbu log)
    let i0 = 0, i1 = s.x.length - 1;
    while (i0 <= i1 && (s.x[i0] < xMin || (xLog && s.x[i0] <= 0))) i0++;
    while (i1 >= i0 && s.x[i1] > xMax) i1--;
    strokeSeries(c, s, i0, i1, (i) => xOf(s.x[i]), (i) => yOf(s.y[i]));
  }

  markers.forEach((mk, k) => {
    if (mk.x < xMin || mk.x > xMax) return;
    const x = xOf(mk.x), y = yOf(mk.y);
    ctx.fillStyle = mk.color;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(mk.label).width;
    // Dua penanda (tepi pita): label pertama di kiri, kedua di kanan agar tidak bertumpuk.
    const preferLeft = markers.length === 2 && k === 0;
    const right = !preferLeft && x + 8 + tw < m.l + W;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.fillText(mk.label, right ? x + 7 : x - 7, y + 5);
  });
  ctx.restore();
  drawLegend(c, series);
}

// ---------------------------------------------------------------------------
// Panel info
// ---------------------------------------------------------------------------
function table(rows) {
  return `<table>${rows.map((r) => (r === '-'
    ? '<tr class="sep"><td></td><td></td></tr>'
    : `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`)).join('')}</table>`;
}

function table3(head, rows) {
  return `<table class="cmp"><tr><th></th>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${
    rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</table>`;
}

function renderInfo(result) {
  const { ecg, amp } = result.stages;
  const p = ecg.params;
  const rows = [];

  if (p.source === 'ecg') {
    const c = ecgCharacteristics({ hr: p.hr, rAmp: p.rAmp });
    const peaks = detectRPeaks(ecg.clean, ecg.fs);
    let hrDet = NaN;
    if (peaks.length >= 2) hrDet = 60 / ((peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1) / ecg.fs);
    rows.push(
      ['Sumber', 'ECG sintetis (5 gaussian P, Q, R, S, T)'],
      ['Detak jantung (HR)', `${fmt(c.hr, 0)} bpm`],
      ['HR terdeteksi dari puncak R', `${fmt(hrDet, 1)} bpm (${peaks.length} denyut)`],
      ['Interval RR', ms(c.rr)],
      ['Amplitudo R / P / T', `${mV(c.rAmp)} / ${mV(c.pAmp)} / ${mV(c.tAmp)}`],
      ['Durasi P / QRS / T (±2σ)', `${ms(c.pDur)} / ${ms(c.qrsDur)} / ${ms(c.tDur)}`],
      ['Interval PR / QT', `${ms(c.pr)} / ${ms(c.qt)}`],
      ['Pita frekuensi utama', c.bandwidthHint],
    );
  } else {
    rows.push(
      ['Sumber', 'Sinus uji'],
      ['Frekuensi', `${fmt(p.sineFreq, 1)} Hz (periode ${ms(1 / p.sineFreq)})`],
      ['Amplitudo puncak', mV(p.sineAmp)],
    );
  }

  const st = signalStats(ecg.x);
  const d = p.disturbances;
  const active = [
    d.baseline.on && `baseline ${fmt(d.baseline.freq, 1)} Hz`,
    d.mains.on && `jala-jala ${d.mains.freq} Hz`,
    d.hf.on && 'noise HF',
    d.alias.on && `alias ${d.alias.freq} Hz`,
  ].filter(Boolean);
  const snr = snrDb(ecg.clean, ecg.noise);
  rows.push(
    '-',
    ['Laju sampel domain analog', `${FS_ANALOG.toLocaleString('id-ID')} Hz`],
    ['Durasi / jumlah sampel', `${fmt(p.duration, 0)} s / ${ecg.x.length.toLocaleString('id-ID')}`],
    ['Gangguan aktif', active.length ? active.join(', ') : 'tidak ada'],
    ['Vpp masukan', mV(st.vpp, 3)],
    ['Rerata / RMS masukan', `${mV(st.mean, 3)} / ${mV(st.rms, 3)}`],
    ['SNR (sinyal bersih : gangguan)', Number.isFinite(snr) ? `${fmt(snr, 1)} dB` : '∞ (tanpa gangguan)'],
  );
  $('infoSignal').innerHTML = table(rows);

  $('infoAmp').innerHTML = table([
    ['Gain', `×${amp.gain.toLocaleString('id-ID')} (${fmt(20 * Math.log10(amp.gain), 1)} dB)`],
    ['Batas saturasi', `±${fmt(amp.vSat, 1)} V`],
    ['Vpp keluaran', `${fmt(amp.vppOut, 3)} V`],
    ['Vpp ideal (tanpa saturasi)', `${fmt(amp.vppIdeal, 3)} V`],
    ['Sampel ter-clip', `${fmt(amp.clippedPercent, 2)} % (${amp.clippedCount.toLocaleString('id-ID')} sampel)`],
    ['Gain maksimum tanpa clipping', Number.isFinite(amp.maxGainNoClip) ? `×${fmt(amp.maxGainNoClip, 0)}` : '∞'],
    ['Status', amp.saturated ? '<b style="color:var(--bad)">SATURASI</b>' : '<b style="color:var(--ok)">Linier</b>'],
  ]);

  const badge = $('satBadge');
  // Persentase sangat kecil tetap ditampilkan bukan nol agar tidak membingungkan.
  const pct = amp.clippedPercent < 0.1 ? fmt(amp.clippedPercent, 3) : fmt(amp.clippedPercent, 1);
  badge.textContent = amp.saturated ? `SATURASI · ${pct} % ter-clip` : 'LINIER';
  badge.className = `badge ${amp.saturated ? 'bad' : 'ok'}`;
}

// ---------------------------------------------------------------------------
// Eksperimen 1 — plot sinyal & amplifier
// ---------------------------------------------------------------------------
function timeWindow(duration) {
  const w = $('window').value;
  return [0, w === 'all' ? duration : Math.min(duration, Number(w))];
}

function hasDisturbance(d) {
  return d.baseline.on || d.mains.on || d.hf.on || d.alias.on;
}

/** Pilih satuan V atau mV berdasarkan puncak sinyal. */
function voltUnit(peak) {
  return peak < 0.1 ? { k: 1e3, unit: 'mV' } : { k: 1, unit: 'V' };
}

function renderExp1(result) {
  const { ecg, amp } = result.stages;
  const [tMin, tMax] = timeWindow(ecg.params.duration);

  const inputSeries = [{ y: ecg.x, fs: ecg.fs, scale: 1e3, color: COLORS.signal, label: 'masukan (dengan gangguan)' }];
  if ($('showClean').checked && hasDisturbance(ecg.params.disturbances)) {
    inputSeries.push({ y: ecg.clean, fs: ecg.fs, scale: 1e3, color: COLORS.clean, width: 1.2, dash: [5, 3], label: 'bersih' });
  }
  drawPlot($('plotInput'), {
    series: inputSeries, tMin, tMax,
    xLabel: 'Waktu (s)', yLabel: 'Tegangan (mV)',
  });

  const st = signalStats(amp.y);
  const peak = Math.max(Math.abs(st.min), Math.abs(st.max), amp.saturated ? amp.vSat : 0);
  const { k, unit } = voltUnit(peak);
  const ampSeries = [{ y: amp.y, fs: ecg.fs, scale: k, color: COLORS.amp, width: 1.5, label: 'keluaran amplifier' }];
  if ($('showIdeal').checked && amp.saturated) {
    ampSeries.push({ y: ecg.x, fs: ecg.fs, scale: amp.gain * k, color: COLORS.ideal, width: 1, dash: [4, 3], label: 'ideal (tanpa saturasi)' });
  }
  drawPlot($('plotAmp'), {
    series: ampSeries, tMin, tMax,
    xLabel: 'Waktu (s)', yLabel: `Tegangan (${unit})`,
    // Tampilkan garis ±Vsat bila sinyal mendekati batas saturasi.
    yInclude: peak > 0.5 * amp.vSat ? [amp.vSat * k, -amp.vSat * k] : [],
    hLines: [
      { y: amp.vSat * k, color: COLORS.clip, label: `+${fmt(amp.vSat, 0)} V (saturasi)` },
      { y: -amp.vSat * k, color: COLORS.clip, label: `−${fmt(amp.vSat, 0)} V (saturasi)` },
    ],
  });
}

// ---------------------------------------------------------------------------
// Eksperimen 2 — filter
// ---------------------------------------------------------------------------
const F_RANGE = [0.03, 2000]; // Hz, sumbu log untuk respons frekuensi & spektrum

/**
 * Analisis yang mahal (FFT, korelasi, pengukuran −3 dB) dihitung sekali per hasil
 * pipeline dan hanya ketika tab Eksperimen 2 dibuka.
 */
function exp2Analysis(result) {
  if (result.exp2) return result.exp2;
  const { ecg, amp, filt } = result.stages;
  const fs = ecg.fs;
  // Referensi = apa yang "seharusnya" keluar dari amplifier tanpa gangguan & saturasi.
  const ref = new Float64Array(ecg.clean.length);
  for (let i = 0; i < ref.length; i++) ref[i] = amp.gain * ecg.clean[i];
  const rPeaks = ecg.params.source === 'ecg' ? detectRPeaks(ecg.clean, fs) : [];
  const toDb = (a) => a.map((v) => 20 * Math.log10(Math.max(v, 1e-12)));
  const sb = amplitudeSpectrum(amp.y, fs);
  const sa = amplitudeSpectrum(filt.y, fs);
  result.exp2 = {
    ref,
    m3: measureMinus3dB(filt.filter.sections, fs),
    before: filterQualityMetrics({ ref, y: amp.y, fs, rPeaks }),
    after: filterQualityMetrics({ ref, y: filt.y, fs, rPeaks }),
    spec: { f: sb.f, before: toDb(sb.amp), after: toDb(sa.amp), df: sb.df },
  };
  return result.exp2;
}

/** Frekuensi gangguan untuk garis penanda di plot frekuensi. */
function disturbanceLines(d) {
  return [
    { x: d.baseline.freq, label: `${fmtSig(d.baseline.freq)} Hz`, faint: !d.baseline.on, color: COLORS.vline },
    { x: d.mains.freq, label: `${d.mains.freq} Hz`, faint: !d.mains.on, color: COLORS.vline },
    { x: d.alias.freq, label: `${d.alias.freq} Hz`, faint: !d.alias.on, color: COLORS.vline },
  ];
}

/** Teks ringkas titik −3 dB terukur, plus lebar pita bila ada dua titik. */
function describeCutoffs(m3) {
  if (!m3.freqs.length) return 'tidak ada (respons datar)';
  const list = m3.freqs.map(hz).join(' dan ');
  return m3.freqs.length === 2 ? `${list} (BW ${hz(m3.freqs[1] - m3.freqs[0])})` : list;
}

function renderExp2(result) {
  const { ecg, amp, filt } = result.stages;
  const a = exp2Analysis(result);
  const { filter } = filt;
  const d = ecg.params.disturbances;
  const gain = amp.gain;

  $('noiseTip').hidden = hasDisturbance(d);
  document.querySelectorAll('.xcard[data-xtype]').forEach((el) => {
    el.classList.toggle('active', el.dataset.xtype === filter.type);
  });

  // --- Ringkasan ---
  $('filterSummary').innerHTML = filter.type === 'none'
    ? '<span class="big">Tanpa filter (bypass)</span><span>Pilih jenis filter di kolom kiri.</span>'
    : `<span class="big">${filter.label}</span>
       <span>−3 dB terukur: <span class="m3">${describeCutoffs(a.m3)}</span></span>
       <span>delay ≈ ${fmt(a.after.delay * 1e3, 1)} ms</span>`;

  // --- Respons frekuensi ---
  const special = [filter.design.fc, filter.design.f0, filter.design.fLow, filter.design.fHigh, ...a.m3.freqs]
    .filter((v) => Number.isFinite(v) && v > F_RANGE[0] && v < F_RANGE[1]);
  const fGrid = Float64Array.from([...logspace(F_RANGE[0], F_RANGE[1], 1200), ...special]).sort();
  const hDb = frequencyResponse(filter.sections, filt.fs, fGrid);
  drawXY($('plotFreqResp'), {
    series: [{ x: fGrid, y: hDb, color: COLORS.resp, width: 2, label: '|H(f)|' }],
    xMin: F_RANGE[0], xMax: F_RANGE[1], yMin: -60, yMax: 6, xLog: true,
    xLabel: 'Frekuensi (Hz, skala log)', yLabel: 'Magnitudo (dB)',
    hLines: filter.sections.length
      ? [{ y: a.m3.levelDb, color: COLORS.marker, label: `${fmt(a.m3.levelDb, 1)} dB`, labelBelow: true }] : [],
    vLines: disturbanceLines(d),
    markers: a.m3.freqs.map((f) => ({ x: f, y: a.m3.levelDb, color: COLORS.marker, label: hz(f) })),
  });

  // --- Spektrum sebelum vs sesudah ---
  let peak = -Infinity;
  for (let i = 0; i < a.spec.f.length; i++) {
    const f = a.spec.f[i];
    if (f >= F_RANGE[0] && f <= F_RANGE[1] && a.spec.before[i] > peak) peak = a.spec.before[i];
  }
  const yMax = Math.ceil((peak + 6) / 10) * 10;
  drawXY($('plotSpectrum'), {
    series: [
      { x: a.spec.f, y: a.spec.before, color: COLORS.before, width: 1.2, label: 'sebelum filter' },
      { x: a.spec.f, y: a.spec.after, color: COLORS.after, width: 1.2, label: 'sesudah filter' },
    ],
    xMin: F_RANGE[0], xMax: F_RANGE[1], yMin: yMax - 100, yMax, xLog: true,
    xLabel: `Frekuensi (Hz, skala log) — resolusi ${fmt(a.spec.df, 3)} Hz`, yLabel: 'Amplitudo (dBV)',
    vLines: disturbanceLines(d),
  });

  // --- Domain waktu ---
  const [tMin, tMax] = timeWindow(ecg.params.duration);
  const split = $('filtView').value === 'split';
  const showRef = $('showRef').checked;
  const fs = ecg.fs;
  const i0 = Math.max(0, Math.floor(tMin * fs)), i1 = Math.min(amp.y.length - 1, Math.ceil(tMax * fs));
  let lo = Infinity, hi = -Infinity;
  for (const arr of showRef ? [amp.y, filt.y, a.ref] : [amp.y, filt.y]) {
    for (let i = i0; i <= i1; i++) { if (arr[i] < lo) lo = arr[i]; if (arr[i] > hi) hi = arr[i]; }
  }
  const { k, unit } = voltUnit(Math.max(Math.abs(lo), Math.abs(hi)));
  const sBefore = { y: amp.y, fs, scale: k, color: COLORS.before, width: 1.3, label: 'sebelum filter (keluaran amplifier)' };
  const sAfter = { y: filt.y, fs, scale: k, color: COLORS.after, width: 1.5, label: 'sesudah filter' };
  const sRef = { y: a.ref, fs, scale: k, color: COLORS.clean, width: 1.1, dash: [5, 3], label: 'referensi bersih' };
  const common = { tMin, tMax, xLabel: 'Waktu (s)', yLabel: `Tegangan (${unit})`, yInclude: [lo * k, hi * k] };
  $('plotFiltB').hidden = !split;
  if (split) {
    drawPlot($('plotFiltA'), { ...common, series: showRef ? [sBefore, sRef] : [sBefore] });
    drawPlot($('plotFiltB'), { ...common, series: showRef ? [sAfter, sRef] : [sAfter] });
  } else {
    drawPlot($('plotFiltA'), { ...common, series: showRef ? [sBefore, sAfter, sRef] : [sBefore, sAfter] });
  }

  // --- Panel respons terukur ---
  const at = (f) => `${fmt(magnitudeDb(filter.sections, filt.fs, f), 1)} dB`;
  const respRows = [
    ['Desain', filter.label],
    ['Titik −3 dB terukur', describeCutoffs(a.m3)],
    ['Gain puncak passband', `${fmt(a.m3.refDb, 2)} dB`],
  ];
  if (filter.type === 'lpf' || filter.type === 'hpf') {
    const f3 = a.m3.freqs[0];
    respRows.push(['Selisih terhadap fc desain', `${fmt((100 * (f3 - filter.design.fc)) / filter.design.fc, 2)} %`]);
  } else if (filter.type === 'notch') {
    respRows.push(['BW desain f0/Q', hz(filter.design.bw)]);
  }
  const hr = ecg.params.hr;
  respRows.push(
    '-',
    [`|H| @ ${fmtSig(d.baseline.freq)} Hz (baseline wander)`, at(d.baseline.freq)],
    [`|H| @ ${fmtSig(hr / 60)} Hz (fundamental HR)`, at(hr / 60)],
    ['|H| @ 10 Hz (pita QRS)', at(10)],
    ['|H| @ 50 Hz (jala-jala)', at(50)],
    [`|H| @ ${d.alias.freq} Hz (komponen alias)`, at(d.alias.freq)],
  );
  $('infoFilterResp').innerHTML = table(respRows);

  // --- Panel evaluasi (dirujuk ke masukan: dibagi gain) ---
  const b = a.before, f = a.after;
  const inMv = (v, dg = 3) => (Number.isFinite(v) ? `${fmt((v / gain) * 1e3, dg)} mV` : '–');
  const pctR = (v) => (Number.isFinite(v) ? `${fmt(v * 100, 1)} %` : '–');
  const db = (v) => (Number.isFinite(v) ? `${fmt(v, 1)} dB` : '∞');
  $('infoFilterEval').innerHTML = table3(['Sebelum', 'Sesudah'], [
    ['SNR terhadap referensi', db(b.snrDb), db(f.snrDb)],
    ['RMSE (dirujuk ke masukan)', inMv(b.rmse), inMv(f.rmse)],
    ['Tinggi R (% referensi)', pctR(b.rRatio), pctR(f.rRatio)],
    [`Deviasi ST (referensi ${inMv(b.stDevRef)})`, inMv(b.stDev), inMv(f.stDev)],
    ['Delay terestimasi', `${fmt(b.delay * 1e3, 1)} ms`, `${fmt(f.delay * 1e3, 1)} ms`],
  ]);

  $('filterNotes').innerHTML = filterNotes({ a, gain, d, filter }).map(([cls, txt]) => `<li class="${cls}">${txt}</li>`).join('');
}

/** Catatan dinamis yang menafsirkan metrik untuk pengaturan saat ini. */
function filterNotes({ a, gain, d, filter }) {
  const notes = [];
  if (filter.type === 'none') return [['', 'Filter tidak aktif — kolom "Sesudah" sama dengan "Sebelum".']];
  const f = a.after, b = a.before;
  if (!hasDisturbance(d)) {
    notes.push(['', 'Tidak ada gangguan aktif: setiap perbedaan dari referensi adalah distorsi yang ditimbulkan filter itu sendiri.']);
  }
  if (Number.isFinite(f.rRatio) && f.rRatio < 0.9) {
    notes.push(['warn', `⚠ Tinggi puncak R tinggal ${fmt(f.rRatio * 100, 0)} % dari referensi — komponen QRS ikut terbuang.`]);
  }
  const stErr = Math.abs(f.stDev - f.stDevRef) / gain;
  if (Number.isFinite(stErr) && stErr > 0.02e-3) {
    notes.push([stErr > 0.05e-3 ? 'warn' : '',
      `${stErr > 0.05e-3 ? '⚠ ' : ''}Level ST bergeser ${fmt(stErr * 1e3, 3)} mV dari referensi (ambang klinis ≈ 0,1 mV) — distorsi segmen ST.`]);
  }
  if (Number.isFinite(b.snrDb) && f.snrDb > b.snrDb + 1) {
    const morphWarn = notes.some(([cls]) => cls === 'warn');
    notes.push(['good', `✓ SNR terhadap referensi naik ${fmt(b.snrDb, 1)} → ${fmt(f.snrDb, 1)} dB: noise yang dibuang lebih besar daripada distorsi yang ditimbulkan.${
      morphWarn ? ' Namun SNR saja tidak cukup — peringatan morfologi di atas menunjukkan informasi klinis ikut hilang.' : ''}`]);
  } else if (f.snrDb < b.snrDb - 1) {
    notes.push(['warn', `⚠ SNR terhadap referensi turun ${db1(b.snrDb)} → ${fmt(f.snrDb, 1)} dB: sinyal tampak berubah, tetapi tidak lebih dekat ke ECG yang sebenarnya.`]);
  }
  if (Math.abs(f.delay) > 0.004) {
    notes.push(['', `Filter kausal menggeser sinyal ≈ ${fmt(f.delay * 1e3, 1)} ms (fase tidak linear).`]);
  }
  return notes;
}
const db1 = (v) => (Number.isFinite(v) ? fmt(v, 1) : '∞');

/** SQNR terukur dengan satuan: NaN (semua sampel ter-clip) → "tidak tersedia". */
const sqnrText = (v) => (Number.isNaN(v) ? 'tidak tersedia (semua sampel ter-clip)' : `${db1(v)} dB`);

// ---------------------------------------------------------------------------
// Eksperimen 3 — ADC: sampling, kuantisasi, aliasing
// ---------------------------------------------------------------------------

/** Analisis Eksperimen 3, dihitung sekali per hasil pipeline saat tab dibuka. */
function exp3Analysis(result) {
  if (result.exp3) return result.exp3;
  const { ecg, amp, filt, adc } = result.stages;
  const fsA = ecg.fs;
  const p = adc.params;
  const d = ecg.params.disturbances;

  // Komponen nada yang diketahui, dengan amplitudonya di MASUKAN ADC:
  // amplitudo asli × gain × |H_filter(f)| × |H_AA(f)|.
  const hLin = (f) => 10 ** ((magnitudeDb(filt.filter.sections, fsA, f)
    + (adc.aa ? magnitudeDb(adc.aa.sections, fsA, f) : 0)) / 20);
  const tones = [];
  if (ecg.params.source === 'sine') tones.push({ nama: 'Sinus uji', f: ecg.params.sineFreq, ampIn: ecg.params.sineAmp });
  if (d.mains.on) tones.push({ nama: 'Interferensi jala-jala', f: d.mains.freq, ampIn: d.mains.amp });
  if (d.alias.on) tones.push({ nama: 'Komponen aliasing', f: d.alias.freq, ampIn: d.alias.amp });
  for (const t of tones) t.amp = t.ampIn * amp.gain * hLin(t.f);

  const toDb = (a) => a.map((v) => 20 * Math.log10(Math.max(v, 1e-12)));
  const sa = amplitudeSpectrum(adc.input, fsA);
  const sd = amplitudeSpectrum(adc.quant.xq, p.fs);
  result.exp3 = {
    aliases: analyzeAliasing(tones, p.fs, adc.quant.lsb / 2),
    above: powerAboveNyquist(adc.input, fsA, p.fs),
    specA: { f: sa.f, db: toDb(sa.amp) },
    specD: { f: sd.f, db: toDb(sd.amp), df: sd.df },
  };
  return result.exp3;
}

/** Level spektrum (dB) maksimum di sekitar frekuensi f (±3 bin). */
function specLevelAt(spec, f, df) {
  const k = Math.round(f / df);
  let best = -Infinity;
  for (let i = Math.max(0, k - 3); i <= Math.min(spec.db.length - 1, k + 3); i++) best = Math.max(best, spec.db[i]);
  return best;
}

function renderExp3(result) {
  const { ecg, amp, adc } = result.stages;
  const a = exp3Analysis(result);
  const p = adc.params;
  const q = adc.quant;
  const fsA = adc.fsAnalog;
  const nyq = p.fs / 2;
  const d = ecg.params.disturbances;
  const hfFold = d.hf.on && !adc.aa;
  const visible = a.aliases.filter((t) => t.visible);

  // --- Banner deteksi aliasing ---
  const banner = $('aliasBanner');
  const msgs = visible.map((t) => `${t.nama} ${hz(t.f)} → muncul sebagai <b>${hz(t.fAlias)}</b>`);
  const bad = visible.length > 0 || a.above > 0.01;
  banner.className = `alias-banner ${bad ? 'bad' : 'ok'}`;
  banner.innerHTML = bad
    ? `<b>⚠ Aliasing terdeteksi</b> (fs/2 = ${hz(nyq)}). ${msgs.join('; ')}${msgs.length ? '. ' : ''}`
      + `Daya di atas fs/2 pada masukan ADC: ${fmt(a.above * 100, 2)} %.${hfFold ? ' Noise putih pita lebar ikut terlipat.' : ''}`
      + `${adc.aa ? '' : ' Aktifkan anti-aliasing LPF untuk perbandingan.'}`
    : `<b>✓ Tidak ada aliasing signifikan.</b> Semua komponen nada yang diketahui berada di bawah fs/2 = ${hz(nyq)} `
      + `atau teredam di bawah ½ LSB; daya di atas fs/2: ${fmt(a.above * 100, 3)} %.`;

  // --- Ringkasan ---
  $('adcSummary').innerHTML = `<span class="big">fs = ${hz(p.fs)}</span>
    <span>Nyquist fs/2 = ${hz(nyq)}</span><span>Ts = ${fmt(1000 / p.fs, 2)} ms</span>
    <span>${q.codes.length.toLocaleString('id-ID')} sampel</span>
    <span class="big">${p.bits} bit</span><span>${q.levels.toLocaleString('id-ID')} level</span>
    <span>LSB = <span class="m3">${fmtVolt(q.lsb)}</span></span><span>rentang ±${fmt(p.vRef, 2)} V</span>`;

  // --- Plot sinyal + sampel ---
  const [tMin, tMax] = timeWindow(ecg.params.duration);
  const rangeView = $('adcYView').value === 'range';
  const i0 = Math.floor(tMin * fsA), i1 = Math.min(adc.input.length - 1, Math.ceil(tMax * fsA));
  let pk = 0;
  for (let i = i0; i <= i1; i++) pk = Math.max(pk, Math.abs(adc.input[i]));
  const { k, unit } = rangeView ? { k: 1, unit: 'V' } : voltUnit(pk);
  const series = [{ y: adc.input, fs: fsA, scale: k, color: COLORS.before, width: 1.3, label: 'sinyal kontinu (masukan ADC)' }];
  if ($('showZoh').checked) series.push({ y: q.xq, fs: p.fs, scale: k, color: '#7aa7f5', width: 1.1, style: 'step', label: 'rekonstruksi ZOH' });
  series.push({ y: q.xq, fs: p.fs, scale: k, color: COLORS.after, style: 'stem', label: `sampel terkuantisasi x_q[n]` });
  drawPlot($('plotAdc'), {
    series, tMin, tMax, xLabel: 'Waktu (s)', yLabel: `Tegangan (${unit})`,
    yInclude: rangeView ? [-p.vRef, p.vRef] : [],
    hLines: [
      { y: p.vRef * k, color: COLORS.clip, label: `+${fmt(p.vRef, 2)} V (batas ADC)` },
      { y: -p.vRef * k, color: COLORS.clip, label: `−${fmt(p.vRef, 2)} V (batas ADC)` },
    ],
    levels: { step: q.lsb * k },
  });

  // --- Plot error kuantisasi (sampel ter-clip tidak digambar) ---
  const errShow = Float64Array.from(q.err, (e, i) => (q.clipped[i] ? NaN : e));
  const eu = q.lsb < 0.2 ? { k: 1e3, unit: 'mV' } : { k: 1, unit: 'V' };
  drawPlot($('plotQErr'), {
    series: [{ y: errShow, fs: p.fs, scale: eu.k, color: COLORS.clean, style: 'stem', label: 'e[n] (sampel tidak ter-clip)' }],
    tMin, tMax, xLabel: 'Waktu (s)', yLabel: `Error (${eu.unit})`,
    yInclude: [-q.lsb / 2 * eu.k, q.lsb / 2 * eu.k],
    hLines: [
      { y: (q.lsb / 2) * eu.k, color: COLORS.clip, label: '+Δ/2' },
      { y: (-q.lsb / 2) * eu.k, color: COLORS.clip, label: '−Δ/2' },
    ],
  });

  // --- Spektrum analog vs sampel ---
  const maxTone = Math.max(0, ...a.aliases.map((t) => t.f));
  const xMax = Math.min(fsA / 2, Math.max(1.25 * p.fs, maxTone * 1.15, 60));
  let peak = -Infinity;
  for (let i = 1; i < a.specA.f.length && a.specA.f[i] <= xMax; i++) peak = Math.max(peak, a.specA.db[i]);
  for (let i = 1; i < a.specD.f.length; i++) peak = Math.max(peak, a.specD.db[i]);
  const yMax = Math.ceil((peak + 6) / 10) * 10;
  const markers = [];
  for (const t of a.aliases) {
    if (!(t.above || t.atNyquist)) continue;
    markers.push({ x: t.f, y: specLevelAt(a.specA, t.f, a.specA.f[1]), color: COLORS.vline, label: hz(t.f) });
    if (t.visible) markers.push({ x: t.fAlias, y: specLevelAt(a.specD, t.fAlias, a.specD.df), color: COLORS.marker, label: `alias ${fmtSig(t.f)}→${hz(t.fAlias)}` });
  }
  drawXY($('plotAdcSpec'), {
    series: [
      { x: a.specA.f, y: a.specA.db, color: COLORS.before, width: 1.1, label: 'masukan analog (10 kHz)' },
      { x: a.specD.f, y: a.specD.db, color: COLORS.after, width: 1.4, label: `hasil sampling (0…fs/2)` },
    ],
    xMin: 0, xMax, yMin: yMax - 100, yMax, xLabel: 'Frekuensi (Hz)', yLabel: 'Amplitudo (dBV)',
    vLines: [
      { x: nyq, color: COLORS.clip, label: `fs/2 = ${hz(nyq)}` },
      ...(p.fs <= xMax ? [{ x: p.fs, color: COLORS.clip, label: `fs = ${hz(p.fs)}`, faint: true }] : []),
    ],
    markers,
  });

  // --- Panel sampling ---
  let maxIn = -Infinity, maxS = -Infinity;
  for (let i = 0; i < adc.input.length; i++) maxIn = Math.max(maxIn, adc.input[i]);
  for (let i = 0; i < adc.sampled.y.length; i++) maxS = Math.max(maxS, adc.sampled.y[i]);
  const sRows = [
    ['Laju sampling fs', hz(p.fs)],
    ['Frekuensi Nyquist fs/2', hz(nyq)],
    ['Periode sampling Ts', `${fmt(1000 / p.fs, 2)} ms`],
    ['Jumlah sampel (durasi × fs)', `${fmt(ecg.params.duration, 0)} s × ${p.fs} Hz = ${q.codes.length.toLocaleString('id-ID')}`],
  ];
  if (ecg.params.source === 'ecg') {
    const c = ecgCharacteristics({ hr: ecg.params.hr });
    sRows.push(
      ['Sampel per denyut (fs × RR)', fmt(p.fs * c.rr, 0)],
      ['Sampel dalam QRS (fs × ±102 ms)', fmt(p.fs * c.qrsDur, 1)],
    );
  }
  sRows.push(
    ['Puncak tertinggi: kontinu → sampel', `${fmtVolt(maxIn)} → ${fmtVolt(maxS)} (${fmt((100 * (maxS - maxIn)) / Math.abs(maxIn || 1), 1)} %)`],
    ['Anti-aliasing LPF', adc.aa ? `Butterworth orde ${adc.aa.order}, fc = ${hz(adc.aa.fc)}` : 'tidak aktif'],
    ['Daya di atas fs/2 (masukan ADC)', `${fmt(a.above * 100, 3)} %`],
  );
  $('infoSampling').innerHTML = table(sRows);

  // --- Panel kuantisasi ---
  let cMin = Infinity, cMax = -Infinity;
  for (const c of q.codes) { if (c < cMin) cMin = c; if (c > cMax) cMax = c; }
  const used = cMax - cMin + 1;
  $('infoQuant').innerHTML = table([
    ['Resolusi', `${p.bits} bit`],
    ['Jumlah level 2^N', q.levels.toLocaleString('id-ID')],
    ['Rentang ADC', `±${fmt(p.vRef, 2)} V (lebar ${fmt(2 * p.vRef, 2)} V)`],
    ['LSB Δ = rentang / 2^N', `${fmtVolt(q.lsb)} (≈ ${fmtVolt(q.lsb / amp.gain)} dirujuk ke masukan)`],
    ['Rentang kode (two\'s complement)', `${q.codeMin.toLocaleString('id-ID')} … ${q.codeMax.toLocaleString('id-ID')}`],
    ['Kode terpakai oleh sinyal', `${cMin.toLocaleString('id-ID')} … ${cMax.toLocaleString('id-ID')} (${fmt((100 * used) / q.levels, 1)} % level)`],
    ['Sampel ter-clip', `${q.clippedCount.toLocaleString('id-ID')} (${fmt((100 * q.clippedCount) / q.codes.length, 2)} %)`],
    '-',
    ['Error maks: terukur / teori Δ/2', `${fmtVolt(q.errMax)} / ${fmtVolt(q.errMaxTheory)}`],
    ['Error RMS: terukur / teori Δ/√12', `${fmtVolt(q.errRms)} / ${fmtVolt(q.errRmsTheory)}`],
    ['SQNR teoretis (sinus skala penuh, 6,02N + 1,76)', `${fmt(q.sqnrTheoryFullScale, 1)} dB`],
    ['SQNR teoretis untuk sinyal ini (P<sub>x</sub> / (Δ²/12))', `${fmt(q.sqnrTheorySignal, 1)} dB`],
    ['SQNR terukur', sqnrText(q.sqnrMeasured)],
  ]);

  // --- Tabel deteksi aliasing ---
  const aliasRows = a.aliases.map((t) => {
    const status = t.visible
      ? (t.atNyquist ? '⚠ tepat di fs/2 (ambigu)' : '⚠ ALIAS')
      : (t.above || t.atNyquist) ? 'di atas fs/2, teredam &lt; ½ LSB' : 'aman (&lt; fs/2)';
    return `<tr class="${t.visible ? 'warn' : ''}"><td style="text-align:left">${t.nama}</td><td>${hz(t.f)}</td>`
      + `<td>${t.above ? '&gt;' : t.atNyquist ? '=' : '&lt;'} ${hz(nyq)}</td>`
      + `<td>${t.above || t.atNyquist ? `|${fmtSig(t.f)} − ${t.k}·${p.fs}| = ${hz(t.fAlias)}` : `${hz(t.f)} (tetap)`}</td>`
      + `<td>${fmtVolt(t.amp)}</td><td style="text-align:left">${status}</td></tr>`;
  });
  if (d.hf.on) {
    aliasRows.push(`<tr class="${hfFold ? 'warn' : ''}"><td style="text-align:left">Noise putih (HF)</td><td>0 … ${hz(fsA / 2)}</td>`
      + `<td>sebagian besar &gt; ${hz(nyq)}</td><td>terlipat ke seluruh 0 … ${hz(nyq)}</td><td>${mV(d.hf.rms * amp.gain, 1)} RMS</td>`
      + `<td style="text-align:left">${hfFold ? '⚠ menaikkan lantai noise' : 'diredam AA LPF'}</td></tr>`);
  }
  $('aliasTable').innerHTML = aliasRows.length
    ? `<div class="table-scroll"><table class="data"><tr><th style="text-align:left">Komponen</th><th>f</th><th>vs fs/2</th>`
      + `<th>f<sub>alias</sub> = |f − k·fs|</th><th>Amplitudo di masukan ADC</th><th style="text-align:left">Status</th></tr>${aliasRows.join('')}</table></div>`
    : '<p class="hint">Tidak ada komponen nada gangguan yang aktif. Aktifkan "Komponen aliasing" atau pilih sinus uji di atas fs/2.</p>';

  // --- Catatan dinamis ---
  const notes = [];
  if (q.clippedCount) notes.push(['warn', `⚠ ${q.clippedCount.toLocaleString('id-ID')} sampel melebihi ±${fmt(p.vRef, 2)} V dan ter-clip — perbesar rentang ADC atau turunkan gain.`]);
  if (used / q.levels < 0.1 && p.bits >= 4) {
    notes.push(['warn', `Sinyal hanya memakai ${fmt((100 * used) / q.levels, 1)} % level (≈ ${fmt(Math.log2(used), 1)} bit efektif dari ${p.bits} bit). Persempit rentang ADC atau naikkan gain.`]);
  }
  if (p.bits <= 4) notes.push(['', `Pada ${p.bits} bit error kuantisasi berkorelasi dengan sinyal (bentuk tangga), sehingga SQNR terukur bisa menyimpang dari rumus 6,02N + 1,76.`]);
  if (ecg.params.source === 'ecg' && maxS < maxIn * 0.95) {
    notes.push(['warn', `Puncak tertinggi hasil sampling ${fmt((100 * (maxIn - maxS)) / maxIn, 1)} % lebih rendah dari sinyal kontinu — sampel tidak jatuh tepat di puncak R.`]);
  }
  if (adc.aa) notes.push(['good', `✓ Anti-aliasing aktif: komponen di atas ${hz(adc.aa.fc)} diredam sebelum sampling (mis. ${fmt(magnitudeDb(adc.aa.sections, fsA, Math.min(1.5 * nyq, fsA / 2 - 1)), 0)} dB di 1,5·fs/2).`]);
  $('adcNotes').innerHTML = notes.map(([cls, t]) => `<li class="${cls}">${t}</li>`).join('');

  // --- Tabel 20 sampel pertama ---
  const rows = [];
  for (let n = 0; n < Math.min(20, q.codes.length); n++) {
    rows.push(`<tr class="${q.clipped[n] ? 'clip' : ''}"><td>${n}</td><td>${fmt((1000 * n) / p.fs, 2)}</td>`
      + `<td>${fmt(adc.sampled.y[n], 5)}</td><td>${q.codes[n].toLocaleString('id-ID')}</td>`
      + `<td class="mono">${toBinary(q.codes[n], p.bits)}</td><td>${fmt(q.xq[n], 5)}</td>`
      + `<td>${fmt(q.err[n] * 1e3, 4)}${q.clipped[n] ? ' (clip)' : ''}</td></tr>`);
  }
  $('sampleTable').innerHTML = `<table class="data"><tr><th>n</th><th>t (ms)</th><th>x[n] kontinu (V)</th><th>kode</th>`
    + `<th>biner (${p.bits}-bit)</th><th>x<sub>q</sub>[n] = kode·Δ (V)</th><th>error (mV)</th></tr>${rows.join('')}</table>`;
}

/** Tegangan dengan satuan otomatis V / mV / µV. */
function fmtVolt(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '–';
  if (a >= 0.1) return `${fmt(v, 3)} V`;
  if (a >= 1e-4) return `${fmt(v * 1e3, 3)} mV`;
  return `${fmt(v * 1e6, 2)} µV`;
}

// ---------------------------------------------------------------------------
// Eksperimen 4 — output digital
// ---------------------------------------------------------------------------

/** Mengatur seluruh kontrol ke konfigurasi rekomendasi (monitor ECG). */
function applyRecommended() {
  document.querySelector('input[name=gainPreset][value="1000"]').checked = true;
  $('gainLog').value = 3;
  $('fType').value = 'bpf';
  $('bpfLow').value = Math.log10(0.5);
  $('bpfHigh').value = Math.log10(40);
  document.querySelector('input[name=fsPreset][value="250"]').checked = true;
  $('fsFree').value = 250;
  document.querySelector('input[name=bitsPreset][value="12"]').checked = true;
  $('bitsFree').value = 12;
  $('vRef').value = 2;
  $('aaOn').checked = true;
  scheduleUpdate();
}

const CHECK = { ok: '✓', warn: '⚠', info: 'ℹ' };

function renderExp4(result) {
  const { ecg, amp, filt, adc } = result.stages;
  const a3 = exp3Analysis(result);
  const p = adc.params;
  const q = adc.quant;
  const f = filt.filter;
  const m3 = measureMinus3dB(f.sections, filt.fs);
  const d = ecg.params.disturbances;

  // Pita sinyal tertinggi yang diteruskan ke ADC: tepi atas LPF/BPF, atau ±150 Hz bila tidak ada.
  const fHigh = f.type === 'lpf' ? f.design.fc : f.type === 'bpf' ? f.design.fHigh : 150;
  const aliasBad = a3.aliases.some((t) => t.visible) || a3.above > 0.01;
  let pkOut = 0;
  for (const v of adc.input) pkOut = Math.max(pkOut, Math.abs(v));
  const lsbIn = q.lsb / amp.gain;
  const activeDist = [d.baseline.on && 'baseline', d.mains.on && '50 Hz', d.hf.on && 'noise HF', d.alias.on && `alias ${d.alias.freq} Hz`].filter(Boolean);

  const filterCheck = (() => {
    if (f.type === 'none') return ['warn', 'tanpa filter: baseline wander dan noise HF tidak ditekan'];
    if ((f.type === 'hpf' && f.design.fc > 0.5) || (f.type === 'bpf' && f.design.fLow > 0.5)) return ['warn', 'HPF > 0,5 Hz berisiko mendistorsi segmen ST'];
    if ((f.type === 'lpf' && f.design.fc < 40) || (f.type === 'bpf' && f.design.fHigh < 40)) return ['warn', 'LPF < 40 Hz memotong puncak R'];
    if (f.type === 'notch' && f.design.q < 10) return ['warn', 'notch lebar (Q < 10) memakan komponen QRS'];
    return ['ok', 'pita mempertahankan morfologi ECG'];
  })();

  const rows = [
    ['Sumber', ecg.params.source === 'ecg' ? `ECG sintetis, ${ecg.params.hr} bpm` : `Sinus uji ${hz(ecg.params.sineFreq)}`,
      ['info', activeDist.length ? `gangguan: ${activeDist.join(', ')}` : 'tanpa gangguan']],
    ['Amplifier', `gain ×${amp.gain.toLocaleString('id-ID')} · Vsat ±${fmt(amp.vSat, 0)} V`,
      amp.saturated ? ['warn', `saturasi: ${fmt(amp.clippedPercent, 2)} % sampel ter-clip`] : ['ok', 'linier, tanpa clipping']],
    ['Filter', `${f.label}${m3.freqs.length ? ` · −3 dB terukur ${m3.freqs.map(hz).join(' & ')}` : ''}`, filterCheck],
    ['Anti-aliasing', adc.aa ? `Butterworth orde ${adc.aa.order}, fc ${hz(adc.aa.fc)}` : 'tidak aktif',
      adc.aa ? ['ok', 'aktif sebelum sampling'] : (aliasBad ? ['warn', 'aliasing terdeteksi — aktifkan AA'] : ['info', 'tidak ada alias terdeteksi'])],
    ['Sampling', `fs ${hz(p.fs)} · Nyquist ${hz(p.fs / 2)} · ${q.codes.length.toLocaleString('id-ID')} sampel`,
      aliasBad ? ['warn', 'ada komponen di atas fs/2 yang terlipat']
        : p.fs / 2 >= fHigh ? ['ok', `fs/2 ≥ pita sinyal (${hz(fHigh)})`] : ['warn', `fs/2 < pita sinyal (${hz(fHigh)})`]],
    ['Kuantisasi', `${p.bits} bit · ${q.levels.toLocaleString('id-ID')} level · ±${fmt(p.vRef, 2)} V · LSB ${fmtVolt(q.lsb)}`,
      q.clippedCount ? ['warn', `${q.clippedCount} sampel ter-clip di ADC`]
        // Aturan praktis: LSB (dirujuk ke elektroda) ≤ 1/30 amplitudo gelombang P (0,15 mV) = 5 µV.
        : lsbIn <= 5e-6 ? ['ok', `LSB ≈ ${fmtVolt(lsbIn)} di elektroda (≤ 5 µV)`] : ['warn', `LSB ≈ ${fmtVolt(lsbIn)} di elektroda — detail gelombang P hilang`]],
    ['Pemanfaatan rentang ADC', `puncak ${fmtVolt(pkOut)} dari ${fmt(p.vRef, 2)} V`,
      pkOut / p.vRef < 0.1 ? ['warn', `hanya ${fmt((100 * pkOut) / p.vRef, 0)} % — naikkan gain`] : ['ok', `${fmt((100 * pkOut) / p.vRef, 0)} % rentang`]],
    ['Output digital', `${(p.fs * p.bits).toLocaleString('id-ID')} bit/s · ${fmt((p.fs * p.bits * ecg.params.duration) / 8 / 1024, 1)} KiB per ${fmt(ecg.params.duration, 0)} s`,
      ['info', `SQNR terukur ${sqnrText(q.sqnrMeasured)}`]],
  ];
  const warns = rows.filter((r) => r[2][0] === 'warn').length;
  $('cfgBadge').textContent = warns ? `${warns} peringatan` : 'semua cek lolos';
  $('cfgBadge').className = `badge ${warns ? 'bad' : 'ok'}`;
  $('cfgSummary').innerHTML = `<div class="table-scroll"><table class="data"><tr><th class="l">Tahap</th><th class="l">Konfigurasi</th><th class="l">Cek</th></tr>${
    rows.map(([k, v, [cls, txt]]) => `<tr><td class="l"><b>${k}</b></td><td class="l" style="white-space:normal">${v}</td>`
      + `<td class="${cls === 'ok' ? 'ok' : cls === 'warn' ? 'fail' : 'l'}" style="white-space:normal">${CHECK[cls]} ${txt}</td></tr>`).join('')}</table></div>`;

  // Plot kode ADC
  const [tMin, tMax] = timeWindow(ecg.params.duration);
  drawPlot($('plotCodes'), {
    series: [{ y: Float64Array.from(q.codes), fs: p.fs, scale: 1, color: COLORS.after, style: 'stem', label: `kode ADC (${p.bits}-bit, two's complement)` }],
    tMin, tMax, xLabel: 'Waktu (s)', yLabel: 'Kode ADC (integer)',
    hLines: [
      { y: q.codeMax, color: COLORS.clip, label: `kode maks ${q.codeMax}` },
      { y: q.codeMin, color: COLORS.clip, label: `kode min ${q.codeMin}` },
    ],
  });

  // Pratinjau CSV (baris yang sama persis dengan berkas unduhan)
  const preview = adcToCsv({ quant: { codes: q.codes.subarray(0, 6), xq: q.xq.subarray(0, 6) }, sampled: adc.sampled });
  $('csvPreview').textContent = `${preview}… (${q.codes.length.toLocaleString('id-ID')} baris data)`;
  $('csvInfo').textContent = `${csvName(adc)} · 3 kolom: waktu_s, kode_adc, tegangan_rekonstruksi_V`;

  const rowsT = [];
  for (let n = 0; n < Math.min(20, q.codes.length); n++) {
    rowsT.push(`<tr class="${q.clipped[n] ? 'clip' : ''}"><td>${n}</td><td>${fmt(n / p.fs, 4)}</td>`
      + `<td>${q.codes[n].toLocaleString('id-ID')}</td><td>${fmt(q.xq[n], 6)}</td></tr>`);
  }
  $('outTable').innerHTML = `<table class="data"><tr><th>n</th><th>waktu (s)</th><th>kode ADC</th><th>tegangan rekonstruksi (V)</th></tr>${rowsT.join('')}</table>`;
}

const csvName = (adc) => `ecg_adc_${adc.params.fs}Hz_${adc.params.bits}bit.csv`;

function downloadCsv() {
  if (!lastResult) return;
  const { adc } = lastResult.stages;
  const blob = new Blob([adcToCsv(adc)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvName(adc);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Validasi matematis
// ---------------------------------------------------------------------------

function fmtVal(v, unit) {
  if (!Number.isFinite(v)) return '–';
  if (unit === 'V') return fmtVolt(v);
  if (unit === 'Hz') return hz(v);
  if (unit === 'dB') return `${fmt(v, 3)} dB`;
  return fmt(v, Number.isInteger(v) ? 0 : 4);
}

/** Tabel teori vs simulasi + selisih + status. */
function valTable(rows) {
  const status = (r) => {
    if (r.na) return ['fail', '✗ di luar jangkauan simulasi'];
    if (Number.isNaN(r.simulasi)) return ['l', 'tidak tersedia (semua sampel ter-clip)'];
    if (r.ok) return ['ok', r.mode === 'le' ? '✓ simulasi ≤ teori' : '✓ sesuai'];
    if (r.assumption) return ['amber', '≈ asumsi error seragam tidak berlaku (N < 6)'];
    return ['fail', '✗ di luar toleransi'];
  };
  const tol = (r) => (r.mode === 'le' ? '≤ teori'
    : (r.tolRel && r.tolRel < 1e-6) || (r.tolAbs && r.tolAbs < 1e-9) ? 'tepat (presisi float)'
    : r.tolRel ?`±${fmt(r.tolRel * 100, r.tolRel < 0.01 ? 1 : 0)} %` : r.tolAbs ? `±${fmtVal(r.tolAbs, r.satuan)}` : 'tepat');
  return `<div class="table-scroll"><table class="data"><tr><th class="l">Besaran</th><th class="l">Rumus</th><th>Teori</th><th>Simulasi</th><th>Selisih</th><th>Toleransi</th><th class="l">Status</th></tr>${
    rows.map((r) => {
      const [cls, txt] = status(r);
      const diff = Number.isFinite(r.diff)
        ? `${r.satuan === 'dB' ? `${fmt(r.diff, 3)} dB` : fmtVal(r.diff, r.satuan)}${r.teori && r.satuan !== 'dB' ? ` (${fmt(r.rel * 100, 2)} %)` : ''}`
        : '–';
      return `<tr><td class="l">${r.nama}</td><td class="l" style="white-space:normal">${r.rumus}</td><td>${fmtVal(r.teori, r.satuan)}</td>`
        + `<td>${fmtVal(r.simulasi, r.satuan)}</td><td>${diff}</td><td>${tol(r)}</td><td class="${cls}">${txt}</td></tr>`;
    }).join('')}</table></div>`;
}

// Validasi RC & ADC tidak bergantung pada sinyal → simpan hasil per kombinasi parameter.
const valCache = new Map();
function cached(key, fn) {
  if (!valCache.has(key)) { if (valCache.size > 50) valCache.clear(); valCache.set(key, fn()); }
  return valCache.get(key);
}

function renderValidation(result) {
  const { ecg, amp, filt, adc } = result.stages;

  // (a) Amplifier
  const va = validateAmplifier(ecg.x, amp);
  $('valAmp').innerHTML = `<p class="hint">Sampel uji: |V<sub>in</sub>| maks = ${fmtVolt(va.vin)} → G·V<sub>in</sub> = ×${amp.gain.toLocaleString('id-ID')} · ${fmtVolt(va.vin)} = ${fmtVolt(va.ideal)}; `
    + `|G·V<sub>in</sub>| ${va.saturated ? '&gt;' : '≤'} ${fmt(va.vSat, 0)} V → <b>${va.saturated ? 'SATURASI, Vout = ±Vsat' : 'linier'}</b></p>${valTable(va.rows)}`;

  // (b) RC
  const r = Number($('rcR').value) * 1e3, c = Number($('rcC').value) * 1e-6;
  if (r > 0 && c > 0) {
    const vr = cached(`rc:${r}:${c}`, () => validateRc(r, c, FS_ANALOG));
    $('rcInfo').textContent = `τ = RC = ${fmt(vr.tau * 1e3, 3)} ms · fc = ${hz(vr.fc)}${vr.outOfRange ? ' — melebihi 0,45 × 10 kHz, tidak dapat disimulasikan' : ''}`;
    $('valRc').innerHTML = valTable(vr.rows);
  } else {
    $('rcInfo').textContent = 'R dan C harus > 0.';
    $('valRc').innerHTML = '';
  }

  // Filter aktif di pipeline: fc desain vs −3 dB terukur
  const f = filt.filter;
  const m3 = measureMinus3dB(f.sections, filt.fs);
  const mk = (nama, rumus, teori, sim, satuan, tolRel) => {
    const diff = sim - teori;
    return { nama, rumus, teori, simulasi: sim, satuan, diff, rel: diff / Math.abs(teori), tolRel, ok: Math.abs(diff) <= tolRel * Math.abs(teori) };
  };
  const fr = [];
  if (f.type === 'lpf' || f.type === 'hpf') {
    fr.push(mk(`${f.type.toUpperCase()} pipeline: −3 dB`, 'fc desain (Butterworth orde 2)', f.design.fc, m3.freqs[0], 'Hz', 0.001));
    fr.push(mk('Gain pada fc', '20·log10(1/√2)', -10 * Math.log10(2), magnitudeDb(f.sections, filt.fs, f.design.fc), 'dB', 0.1));
  } else if (f.type === 'bpf') {
    fr.push(mk('BPF pipeline: −3 dB bawah', 'f_L desain', f.design.fLow, m3.freqs[0], 'Hz', 0.02));
    fr.push(mk('BPF pipeline: −3 dB atas', 'f_H desain', f.design.fHigh, m3.freqs[1], 'Hz', 0.02));
  } else if (f.type === 'notch') {
    fr.push(mk('Notch pipeline: lebar pita −3 dB', 'BW = f0 / Q', f.design.bw, m3.freqs[1] - m3.freqs[0], 'Hz', 0.02));
  }
  const cEq = c > 0 && fr.length && f.type !== 'notch' ? ` R setara untuk fc ${hz(f.design.fc ?? f.design.fHigh)} dengan C = ${fmt(c * 1e6, 3)} µF: R = 1/(2π·fc·C) = ${fmt(1 / (2 * Math.PI * (f.design.fc ?? f.design.fHigh) * c) / 1e3, 2)} kΩ.` : '';
  $('valFilter').innerHTML = fr.length
    ? `<p class="hint" style="margin:10px 0 4px">Filter aktif di pipeline (Eksperimen 2) — biquad orde 2, bukan RC orde 1.${cEq}</p>${valTable(fr)}`
    : '<p class="hint" style="margin:10px 0 0">Filter pipeline tidak aktif.</p>';

  // (c) ADC
  const { bits, vRef } = adc.params;
  const vd = cached(`adc:${bits}:${vRef}`, () => validateAdc(bits, vRef));
  $('adcValInfo').textContent = `N = ${bits} bit, Vrange = 2 × ${fmt(vRef, 2)} V`;
  $('valAdc').innerHTML = `<p class="hint">Level & LSB dari ramp yang menyapu seluruh rentang; error RMS & SQNR dari sinus skala penuh (A = Vref − ½LSB, 7,31 Hz, fs 1 kHz, 20 s).</p>`
    + `${valTable(vd.rows)}<p class="hint" style="margin:10px 0 4px">Sinyal pipeline saat ini (bukan sinus skala penuh): SQNR dibandingkan dengan P<sub>x</sub>/(LSB²/12).</p>`
    + valTable(validateAdcSignal(adc.quant));
}

// ---------------------------------------------------------------------------
// Diagram pipeline & siklus pembaruan
// ---------------------------------------------------------------------------
function renderPipeline() {
  $('pipeline').innerHTML = STAGE_DEFS.map((s, i) => (
    `${i ? '<span class="arrow">→</span>' : ''}<span class="stage${s.ready ? '' : ' pending'}" title="${s.ready ? 'Sudah tersedia' : 'Belum diimplementasikan'}">${s.label}</span>`
  )).join('');
}

const activeTab = () => document.querySelector('.tabs button[aria-selected=true]').dataset.tab;

/** Gambar ulang hanya tab yang sedang terlihat. */
function renderPlots(result) {
  const tab = activeTab();
  if (tab === 'exp1') renderExp1(result);
  else if (tab === 'exp2') renderExp2(result);
  else if (tab === 'exp3') renderExp3(result);
  else if (tab === 'exp4') renderExp4(result);
  else if (tab === 'valid') renderValidation(result);
}

let lastResult = null;
let pending = false;

// Setiap perubahan kontrol → hitung ulang pipeline → gambar ulang.
function update() {
  pending = false;
  syncControls();
  lastResult = runPipeline(readParams());
  renderInfo(lastResult);
  renderPlots(lastResult);
}

function scheduleUpdate() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(update);
}

function init() {
  renderPipeline();

  const controls = $('controls');
  controls.addEventListener('input', (e) => {
    // Menggeser slider gain bebas otomatis memilih preset "Bebas".
    if (e.target.id === 'gainLog') document.querySelector('input[name=gainPreset][value=custom]').checked = true;
    if (e.target.id === 'fsFree') document.querySelector('input[name=fsPreset][value=custom]').checked = true;
    if (e.target.id === 'bitsFree') document.querySelector('input[name=bitsPreset][value=custom]').checked = true;
    scheduleUpdate();
  });
  controls.addEventListener('change', (e) => {
    // Memilih preset menyelaraskan posisi slider "Bebas" dengan nilai preset.
    if (e.target.value !== 'custom') {
      if (e.target.name === 'gainPreset') $('gainLog').value = Math.log10(Number(e.target.value));
      if (e.target.name === 'fsPreset') $('fsFree').value = e.target.value;
      if (e.target.name === 'bitsPreset') $('bitsFree').value = e.target.value;
    }
    scheduleUpdate();
  });
  controls.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    applyPreset($('fType').value, Number(btn.dataset.preset));
    scheduleUpdate();
  });

  // Kontrol tampilan di dalam tab Eksperimen 2 tidak mengubah hasil pipeline.
  $('exp2').addEventListener('change', () => { if (lastResult) renderPlots(lastResult); });
  $('exp3').addEventListener('change', () => { if (lastResult) renderPlots(lastResult); });
  $('valid').addEventListener('input', () => { if (lastResult) renderPlots(lastResult); });
  $('applyRecommended').addEventListener('click', applyRecommended);
  $('exportCsv').addEventListener('click', downloadCsv);
  $('aliasScenario').addEventListener('click', () => {
    $('aliasOn').checked = true;
    $('aaOn').checked = false;
    $('fType').value = 'none';
    document.querySelector('input[name=fsPreset][value="100"]').checked = true;
    $('fsFree').value = 100;
    $('window').value = '0.5';
    scheduleUpdate();
  });
  $('enableAllNoise').addEventListener('click', () => {
    for (const id of ['bwOn', 'mainsOn', 'hfOn', 'aliasOn']) $(id).checked = true;
    scheduleUpdate();
  });

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== btn.dataset.tab; });
      if (lastResult) renderPlots(lastResult); // canvas baru terlihat → ukur & gambar ulang
    });
  });

  window.addEventListener('resize', () => { if (lastResult) renderPlots(lastResult); });

  update();
  document.body.dataset.ready = 'true'; // penanda untuk pengujian otomatis
}

init();
