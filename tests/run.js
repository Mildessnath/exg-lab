/**
 * tests/run.js — Pengujian unit tanpa dependensi.
 * Jalankan dari folder ecg-simulator:  node tests/run.js   (Node ≥ 22)
 */

import assert from 'node:assert/strict';
import {
  FS_ANALOG, DEFAULT_SIGNAL_PARAMS, synthEcg, synthSine, generateSignal, whiteNoise,
  signalStats, snrDb, detectRPeaks, ecgCharacteristics, makeDisturbance, mulberry32,
} from '../js/signal.js';
import { amplify, V_SAT } from '../js/amplifier.js';
import { runPipeline, DEFAULT_PARAMS, STAGE_DEFS } from '../js/pipeline.js';
import {
  FILTER_PRESETS, DEFAULT_FILTER_PARAMS, designFilter, magnitudeDb, measureMinus3dB,
  applyFilterSpec, applyCascade, amplitudeSpectrum, filterQualityMetrics,
} from '../js/filters.js';
import {
  sample, quantize, aliasFrequency, analyzeAliasing, designAntiAlias, runAdc, toBinary, adcToCsv,
} from '../js/adc.js';
import { rcCutoff, designRcLowpass, applyBiquad } from '../js/filters.js';
import { validateAmplifier, validateRc, validateAdc } from '../js/validation.js';
import { profileTests } from './profiles.test.js';
import { dipoleTests } from './dipole.test.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} ≉ ${b} (±${tol})`);

/** Amplitudo komponen frekuensi f dengan korelasi sinus/kosinus (DFT satu titik). */
function toneAmplitude(x, fs, f) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    const ph = 2 * Math.PI * f * i / fs;
    re += x[i] * Math.cos(ph);
    im += x[i] * Math.sin(ph);
  }
  return 2 * Math.hypot(re, im) / x.length;
}

console.log('signal.js');
test('fs analog 10 kHz dan jumlah sampel = durasi × fs', () => {
  assert.equal(FS_ANALOG, 10000);
  const s = generateSignal({ duration: 2 });
  assert.equal(s.x.length, 20000);
  assert.equal(s.t[1], 1 / 10000);
});
test('puncak R ≈ 1 mV', () => {
  const x = synthEcg({ duration: 5, fs: FS_ANALOG, hr: 72, rAmp: 1e-3 });
  close(signalStats(x).max, 1e-3, 0.01e-3, 'R max');
});
test('HR terdeteksi ≈ 72 bpm', () => {
  const x = synthEcg({ duration: 10, fs: FS_ANALOG, hr: 72 });
  const pk = detectRPeaks(x, FS_ANALOG);
  const rr = (pk[pk.length - 1] - pk[0]) / (pk.length - 1) / FS_ANALOG;
  close(60 / rr, 72, 0.1, 'HR');
  assert.equal(pk.length, 12); // R pertama di 0,3 s, RR 0,833 s → 12 denyut dalam 10 s
});
test('karakteristik morfologi dalam rentang fisiologis', () => {
  const c = ecgCharacteristics({ hr: 72 });
  close(c.rr, 0.8333, 0.001);
  assert.ok(c.qrsDur > 0.06 && c.qrsDur < 0.12, `QRS ${c.qrsDur}`);
  assert.ok(c.pr > 0.12 && c.pr < 0.22, `PR ${c.pr}`);
  assert.ok(c.qt > 0.3 && c.qt < 0.45, `QT ${c.qt}`);
});
test('sinus uji: frekuensi dan amplitudo benar', () => {
  const x = synthSine({ duration: 1, fs: FS_ANALOG, freq: 10, amp: 1e-3 });
  close(toneAmplitude(x, FS_ANALOG, 10), 1e-3, 1e-6);
  close(signalStats(x).vpp, 2e-3, 1e-6);
});
test('gangguan nonaktif → noise nol, SNR tak hingga', () => {
  const s = generateSignal(DEFAULT_SIGNAL_PARAMS);
  assert.equal(signalStats(s.noise).rms, 0);
  assert.equal(snrDb(s.clean, s.noise), Infinity);
});
test('interferensi 50 Hz dan komponen alias muncul pada frekuensinya', () => {
  const n = 20000;
  const d = {
    mains: { on: true, amp: 0.1e-3, freq: 50 },
    alias: { on: true, amp: 0.2e-3, freq: 80 },
  };
  const noise = makeDisturbance(n, FS_ANALOG, d);
  close(toneAmplitude(noise, FS_ANALOG, 50), 0.1e-3, 1e-6, '50 Hz');
  close(toneAmplitude(noise, FS_ANALOG, 80), 0.2e-3, 1e-6, '80 Hz');
  close(toneAmplitude(noise, FS_ANALOG, 120), 0, 1e-6, '120 Hz');
});
test('baseline wander 0,3 Hz', () => {
  const noise = makeDisturbance(100000, FS_ANALOG, { baseline: { on: true, amp: 0.3e-3, freq: 0.3 } });
  close(toneAmplitude(noise, FS_ANALOG, 0.3), 0.3e-3, 1e-6);
});
test('noise putih: RMS sesuai dan deterministik (seed)', () => {
  const a = whiteNoise(100000, 0.05e-3, 7);
  const b = whiteNoise(100000, 0.05e-3, 7);
  assert.deepEqual(a, b);
  close(signalStats(a).rms, 0.05e-3, 0.002e-3);
  close(signalStats(a).mean, 0, 0.002e-3);
});
test('generateSignal tidak mengubah objek parameter (fungsi murni)', () => {
  const p = structuredClone({ ...DEFAULT_SIGNAL_PARAMS, disturbances: { hf: { on: true, rms: 1e-5, seed: 1 } } });
  const before = JSON.stringify(p);
  generateSignal(p);
  assert.equal(JSON.stringify(p), before);
});

