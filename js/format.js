/**
 * format.js — Pemformatan angka bergaya Indonesia (koma desimal, titik ribuan).
 * Murni, tanpa DOM; dipakai oleh ui.js dan oleh teks info tiap profil sinyal.
 */

export function fmt(v, digits = 2) {
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '−∞';
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString('id-ID', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Tiga angka penting: 40 → "40,0", 0.5 → "0,500", 100 → "100". */
export function fmtSig(v) {
  if (!Number.isFinite(v) || v <= 0) return fmt(v, 2);
  v = Number(v.toPrecision(3)); // 9,998 → 10,0 (bukan 10,00)
  return fmt(v, Math.min(3, Math.max(0, 2 - Math.floor(Math.log10(v)))));
}

/** Dua desimal tanpa nol di belakang: 2 → "2", 2,5 → "2,5", 2,25 → "2,25". */
export function fmtTrim(v) {
  return fmt(v, 2).replace(/,?0+$/, '');
}

export const mV = (v, d = 2) => `${fmt(v * 1e3, d)} mV`;
export const ms = (v) => `${fmt(v * 1e3, 0)} ms`;
export const hz = (v) => `${fmtSig(v)} Hz`;
export const sig3 = (v) => Number(v.toPrecision(3));

/** Tegangan dengan satuan otomatis V / mV / µV / nV. */
export function fmtVolt(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '–';
  if (a >= 0.1) return `${fmt(v, 3)} V`;
  if (a >= 1e-4) return `${fmt(v * 1e3, 3)} mV`;
  if (a >= 1e-6) return `${fmt(v * 1e6, 2)} µV`;
  return `${fmt(v * 1e9, 2)} nV`;
}

/**
 * Satuan sumbu plot tegangan berdasarkan puncak sinyal.
 * @returns {{ k: number, unit: string }}  k = faktor pengali dari volt
 */
export function voltUnit(peak) {
  if (peak < 1e-4) return { k: 1e6, unit: 'µV' };
  if (peak < 0.1) return { k: 1e3, unit: 'mV' };
  return { k: 1, unit: 'V' };
}
