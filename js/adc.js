/**
 * adc.js — Tahap 4–5: sampling dan kuantisasi (ADC).
 *
 * Masukan ADC adalah sinyal "analog" (domain 10 kHz) keluaran tahap filter.
 * Urutan di dalam ADC:
 *
 *   [LPF anti-aliasing opsional] → sampling (fs ADC) → kuantisasi N-bit
 *
 * Model:
 *  - Sampling ideal (sample-and-hold sesaat, tanpa jitter): x[n] = x(n/fs).
 *    Bila n/fs tidak jatuh tepat di grid 10 kHz, nilainya diinterpolasi linear;
 *    galat interpolasi ini jauh di bawah 1 LSB 12-bit untuk sinyal ECG.
 *  - Kuantisasi MID-TREAD: ada level tepat di 0 V (kode 0), pembulatan ke level
 *    terdekat. Rentang bipolar ±V_ref dibagi 2^N level, LSB Δ = 2·V_ref / 2^N.
 *    Kode integer two's complement: −2^(N−1) … 2^(N−1) − 1, sehingga level
 *    tertinggi = V_ref − Δ (asimetri satu LSB yang lazim pada ADC bipolar).
 *  - Masukan di luar rentang di-clip ke kode minimum/maksimum.
 *
 * Semua fungsi murni.
 */

import { designLowpass, applyCascade, amplitudeSpectrum } from './filters.js';

export const FS_PRESETS = Object.freeze([100, 250, 500]);
export const BIT_PRESETS = Object.freeze([2, 4, 8, 12]);

export const DEFAULT_ADC_PARAMS = Object.freeze({
  fs: 250,          // Hz
  bits: 12,
  vRef: 2,          // V → rentang ±2 V
  antiAlias: false, // LPF anti-aliasing sebelum sampling
  aaOrder: 8,       // orde Butterworth (genap → kaskade biquad)
  aaRatio: 0.4,     // fc = 0,4·fs (sedikit di bawah Nyquist 0,5·fs)
});

// ---------------------------------------------------------------------------
// LPF anti-aliasing
// ---------------------------------------------------------------------------

/**
 * Faktor Q tiap biquad untuk Butterworth orde genap n:
 *   Q_k = 1 / (2·cos θ_k),  θ_k = (2k − 1)·π / (2n),  k = 1 … n/2
 * Kaskade biquad dengan Q ini (fc sama) menghasilkan respons Butterworth orde n.
 */
export function butterworthQs(order) {
  const qs = [];
  for (let k = 1; k <= order / 2; k++) qs.push(1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order))));
  return qs;
}

/**
 * LPF anti-aliasing Butterworth orde 8 (bawaan), fc = 0,4·fs ADC.
 * Kemiringan asimtotik orde 8 = 48 dB/oktaf, tetapi redaman di dekat fc masih
 * landai: −3 dB di fc (0,4·fs), ≈ −15,6 dB di Nyquist (0,5·fs), ≈ −28 dB di 0,6·fs
 * dan baru ≈ −48 dB di 0,8·fs (satu oktaf di atas fc). Jadi komponen di antara
 * fs/2 dan ±0,8·fs masih dapat lolos sebagai alias yang terlihat. Orde 2
 * (12 dB/oktaf) jauh lebih landai lagi.
 * fc diletakkan di bawah fs/2 karena filter nyata butuh pita transisi.
 */
