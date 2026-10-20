/**
 * amplifier.js — Tahap 2: penguat instrumentasi (model ideal + saturasi).
 *
 * Model: y = G · x, lalu hard clipping pada ±V_sat (rel catu daya op-amp).
 * Tidak memodelkan CMRR, offset, atau bandwidth terbatas — sengaja disederhanakan
 * agar efek gain dan saturasi terlihat jelas.
 *
 * Fungsi murni: masukan tidak diubah, keluaran berupa objek baru.
 */

/** Tegangan saturasi keluaran (V). */
export const V_SAT = 2.0;

/** Pilihan gain cepat. */
export const GAIN_PRESETS = Object.freeze([10, 100, 1000]);

export const DEFAULT_AMP_PARAMS = Object.freeze({ gain: 1000, vSat: V_SAT });

/** Hard clipping satu nilai ke rentang [-vSat, +vSat]. */
export function clip(v, vSat) {
  return v > vSat ? vSat : v < -vSat ? -vSat : v;
}

/**
 * Menguatkan sinyal dan menerapkan hard clipping.
 * @param {Float64Array} x  sinyal masukan (V)
 * @param {{gain:number, vSat?:number}} params
 * @returns {{
 *   y: Float64Array, gain: number, vSat: number,
 *   clippedCount: number, clippedPercent: number, saturated: boolean,
 *   vppOut: number, vppIdeal: number, maxGainNoClip: number
 * }}
 */
export function amplify(x, { gain = DEFAULT_AMP_PARAMS.gain, vSat = V_SAT } = {}) {
  const n = x.length;
  const y = new Float64Array(n);
  let clipped = 0;
  let outMin = Infinity, outMax = -Infinity;
  let inMin = Infinity, inMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    if (xi < inMin) inMin = xi;
    if (xi > inMax) inMax = xi;
    const ideal = gain * xi;
    const v = clip(ideal, vSat);
    if (v !== ideal) clipped++;
    y[i] = v;
    if (v < outMin) outMin = v;
    if (v > outMax) outMax = v;
  }
  const peakIn = Math.max(Math.abs(inMin), Math.abs(inMax));
  return {
    y,
    gain,
    vSat,
    clippedCount: clipped,
    clippedPercent: n ? (100 * clipped) / n : 0,
    saturated: clipped > 0,
    vppOut: n ? outMax - outMin : 0,
    // Vpp yang seharusnya muncul seandainya penguat tidak saturasi.
    vppIdeal: n ? gain * (inMax - inMin) : 0,
    // Gain terbesar yang masih menjaga |y| ≤ vSat untuk sinyal ini.
    maxGainNoClip: peakIn > 0 ? vSat / peakIn : Infinity,
  };
}
