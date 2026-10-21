/**
 * profiles/eog.js — Profil EOG (elektrookulogram).
 *
 * MODEL SEDERHANA, BUKAN DATA KLINIS: posisi mata horizontal berupa perubahan
 * TANGGA (saccade) bergantian kiri/kanan — tiap saccade menggeser potensial sebesar
 * tepat `amplitudo`, dengan transisi mulus (smoothstep 40 ms) — ditambah kedip
 * berupa pulsa gaussian (σ = 60 ms). Tidak memodelkan sudut-ke-tegangan, saccade
 * berbagai ukuran, nistagmus, atau pergerakan mata vertikal terpisah.
 *
 * Karena langkah tangga mengandung komponen DC / frekuensi sangat rendah, preset
 * memakai LPF ~30 Hz tanpa HPF (HPF 0,05 Hz saja sudah meluruhkan plato ≈ 47 % dalam
 * 2 s).
 */

import { fmt, hz, fmtVolt } from '../format.js';
import { pulseTrain, defaultsFromControls } from './common.js';
import * as D from './disturbances.js';
import { U, slider } from './disturbances.js';

const FIRST_SACCADE = 0.75;  // s
const SACCADE_RAMP = 0.04;   // s
const FIRST_BLINK = 1.75;    // s
const BLINK_SIGMA = 0.06;    // s

const smoothstep = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Waktu saccade ke-k. */
export const saccadeTime = (k, interval) => FIRST_SACCADE + k * interval;

/** Sinyal EOG bersih (V). */
export function synthEog(t, p) {
  const n = t.length;
  const fs = p.fs;
  const amp = p.eogAmp ?? 0.5e-3;
  const T = Math.max(0.1, p.eogInterval ?? 2);
  const x = new Float64Array(n);
  const tEnd = t[n - 1];

  // Posisi awal −amp/2; saccade ke-k menambah (−1)^k · amp (k = 0 → +amp).
  x.fill(-amp / 2);
  for (let k = 0; saccadeTime(k, T) <= tEnd + SACCADE_RAMP; k++) {
    const tk = saccadeTime(k, T);
    const step = (k % 2 === 0 ? 1 : -1) * amp;
    const i0 = Math.max(0, Math.floor(tk * fs));
    for (let i = i0; i < n; i++) {
      const u = (t[i] - tk) / SACCADE_RAMP;
      if (u >= 1) { for (let j = i; j < n; j++) x[j] += step; break; }
      x[i] += step * smoothstep(u);
    }
  }

  if (p.eogBlink ?? true) {
    const b = pulseTrain(t, { amp: p.eogBlinkAmp ?? 0.8e-3, period: p.eogBlinkInterval ?? 3.3, first: FIRST_BLINK, sigma: BLINK_SIGMA, fs });
    for (let i = 0; i < n; i++) x[i] += b[i];
  }
  return x;
}

const controls = [
  { type: 'range', ...slider('eogAmp', 'Amplitudo saccade (ukuran langkah)', 0.05, 3.5, 0.05, 0.5, U.mV, 2) },
  { type: 'range', ...slider('eogInterval', 'Selang antar saccade', 0.5, 5, 0.1, 2, U.s, 1) },
  { type: 'check', key: 'eogBlink', label: 'Sertakan kedip mata', def: true },
  { type: 'range', ...slider('eogBlinkAmp', 'Amplitudo kedip (puncak)', 0.05, 3, 0.05, 0.8, U.mV, 2), showIf: { eogBlink: true } },
  { type: 'range', ...slider('eogBlinkInterval', 'Selang antar kedip', 1, 8, 0.1, 3.3, U.s, 1), showIf: { eogBlink: true } },
];

