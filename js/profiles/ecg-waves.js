/**
 * profiles/ecg-waves.js — Konstanta gelombang PQRST (amplitudo, waktu, lebar gaussian).
 * Dipisah dari ecg.js agar model dipol (js/cardiac-dipole.js) dan profil ECG dapat
 * sama-sama memakainya tanpa impor melingkar.
 */

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