console.log('amplifier.js');
test('linier tanpa saturasi: y = G·x', () => {
  const x = synthSine({ duration: 0.1, fs: FS_ANALOG, freq: 10, amp: 1e-3 });
  const r = amplify(x, { gain: 100 });
  assert.equal(r.saturated, false);
  assert.equal(r.clippedCount, 0);
  close(r.y[123], 100 * x[123], 1e-15);
  close(r.vppOut, 0.2, 1e-6);
});
test('hard clipping pada ±2 V dan persentase ter-clip', () => {
  const x = Float64Array.from([-3e-3, -1e-3, 0, 1e-3, 3e-3]);
  const r = amplify(x, { gain: 1000 });
  assert.deepEqual(Array.from(r.y), [-V_SAT, -1, 0, 1, V_SAT]);
  assert.equal(r.clippedCount, 2);
  close(r.clippedPercent, 40, 1e-9);
  close(r.vppOut, 4, 1e-12);
  close(r.vppIdeal, 6, 1e-12);
  close(r.maxGainNoClip, 2 / 3e-3, 1e-6);
});
test('sinus 1 mV × 10000 → hampir semua sampel ter-clip', () => {
  const x = synthSine({ duration: 1, fs: FS_ANALOG, freq: 10, amp: 1e-3 });
  const r = amplify(x, { gain: 10000 });
  // |sin| > 0,2 untuk ≈ 87,2 % waktu
  close(r.clippedPercent, 100 * (1 - (2 / Math.PI) * Math.asin(0.2)), 0.2);
  assert.ok(signalStats(r.y).max <= V_SAT);
});
test('ECG default (gain 1000) tidak saturasi', () => {
  const s = generateSignal(DEFAULT_SIGNAL_PARAMS);
  assert.equal(amplify(s.x, { gain: 1000 }).saturated, false);
});