export const eogProfile = {
  id: 'eog',
  nama: 'EOG (elektrookulogram)',
  singkat: 'EOG',
  deskripsi: 'EOG sintetis: saccade berupa langkah tangga bergantian ± dan kedip berupa pulsa; drift DC opsional (model sederhana, bukan data klinis).',
  amplitudo: { tipikal: [0.05e-3, 3.5e-3], keterangan: 'ukuran langkah saccade / kedip' },
  band: [0.05, 30],
  bandCheck: { hpMax: 0.1, lpMin: 30, hpWhy: 'meluruhkan plato langkah saccade', lpWhy: 'melembutkan tepi langkah dan kedip' },
  repFreq: () => [1, 'langkah saccade'],
  lsbTarget: 10e-6,
  defaultDuration: 10,
  controls,
  disturbances: [
    D.drift(U.uVs, 200, 50, 5, 0),
    D.mains(U.uV, 200, 20, 1, 0),
    D.baseline(U.uV, 500, 50, 5, 0),
    D.hf(U.uV, 50, 5, 0.5, 1),
    D.alias(U.uV, 200, 20, 150, 1, 0),
  ],
  defaults: defaultsFromControls(controls),
  preset: {
    gain: 1000,
    filter: { type: 'lpf', lpf: { fc: 30 }, addNotch: false },
    fs: 250, bits: 16, vRef: 2, vSat: 2, antiAlias: true,
  },
  limits: { vSat: [0.5, 5], vRef: [0.1, 5] },
  generator: synthEog,
  info({ p, clean }) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < clean.length; i++) { if (clean[i] < mn) mn = clean[i]; if (clean[i] > mx) mx = clean[i]; }
    return [
      ['Sumber', 'EOG sintetis (saccade tangga + kedip)'],
      ['Ukuran langkah saccade', fmtVolt(p.eogAmp)],
      ['Selang saccade', `${fmt(p.eogInterval, 1)} s (transisi 40 ms)`],
      ['Kedip', (p.eogBlink ?? true) ? `${fmtVolt(p.eogBlinkAmp)} tiap ${fmt(p.eogBlinkInterval, 1)} s` : 'tidak disertakan'],
      ['Vpp sinyal bersih', fmtVolt(mx - mn)],
      ['Pita utama', `DC – ${hz(30)} (langkah tangga berenergi di frekuensi sangat rendah; sinyal DC-coupled)`],
    ];
  },
  batas: [
    'Saccade seragam bergantian kiri/kanan; tanpa hubungan sudut–tegangan, nistagmus, atau komponen vertikal terpisah.',
    'Kedip berupa pulsa gaussian tunggal; drift DC adalah gangguan terpisah berupa rampa linear.',
    'Plato langkah hanya bertahan bila filter tidak memotong frekuensi sangat rendah (tanpa HPF atau HPF ≪ 0,05 Hz).',
  ],
  filterAdvice: 'Langkah saccade mengandung komponen DC/sangat rendah: HPF 0,5 Hz atau lebih meluruhkan plato dengan cepat dan mengubah langkah menjadi pulsa. LPF ≈ 30 Hz cukup untuk mempertahankan tepi langkah dan kedip sambil meredam noise. Drift DC lolos tanpa HPF dan dapat menjenuhkan amplifier bergain tinggi.',
  recommendReasons: [
    ['Gain ×1000', 'Langkah 0,5 mV + kedip 0,8 mV menjadi ≈ 1 V (puncak ≈ 1,05 V), di bawah rail ±2 V.'],
    ['LPF 30 Hz, tanpa HPF', 'Mempertahankan plato langkah (DC) dan kedip; LPF membuang noise HF. Aktifkan HPF sangat rendah bila drift DC besar.'],
    ['fs 250 Hz + anti-aliasing', 'Isi energi sinyal < 30 Hz; Nyquist 125 Hz memberi ruang. AA LPF orde 8 meredam noise pita lebar sebelum sampling, tetapi tidak total.'],
    ['16 bit, ±2 V', 'LSB 61 µV di keluaran ≈ 0,06 µV di masukan — jauh di bawah langkah saccade terkecil (50 µV).'],
  ],
};
