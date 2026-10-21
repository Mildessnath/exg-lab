/**
 * signal.js — Tahap 1: pembangkit sinyal "analog".
 *
 * Domain analog disimulasikan dengan laju sampel sangat tinggi (10 kHz) sehingga,
 * relatif terhadap pita sinyal biopotensial dan ADC yang akan disimulasikan nanti,
 * sinyal ini dapat dianggap kontinu.
 *
 * Sumber sinyal dipilih lewat PROFIL (js/profiles/): ECG, EMG, EEG, EOG, dan sinus
 * uji. Berkas ini hanya menyatukan: profil → sinyal bersih, ditambah gangguan,
 * ditambah statistik. Semua sinyal sintetis dan model sederhana, bukan data klinis.
 *
 * Semua fungsi di sini MURNI: keluaran hanya bergantung pada argumen, tidak ada
 * state global yang diubah. Noise acak memakai PRNG ber-seed agar hasil deterministik
 * (plot tidak "bergetar" setiap slider digeser, dan pengujian dapat diulang).
 *
 * Satuan internal: detik (s) dan volt (V). 1 mV = 1e-3 V.
 */

import {
  FS_ANALOG, sampleCount, makeTimeAxis, mulberry32, whiteNoise, signalStats, pulseTrain,
} from './profiles/common.js';
import { getProfile } from './profiles/index.js';
import { ECG_WAVES, FIRST_R_TIME, synthEcg, ecgCharacteristics, detectRPeaks } from './profiles/ecg.js';
import { synthSine } from './profiles/sine.js';
import { emgProfile } from './profiles/emg.js';
import { eegProfile } from './profiles/eeg.js';
import { eogProfile } from './profiles/eog.js';

// Ekspor lama dipertahankan agar seluruh pemakai (UI, tes) tidak perlu berubah.
export {
  FS_ANALOG, sampleCount, makeTimeAxis, mulberry32, whiteNoise, signalStats,
  ECG_WAVES, FIRST_R_TIME, synthEcg, synthSine, ecgCharacteristics, detectRPeaks,
};

/**
 * Parameter bawaan sumber sinyal dan gangguan.
 * `source` = id profil ('ecg' | 'emg' | 'eeg' | 'eog' | 'sine'). Kunci parameter
 * ECG dan sinus (hr, rAmp, sineFreq, sineAmp) sama seperti v1.
 */
export const DEFAULT_SIGNAL_PARAMS = Object.freeze({
  source: 'ecg',
  duration: 5,            // s
  fs: FS_ANALOG,          // Hz
  hr: 72,                 // bpm
  rAmp: 1e-3,             // V (≈ 1 mV)
  lead: 'II',             // sadapan ECG (model dipol; II = ECG asli)
  sineFreq: 10,           // Hz
  sineAmp: 1e-3,          // V (amplitudo puncak)
  ...emgProfile.defaults,
  ...eegProfile.defaults,
  ...eogProfile.defaults,
  disturbances: Object.freeze({
    baseline: Object.freeze({ on: false, amp: 0.3e-3, freq: 0.3 }),   // baseline wander
    mains: Object.freeze({ on: false, amp: 0.1e-3, freq: 50 }),       // interferensi jala-jala
    hf: Object.freeze({ on: false, rms: 0.03e-3, seed: 12345 }),      // noise putih (HF)
    alias: Object.freeze({ on: false, amp: 0.1e-3, freq: 80 }),       // komponen penyebab aliasing
    motion: Object.freeze({ on: false, amp: 0.2e-3, freq: 2 }),       // artefak gerak (EMG)
    blink: Object.freeze({ on: false, amp: 60e-6, interval: 4 }),     // artefak kedip (EEG)
    drift: Object.freeze({ on: false, amp: 50e-6 }),                  // drift DC, V/s (EOG)
  }),
});