console.log('filters.js');
const fs = FS_ANALOG;
const design = (type, v) => designFilter({ ...DEFAULT_FILTER_PARAMS, type, [type]: v }, fs);
test('preset wajib tersedia (LPF 40/100, HPF 0,5/5, BPF 0,5–40/5–15, notch Q30/Q5)', () => {
  const has = (type, pred) => assert.ok(FILTER_PRESETS[type].some(pred), type);
  has('lpf', (p) => p.fc === 40); has('lpf', (p) => p.fc === 100);
  has('hpf', (p) => p.fc === 0.5); has('hpf', (p) => p.fc === 5);
  has('bpf', (p) => p.fLow === 0.5 && p.fHigh === 40); has('bpf', (p) => p.fLow === 5 && p.fHigh === 15);
  has('notch', (p) => p.f0 === 50 && p.q === 30); has('notch', (p) => p.f0 === 50 && p.q === 5);
});
test('LPF Butterworth: 0 dB di DC, −3 dB terukur = fc, −12 dB/oktaf jauh di atas fc', () => {
  const d = design('lpf', { fc: 40 });
  close(magnitudeDb(d.sections, fs, 0.01), 0, 1e-6);
  const m = measureMinus3dB(d.sections, fs);
  assert.equal(m.freqs.length, 1);
  close(m.freqs[0], 40, 0.01);
  // Oktaf 200→400 Hz: cukup jauh dari fc, cukup jauh dari Nyquist (warping bilinear
  // menambah redaman ekstra mendekati 5 kHz).
  close(magnitudeDb(d.sections, fs, 400) - magnitudeDb(d.sections, fs, 200), -12, 0.3);
});
test('HPF Butterworth: −3 dB terukur = fc (0,5 Hz dan 5 Hz), 0 dB di passband', () => {
  for (const fc of [0.5, 5]) {
    const d = design('hpf', { fc });
    close(measureMinus3dB(d.sections, fs).freqs[0], fc, fc * 1e-3);
    close(magnitudeDb(d.sections, fs, 200), 0, 0.01);
  }
});
test('BPF kaskade 0,5–40 Hz: dua titik −3 dB di tepi pita', () => {
  const m = measureMinus3dB(design('bpf', { fLow: 0.5, fHigh: 40 }).sections, fs);
  assert.equal(m.freqs.length, 2);
  close(m.freqs[0], 0.5, 0.01);
  close(m.freqs[1], 40, 0.1);
});
test('Notch 50 Hz: redaman > 60 dB di f0, BW −3 dB ≈ f0/Q', () => {
  for (const q of [30, 5]) {
    const d = design('notch', { f0: 50, q });
    assert.ok(magnitudeDb(d.sections, fs, 50) < -60);
    const m = measureMinus3dB(d.sections, fs);
    assert.equal(m.freqs.length, 2);
    close(m.freqs[1] - m.freqs[0], 50 / q, (50 / q) * 0.01, `Q=${q}`);
  }
});
test('penerapan filter sesuai respons: notch membuang 50 Hz, menyisakan 10 Hz', () => {
  const n = 50000;
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 10 * i / fs) + Math.sin(2 * Math.PI * 50 * i / fs));
  const y = applyFilterSpec(x, fs, { ...DEFAULT_FILTER_PARAMS, type: 'notch' }).y;
  const tail = y.subarray(20000); // lewati transien
  close(toneAmplitude(tail, fs, 10), 1, 0.01);
  assert.ok(toneAmplitude(tail, fs, 50) < 0.01);
});
test('tanpa filter = bypass identik', () => {
  const x = synthSine({ duration: 0.1, fs, freq: 10, amp: 1 });
  const r = applyFilterSpec(x, fs, { ...DEFAULT_FILTER_PARAMS, type: 'none' });
  assert.deepEqual(Array.from(r.y), Array.from(x));
  assert.equal(r.filter.sections.length, 0);
});
test('FFT: puncak sinus 50 Hz di bin yang benar', () => {
  const x = synthSine({ duration: 5, fs, freq: 50, amp: 0.3 });
  const s = amplitudeSpectrum(x, fs);
  let k = 0;
  for (let i = 1; i < s.amp.length; i++) if (s.amp[i] > s.amp[k]) k = i;
  close(s.f[k], 50, s.df);
  close(s.amp[k], 0.3, 0.3 * 0.16); // scalloping Hann ≤ 1,42 dB
});
test('filter berlebihan merusak morfologi: HPF 5 Hz & LPF 15 Hz vs preset monitor', () => {
  const ref = synthEcg({ duration: 5, fs, hr: 72 });
  const rPeaks = detectRPeaks(ref, fs);
  const q = (type, v) => filterQualityMetrics({ ref, y: applyCascade(ref, design(type, v).sections), fs, rPeaks });
  const hp05 = q('hpf', { fc: 0.5 }), hp5 = q('hpf', { fc: 5 });
  const lp40 = q('lpf', { fc: 40 }), lp15 = q('lpf', { fc: 15 });
  assert.ok(Math.abs(hp5.stDev - hp5.stDevRef) > 3 * Math.abs(hp05.stDev - hp05.stDevRef), 'ST HPF 5 Hz');
  assert.ok(hp5.rRatio < 0.8 && hp05.rRatio > 0.95, `R HPF ${hp5.rRatio} ${hp05.rRatio}`);
  assert.ok(lp15.rRatio < 0.8 && lp40.rRatio > 0.95, `R LPF ${lp15.rRatio} ${lp40.rRatio}`);
  assert.ok(lp15.delay > lp40.delay && lp40.delay > 0, 'delay LPF');
  const hp005 = q('hpf', { fc: 0.05 });
  assert.ok(hp005.snrDb > 30 && hp005.rRatio > 0.99, 'HPF 0,05 Hz hampir transparan');
});

