/**
 * profiles/eeg.js — Profil EEG kulit kepala.
 *
 * MODEL SEDERHANA, BUKAN DATA KLINIS: jumlah osilasi per pita (delta 0,5–4; theta
 * 4–8; alpha 8–13; beta 13–30; gamma 30–70 Hz), masing-masing derau gaussian
 * berpita unit-RMS, di atas latar ≈ 1/f (Voss–McCartney). Tanpa sumber dipol,
 * konduksi volume, spindle, kompleks-K, atau topografi kanal.
 *
 * Definisi kontrol:
 *   - daya tiap pita (0–100 %): bobot DAYA relatif; amplitudo pita = √(daya)
 *   - amplitudo total        : puncak |x| pada MODE MATA TERBUKA. Skala ini dihitung
 *                              dari campuran mata-terbuka lalu dipakai juga pada mode
 *                              mata tertutup, sehingga alpha yang naik benar-benar
 *                              menaikkan daya alpha (dan amplitudo total) mutlak.
 *   - mata tertutup          : amplitudo alpha × 2,5 (daya × 6,25)
 */

import { fmt, hz, fmtVolt } from '../format.js';
import { bandNoise, pinkNoise, peakAbs, defaultsFromControls } from './common.js';
import * as D from './disturbances.js';
import { U, slider } from './disturbances.js';

export const EEG_BANDS = Object.freeze([
  Object.freeze({ id: 'delta', key: 'eegDelta', nama: 'delta', lo: 0.5, hi: 4 }),
  Object.freeze({ id: 'theta', key: 'eegTheta', nama: 'theta', lo: 4, hi: 8 }),
  Object.freeze({ id: 'alpha', key: 'eegAlpha', nama: 'alpha', lo: 8, hi: 13 }),
  Object.freeze({ id: 'beta', key: 'eegBeta', nama: 'beta', lo: 13, hi: 30 }),
  Object.freeze({ id: 'gamma', key: 'eegGamma', nama: 'gamma', lo: 30, hi: 70 }),
]);

/** Pengali amplitudo alpha pada mode mata tertutup. */
export const ALPHA_CLOSED_GAIN = 2.5;

/** Bobot daya relatif (0…1) tiap pita dari parameter. */
function weights(p) {
  const w = {};
  for (const b of EEG_BANDS) w[b.id] = Math.max(0, p[b.key] ?? 0);
  w.bg = Math.max(0, p.eegBg ?? 0);
  return w;
}

/** Sinyal EEG bersih (V). */
export function synthEeg(t, p) {
  const n = t.length;
  const fs = p.fs;
  const amp = p.eegAmp ?? 40e-6;
  const seed = p.eegSeed ?? 777;
  const w = weights(p);
  const closed = (p.eegState ?? 'open') === 'closed';
  const out = new Float64Array(n);
  if (amp === 0) return out;

  // komponen unit-RMS (hanya yang berbobot > 0 yang dihitung)
  const comp = {};
  EEG_BANDS.forEach((b, i) => {
    if (w[b.id] > 0) comp[b.id] = bandNoise(n, fs, { fLow: b.lo, fHigh: b.hi, seed: seed + 1 + i, order: 4 });
  });
  const bg = w.bg > 0 ? pinkNoise(n, seed + 99) : null;

  const mix = (alphaGain) => {
    const y = new Float64Array(n);
    for (const b of EEG_BANDS) {
      const c = comp[b.id];
      if (!c) continue;
      const a = Math.sqrt(w[b.id]) * (b.id === 'alpha' ? alphaGain : 1);
      for (let i = 0; i < n; i++) y[i] += a * c[i];
    }
    if (bg) { const a = Math.sqrt(w.bg); for (let i = 0; i < n; i++) y[i] += a * bg[i]; }
    return y;
  };

  const open = mix(1);
  const pk = peakAbs(open);
  if (pk === 0) return out;
  const s = amp / pk;
  const y = closed ? mix(ALPHA_CLOSED_GAIN) : open;
  for (let i = 0; i < n; i++) out[i] = y[i] * s;
  return out;
}

const pw = (key, label, def) => ({
  type: 'range', key, label, min: 0, max: 100, step: 1, def, unit: '%', toSI: 0.01, digits: 0,
});

const controls = [
  { type: 'range', ...slider('eegAmp', 'Amplitudo total (puncak, mata terbuka)', 10, 100, 1, 40, U.uV, 0) },
  {
    type: 'select', key: 'eegState', label: 'Keadaan mata', def: 'open',
    options: [['open', 'Mata terbuka'], ['closed', 'Mata tertutup (alpha naik)']],
  },
  pw('eegDelta', 'Daya delta (0,5–4 Hz)', 50),
  pw('eegTheta', 'Daya theta (4–8 Hz)', 30),
  pw('eegAlpha', 'Daya alpha (8–13 Hz)', 40),
  pw('eegBeta', 'Daya beta (13–30 Hz)', 20),
  pw('eegGamma', 'Daya gamma (30–70 Hz)', 8),
  pw('eegBg', 'Daya latar ≈ 1/f', 30),
];

