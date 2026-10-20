/**
 * validation.js — Validasi matematis: membandingkan rumus teori dengan hasil
 * simulasi yang benar-benar dijalankan (bukan rumus yang sama dihitung dua kali).
 *
 *  (a) Amplifier : Vout = G·Vin dengan batas saturasi ±Vsat
 *  (b) Filter RC : fc = 1/(2πRC) vs titik −3 dB terukur (respons frekuensi dan
 *                  simulasi domain waktu dengan sinus di fc)
 *  (c) ADC       : level = 2^N, LSB = Vrange/2^N, error maks = LSB/2,
 *                  RMS = LSB/√12, SQNR = 6,02N + 1,76 dB
 *
 * Semua fungsi murni. Setiap baris hasil: { nama, rumus, teori, simulasi, satuan, tol, ok }.
 */

import { rcCutoff, designRcLowpass, applyBiquad, magnitudeDb, measureMinus3dB } from './filters.js';
import { quantize } from './adc.js';

/** Baris perbandingan dengan selisih absolut & relatif dan status lolos toleransi. */
function row(nama, rumus, teori, simulasi, satuan, { tolAbs = 0, tolRel = 0, mode = 'eq' } = {}) {
  const diff = simulasi - teori;
  const rel = teori !== 0 ? diff / Math.abs(teori) : 0;
  // mode 'le': simulasi cukup ≤ teori (mis. error maks ≤ LSB/2)
  const ok = mode === 'le'
    ? simulasi <= teori * (1 + 1e-9) + tolAbs
    : Math.abs(diff) <= Math.max(tolAbs, tolRel * Math.abs(teori)) + 1e-12;
  return { nama, rumus, teori, simulasi, satuan, diff, rel, ok, mode, tolAbs, tolRel };
}

/** Amplitudo komponen f (s.d. korelasi sin/cos), dipakai untuk simulasi domain waktu. */
function toneAmplitude(x, fs, f, i0 = 0) {
  let re = 0, im = 0;
  for (let i = i0; i < x.length; i++) {
    const ph = (2 * Math.PI * f * i) / fs;
    re += x[i] * Math.cos(ph);
    im += x[i] * Math.sin(ph);
  }
  return (2 * Math.hypot(re, im)) / (x.length - i0);
}

// ---------------------------------------------------------------------------
// (a) Amplifier
// ---------------------------------------------------------------------------

/**
 * @param {Float64Array} x   masukan amplifier (V)
 * @param {object} amp       hasil amplify()
 */
export function validateAmplifier(x, amp) {
  const { gain: g, vSat } = amp;
  // Sampel uji: sampel dengan |Vin| terbesar
  let iPk = 0;
  for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[iPk])) iPk = i;
  const vin = x[iPk];
  const ideal = g * vin;
  const saturated = Math.abs(ideal) > vSat;
  const vOutTheory = saturated ? Math.sign(ideal) * vSat : ideal;
  let inMin = Infinity, inMax = -Infinity;
  for (const v of x) { if (v < inMin) inMin = v; if (v > inMax) inMax = v; }
  const clipV = (v) => Math.max(-vSat, Math.min(vSat, v));
  return {
    vin, ideal, saturated, vSat, gain: g,
    rows: [
      row('Vout pada sampel |Vin| maks', saturated ? `±Vsat (karena |G·Vin| = ${Math.abs(ideal).toFixed(3).replace('.', ',')} V > ${vSat} V)` : 'G·Vin',
        vOutTheory, amp.y[iPk], 'V', { tolAbs: 1e-12 }),
      row('Vpp keluaran', 'clip(G·Vmaks) − clip(G·Vmin)', clipV(g * inMax) - clipV(g * inMin), amp.vppOut, 'V', { tolAbs: 1e-12 }),
      row('|Vout| maks ≤ Vsat', '|Vout| ≤ Vsat', vSat, amp.y.reduce((m, v) => Math.max(m, Math.abs(v)), 0), 'V', { mode: 'le' }),
    ],
  };
}

// ---------------------------------------------------------------------------
// (b) Filter RC
// ---------------------------------------------------------------------------

/**
 * @param {number} r  resistansi (Ω)
 * @param {number} c  kapasitansi (F)
 * @param {number} fs laju sampel domain analog (Hz)
 */