console.log('adc.js');
test('sampling: jumlah sampel = durasi × fs, nilai = x(n/fs)', () => {
  const x = synthSine({ duration: 2, fs, freq: 3, amp: 1 });
  for (const f of [100, 250, 500, 300]) {
    const s = sample(x, fs, f);
    close(s.n, 2 * f, 1, `fs=${f}`);
    const n = 7;
    close(s.y[n], Math.sin(2 * Math.PI * 3 * n / f), 1e-5, `nilai fs=${f}`);
  }
});
test('kuantisasi mid-tread: level, LSB, kode, clip ke rentang', () => {
  // 1,8 V masih di bawah level tertinggi + Δ/2 = 1,875 V → tidak ter-clip
  const q = quantize(Float64Array.from([0, 0.1, -0.1, 0.24, 0.26, 1.8, 3, -3]), { bits: 4, vRef: 2 });
  assert.equal(q.levels, 16);
  close(q.lsb, 0.25, 1e-12);
  assert.deepEqual(Array.from(q.codes), [0, 0, 0, 1, 1, 7, 7, -8]); // 0 V tepat di level (mid-tread)
  assert.equal(q.clippedCount, 2);
  close(q.xq[6], 1.75, 1e-12); // level tertinggi = Vref − Δ
  assert.ok(q.errMax <= q.lsb / 2 + 1e-12);
});
test('error kuantisasi ≈ Δ/√12 dan SQNR ≈ 6,02N + 1,76 (sinus skala penuh)', () => {
  // frekuensi tak sebanding dengan fs agar error tidak berpola periodik
  const x = synthSine({ duration: 10, fs, freq: 7.31, amp: 1.999 });
  const s = sample(x, fs, 1000);
  for (const bits of [8, 12]) {
    const q = quantize(s.y, { bits, vRef: 2 });
    close(q.errRms, q.lsb / Math.sqrt(12), q.lsb * 0.02, `RMS ${bits}`);
    close(q.sqnrMeasured, 6.02 * bits + 1.76, 0.5, `SQNR ${bits}`);
  }
});
test('frekuensi alias |f − k·fs|', () => {
  assert.equal(aliasFrequency(80, 100).fAlias, 20);
  assert.equal(aliasFrequency(180, 100).fAlias, 20);
  assert.equal(aliasFrequency(130, 250).fAlias, 120);
  assert.equal(aliasFrequency(40, 250).fAlias, 40);
});
test('alias 80 Hz pada fs 100 Hz muncul di 20 Hz; AA LPF menghilangkannya', () => {
  const x = synthSine({ duration: 5, fs, freq: 80, amp: 1 });
  const noAA = runAdc(x, fs, { fs: 100, bits: 12, vRef: 2, antiAlias: false });
  const withAA = runAdc(x, fs, { fs: 100, bits: 12, vRef: 2, antiAlias: true });
  const tail = (r) => r.quant.xq.subarray(100);
  close(toneAmplitude(tail(noAA), 100, 20), 1, 0.01);
  assert.ok(toneAmplitude(tail(withAA), 100, 20) < 0.01);
  const r = analyzeAliasing([{ nama: 'alias', f: 80, amp: 1 }], 100, 1e-3)[0];
  assert.ok(r.above && r.visible);
  assert.equal(r.fAlias, 20);
});
test('AA LPF Butterworth orde 8: −3 dB di 0,4·fs, ≈ −48 dB satu oktaf di atasnya', () => {
  const aa = designAntiAlias(100, fs);
  assert.equal(aa.sections.length, 4);
  close(magnitudeDb(aa.sections, fs, 40), -3.01, 0.05);
  close(magnitudeDb(aa.sections, fs, 80), -48, 1);
});
test('kode biner two\'s complement', () => {
  assert.equal(toBinary(-1, 4), '1111');
  assert.equal(toBinary(-8, 4), '1000');
  assert.equal(toBinary(5, 12), '000000000101');
});