/**
 * Menjumlahkan seluruh gangguan yang aktif menjadi satu sinyal noise.
 * Fase awal tiap sinus dipilih tetap (bukan nol) supaya tidak semua gangguan
 * berawal di titik nol secara bersamaan.
 *
 * Urutan penjumlahan: baseline, jala-jala, alias, noise putih (seperti v1; keluaran
 * ECG tidak berubah), lalu gangguan khas profil: artefak gerak, kedip, drift DC.
 * @returns {Float64Array} noise total (V)
 */
export function makeDisturbance(n, fs, d) {
  const noise = new Float64Array(n);
  const addSine = (amp, freq, phase) => {
    const w = 2 * Math.PI * freq;
    for (let i = 0; i < n; i++) noise[i] += amp * Math.sin(w * (i / fs) + phase);
  };
  if (d.baseline && d.baseline.on) addSine(d.baseline.amp, d.baseline.freq ?? 0.3, 0.0);
  if (d.mains && d.mains.on) addSine(d.mains.amp, d.mains.freq ?? 50, 0.7);
  if (d.alias && d.alias.on) addSine(d.alias.amp, d.alias.freq, 1.3);
  if (d.hf && d.hf.on && d.hf.rms > 0) {
    const w = whiteNoise(n, d.hf.rms, d.hf.seed ?? 12345);
    for (let i = 0; i < n; i++) noise[i] += w[i];
  }
  // Artefak gerak: sinus lambat (frekuensi dasar d.motion.freq) yang amplitudonya
  // dimodulasi pelan (0,37 Hz) agar tampak tak beraturan; puncak ≤ amp.
  if (d.motion && d.motion.on) {
    const w = 2 * Math.PI * (d.motion.freq ?? 2);
    const wm = 2 * Math.PI * 0.37;
    for (let i = 0; i < n; i++) {
      const tt = i / fs;
      noise[i] += d.motion.amp * Math.sin(w * tt + 0.5) * (0.6 + 0.4 * Math.sin(wm * tt + 1.1));
    }
  }
  // Artefak kedip: pulsa gaussian σ = 70 ms berulang tiap d.blink.interval detik.
  if (d.blink && d.blink.on && d.blink.amp > 0) {
    const tt = new Float64Array(n);
    for (let i = 0; i < n; i++) tt[i] = i / fs;
    const b = pulseTrain(tt, { amp: d.blink.amp, period: d.blink.interval ?? 4, first: 0.9, sigma: 0.07, fs });
    for (let i = 0; i < n; i++) noise[i] += b[i];
  }
  // Drift DC: rampa linear dari 0 dengan laju d.drift.amp (V/s).
  if (d.drift && d.drift.on) {
    for (let i = 0; i < n; i++) noise[i] += d.drift.amp * (i / fs);
  }
  return noise;
}

/**
 * Membangkitkan sinyal masukan lengkap = sumber bersih (profil) + gangguan.
 * @returns {{t, fs, clean, noise, x, params}}
 */
export function generateSignal(params) {
  const p = { ...DEFAULT_SIGNAL_PARAMS, ...params };
  const d = { ...DEFAULT_SIGNAL_PARAMS.disturbances, ...(params && params.disturbances) };
  const t = makeTimeAxis(p.duration, p.fs);
  const clean = getProfile(p.source).generator(t, p);
  const noise = makeDisturbance(t.length, p.fs, d);
  const x = new Float64Array(t.length);
  for (let i = 0; i < x.length; i++) x[i] = clean[i] + noise[i];
  return { t, fs: p.fs, clean, noise, x, params: { ...p, disturbances: d } };
}

/** SNR (dB) = 10·log10(P_sinyal / P_noise). Infinity bila tidak ada noise. */
export function snrDb(clean, noise) {
  let ps = 0, pn = 0;
  for (let i = 0; i < clean.length; i++) {
    ps += clean[i] * clean[i];
    pn += noise[i] * noise[i];
  }
  if (pn === 0) return Infinity;
  return 10 * Math.log10(ps / pn);
}
