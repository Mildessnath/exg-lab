/**
 * profiles/emg.js — Profil EMG permukaan (sEMG).
 *
 * MODEL SEDERHANA, BUKAN DATA KLINIS: derau gaussian pita-lebar berpita 20–450 Hz
 * (derau putih → HPF 20 Hz + LPF 450 Hz Butterworth orde 4) dikalikan envelope
 * aktivasi otot. Model ini tidak memodelkan unit motor, bentuk potensial aksi,
 * kelelahan otot, atau crosstalk.
 *
 * Definisi kontrol:
 *   - amplitudo puncak : puncak |x| pada kontraksi 100 %
 *   - tingkat kontraksi: skala linear envelope (0–100 %); puncak aktual = amp × tingkat
 *   - pola             : 'tonic'  = aktivasi menetap (fluktuasi lambat ±10 %)
 *                        'burst'  = pulsa aktivasi berulang (duty 40 %, tepi 20 ms)
 */

import { fmt, mV, hz, fmtVolt } from '../format.js';
import { bandNoise, peakAbs, signalStats, defaultsFromControls } from './common.js';
import * as D from './disturbances.js';
import { U, slider } from './disturbances.js';

export const EMG_BAND = Object.freeze([20, 450]);
const BURST_DUTY = 0.4;
const EDGE = 0.02; // s, waktu naik/turun tepi burst

/** Envelope aktivasi 0…1. */
export function emgEnvelope(t, { pattern, burstRate }) {
  const n = t.length;
  const env = new Float64Array(n);
  if (pattern === 'tonic') {
    for (let i = 0; i < n; i++) env[i] = 0.9 + 0.1 * Math.sin(2 * Math.PI * 0.7 * t[i] + 0.6);
    return env;
  }
  const T = 1 / Math.max(burstRate, 0.05);
  const on = BURST_DUTY * T;
  const edge = Math.min(EDGE, on / 2);
  const t0 = 0.15;
  for (let i = 0; i < n; i++) {
    const ph = (((t[i] - t0) % T) + T) % T;
    let g = 0;
    if (ph < on) {
      if (ph < edge) g = 0.5 * (1 - Math.cos((Math.PI * ph) / edge));
      else if (ph > on - edge) g = 0.5 * (1 + Math.cos((Math.PI * (ph - (on - edge))) / edge));
      else g = 1;
    }
    env[i] = g;
  }
  return env;
}

/** Sinyal EMG bersih (V). */
export function synthEmg(t, p) {
  const n = t.length;
  const fs = p.fs;
  const level = Math.min(1, Math.max(0, p.emgLevel ?? 0.6));
  const amp = p.emgAmp ?? 1e-3;
  const out = new Float64Array(n);
  if (level === 0 || amp === 0) return out;
  const noise = bandNoise(n, fs, { fLow: EMG_BAND[0], fHigh: EMG_BAND[1], seed: p.emgSeed ?? 20240, order: 4 });
  const env = emgEnvelope(t, { pattern: p.emgPattern ?? 'burst', burstRate: p.emgBurstRate ?? 1 });
  for (let i = 0; i < n; i++) out[i] = noise[i] * env[i];
  const pk = peakAbs(out);
  if (pk > 0) { const k = (amp * level) / pk; for (let i = 0; i < n; i++) out[i] *= k; }
  return out;
}

const controls = [
  { type: 'range', ...slider('emgAmp', 'Amplitudo puncak (kontraksi 100 %)', 0.05, 5, 0.05, 1, U.mV, 2) },
  { type: 'range', key: 'emgLevel', label: 'Tingkat kontraksi', min: 0, max: 100, step: 1, def: 60, unit: '%', toSI: 0.01, digits: 0 },
  {
    type: 'select', key: 'emgPattern', label: 'Pola aktivasi', def: 'burst',
    options: [['burst', 'Burst berulang'], ['tonic', 'Tonik (menetap)']],
  },
  { type: 'range', ...slider('emgBurstRate', 'Laju burst', 0.5, 4, 0.1, 1, { unit: 'burst/s', toSI: 1 }, 1), showIf: { emgPattern: 'burst' } },
];