// --- Perbaikan hasil review: SQNR bila semua sampel ter-clip ---
test('quantize: semua sampel ter-clip → sqnrMeasured NaN (bukan Infinity), statistik error NaN', () => {
  const q = quantize(Float64Array.from([3, -3, 2.5, -2.2, 10]), { bits: 12, vRef: 2 });
  assert.equal(q.clippedCount, 5);
  assert.ok(Number.isNaN(q.sqnrMeasured), `sqnrMeasured = ${q.sqnrMeasured}`);
  assert.ok(Number.isNaN(q.errRms));
  assert.notEqual(q.sqnrMeasured, Infinity);
});
test('quantize: sqnrMeasured tetap terdefinisi untuk kasus lain (campuran clip / tepat di level)', () => {
  // sebagian ter-clip → dihitung dari sampel yang tidak ter-clip, hasilnya hingga
  const mixed = quantize(Float64Array.from([0.3, -0.7, 0.123, 3, -3]), { bits: 8, vRef: 2 });
  assert.equal(mixed.clippedCount, 2);
  assert.ok(Number.isFinite(mixed.sqnrMeasured), `campuran: ${mixed.sqnrMeasured}`);
  // ada sampel terukur, semuanya tepat di level (error 0) → Infinity (error nol), bukan NaN
  const exact = quantize(Float64Array.from([0, 0.25, -0.5, 1]), { bits: 4, vRef: 2 }); // Δ = 0,25
  assert.equal(exact.clippedCount, 0);
  assert.equal(exact.sqnrMeasured, Infinity);
  // tidak ada sampel sama sekali tidak diuji: tidak terjadi di pipeline (durasi ≥ 2 s)
});
test('pipeline: semua sampel ADC ter-clip → sqnrMeasured NaN sampai ke keluaran runPipeline', () => {
  // Pada fs 100 Hz, jala-jala 50 Hz jatuh tepat ±0,644·0,5 mV = ±0,322 V (gain 1000) di tiap
  // sampel; sinus uji 0,1 mV menambah paling banyak ±0,1 V → |x| ≥ 0,222 V > Vref 0,1 V.
  const params = {
    signal: {
      ...DEFAULT_SIGNAL_PARAMS, source: 'sine', sineFreq: 10, sineAmp: 0.1e-3,
      disturbances: { ...DEFAULT_SIGNAL_PARAMS.disturbances, mains: { on: true, amp: 0.5e-3, freq: 50 } },
    },
    amplifier: { gain: 1000, vSat: 2 },
    filter: { ...DEFAULT_FILTER_PARAMS, type: 'none' },
    adc: { fs: 100, bits: 12, vRef: 0.1, antiAlias: false },
  };
  const { quant } = runPipeline(params).stages.adc;
  assert.equal(quant.clippedCount, quant.codes.length, 'semua sampel harus ter-clip');
  assert.ok(Number.isNaN(quant.sqnrMeasured), `sqnrMeasured = ${quant.sqnrMeasured}`);
  // dan kasus normal pada pipeline yang sama dengan rentang cukup: terhingga
  const ok = runPipeline({ ...params, adc: { ...params.adc, vRef: 2 } }).stages.adc.quant;
  assert.ok(Number.isFinite(ok.sqnrMeasured));
});

// --- Perbaikan hasil review: respons AA & deteksi aliasing ---
test('AA Butterworth orde 8: ≈ −15,6 dB di Nyquist, ≈ −28 dB di 0,6·fs, ≈ −48 dB di 0,8·fs (bukan 48 dB di Nyquist)', () => {
  for (const f of [100, 250, 500]) {
    const aa = designAntiAlias(f, fs);
    const h = (r) => magnitudeDb(aa.sections, fs, r * f);
    close(h(0.4), -3.01, 0.1, `fc, fs=${f}`);
    close(h(0.5), -15.6, 0.3, `Nyquist, fs=${f}`);
    close(h(0.6), -28.2, 0.5, `0,6·fs, fs=${f}`);
    close(h(0.8), -48.2, 1, `0,8·fs, fs=${f}`);
    assert.ok(h(0.5) > -20, 'di Nyquist redaman jauh dari 48 dB');
  }
});
test('deteksi aliasing memakai amplitudo setelah respons AA: alias tetap terlihat di 0,6·fs, hilang di 0,8·fs', () => {
  // Rumus amplitudo identik dengan ui.js (exp3Analysis): ampIn × gain × |H_AA(f)|
  const fsAdc = 100, gain = 1000, ampIn = 0.1e-3; // 0,1 V di masukan ADC tanpa AA
  const lsbHalf = (2 * 2) / 2 ** 12 / 2; // ½ LSB 12 bit, ±2 V ≈ 0,488 mV
  const aa = designAntiAlias(fsAdc, fs);
  const tone = (nama, f, withAA) => ({
    nama, f, amp: ampIn * gain * (withAA ? 10 ** (magnitudeDb(aa.sections, fs, f) / 20) : 1),
  });
  const [t50, t60, t80] = analyzeAliasing([tone('N', 50, true), tone('0,6', 60, true), tone('0,8', 80, true)], fsAdc, lsbHalf);
  assert.ok(t50.atNyquist && t50.visible, `di Nyquist (−15,6 dB): ${t50.amp}`);
  assert.ok(t60.visible, `0,6·fs masih lolos: ${t60.amp}`);
  assert.ok(!t80.visible, `0,8·fs teredam < ½ LSB: ${t80.amp}`);
  assert.ok(t60.amp > 5 * t80.amp, 'amplitudo setelah AA turun tajam dari 0,6 ke 0,8·fs');
  // tanpa AA, ketiganya sama-sama terlihat → perbandingan membuktikan respons AA memang dipakai
  const raw = analyzeAliasing([tone('0,8', 80, false)], fsAdc, lsbHalf)[0];
  assert.ok(raw.visible && raw.fAlias === 20);
});

