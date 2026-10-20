/**
 * signal.js — Tahap 1: pembangkit sinyal "analog".
 *
 * Domain analog disimulasikan dengan laju sampel sangat tinggi (10 kHz) sehingga,
 * relatif terhadap pita ECG (0,05–150 Hz) dan ADC yang akan disimulasikan nanti,
 * sinyal ini dapat dianggap kontinu.
 *
 * Semua fungsi di sini MURNI: keluaran hanya bergantung pada argumen, tidak ada
 * state global yang diubah. Noise acak memakai PRNG ber-seed agar hasil deterministik
 * (plot tidak "bergetar" setiap slider digeser, dan pengujian dapat diulang).
 *
 * Satuan internal: detik (s) dan volt (V). 1 mV = 1e-3 V.
 */

/** Laju sampel domain "analog" (Hz). */
export const FS_ANALOG = 10000;

/**
 * Model gelombang PQRST: setiap gelombang adalah satu gaussian
 *   a · exp(-(t - (tR + offset))² / (2σ²))
 * offset relatif terhadap puncak R (s), amplitudo relatif terhadap R = 1 mV.
 */
export const ECG_WAVES = Object.freeze([
  Object.freeze({ nama: 'P', offset: -0.200, amp: 0.15, sigma: 0.025 }),
  Object.freeze({ nama: 'Q', offset: -0.035, amp: -0.12, sigma: 0.008 }),
  Object.freeze({ nama: 'R', offset: 0.000, amp: 1.00, sigma: 0.009 }),
  Object.freeze({ nama: 'S', offset: 0.035, amp: -0.25, sigma: 0.008 }),
  Object.freeze({ nama: 'T', offset: 0.280, amp: 0.30, sigma: 0.045 }),
]);

/** Waktu puncak R pertama (s) — memberi ruang agar gelombang P pertama terlihat. */
export const FIRST_R_TIME = 0.3;

/** Parameter bawaan sumber sinyal dan gangguan. */
export const DEFAULT_SIGNAL_PARAMS = Object.freeze({
  source: 'ecg',          // 'ecg' | 'sine'
  duration: 5,            // s
  fs: FS_ANALOG,          // Hz
  hr: 72,                 // bpm
  rAmp: 1e-3,             // V (≈ 1 mV)
  sineFreq: 10,           // Hz
  sineAmp: 1e-3,          // V (amplitudo puncak)
  disturbances: Object.freeze({
    baseline: Object.freeze({ on: false, amp: 0.3e-3, freq: 0.3 }),   // baseline wander
    mains: Object.freeze({ on: false, amp: 0.1e-3, freq: 50 }),       // interferensi jala-jala
    hf: Object.freeze({ on: false, rms: 0.03e-3, seed: 12345 }),      // noise putih (HF)
    alias: Object.freeze({ on: false, amp: 0.1e-3, freq: 80 }),       // komponen penyebab aliasing
  }),
});

/** Jumlah sampel untuk durasi dan fs tertentu. */
export function sampleCount(duration, fs) {
  return Math.max(1, Math.round(duration * fs));
}

/** Sumbu waktu t[i] = i / fs. */
export function makeTimeAxis(duration, fs) {
  const n = sampleCount(duration, fs);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i / fs;
  return t;
}

/**
 * ECG sintetis sebagai jumlah gaussian P, Q, R, S, T yang diulang tiap interval RR.
 * @returns {Float64Array} sinyal dalam volt
 */
export function synthEcg({ duration, fs, hr = 72, rAmp = 1e-3 }) {
  const n = sampleCount(duration, fs);
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
        const d = i / fs - c;
        x[i] += a * Math.exp(-d * d * k);
      }
    }
  }
  return x;
}

/** Sinus uji: A · sin(2π f t). */
export function synthSine({ duration, fs, freq = 10, amp = 1e-3 }) {
  const n = sampleCount(duration, fs);
  const x = new Float64Array(n);
  const w = 2 * Math.PI * freq;
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(w * (i / fs));
  return x;
}

/** PRNG mulberry32: generator bilangan acak [0,1) ber-seed, ringan dan deterministik. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Noise putih gaussian (Box–Muller) dengan RMS tertentu. */
export function whiteNoise(n, rms, seed) {
  const rand = mulberry32(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    out[i] = rms * r * Math.cos(2 * Math.PI * u2);
    if (i + 1 < n) out[i + 1] = rms * r * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/**
 * Menjumlahkan seluruh gangguan yang aktif menjadi satu sinyal noise.
 * Fase awal tiap sinus dipilih tetap (bukan nol) supaya tidak semua gangguan
 * berawal di titik nol secara bersamaan.
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
  return noise;
}

/**
 * Membangkitkan sinyal masukan lengkap = sumber bersih + gangguan.
 * @returns {{t, fs, clean, noise, x, params}}
 */
export function generateSignal(params) {
  const p = { ...DEFAULT_SIGNAL_PARAMS, ...params };
  const d = { ...DEFAULT_SIGNAL_PARAMS.disturbances, ...(params && params.disturbances) };
  const t = makeTimeAxis(p.duration, p.fs);
  const clean = p.source === 'sine'
    ? synthSine({ duration: p.duration, fs: p.fs, freq: p.sineFreq, amp: p.sineAmp })
    : synthEcg({ duration: p.duration, fs: p.fs, hr: p.hr, rAmp: p.rAmp });
  const noise = makeDisturbance(t.length, p.fs, d);
  const x = new Float64Array(t.length);
  for (let i = 0; i < x.length; i++) x[i] = clean[i] + noise[i];
  return { t, fs: p.fs, clean, noise, x, params: { ...p, disturbances: d } };
}

/** Statistik dasar: min, max, Vpp, rerata, RMS. */
export function signalStats(x) {
  let min = Infinity, max = -Infinity, sum = 0, sum2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sum2 += v * v;
  }
  const n = x.length || 1;
  return { min, max, vpp: max - min, mean: sum / n, rms: Math.sqrt(sum2 / n) };
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
