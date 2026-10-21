/**
 * profiles/disturbances.js — Pabrik definisi gangguan untuk profil sinyal.
 *
 * Satu definisi gangguan = toggle + slider. Nilai slider dinyatakan dalam satuan
 * tampilan (mV, µV, Hz, s, …) dan dikonversi ke SI lewat `toSI`. Sifat gangguan
 * yang tidak dapat diatur (mis. frekuensi baseline 0,3 Hz) ada di `fixed`.
 *
 * Pembangkitan sinyal gangguan sendiri ada di makeDisturbance (signal.js); berkas
 * ini hanya mendeskripsikan kontrol dan rentangnya per profil.
 */

export const U = Object.freeze({
  mV: Object.freeze({ unit: 'mV', toSI: 1e-3 }),
  uV: Object.freeze({ unit: 'µV', toSI: 1e-6 }),
  uVs: Object.freeze({ unit: 'µV/s', toSI: 1e-6 }),
  Hz: Object.freeze({ unit: 'Hz', toSI: 1 }),
  s: Object.freeze({ unit: 's', toSI: 1 }),
});

/** Spesifikasi satu slider. */
export function slider(key, label, min, max, step, def, u, digits = 2) {
  return { key, label, min, max, step, def, unit: u.unit, toSI: u.toSI, digits };
}

/** Baseline wander 0,3 Hz (frekuensi tetap). */
export const baseline = (u, max, def, step = 0.01, digits = 2) => ({
  id: 'baseline', label: 'Baseline wander (0,3 Hz)', short: 'baseline 0,3 Hz',
  fixed: { freq: 0.3 },
  sliders: [slider('amp', 'Amplitudo', 0, max, step, def, u, digits)],
});

/** Interferensi jala-jala 50 Hz (frekuensi tetap). */
export const mains = (u, max, def, step = 0.01, digits = 2, label = 'Interferensi jala-jala 50 Hz') => ({
  id: 'mains', label, short: 'jala-jala 50 Hz',
  fixed: { freq: 50 },
  sliders: [slider('amp', 'Amplitudo', 0, max, step, def, u, digits)],
});

/** Noise putih pita lebar (RMS). */
export const hf = (u, max, def, step = 0.005, digits = 3) => ({
  id: 'hf', label: 'Noise HF (putih)', short: 'noise HF',
  fixed: { seed: 12345 },
  sliders: [slider('rms', 'RMS', 0, max, step, def, u, digits)],
});

/** Komponen penyebab aliasing: nada dengan frekuensi yang dapat diatur. */
export const alias = (u, maxAmp, defAmp, defFreq, step = 0.01, digits = 2) => ({
  id: 'alias', label: 'Komponen aliasing', short: 'alias',
  hint: 'Nada di atas frekuensi Nyquist ADC. Contoh: 80 Hz yang dicuplik pada 100 Hz akan muncul sebagai 20 Hz (Eksperimen 3).',
  sliders: [
    slider('freq', 'Frekuensi', 10, 3000, 1, defFreq, U.Hz, 0),
    slider('amp', 'Amplitudo', 0, maxAmp, step, defAmp, u, digits),
  ],
});

/** Artefak gerak EMG: komponen frekuensi rendah tak beraturan. */
export const motion = (u, max, def, step, digits) => ({
  id: 'motion', label: 'Artefak gerak (frekuensi rendah)', short: 'artefak gerak',
  sliders: [
    slider('amp', 'Amplitudo', 0, max, step, def, u, digits),
    slider('freq', 'Frekuensi dasar', 0.5, 10, 0.5, 2, U.Hz, 1),
  ],
});

/** Artefak kedip mata: pulsa gaussian berulang (≈ 140 ms lebar total). */
export const blink = (u, max, def, step, digits) => ({
  id: 'blink', label: 'Artefak kedip mata', short: 'kedip mata',
  sliders: [
    slider('amp', 'Amplitudo', 0, max, step, def, u, digits),
    slider('interval', 'Selang kedip', 1, 10, 0.5, 4, U.s, 1),
  ],
});

/** Drift DC: perubahan potensial elektroda yang lambat (rampa linear). */
export const drift = (u, max, def, step, digits) => ({
  id: 'drift', label: 'Drift DC', short: 'drift DC',
  sliders: [slider('amp', 'Laju drift', 0, max, step, def, u, digits)],
});