console.log('pipeline.js');
test('runPipeline menghasilkan tahap ecg & amp yang konsisten', () => {
  const r = runPipeline(DEFAULT_PARAMS);
  assert.equal(r.stages.amp.y.length, r.stages.ecg.x.length);
  assert.ok(STAGE_DEFS.find((s) => s.id === 'amp').ready);
  close(r.stages.amp.y[3000], 1000 * r.stages.ecg.x[3000], 1e-12);
  assert.equal(r.stages.filt.y.length, r.stages.amp.y.length);
  assert.ok(STAGE_DEFS.find((s) => s.id === 'filter').ready);
  assert.equal(r.stages.filt.filter.type, DEFAULT_FILTER_PARAMS.type);
  assert.equal(r.stages.adc.quant.codes.length, 5 * r.stages.adc.params.fs);
  assert.ok(STAGE_DEFS.find((s) => s.id === 'quant').ready);
});

// ===========================================================================
// Spesifikasi tugas (butir 3)
// ===========================================================================
console.log('spesifikasi tugas');

/** Rasio amplitudo keluaran/masukan (dB) untuk sinus f, setelah transien `skip` detik. */
function sineGainDb(sections, f, { dur = 3, skip = 1 } = {}) {
  const x = synthSine({ duration: dur, fs, freq: f, amp: 1 });
  const y = applyCascade(x, sections);
  const i0 = Math.round(skip * fs);
  return 20 * Math.log10(toneAmplitude(y.subarray(i0), fs, f) / toneAmplitude(x.subarray(i0), fs, f));
}

test('gain 100 pada sinus 1 mV → 100 mV', () => {
  const r = amplify(synthSine({ duration: 1, fs, freq: 10, amp: 1e-3 }), { gain: 100 });
  close(signalStats(r.y).max, 0.1, 1e-9, 'puncak +');
  close(signalStats(r.y).min, -0.1, 1e-9, 'puncak −');
  assert.equal(r.saturated, false);
});

test('gain 1000 pada sinus 3 mV → ter-clip tepat ±2 V', () => {
  const r = amplify(synthSine({ duration: 1, fs, freq: 10, amp: 3e-3 }), { gain: 1000 });
  const st = signalStats(r.y);
  assert.equal(st.max, 2);
  assert.equal(st.min, -2);
  assert.ok(r.saturated && r.clippedCount > 0);
  // setiap sampel yang ter-clip bernilai tepat ±2 V, bukan sekadar mendekati
  const x = synthSine({ duration: 1, fs, freq: 10, amp: 3e-3 });
  for (let i = 0; i < x.length; i++) if (Math.abs(1000 * x[i]) > 2) assert.equal(Math.abs(r.y[i]), 2);
});

for (const [type, v, fc] of [['lpf', { fc: 40 }, 40], ['lpf', { fc: 100 }, 100], ['hpf', { fc: 0.5 }, 0.5], ['hpf', { fc: 5 }, 5]]) {
  test(`${type.toUpperCase()} ${fc} Hz: magnitude di fc = −3 dB ±0,3 (respons & simulasi sinus)`, () => {
    const s = design(type, v).sections;
    close(magnitudeDb(s, fs, fc), -3.01, 0.3, '|H(fc)|');
    const dur = Math.max(3, 30 / fc), skip = Math.max(1, 15 / fc);
    close(sineGainDb(s, fc, { dur, skip }), -3.01, 0.3, 'simulasi');
  });
}

test('RC orde 1: fc = 1/(2πRC), magnitude di fc = −3 dB ±0,3', () => {
  const r = 39.79e3, c = 0.1e-6;
  const fc = rcCutoff(r, c);
  close(fc, 40, 0.01);
  const sec = designRcLowpass(fc, fs);
  close(magnitudeDb([sec], fs, fc), -3.01, 0.3);
  close(sineGainDb([sec], fc), -3.01, 0.3, 'simulasi');
  const v = validateRc(r, c, fs);
  assert.ok(v.rows.every((row) => row.ok), 'validasi RC');
});

for (const q of [30, 5]) {
  test(`notch 50 Hz Q=${q} meredam ≥ 20 dB (respons & simulasi sinus)`, () => {
    const s = design('notch', { f0: 50, q }).sections;
    assert.ok(magnitudeDb(s, fs, 50) <= -20, `|H(50)| = ${magnitudeDb(s, fs, 50)}`);
    const g = sineGainDb(s, 50, { dur: 4, skip: 2 });
    assert.ok(g <= -20, `simulasi: ${g.toFixed(1)} dB`);
  });
}