/** Fraksi daya model per pita (setelah faktor alpha), untuk panel info. */
export function eegPowerShares(p) {
  const w = weights(p);
  const g = (p.eegState ?? 'open') === 'closed' ? ALPHA_CLOSED_GAIN : 1;
  const parts = {};
  let total = 0;
  for (const b of EEG_BANDS) { parts[b.id] = w[b.id] * (b.id === 'alpha' ? g * g : 1); total += parts[b.id]; }
  parts.bg = w.bg; total += w.bg;
  const sh = {};
  for (const k of Object.keys(parts)) sh[k] = total > 0 ? parts[k] / total : 0;
  return sh;
}

export const eegProfile = {
  id: 'eeg',
  nama: 'EEG (elektroensefalogram)',
  singkat: 'EEG',
  deskripsi: 'EEG sintetis: osilasi delta–gamma di atas latar ≈ 1/f; mata tertutup menaikkan alpha (model sederhana, bukan data klinis).',
  amplitudo: { tipikal: [10e-6, 100e-6], keterangan: 'amplitudo total' },
  band: [0.5, 70],
  bandCheck: { hpMax: 0.5, lpMin: 70, hpWhy: 'membuang aktivitas delta', lpWhy: 'membuang gamma' },
  repFreq: () => [10, 'alpha'],
  lsbTarget: 0.5e-6,
  defaultDuration: 10,
  controls,
  disturbances: [
    D.mains(U.uV, 100, 20, 1, 0, 'Interferensi jala-jala 50 Hz (dominan)'),
    D.baseline(U.uV, 100, 30, 1, 0),
    D.blink(U.uV, 200, 80, 5, 0),
    D.hf(U.uV, 20, 2, 0.5, 1),
    D.alias(U.uV, 100, 20, 300, 1, 0),
  ],
  defaults: { ...defaultsFromControls(controls), eegSeed: 777 },
  preset: {
    gain: 10000,
    filter: { type: 'bpf', bpf: { fLow: 0.5, fHigh: 70 }, addNotch: true, notch: { f0: 50, q: 30 } },
    fs: 250, bits: 24, vRef: 2.5, vSat: 2.5, antiAlias: true,
  },
  limits: { vSat: [0.5, 5], vRef: [0.1, 5] },
  generator: synthEeg,
  info({ p, clean }) {
    const sh = eegPowerShares(p);
    const pct = (k) => fmt(sh[k] * 100, 0);
    return [
      ['Sumber', 'EEG sintetis (osilasi per pita + latar ≈ 1/f)'],
      ['Keadaan mata', (p.eegState ?? 'open') === 'closed' ? 'tertutup (alpha × 2,5)' : 'terbuka'],
      ['Amplitudo puncak (nominal mata terbuka / aktual)', `${fmtVolt(p.eegAmp)} / ${fmtVolt(peakAbs(clean))}`],
      ['Daya relatif δ / θ / α / β / γ / latar', `${pct('delta')} / ${pct('theta')} / ${pct('alpha')} / ${pct('beta')} / ${pct('gamma')} / ${pct('bg')} %`],
      ['Pita', EEG_BANDS.map((b) => `${b.nama} ${fmt(b.lo, b.lo < 1 ? 1 : 0)}–${fmt(b.hi, 0)}`).join(', ') + ' Hz'],
    ];
  },
  batas: [
    'Derau berpita + latar 1/f (Voss–McCartney, simpangan ±1–2 dB): tanpa dipol, konduksi volume, spindle, atau topografi kanal.',
    'Amplitudo total mengacu pada mode mata terbuka; mode mata tertutup menaikkan alpha × 2,5 pada skala yang sama.',
    'Tepi pita lunak: pada mata tertutup alpha ikut mengisi pita tetangga (terukur: daya alpha ×5,3, theta ×1,8, beta ×2,9; delta dan gamma tidak berubah).',
    'Artefak kedip, jala-jala, dan baseline adalah gangguan terpisah (kolom Gangguan).',
  ],
  filterAdvice: 'EEG ber-amplitudo puluhan µV, sehingga jala-jala 50 Hz dan artefak kedip/baseline mudah melebihi sinyal. Pita 0,5–70 Hz mempertahankan delta–gamma; notch 50 Hz membuang jala-jala tetapi ikut memakan gamma di sekitar 50 Hz. HPF di atas ≈ 0,5 Hz membuang delta, LPF di bawah ≈ 30 Hz membuang gamma.',
  recommendReasons: [
    ['Gain ×10.000', '40 µV menjadi 0,4 V; artefak kedip 80 µV masih menyisakan ruang di bawah rail ±2,5 V.'],
    ['BPF 0,5–70 Hz + notch 50 Hz', 'Pita EEG delta–gamma; notch (kaskade, Q = 30) menekan jala-jala yang biasanya dominan.'],
    ['fs 250 Hz + anti-aliasing', 'Nyquist 125 Hz > 70 Hz; AA LPF orde 8 (fc 100 Hz) meredam noise pita lebar sebelum sampling, tetapi tidak total (≈ −15,6 dB di Nyquist, ≈ −48 dB di 0,8·fs).'],
    ['24 bit, ±2,5 V', 'LSB 0,3 µV di keluaran ≈ 0,03 nV di masukan; resolusi tinggi berguna karena amplitudo EEG kecil dan gain moderat.'],
  ],
};
