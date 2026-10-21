/**
 * profiles/sine.js — Profil "Sinus uji": A·sin(2πft). Bukan sinyal biologis;
 * dipakai untuk menguji gain, filter, aliasing, dan kuantisasi dengan sinyal
 * yang frekuensi dan amplitudonya diketahui persis.
 */

import { fmt, mV, ms } from '../format.js';
import { sampleCount, defaultsFromControls } from './common.js';
import * as D from './disturbances.js';
import { U, slider } from './disturbances.js';

/** Sinus uji: A · sin(2π f t). */
export function synthSine({ duration, fs, freq = 10, amp = 1e-3 }) {
  const n = sampleCount(duration, fs);
  const x = new Float64Array(n);
  const w = 2 * Math.PI * freq;
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(w * (i / fs));
  return x;
}

const controls = [
  { type: 'range', ...slider('sineFreq', 'Frekuensi sinus', 0.5, 2000, 0.5, 10, U.Hz, 1) },
  { type: 'range', ...slider('sineAmp', 'Amplitudo sinus (puncak)', 0.1, 2, 0.05, 1, U.mV, 2) },
];

export const sineProfile = {
  id: 'sine',
  nama: 'Sinus uji',
  singkat: 'Sinus',
  deskripsi: 'Sinus murni dengan frekuensi dan amplitudo yang diketahui — sinyal uji, bukan sinyal biologis.',
  amplitudo: { tipikal: [0.1e-3, 2e-3], keterangan: 'amplitudo puncak' },
  band: [0.5, 40],
  bandCheck: { hpMax: 0.5, lpMin: 40, hpWhy: 'membuang sebagian pita sinyal', lpWhy: 'membuang sebagian pita sinyal' },
  repFreq: (p) => [p.sineFreq, 'sinus uji'],
  lsbTarget: 5e-6,
  defaultDuration: 5,
  controls,
  disturbances: [
    D.baseline(U.mV, 1, 0.3),
    D.mains(U.mV, 0.5, 0.1),
    D.hf(U.mV, 0.2, 0.03),
    D.alias(U.mV, 0.5, 0.1, 80),
  ],
  defaults: defaultsFromControls(controls),
  preset: {
    gain: 1000,
    filter: { type: 'bpf', bpf: { fLow: 0.5, fHigh: 40 }, addNotch: false },
    fs: 250, bits: 12, vRef: 2, vSat: 2, antiAlias: true,
  },
  limits: { vSat: [0.5, 5], vRef: [0.1, 5] },
  generator(t, params) {
    const w = 2 * Math.PI * (params.sineFreq ?? 10);
    const amp = params.sineAmp ?? 1e-3;
    const x = new Float64Array(t.length);
    for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin(w * t[i]);
    return x;
  },
  info({ p }) {
    return [
      ['Sumber', 'Sinus uji'],
      ['Frekuensi', `${fmt(p.sineFreq, 1)} Hz (periode ${ms(1 / p.sineFreq)})`],
      ['Amplitudo puncak', mV(p.sineAmp)],
    ];
  },
  batas: ['Sinyal uji ideal: tidak mewakili sinyal biologis apa pun.'],
  filterAdvice: 'Sinus uji memudahkan membaca respons filter: amplitudo keluaran/masukan pada frekuensi sinus = |H(f)| langsung.',
  recommendReasons: [
    ['Gain ×1000', '1 mV menjadi 1 V: separuh rentang ADC ±2 V.'],
    ['BPF 0,5–40 Hz', 'Meloloskan sinus uji bawaan (10 Hz) tanpa pelemahan berarti. Ubah frekuensi sinus di atas pita ini untuk melihat filter bekerja.'],
    ['fs 250 Hz + anti-aliasing', 'Nyquist 125 Hz. Sinus di atas 125 Hz akan terlipat bila anti-aliasing dimatikan.'],
    ['12 bit, ±2 V', 'LSB 0,98 mV di keluaran ≈ 0,98 µV di masukan.'],
  ],
};