for (const bits of [2, 4, 8, 12]) {
  test(`ADC ${bits} bit: level = 2^N, LSB = 4/2^N, error maks ≤ LSB/2, RMS ≈ LSB/√12 (masukan acak seragam, ±1 %)`, () => {
    const lsb = 4 / 2 ** bits;
    // ramp menyapu seluruh rentang ±2 V
    const ramp = Float64Array.from({ length: 2 ** bits * 8 + 1 }, (_, i, ) => -2 + (4 * i) / (2 ** bits * 8));
    const qr = quantize(ramp, { bits, vRef: 2 });
    assert.equal(qr.levels, 2 ** bits);
    assert.equal(new Set(qr.codes).size, 2 ** bits, 'level terpakai pada ramp');
    close(qr.lsb, lsb, 1e-15, 'LSB');
    assert.ok(qr.errMax <= lsb / 2 + 1e-12, `error maks ${qr.errMax}`);
    // RMS = LSB/√12 adalah model statistik: berlaku bila error terdistribusi seragam
    // pada [−Δ/2, Δ/2]. Asumsi itu dipenuhi oleh masukan acak seragam di seluruh
    // rentang (tanpa clipping) — untuk N berapa pun.
    const rand = mulberry32(2024 + bits);
    const lo = -2 + lsb / 2, hi = 2 - lsb * 0.501 - lsb / 2;
    const u = Float64Array.from({ length: 200000 }, () => lo + (hi - lo) * rand());
    const qu = quantize(u, { bits, vRef: 2 });
    assert.equal(qu.clippedCount, 0);
    assert.ok(qu.errMax <= lsb / 2 + 1e-12, 'error maks acak');
    close(qu.errRms, lsb / Math.sqrt(12), 0.01 * lsb / Math.sqrt(12), `RMS ${bits} bit (masukan acak seragam)`);
  });
}

test('RMS sinus skala penuh ≈ LSB/√12 hanya bila N besar (N ≥ 8); N kecil menyimpang', () => {
  // Pada sinus, error kuantisasi deterministik dan berkorelasi dengan sinyal.
  // Dengan sedikit level, model seragam tidak berlaku — ini keterbatasan rumus,
  // bukan kesalahan kuantiser. Didokumentasikan di README dan panel validasi.
  const rmsRatio = (bits) => {
    const lsb = 4 / 2 ** bits, a = 2 - 0.501 * lsb;
    const sine = Float64Array.from({ length: 20000 }, (_, i) => a * Math.sin(2 * Math.PI * 7.31 * i / 1000));
    return quantize(sine, { bits, vRef: 2 }).errRms / (lsb / Math.sqrt(12));
  };
  for (const bits of [8, 12]) close(rmsRatio(bits), 1, 0.05, `${bits} bit`);
  assert.ok(Math.abs(rmsRatio(2) - 1) > 0.05, '2 bit diharapkan menyimpang > 5 %');
});

test('sinus 80 Hz pada fs 100 Hz (lewat pipeline) muncul di 20 Hz', () => {
  const params = {
    signal: { ...DEFAULT_SIGNAL_PARAMS, source: 'sine', sineFreq: 80, sineAmp: 1e-3 },
    amplifier: { gain: 1000, vSat: 2 },
    filter: { ...DEFAULT_FILTER_PARAMS, type: 'none' },
    adc: { fs: 100, bits: 12, vRef: 2, antiAlias: false },
  };
  const { adc } = runPipeline(params).stages;
  const s = amplitudeSpectrum(adc.quant.xq, 100);
  let k = 1;
  for (let i = 1; i < s.amp.length; i++) if (s.amp[i] > s.amp[k]) k = i;
  close(s.f[k], 20, s.df, 'frekuensi puncak');
  close(s.amp[k], 1, 0.16, 'amplitudo alias ≈ 1 V');
});