export const emgProfile = {
  id: 'emg',
  nama: 'EMG permukaan',
  singkat: 'EMG',
  deskripsi: 'EMG permukaan sintetis: derau pita-lebar 20–450 Hz × envelope aktivasi otot (model sederhana, bukan data klinis).',
  amplitudo: { tipikal: [0.05e-3, 5e-3], keterangan: 'amplitudo puncak sEMG' },
  band: EMG_BAND,
  bandCheck: { hpMax: 20, lpMin: 450, hpWhy: 'membuang pita bawah sEMG', lpWhy: 'memotong energi sEMG di atas cutoff' },
  repFreq: () => [100, 'pita sEMG'],
  lsbTarget: 5e-6,
  defaultDuration: 5,
  controls,
  disturbances: [
    D.mains(U.uV, 500, 50, 5, 0),
    D.motion(U.uV, 1000, 200, 10, 0),
    D.baseline(U.uV, 500, 100, 5, 0),
    D.hf(U.uV, 50, 5, 0.5, 1),
    D.alias(U.uV, 500, 100, 1200, 5, 0),
  ],
  defaults: { ...defaultsFromControls(controls), emgSeed: 20240 },
  preset: {
    gain: 1000,
    filter: { type: 'bpf', bpf: { fLow: 20, fHigh: 450 }, addNotch: true, notch: { f0: 50, q: 30 } },
    fs: 2000, bits: 16, vRef: 2.5, vSat: 2.5, antiAlias: true,
  },
  limits: { vSat: [0.5, 5], vRef: [0.1, 5] },
  generator: synthEmg,
  info({ p, clean }) {
    const st = signalStats(clean);
    const level = p.emgLevel ?? 0.6;
    return [
      ['Sumber', 'EMG permukaan sintetis (derau 20–450 Hz × envelope)'],
      ['Pola', (p.emgPattern ?? 'burst') === 'burst' ? `burst berulang, ${fmt(p.emgBurstRate ?? 1, 1)} burst/s` : 'tonik (aktivasi menetap)'],
      ['Tingkat kontraksi', `${fmt(level * 100, 0)} %`],
      ['Amplitudo puncak (nominal 100 % / aktual)', `${mV(p.emgAmp)} / ${fmtVolt(peakAbs(clean))}`],
      ['RMS sinyal bersih', fmtVolt(st.rms)],
      ['Pita derau (−3 dB)', `${hz(EMG_BAND[0])} – ${hz(EMG_BAND[1])}`],
    ];
  },
  batas: [
    'Derau gaussian berpita × envelope: tanpa unit motor, bentuk potensial aksi, kelelahan, atau crosstalk.',
    'Tepi pita 20/450 Hz lunak (Butterworth orde 4), bukan dinding bata.',
    'Amplitudo diskalakan agar puncaknya tepat = amplitudo × tingkat kontraksi.',
  ],
  filterAdvice: 'Energi sEMG berada di 20–450 Hz: LPF di bawah ≈ 450 Hz membuang energi sinyal, HPF di atas ≈ 20 Hz memakan pita bawahnya. HPF 20 Hz sekaligus menekan artefak gerak dan baseline. Notch 50 Hz membuang jala-jala tetapi ikut memakan sedikit energi sEMG di sekitar 50 Hz.',
  recommendReasons: [
    ['Gain ×1000', 'Puncak 0,6 mV (1 mV × 60 %) menjadi ≈ 0,6 V; rail ±2,5 V menyisakan ruang untuk artefak gerak sebelum saturasi.'],
    ['BPF 20–450 Hz + notch 50 Hz', 'Pita sEMG; HPF 20 Hz menekan artefak gerak dan baseline, notch menekan jala-jala 50 Hz (kaskade, Q = 30).'],
    ['fs 2000 Hz + anti-aliasing', 'Nyquist 1000 Hz > 450 Hz. fs = 2000 Hz membagi 10 kHz tepat (sampel tanpa interpolasi) dan AA fc 800 Hz tidak memotong pita sEMG.'],
    ['16 bit, ±2,5 V', 'LSB 76 µV di keluaran ≈ 0,08 µV di masukan — jauh di bawah amplitudo sEMG terkecil (50 µV).'],
  ],
};
