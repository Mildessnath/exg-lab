/**
 * profiles/ecg.js — Profil ECG: jumlah gaussian P, Q, R, S, T yang diulang tiap RR.
 *
 * Generator dipindahkan dari signal.js TANPA mengubah satu pun operasi aritmetika:
 * keluarannya identik bit-per-bit dengan versi sebelum refactor (dijaga oleh tes
 * regresi berbasis fixture di tests/fixtures/ecg-reference.json).
 *
 * MODEL SEDERHANA, BUKAN DATA KLINIS: satu sadapan dengan morfologi tetap, tanpa
 * variabilitas detak, aritmia, atau artefak gerak nyata.
 */

import { fmt, mV, ms } from '../format.js';
import { makeTimeAxis, signalStats, defaultsFromControls } from './common.js';
import { ECG_WAVES, FIRST_R_TIME } from './ecg-waves.js';
import { LEADS, getLead, leadSignal, leadWaveAmplitudes } from '../cardiac-dipole.js';
import * as D from './disturbances.js';
import { U, slider } from './disturbances.js';

export { ECG_WAVES, FIRST_R_TIME };

/** Inti pembangkit: t = sumbu waktu (t[i] = i / fs), keluaran dalam volt. */
function ecgCore(t, fs, duration, hr, rAmp) {
  const n = t.length;
  const x = new Float64Array(n);
  const rr = 60 / hr;
  // Mulai satu denyut sebelum t=0 agar gelombang T denyut sebelumnya ikut tergambar.
  for (let tR = FIRST_R_TIME - rr; tR < duration + rr; tR += rr) {
    for (const w of ECG_WAVES) {
      const c = tR + w.offset;
      const a = w.amp * rAmp;
      // Gaussian praktis nol di luar ±5σ, jadi cukup hitung jendela itu saja.
      const i0 = Math.max(0, Math.ceil((c - 5 * w.sigma) * fs));
      const i1 = Math.min(n - 1, Math.floor((c + 5 * w.sigma) * fs));
      const k = 1 / (2 * w.sigma * w.sigma);
      for (let i = i0; i <= i1; i++) {
        const d = t[i] - c; // t[i] === i / fs persis
        x[i] += a * Math.exp(-d * d * k);
      }
    }
  }
  return x;
}

/**
 * ECG sintetis sebagai jumlah gaussian P, Q, R, S, T yang diulang tiap interval RR.
 * @returns {Float64Array} sinyal dalam volt
 */
export function synthEcg({ duration, fs, hr = 72, rAmp = 1e-3 }) {
  return ecgCore(makeTimeAxis(duration, fs), fs, duration, hr, rAmp);
}

/**
 * Karakteristik morfologi ECG sintetis, diturunkan langsung dari parameter model.
 * Durasi tiap gelombang didekati sebagai lebar ±2σ (≈95% energi gaussian).
 */
export function ecgCharacteristics({ hr = 72, rAmp = 1e-3 } = {}) {
  const w = Object.fromEntries(ECG_WAVES.map((g) => [g.nama, g]));
  const onset = (g) => g.offset - 2 * g.sigma;
  const end = (g) => g.offset + 2 * g.sigma;
  const qrsOnset = onset(w.Q);
  return {
    hr,
    rr: 60 / hr,
    rAmp,
    pAmp: w.P.amp * rAmp,
    tAmp: w.T.amp * rAmp,
    pDur: 4 * w.P.sigma,
    qrsDur: end(w.S) - qrsOnset,
    tDur: 4 * w.T.sigma,
    pr: qrsOnset - onset(w.P),
    qt: end(w.T) - qrsOnset,
    // Komponen spektral utama ECG berada kira-kira di 0,05–40 Hz (QRS hingga ~100 Hz).
    bandwidthHint: '≈ 0,05–100 Hz',
  };
}

/** Deteksi puncak R sederhana (ambang + periode refrakter), untuk verifikasi HR. */
export function detectRPeaks(x, fs, { thresholdRatio = 0.6, refractory = 0.25 } = {}) {
  const { max } = signalStats(x);
  const thr = max * thresholdRatio;
  const minGap = Math.round(refractory * fs);
  const peaks = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i] > thr && x[i] >= x[i - 1] && x[i] >= x[i + 1]) {
      peaks.push(i);
      i += minGap;
    } else {
      i++;
    }
  }
  return peaks;
}

const controls = [
  {
    type: 'select', key: 'lead', label: 'Sadapan', def: 'II',
    options: LEADS.map((l) => [l.id, l.id === 'II' ? 'II (bawaan)' : l.id, l.grup]),
  },
  { type: 'range', key: 'hr', label: 'Detak jantung', min: 40, max: 150, step: 1, def: 72, unit: 'bpm', toSI: 1, digits: 0 },
  { type: 'range', ...slider('rAmp', 'Amplitudo R (puncak)', 0.2, 3, 0.05, 1, U.mV, 2) },
];