export function validateRc(r, c, fs) {
  const fc = rcCutoff(r, c);
  const sec = designRcLowpass(fc, fs);
  const m3 = measureMinus3dB([sec], fs);
  const f3 = m3.freqs[0] ?? NaN;
  // Simulasi domain waktu: sinus ber-amplitudo 1 pada fc melalui filter;
  // ukur amplitudo keluaran setelah transien (≥ 5τ) lewat.
  const tau = r * c;
  // fc di atas ±0,45·fs tidak dapat direpresentasikan di domain simulasi (Nyquist 5 kHz).
  if (fc >= 0.45 * fs) {
    const na = (nama, rumus, teori, satuan) => ({ nama, rumus, teori, simulasi: NaN, satuan, diff: NaN, rel: NaN, ok: false, na: true });
    return {
      r, c, fc, tau, outOfRange: true,
      rows: [
        na('Frekuensi cutoff −3 dB', 'fc = 1/(2πRC)', fc, 'Hz'),
        na('Gain pada fc (respons frekuensi)', '20·log10(1/√2)', -10 * Math.log10(2), 'dB'),
        na('Gain pada fc (simulasi sinus)', '20·log10(1/√2)', -10 * Math.log10(2), 'dB'),
      ],
    };
  }
  const fsim = fc;
  const settle = Math.ceil(Math.max(5 * tau, 2 / fsim) * fs);
  const periods = Math.max(10, Math.ceil(fsim * 0.5));
  const nMeasure = Math.round((periods / fsim) * fs);
  const n = Math.min(settle + nMeasure, 3_000_000);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * fsim * i) / fs);
  const y = applyBiquad(x, sec, 0);
  const gainDbTime = 20 * Math.log10(toneAmplitude(y, fs, fsim, Math.min(settle, n - 1)));
  return {
    r, c, fc, tau, outOfRange: false,
    rows: [
      row('Frekuensi cutoff −3 dB', 'fc = 1/(2πRC) vs −3 dB terukur dari |H(f)|', fc, f3, 'Hz', { tolRel: 0.001 }),
      row('Gain pada fc (respons frekuensi)', '20·log10(1/√2)', -10 * Math.log10(2), magnitudeDb([sec], fs, fc), 'dB', { tolAbs: 0.3 }),
      row('Gain pada fc (simulasi sinus)', '20·log10(1/√2)', -10 * Math.log10(2), gainDbTime, 'dB', { tolAbs: 0.3 }),
    ],
  };
}

// ---------------------------------------------------------------------------
// (c) ADC
// ---------------------------------------------------------------------------

/**
 * Validasi ADC N-bit, rentang ±vRef, dengan dua sinyal uji yang benar-benar
 * dikuantisasi: (1) ramp lambat yang menyapu seluruh rentang → level & LSB;
 * (2) sinus skala penuh dengan frekuensi tak-sebanding fs → error & SQNR.
 */
export function validateAdc(bits, vRef) {
  const levelsT = 2 ** bits;
  const lsbT = (2 * vRef) / levelsT;

  // (1) Ramp: 4 titik per level, dari −vRef hingga +vRef
  const nRamp = Math.min(levelsT * 4 + 1, 300_001);
  const ramp = new Float64Array(nRamp);
  for (let i = 0; i < nRamp; i++) ramp[i] = -vRef + (2 * vRef * i) / (nRamp - 1);
  const qr = quantize(ramp, { bits, vRef });
  const distinct = new Set(qr.codes).size;
  let xqMin = Infinity, xqMax = -Infinity;
  for (const v of qr.xq) { if (v < xqMin) xqMin = v; if (v > xqMax) xqMax = v; }
  const lsbSim = (xqMax - xqMin) / (distinct - 1);

  // (2) Sinus skala penuh: amplitudo terbesar yang belum ter-clip. Level tertinggi
  // mid-tread = vRef − Δ, ambang clip = vRef − Δ/2 → A = vRef − 0,501·Δ.
  // fs uji 1 kHz, 20 s, f = 7,31 Hz (tak sebanding fs agar error tidak periodik).
  const fsT = 1000, fT = 7.31;
  const nS = 20 * fsT;
  const sine = new Float64Array(nS);
  const aT = vRef - 0.501 * lsbT;
  for (let i = 0; i < nS; i++) sine[i] = aT * Math.sin((2 * Math.PI * fT * i) / fsT);
  const qs = quantize(sine, { bits, vRef });

  // RMS = LSB/√12 dan 6,02N + 1,76 menganggap error terdistribusi seragam dan tak
  // berkorelasi dengan sinyal — hanya berlaku bila sinyal melintasi banyak level.
  // Untuk N < 6 baris tersebut tetap dihitung, tetapi ditandai "asumsi tidak berlaku".
  const uniformOk = bits >= 6;
  const assume = (r) => ({ ...r, assumption: !uniformOk });
  return {
    bits, vRef, ramp: qr, sine: qs, uniformOk,
    rows: [
      row('Jumlah level', '2^N', levelsT, distinct, '', { tolAbs: 0 }),
      row('LSB', 'Vrange / 2^N = 2·Vref / 2^N', lsbT, lsbSim, 'V', { tolRel: 1e-9 }),
      row('Error maks (ramp)', 'LSB / 2', lsbT / 2, qr.errMax, 'V', { mode: 'le' }),
      assume(row('Error RMS (sinus skala penuh)', 'LSB / √12', lsbT / Math.sqrt(12), qs.errRms, 'V', { tolRel: 0.05 })),
      assume(row('SQNR (sinus skala penuh)', '6,02·N + 1,76', 6.02 * bits + 1.76, qs.sqnrMeasured, 'dB', { tolAbs: 1 })),
    ],
  };
}

/** Sinyal pipeline sendiri: SQNR terukur vs P_x/(Δ²/12) (bukan rumus skala penuh). */
export function validateAdcSignal(quant) {
  return [
    row('Error maks (sinyal pipeline)', 'LSB / 2', quant.errMaxTheory, quant.errMax, 'V', { mode: 'le' }),
    row('Error RMS (sinyal pipeline)', 'LSB / √12', quant.errRmsTheory, quant.errRms, 'V', { tolRel: 0.1 }),
    row('SQNR (sinyal pipeline)', '10·log10(Px / (LSB²/12))', quant.sqnrTheorySignal, quant.sqnrMeasured, 'dB', { tolAbs: 1.5 }),
  ];
}
