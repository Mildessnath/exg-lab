/**
 * profiles/common.js — Utilitas sintesis yang dipakai bersama oleh signal.js dan
 * seluruh profil sinyal. Dipisah dari signal.js agar profil dapat mengimpornya
 * tanpa impor melingkar (signal.js mengimpor registri profil).
 *
 * Semua fungsi MURNI dan deterministik (PRNG ber-seed): pemanggilan yang sama
 * selalu menghasilkan deretan angka yang sama persis.
 */

import { designHighpass, designLowpass, applyBiquad } from '../filters.js';
import { butterworthQs } from '../adc.js';

/** Laju sampel domain "analog" (Hz). */
export const FS_ANALOG = 10000;

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

/** Nilai mutlak terbesar. */
export function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}

/** Skala sinyal in-place agar RMS-nya = target. Sinyal nol dibiarkan. */
function normalizeRms(x, target = 1) {
  let s2 = 0;
  for (let i = 0; i < x.length; i++) s2 += x[i] * x[i];
  const rms = Math.sqrt(s2 / (x.length || 1));
  if (rms > 0) { const k = target / rms; for (let i = 0; i < x.length; i++) x[i] *= k; }
  return x;
}

/**
 * Derau gaussian berpita [fLow, fHigh] dengan RMS = 1.
 * Dibuat dari derau putih lewat HPF + LPF Butterworth orde `order` (kaskade biquad),
 * jadi pita ini "lunak" (kemiringan 6·order dB/oktaf), bukan dinding bata.
 * Sebelum transien filter meluruh, `lead` detik awal dibuang agar keluaran sudah
 * stasioner sejak t = 0.
 */
export function bandNoise(n, fs, { fLow, fHigh, seed, order = 4 }) {
  const leadSec = fLow > 0 ? Math.min(8, Math.max(0.3, 3 / fLow)) : 0.3;
  const lead = Math.round(leadSec * fs);
  let y = whiteNoise(n + lead, 1, seed);
  const qs = butterworthQs(order);
  if (fLow > 0) for (const q of qs) y = applyBiquad(y, designHighpass(fLow, fs, q), 0);
  if (fHigh < 0.45 * fs) for (const q of qs) y = applyBiquad(y, designLowpass(fHigh, fs, q), 0);
  return normalizeRms(y.slice(lead), 1);
}

/**
 * Derau "pink" (daya ∝ 1/f) dengan algoritma Voss–McCartney: jumlah K sumber acak
 * yang diperbarui pada laju fs/2^k, ditambah satu derau putih. Spektrumnya hanya
 * mendekati 1/f (simpangan ±1–2 dB), cukup untuk latar EEG sintetis. RMS = 1.
 */
export function pinkNoise(n, seed, rows = 16) {
  const rand = mulberry32(seed);
  const vals = new Float64Array(rows);
  let sum = 0;
  for (let k = 0; k < rows; k++) { vals[k] = rand() * 2 - 1; sum += vals[k]; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // baris yang diperbarui = jumlah nol di akhir biner (i+1)
    let c = i + 1, k = 0;
    while ((c & 1) === 0 && k < rows - 1) { c >>= 1; k++; }
    const nv = rand() * 2 - 1;
    sum += nv - vals[k];
    vals[k] = nv;
    out[i] = sum + (rand() * 2 - 1);
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= mean;
  return normalizeRms(out, 1);
}

/**
 * Deret pulsa gaussian: amp·exp(−(t − tc)²/2σ²) untuk tc = first + k·period.
 * Dipakai untuk artefak kedip mata (EEG) dan kedip pada EOG.
 */
export function pulseTrain(t, { amp, period, first, sigma, fs: fsIn }) {
  const n = t.length;
  const out = new Float64Array(n);
  if (!(period > 0) || !(amp !== 0)) return out;
  const fs = fsIn ?? (n > 1 ? 1 / (t[1] - t[0]) : 1);
  const tEnd = t[n - 1];
  const k = 1 / (2 * sigma * sigma);
  for (let tc = first; tc - 5 * sigma <= tEnd; tc += period) {
    const i0 = Math.max(0, Math.ceil((tc - 5 * sigma) * fs));
    const i1 = Math.min(n - 1, Math.floor((tc + 5 * sigma) * fs));
    for (let i = i0; i <= i1; i++) {
      const d = t[i] - tc;
      out[i] += amp * Math.exp(-d * d * k);
    }
  }
  return out;
}

/** Turunkan nilai bawaan (satuan SI) dari daftar kontrol profil (satuan tampilan). */
export function defaultsFromControls(controls) {
  const out = {};
  for (const c of controls) out[c.key] = c.type === 'range' ? c.def * (c.toSI ?? 1) : c.def;
  return out;
}