export function designAntiAlias(fsAdc, fsAnalog, { order = 8, ratio = 0.4 } = {}) {
  const fc = ratio * fsAdc;
  return { fc, order, sections: butterworthQs(order).map((q) => designLowpass(fc, fsAnalog, q)) };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Mencuplik sinyal domain analog (fsIn) pada laju fsOut.
 * @returns {{ y: Float64Array, fs: number, n: number }}
 */
export function sample(x, fsIn, fsOut) {
  const n = Math.max(1, Math.floor(((x.length - 1) * fsOut) / fsIn) + 1);
  const y = new Float64Array(n);
  const ratio = fsIn / fsOut;
  for (let k = 0; k < n; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const frac = pos - i;
    y[k] = frac === 0 || i + 1 >= x.length ? x[Math.min(i, x.length - 1)] : x[i] + frac * (x[i + 1] - x[i]);
  }
  return { y, fs: fsOut, n };
}

/** Frekuensi alias setelah sampling: |f − k·fs| dengan k = round(f/fs). */
export function aliasFrequency(f, fs) {
  const k = Math.round(f / fs);
  return { fAlias: Math.abs(f - k * fs), k };
}

// ---------------------------------------------------------------------------
// Kuantisasi
// ---------------------------------------------------------------------------

/**
 * Kuantisasi mid-tread N-bit pada rentang ±vRef.
 * Statistik error dihitung hanya pada sampel yang TIDAK ter-clip (error granular);
 * sampel ter-clip dilaporkan terpisah karena errornya bisa jauh melebihi Δ/2.
 */
export function quantize(x, { bits = 12, vRef = 2 } = {}) {
  const levels = 2 ** bits;
  const lsb = (2 * vRef) / levels;
  const codeMin = -(levels / 2);
  const codeMax = levels / 2 - 1;
  const n = x.length;
  const codes = new Int32Array(n);
  const xq = new Float64Array(n);
  const err = new Float64Array(n);
  const clipped = new Uint8Array(n);
  let clippedCount = 0, errMax = 0, sumE2 = 0, sumX2 = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    let c = Math.round(x[i] / lsb) || 0; // `|| 0` mengubah −0 menjadi 0
    if (c > codeMax) { c = codeMax; clipped[i] = 1; } else if (c < codeMin) { c = codeMin; clipped[i] = 1; }
    codes[i] = c;
    xq[i] = c * lsb;
    err[i] = xq[i] - x[i];
    if (clipped[i]) { clippedCount++; continue; }
    const ae = Math.abs(err[i]);
    if (ae > errMax) errMax = ae;
    sumE2 += err[i] * err[i];
    sumX2 += x[i] * x[i];
    cnt++;
  }
  const errRms = cnt ? Math.sqrt(sumE2 / cnt) : NaN;
  return {
    bits, vRef, levels, lsb, codeMin, codeMax,
    codes, xq, err, clipped, clippedCount,
    errMax, errRms,
    errMaxTheory: lsb / 2,
    errRmsTheory: lsb / Math.sqrt(12),
    // SQNR terukur: daya sinyal / daya error (sampel tidak ter-clip).
    // NaN bila semua sampel ter-clip (tidak ada sampel yang bisa diukur);
    // Infinity hanya bila ada sampel terukur tetapi seluruhnya tepat di level.
    sqnrMeasured: cnt === 0 ? NaN : (sumE2 > 0 ? 10 * Math.log10(sumX2 / sumE2) : Infinity),
    // SQNR teoretis untuk SINYAL INI: P_x / (Δ²/12) — memperhitungkan seberapa
    // penuh rentang ADC terpakai.
    sqnrTheorySignal: cnt && sumX2 > 0 ? 10 * Math.log10((sumX2 / cnt) / ((lsb * lsb) / 12)) : -Infinity,
    // SQNR teoretis sinus skala penuh: 6,02·N + 1,76 dB
    sqnrTheoryFullScale: sqnrFullScale(bits),
  };
}

export function sqnrFullScale(bits) {
  return 6.02 * bits + 1.76;
}

/** Kode two's complement N-bit sebagai string biner. */
export function toBinary(code, bits) {
  const u = code < 0 ? code + 2 ** bits : code;
  return u.toString(2).padStart(bits, '0');
}

// ---------------------------------------------------------------------------
// Deteksi aliasing
// ---------------------------------------------------------------------------

/**
 * Fraksi daya sinyal analog yang berada di atas fs/2 (perkiraan dari spektrum
 * FFT). Inilah energi yang akan "terlipat" ke pita 0…fs/2 saat sampling.
 */
export function powerAboveNyquist(x, fsAnalog, fsAdc) {
  const { f, amp } = amplitudeSpectrum(x, fsAnalog);
  let total = 0, above = 0;
  for (let k = 1; k < f.length; k++) {
    const p = amp[k] * amp[k];
    total += p;
    if (f[k] > fsAdc / 2) above += p;
  }
  return total > 0 ? above / total : 0;
}

/**
 * Menilai komponen-komponen nada yang diketahui terhadap fs ADC.
 * @param {Array<{nama, f, amp}>} tones — amp = amplitudo di masukan ADC (V)
 * @param {number} threshold — amplitudo minimum agar alias dianggap terlihat (mis. Δ/2)
 */
export function analyzeAliasing(tones, fs, threshold = 0) {
  const nyq = fs / 2;
  return tones.map((t) => {
    const { fAlias, k } = aliasFrequency(t.f, fs);
    const above = t.f > nyq + 1e-9;
    const atNyquist = Math.abs(t.f - nyq) < 1e-9;
    return { ...t, fAlias, k, above, atNyquist, visible: (above || atNyquist) && t.amp > threshold };
  });
}

// ---------------------------------------------------------------------------
// Output digital
// ---------------------------------------------------------------------------

/**
 * CSV keluaran ADC: waktu (s), kode integer, tegangan rekonstruksi kode·Δ (V).
 * Pemisah koma dan titik desimal (konvensi CSV internasional, terbaca oleh
 * Python/MATLAB/Excel dengan pengaturan standar).
 */
export function adcToCsv(adc) {
  const { quant, sampled } = adc;
  const lines = ['waktu_s,kode_adc,tegangan_rekonstruksi_V'];
  for (let n = 0; n < quant.codes.length; n++) {
    lines.push(`${(n / sampled.fs).toFixed(6)},${quant.codes[n]},${Number(quant.xq[n].toPrecision(10))}`);
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Tahap ADC lengkap (untuk pipeline)
// ---------------------------------------------------------------------------

export function runAdc(x, fsAnalog, params = DEFAULT_ADC_PARAMS) {
  const p = { ...DEFAULT_ADC_PARAMS, ...params };
  const aa = p.antiAlias ? designAntiAlias(p.fs, fsAnalog, { order: p.aaOrder, ratio: p.aaRatio }) : null;
  const input = aa ? applyCascade(x, aa.sections) : x;
  const sampled = sample(input, fsAnalog, p.fs);
  const quant = quantize(sampled.y, { bits: p.bits, vRef: p.vRef });
  return { params: p, aa, input, fsAnalog, sampled, quant };
}