test('mengubah tiap parameter mengubah output pipeline', () => {
  const base = () => structuredClone({
    signal: { ...DEFAULT_SIGNAL_PARAMS, disturbances: structuredClone(DEFAULT_SIGNAL_PARAMS.disturbances) },
    amplifier: { gain: 1000, vSat: 2 },
    filter: structuredClone(DEFAULT_FILTER_PARAMS),
    adc: { fs: 250, bits: 12, vRef: 2, antiAlias: false },
  });
  // [nama, siapkan konteks (base & ubah), ubah parameter]
  const cases = [
    ['source', null, (p) => { p.signal.source = 'sine'; }],
    ['hr', null, (p) => { p.signal.hr = 90; }],
    ['duration', null, (p) => { p.signal.duration = 2; }],
    ['sineFreq', (p) => { p.signal.source = 'sine'; }, (p) => { p.signal.sineFreq = 20; }],
    ['sineAmp', (p) => { p.signal.source = 'sine'; }, (p) => { p.signal.sineAmp = 0.5e-3; }],
    ['baseline.on', null, (p) => { p.signal.disturbances.baseline.on = true; }],
    ['baseline.amp', (p) => { p.signal.disturbances.baseline.on = true; }, (p) => { p.signal.disturbances.baseline.amp = 0.8e-3; }],
    ['mains.on', null, (p) => { p.signal.disturbances.mains.on = true; }],
    ['mains.amp', (p) => { p.signal.disturbances.mains.on = true; }, (p) => { p.signal.disturbances.mains.amp = 0.3e-3; }],
    ['hf.on', null, (p) => { p.signal.disturbances.hf.on = true; }],
    ['hf.rms', (p) => { p.signal.disturbances.hf.on = true; }, (p) => { p.signal.disturbances.hf.rms = 0.1e-3; }],
    ['alias.on', null, (p) => { p.signal.disturbances.alias.on = true; }],
    ['alias.amp', (p) => { p.signal.disturbances.alias.on = true; }, (p) => { p.signal.disturbances.alias.amp = 0.3e-3; }],
    ['alias.freq', (p) => { p.signal.disturbances.alias.on = true; }, (p) => { p.signal.disturbances.alias.freq = 30; }],
    ['gain', null, (p) => { p.amplifier.gain = 100; }],
    ['filter.type', null, (p) => { p.filter.type = 'none'; }],
    ['lpf.fc', (p) => { p.filter.type = 'lpf'; }, (p) => { p.filter.lpf.fc = 15; }],
    ['hpf.fc', (p) => { p.filter.type = 'hpf'; }, (p) => { p.filter.hpf.fc = 5; }],
    ['bpf.fLow', null, (p) => { p.filter.bpf.fLow = 5; }],
    ['bpf.fHigh', null, (p) => { p.filter.bpf.fHigh = 15; }],
    ['notch.f0', (p) => { p.filter.type = 'notch'; }, (p) => { p.filter.notch.f0 = 20; }],
    ['notch.q', (p) => { p.filter.type = 'notch'; }, (p) => { p.filter.notch.q = 2; }],
    ['adc.fs', null, (p) => { p.adc.fs = 500; }],
    ['adc.bits', null, (p) => { p.adc.bits = 8; }],
    ['adc.vRef', null, (p) => { p.adc.vRef = 1; }],
    ['adc.antiAlias', null, (p) => { p.adc.antiAlias = true; }],
  ];
  const unchanged = [];
  for (const [name, prep, change] of cases) {
    const a = base(), b = base();
    if (prep) { prep(a); prep(b); }
    change(b);
    const qa = runPipeline(a).stages.adc.quant, qb = runPipeline(b).stages.adc.quant;
    const same = qa.codes.length === qb.codes.length && qa.xq.every((v, i) => v === qb.xq[i]);
    if (same) unchanged.push(name);
  }
  assert.deepEqual(unchanged, [], `parameter tanpa efek: ${unchanged.join(', ')}`);
});

test('CSV ekspor: header + 1 baris per sampel, kode·LSB = tegangan', () => {
  const { adc } = runPipeline(DEFAULT_PARAMS).stages;
  const lines = adcToCsv(adc).trim().split('\n');
  assert.equal(lines[0], 'waktu_s,kode_adc,tegangan_rekonstruksi_V');
  assert.equal(lines.length - 1, adc.quant.codes.length);
  const n = 10;
  const [t, code, v] = lines[n + 1].split(',').map(Number); // baris 0 = header
  close(t, n / adc.params.fs, 1e-9);
  assert.equal(code, adc.quant.codes[n]);
  close(v, code * adc.quant.lsb, 1e-9);
});

test('validasi amplifier & ADC konsisten dengan simulasi (N ≥ 6)', () => {
  const r = runPipeline(DEFAULT_PARAMS);
  assert.ok(validateAmplifier(r.stages.ecg.x, r.stages.amp).rows.every((row) => row.ok));
  for (const bits of [8, 12, 16]) assert.ok(validateAdc(bits, 2).rows.every((row) => row.ok), `${bits} bit`);
});

// ===========================================================================
// Profil sinyal (ECG, EMG, EEG, EOG, sinus uji) dan rentang parameter diperluas
// ===========================================================================
profileTests({ test, close, toneAmplitude });

// ===========================================================================
// Model dipol jantung dan pilihan sadapan
// ===========================================================================
dipoleTests({ test, close });

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed ? 1 : 0);