export const ecgProfile = {
  id: 'ecg',
  nama: 'ECG (elektrokardiogram)',
  singkat: 'ECG',
  deskripsi: 'ECG sintetis: lima gaussian P, Q, R, S, T yang diulang tiap interval RR (model sederhana, bukan data klinis).',
  amplitudo: { tipikal: [0.5e-3, 2e-3], keterangan: 'puncak gelombang R' },
  band: [0.05, 150],
  bandCheck: { hpMax: 0.5, lpMin: 40, hpWhy: 'mendistorsi segmen ST', lpWhy: 'memotong puncak R' },
  repFreq: () => [10, 'pita QRS'],
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
    const hr = params.hr ?? 72, rAmp = params.rAmp ?? 1e-3;
    const fs = params.fs;
    const duration = params.duration ?? t.length / fs;
    const lead = getLead(params.lead).id;
    // Sadapan II = jalur ECG asli (identik bit-per-bit dengan v1). Model dipol
    // (cardiac-dipole.js) mereproduksinya sampai ≈ 1e-15 relatif, jadi memilih II tidak
    // mengubah pipeline sama sekali; sadapan lain adalah proyeksi dipol yang sama.
    if (lead === 'II') return ecgCore(t, fs, duration, hr, rAmp);
    return leadSignal(t, { fs, duration, hr, rAmp }, lead);
  },
  info({ p, clean, fs }) {
    const c = ecgCharacteristics({ hr: p.hr, rAmp: p.rAmp });
    const lead = getLead(p.lead);
    const amps = leadWaveAmplitudes(lead.id, p.rAmp);
    // Pada sadapan dengan R negatif (mis. aVR, V1) puncak R dicari pada sinyal terbalik.
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < clean.length; i++) { if (clean[i] < mn) mn = clean[i]; if (clean[i] > mx) mx = clean[i]; }
    const ref = -mn > mx ? clean.map((v) => -v) : clean;
    const peaks = detectRPeaks(ref, fs);
    let hrDet = NaN;
    if (peaks.length >= 2) hrDet = 60 / ((peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1) / fs);
    return [
      ['Sumber', 'ECG sintetis (5 gaussian P, Q, R, S, T)'],
      ['Sadapan', lead.kualitatif ? `${lead.id} — perkiraan kualitatif (model dipol tunggal)` : `${lead.id} — model dipol tunggal${lead.id === 'II' ? ' (= ECG asli)' : ''}`],
      ['Amplitudo R / P / T pada sadapan ini', `${mV(amps.R)} / ${mV(amps.P)} / ${mV(amps.T)}`],
      ['Detak jantung (HR)', `${fmt(c.hr, 0)} bpm`],
      ['HR terdeteksi dari puncak R', `${fmt(hrDet, 1)} bpm (${peaks.length} denyut)`],
      ['Interval RR', ms(c.rr)],
      ['Amplitudo R / P / T (sadapan II)', `${mV(c.rAmp)} / ${mV(c.pAmp)} / ${mV(c.tAmp)}`],
      ['Durasi P / QRS / T (±2σ)', `${ms(c.pDur)} / ${ms(c.qrsDur)} / ${ms(c.tDur)}`],
      ['Interval PR / QT', `${ms(c.pr)} / ${ms(c.qt)}`],
      ['Pita frekuensi utama', c.bandwidthHint],
    ];
  },
  batas: [
    'Morfologi tetap; tanpa variabilitas detak, aritmia, atau artefak gerak nyata.',
    'Sadapan selain II berasal dari model dipol tunggal yang disederhanakan (bukan volume conductor); V1–V6 hanya perkiraan kualitatif.',
    'Tidak cocok untuk menguji algoritma klinis.',
  ],
  filterAdvice: 'Energi QRS membentang hingga ±40–100 Hz dan segmen ST/T berubah paling lambat (&lt; 1 Hz): LPF di bawah ≈ 40 Hz memotong puncak R, HPF di atas ≈ 0,5 Hz mendistorsi segmen ST. Pita monitor umum: 0,5–40 Hz.',
  recommendReasons: [
    ['Gain ×1000', 'R ≈ 1 mV menjadi ≈ 1 V: memakai separuh rentang ADC ±2 V dan menyisakan ruang untuk baseline wander serta noise sebelum saturasi.'],
    ['BPF 0,5–40 Hz', 'Pita monitor: HPF 0,5 Hz menekan baseline wander, LPF 40 Hz menekan noise HF dan sebagian 50 Hz, sambil mempertahankan bentuk QRS (puncak R ±95 %). Untuk EKG diagnostik dipakai 0,05–150 Hz.'],
    ['fs 250 Hz + anti-aliasing', 'Nyquist 125 Hz jauh di atas pita 40 Hz; AA LPF orde 8 (fc 100 Hz) meredam noise pita lebar sebelum sampling, tetapi tidak total: ≈ −15,6 dB di Nyquist (125 Hz) dan baru ≈ −48 dB di 200 Hz (0,8·fs), sehingga komponen di antaranya masih dapat terlipat sebagian. Satu QRS terwakili ±25 sampel.'],
    ['12 bit, ±2 V', 'LSB 0,98 mV di keluaran ≈ 0,98 µV dirujuk ke elektroda — jauh di bawah amplitudo gelombang P (±0,15 mV). Laju data 250 × 12 = 3.000 bit/s.'],
  ],
};
