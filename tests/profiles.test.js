/**
 * tests/profiles.test.js — Tes profil sinyal (ECG, EMG, EEG, EOG, sinus uji) dan
 * rentang parameter yang diperluas. Dipanggil dari tests/run.js:
 *   profileTests({ test, close, toneAmplitude })
 *
 * Ambang batas tiap tes diambil dari pengukuran nyata terhadap model (bukan tebakan);
 * komentar di tiap tes menyebut nilai terukur yang menjadi dasarnya.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  FS_ANALOG, DEFAULT_SIGNAL_PARAMS, generateSignal, makeDisturbance, signalStats, synthEcg, synthSine,
} from '../js/signal.js';
import { peakAbs, pinkNoise, makeTimeAxis } from '../js/profiles/common.js';
import { PROFILES, getProfile, validateProfile } from '../js/profiles/index.js';
import { defaultParams } from '../js/profiles/params.js';
import { emgEnvelope, synthEmg } from '../js/profiles/emg.js';
import { EEG_BANDS, ALPHA_CLOSED_GAIN } from '../js/profiles/eeg.js';
import { saccadeTime } from '../js/profiles/eog.js';
import { runPipeline, DEFAULT_PARAMS } from '../js/pipeline.js';
import { amplify } from '../js/amplifier.js';
import {
  DEFAULT_FILTER_PARAMS, FILTER_PRESETS, FILTER_LIMITS, designFilter, magnitudeDb, measureMinus3dB,
  amplitudeSpectrum,
} from '../js/filters.js';
import {
  quantize, sample, aliasFrequency, analyzeAliasing, designAntiAlias, powerAboveNyquist, adcToCsv, runAdc,
} from '../js/adc.js';
import { validateAmplifier, validateRc, validateAdc, RC_FC_MIN } from '../js/validation.js';
import { voltUnit, fmtVolt, fmtTrim } from '../js/format.js';

const sha = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

/** Fraksi daya (tanpa DC) yang berada di [lo, hi] Hz. */
function bandFraction(x, fs, lo, hi) {
  const s = amplitudeSpectrum(x, fs);
  let tot = 0, ins = 0;
  for (let k = 1; k < s.f.length; k++) {
    const p = s.amp[k] ** 2;
    tot += p;
    if (s.f[k] >= lo && s.f[k] < hi) ins += p;
  }
  return ins / tot;
}
/** Daya mutlak (satuan sembarang, sama untuk semua pemanggilan) di [lo, hi] Hz. */
function bandPower(x, fs, lo, hi) {
  const s = amplitudeSpectrum(x, fs);
  let ins = 0;
  for (let k = 1; k < s.f.length; k++) if (s.f[k] >= lo && s.f[k] < hi) ins += s.amp[k] ** 2;
  return ins;
}
/** Kemiringan log–log daya per Hz (rata-rata Welch), bin selebar satu oktaf. */
function welchSlope(x, fs, segLen, edges) {
  const nseg = Math.floor(x.length / segLen);
  let acc = null, f = null;
  for (let s = 0; s < nseg; s++) {
    const sp = amplitudeSpectrum(x.subarray(s * segLen, (s + 1) * segLen), fs);
    if (!acc) { acc = new Float64Array(sp.amp.length); f = sp.f; }
    for (let k = 0; k < acc.length; k++) acc[k] += sp.amp[k] ** 2 / nseg;
  }
  const xs = [], ys = [];
  for (let i = 0; i < edges.length - 1; i++) {
    let p = 0, c = 0;
    for (let k = 1; k < f.length; k++) if (f[k] >= edges[i] && f[k] < edges[i + 1]) { p += acc[k]; c++; }
    xs.push(Math.log10(Math.sqrt(edges[i] * edges[i + 1])));
    ys.push(Math.log10(p / c));
  }
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let num = 0, den = 0;
  xs.forEach((xv, i) => { num += (xv - mx) * (ys[i] - my); den += (xv - mx) ** 2; });
  return num / den;
}

export function profileTests({ test, close, toneAmplitude }) {
  const fs = FS_ANALOG;
  const clone = (o) => structuredClone(o);

  // =========================================================================
  console.log('profil: registri & bentuk');
  // =========================================================================
  test('registri memuat ECG, EMG, EEG, EOG, dan sinus uji; id tak dikenal jatuh ke ECG', () => {
    assert.deepEqual(PROFILES.map((p) => p.id), ['ecg', 'emg', 'eeg', 'eog', 'sine']);
    assert.equal(getProfile('xyz').id, 'ecg');
    assert.equal(getProfile('eeg').id, 'eeg');
  });
  for (const p of PROFILES) {
    test(`profil ${p.id}: semua field wajib ada dan konsisten (validateProfile)`, () => {
      assert.deepEqual(validateProfile(p), []);
    });
    test(`profil ${p.id}: generator deterministik, terhingga, panjang = durasi × fs, tidak mengubah parameter`, () => {
      const params = defaultParams(p.id).signal;
      const before = JSON.stringify(params);
      const t = makeTimeAxis(2, fs);
      const a = p.generator(t, { ...params, duration: 2 });
      const b = p.generator(t, { ...params, duration: 2 });
      assert.equal(a.length, 20000);
      assert.deepEqual(a, b);
      assert.ok(a.every(Number.isFinite));
      assert.equal(JSON.stringify(params), before);
      assert.ok(peakAbs(a) > 0, 'keluaran tidak nol pada nilai bawaan');
    });
    test(`profil ${p.id}: panel info menghasilkan baris teks tanpa "NaN"/"undefined"`, () => {
      const prm = defaultParams(p.id).signal;
      const sig = generateSignal(prm);
      const rows = p.info({ p: sig.params, clean: sig.clean, x: sig.x, fs: sig.fs });
      assert.ok(rows.length >= 3);
      for (const [k, v] of rows) {
        assert.equal(typeof k, 'string');
        assert.ok(!/undefined|NaN/.test(`${k}${v}`), `${k}: ${v}`);
      }
    });
    test(`profil ${p.id}: rentang slider memuat rentang tipikal amplitudo dan nilai preset`, () => {
      const amp = p.controls.find((c) => /Amp$/.test(c.key) && c.type === 'range');
      assert.ok(amp, 'ada kontrol amplitudo');
      assert.ok(amp.min * amp.toSI <= p.amplitudo.tipikal[0] * (1 + 1e-9), `min ${amp.min * amp.toSI}`);
      assert.ok(amp.max * amp.toSI >= p.amplitudo.tipikal[1] * (1 - 1e-9), `max ${amp.max * amp.toSI}`);
      const pr = p.preset, f = pr.filter, L = FILTER_LIMITS;
      assert.ok(pr.fs >= 20 && pr.fs <= 4000 && pr.bits >= 1 && pr.bits <= 24 && pr.gain >= 1 && pr.gain <= 1e5);
      const inR = (v, [lo, hi]) => v >= lo && v <= hi;
      if (f.lpf) assert.ok(inR(f.lpf.fc, L.lpf));
      if (f.hpf) assert.ok(inR(f.hpf.fc, L.hpf));
      if (f.bpf) { assert.ok(inR(f.bpf.fLow, L.bpfLow)); assert.ok(inR(f.bpf.fHigh, L.bpfHigh)); }
      if (f.addNotch) assert.ok(inR(f.notch.f0, L.notchF0) && inR(f.notch.q, L.notchQ));
    });
  }

  // =========================================================================
  console.log('profil ECG: regresi terhadap versi sebelum refactor');
  // =========================================================================
  const REF = JSON.parse(readFileSync(new URL('./fixtures/ecg-reference.json', import.meta.url), 'utf8'));
  /** Bandingkan deret terhadap fixture: hash seluruh byte + sampel eksplisit, tanpa toleransi. */
  const matchesRef = (arr, ref, label) => {
    assert.equal(arr.length, ref.n, `${label}: panjang`);
    for (const [i, v] of ref.samples) assert.ok(Object.is(arr[i], v), `${label}[${i}]: ${arr[i]} ≠ ${v}`);
    assert.equal(sha(arr), ref.sha256, `${label}: sha256 seluruh deret`);
  };
  const allOn = REF.ecgAllDisturbances.params.disturbances;
  test('ECG bawaan: clean & x identik bit-per-bit dengan v1 (hash + sampel)', () => {
    const g = generateSignal(DEFAULT_SIGNAL_PARAMS);
    matchesRef(g.clean, REF.ecgDefault.clean, 'clean');
    matchesRef(g.x, REF.ecgDefault.x, 'x');
  });
  test('ECG 90 bpm / 2 s dan ECG 55 bpm, R 2 mV, 10 s, semua gangguan: identik dengan v1', () => {
    matchesRef(generateSignal({ ...DEFAULT_SIGNAL_PARAMS, hr: 90, duration: 2 }).clean, REF.ecg90bpm2s.clean, 'ecg90');
    const g = generateSignal({ ...DEFAULT_SIGNAL_PARAMS, rAmp: 2e-3, hr: 55, duration: 10, disturbances: allOn });
    matchesRef(g.clean, REF.ecgAllDisturbances.clean, 'clean');
    matchesRef(g.noise, REF.ecgAllDisturbances.noise, 'noise');
    matchesRef(g.x, REF.ecgAllDisturbances.x, 'x');
  });
  test('sinus uji dan fungsi sintesis langsung (synthEcg, synthSine): identik dengan v1', () => {
    matchesRef(generateSignal({ ...DEFAULT_SIGNAL_PARAMS, source: 'sine', sineFreq: 37, sineAmp: 0.7e-3 }).clean, REF.sine37.clean, 'sine');
    matchesRef(synthEcg({ duration: 3, fs: 10000, hr: 66, rAmp: 1.3e-3 }), REF.synthEcgDirect, 'synthEcg');
    matchesRef(synthSine({ duration: 1, fs: 10000, freq: 12.5, amp: 2e-3 }), REF.synthSineDirect, 'synthSine');
  });
  test('pipeline bawaan (amplifier → filter → ADC): keluaran tiap tahap identik dengan v1', () => {
    const r = runPipeline(DEFAULT_PARAMS);
    matchesRef(r.stages.amp.y, REF.pipelineDefault.amp, 'amp.y');
    matchesRef(r.stages.filt.y, REF.pipelineDefault.filt, 'filt.y');
    assert.equal(r.stages.adc.quant.codes.length, REF.pipelineDefault.codes.n);
    assert.equal(sha(r.stages.adc.quant.codes), REF.pipelineDefault.codes.sha256, 'kode ADC');
    matchesRef(r.stages.adc.quant.xq, REF.pipelineDefault.xq, 'xq');
  });
  test('generator profil ECG = synthEcg; bawaan profil ECG sama dengan DEFAULT_SIGNAL_PARAMS', () => {
    const t = makeTimeAxis(3, fs);
    const a = getProfile('ecg').generator(t, { fs, duration: 3, hr: 66, rAmp: 1.3e-3 });
    assert.equal(sha(a), sha(synthEcg({ duration: 3, fs, hr: 66, rAmp: 1.3e-3 })));
    const d = defaultParams('ecg').signal;
    assert.equal(d.hr, DEFAULT_SIGNAL_PARAMS.hr);
    close(d.rAmp, DEFAULT_SIGNAL_PARAMS.rAmp, 1e-18);
    for (const k of ['baseline', 'mains', 'hf', 'alias']) {
      for (const [kk, v] of Object.entries(DEFAULT_SIGNAL_PARAMS.disturbances[k])) {
        if (typeof v === 'number') close(d.disturbances[k][kk], v, Math.abs(v) * 1e-12 + 1e-18, `${k}.${kk}`);
      }
    }
  });

  // =========================================================================
  console.log('profil EMG');
  // =========================================================================
  const emg = (extra = {}) => generateSignal({ source: 'emg', duration: 5, ...extra }).clean;
  for (const pat of ['tonic', 'burst']) {
    test(`EMG ${pat}: daya terkonsentrasi di 20–450 Hz (terukur 0,90 di 20–450; 0,999 di 10–900; 0,004 di < 20)`, () => {
      const x = emg({ emgPattern: pat, emgLevel: 1, emgAmp: 1e-3 });
      assert.ok(bandFraction(x, fs, 20, 450) >= 0.85, `20–450: ${bandFraction(x, fs, 20, 450)}`);
      assert.ok(bandFraction(x, fs, 10, 900) >= 0.99, `10–900: ${bandFraction(x, fs, 10, 900)}`);
      assert.ok(bandFraction(x, fs, 0, 20) <= 0.01, `< 20 Hz: ${bandFraction(x, fs, 0, 20)}`);
    });
  }
  test('EMG: amplitudo puncak = amplitudo × tingkat kontraksi (0,05–5 mV, berbagai tingkat)', () => {
    for (const [amp, level] of [[0.05e-3, 1], [1e-3, 0.6], [5e-3, 1], [2e-3, 0.25], [0.5e-3, 0.01]]) {
      for (const pat of ['burst', 'tonic']) {
        const x = emg({ emgAmp: amp, emgLevel: level, emgPattern: pat });
        close(peakAbs(x), amp * level, amp * level * 1e-9, `${pat} ${amp} × ${level}`);
      }
    }
  });
  test('EMG: kontraksi 0 % → sinyal nol; tingkat 50 % → persis setengah dari 100 % (puncak & RMS)', () => {
    assert.ok(emg({ emgLevel: 0 }).every((v) => v === 0));
    const full = emg({ emgLevel: 1 }), half = emg({ emgLevel: 0.5 });
    close(peakAbs(half) / peakAbs(full), 0.5, 1e-9);
    close(signalStats(half).rms / signalStats(full).rms, 0.5, 1e-9);
  });
  test('EMG burst: jumlah burst = laju × durasi, di antara burst sinyal nol persis; tonik tidak pernah nol', () => {
    for (const rate of [1, 2]) {
      const t = makeTimeAxis(5, fs);
      const env = emgEnvelope(t, { pattern: 'burst', burstRate: rate });
      let rises = 0;
      for (let i = 1; i < env.length; i++) if (env[i - 1] < 0.5 && env[i] >= 0.5) rises++;
      assert.equal(rises, 5 * rate, `laju ${rate}`);
    }
    const x = emg({ emgPattern: 'burst', emgBurstRate: 1, emgLevel: 1 });
    const zeros = x.filter((v) => v === 0).length / x.length;
    assert.ok(zeros > 0.55 && zeros < 0.65, `fraksi nol ${zeros}`);
    const tonic = emgEnvelope(makeTimeAxis(5, fs), { pattern: 'tonic', burstRate: 1 });
    assert.ok(Math.min(...tonic) >= 0.8 - 1e-12);
  });
  test('EMG: derau berbeda untuk seed berbeda, sama untuk seed sama', () => {
    const a = emg({ emgSeed: 1 }), b = emg({ emgSeed: 2 }), c = emg({ emgSeed: 1 });
    assert.deepEqual(a, c);
    assert.notDeepEqual(a, b);
  });
  test('gangguan artefak gerak (EMG): frekuensi rendah (> 99 % daya di < 10 Hz), puncak ≤ amplitudo', () => {
    const n = 50000;
    const noise = makeDisturbance(n, fs, { motion: { on: true, amp: 1e-3, freq: 2 } });
    assert.ok(peakAbs(noise) <= 1e-3 * (1 + 1e-12) && peakAbs(noise) > 0.5e-3);
    assert.ok(bandFraction(noise, fs, 0, 10) >= 0.99, `${bandFraction(noise, fs, 0, 10)}`);
  });

  // =========================================================================
  console.log('profil EEG');
  // =========================================================================
  const eegWeights = (only) => Object.fromEntries(EEG_BANDS.map((b) => [b.key, b.id === only ? 1 : 0]));
  const eeg = (extra = {}) => generateSignal({ source: 'eeg', duration: 10, ...extra }).clean;
  for (const b of EEG_BANDS) {
    test(`EEG hanya pita ${b.nama} (${b.lo}–${b.hi} Hz): daya terkonsentrasi di pita itu dan pita itu yang dominan`, () => {
      // terukur: delta 0,87; theta 0,73; alpha 0,61; beta 0,84; gamma 0,76 (tepi pita lunak, orde 4)
      const x = eeg({ ...eegWeights(b.id), eegBg: 0 });
      const own = bandFraction(x, fs, b.lo, b.hi);
      assert.ok(own >= 0.55, `${b.nama}: ${own}`);
      assert.ok(bandFraction(x, fs, b.lo * 0.7, b.hi * 1.4) >= 0.9, 'dalam ±(0,7…1,4)× pita');
      for (const o of EEG_BANDS) if (o.id !== b.id) assert.ok(bandFraction(x, fs, o.lo, o.hi) < own, `${o.nama} < ${b.nama}`);
    });
  }
  test('EEG: amplitudo total (puncak, mata terbuka) = 10–100 µV untuk berbagai bobot pita', () => {
    for (const amp of [10e-6, 40e-6, 100e-6]) close(peakAbs(eeg({ eegAmp: amp })), amp, amp * 1e-9, `${amp}`);
    close(peakAbs(eeg({ eegAmp: 25e-6, eegDelta: 0.1, eegAlpha: 1, eegGamma: 0.9, eegBg: 0.05 })), 25e-6, 25e-6 * 1e-9, 'bobot lain');
  });
  test('EEG: daya alpha naik pada mode mata tertutup (relatif ×2,3; mutlak ≈ ×ALPHA_CLOSED_GAIN²)', () => {
    const open = eeg({ eegState: 'open' }), closed = eeg({ eegState: 'closed' });
    const rel = (x) => bandFraction(x, fs, 8, 13);
    assert.ok(rel(closed) >= 1.5 * rel(open), `relatif ${rel(open)} → ${rel(closed)}`);
    // Terukur (tertutup/terbuka): alpha ×5,30 (< 6,25 karena theta/beta ikut mengisi 8–13 Hz);
    // theta ×1,84 dan beta ×2,91 (tepi pita lunak: alpha ikut mengisi pita tetangga);
    // delta ×1,00 dan gamma ×1,02 (jauh dari alpha, tidak berubah).
    const r = (lo, hi) => bandPower(closed, fs, lo, hi) / bandPower(open, fs, lo, hi);
    const ratio = r(8, 13);
    assert.ok(ratio > 4.5 && ratio < ALPHA_CLOSED_GAIN ** 2 + 0.25, `rasio daya alpha mutlak ${ratio}`);
    assert.ok(r(4, 8) > 1.3 && r(13, 30) > 1.3, 'pita tetangga ikut naik (kebocoran tepi lunak)');
    close(r(0.5, 4), 1, 0.1, 'delta (jauh dari alpha)');
    close(r(30, 70), 1, 0.1, 'gamma (jauh dari alpha)');
    assert.ok(peakAbs(closed) > peakAbs(open), 'amplitudo total ikut naik');
  });
  test('latar ≈ 1/f: kemiringan Welch −1,0 ± 0,1 (rekaman panjang); 10 s tunggal −1,0 ± 0,3', () => {
    // terukur: Welch 2^20 sampel → −1,013; satu realisasi 10 s bervariasi −0,88…−1,07 antar seed
    const long = pinkNoise(2 ** 20, 5);
    const s = welchSlope(long, fs, 2 ** 16, [1, 2, 4, 8, 16, 32, 64, 128]);
    assert.ok(s > -1.1 && s < -0.9, `Welch: ${s}`);
    const bg = eeg({ ...eegWeights('none'), eegBg: 1 });
    const s2 = welchSlope(bg, fs, bg.length, [1, 2, 4, 8, 16, 32, 64, 128]);
    assert.ok(s2 > -1.3 && s2 < -0.7, `EEG latar 10 s: ${s2}`);
  });
  test('artefak kedip mata (EEG): pulsa tepat amplitudo di 0,9 s + k·selang', () => {
    const n = 100000;
    const noise = makeDisturbance(n, fs, { blink: { on: true, amp: 80e-6, interval: 4 } });
    close(noise[9000], 80e-6, 1e-12, 't = 0,9 s');
    close(noise[49000], 80e-6, 1e-12, 't = 4,9 s');
    close(peakAbs(noise), 80e-6, 1e-12, 'puncak');
    assert.ok(Math.abs(noise[20000]) < 1e-12, 'di antara kedip ≈ 0');
  });
  test('jala-jala 50 Hz pada EEG: nada tepat 50 Hz dengan amplitudo yang diatur', () => {
    const noise = makeDisturbance(100000, fs, { mains: { on: true, amp: 20e-6, freq: 50 } });
    close(toneAmplitude(noise, fs, 50), 20e-6, 1e-9);
  });

  // =========================================================================
  console.log('profil EOG');
  // =========================================================================
  const eog = (extra = {}) => generateSignal({ source: 'eog', duration: 10, eogBlink: false, ...extra }).clean;
  const meanWin = (x, a, b) => { let s = 0; const i0 = Math.round(a * fs), i1 = Math.round(b * fs); for (let i = i0; i < i1; i++) s += x[i]; return s / (i1 - i0); };
  test('EOG: ukuran langkah tiap saccade = amplitudo saccade (0,1 / 0,5 / 2 mV), tanda bergantian', () => {
    for (const amp of [0.1e-3, 0.5e-3, 2e-3]) {
      const x = eog({ eogAmp: amp, eogInterval: 2 });
      for (let k = 0; k < 4; k++) {
        const tk = saccadeTime(k, 2);
        const step = meanWin(x, tk + 0.1, tk + 0.5) - meanWin(x, tk - 0.5, tk - 0.05);
        close(step, (k % 2 === 0 ? 1 : -1) * amp, amp * 1e-9, `amp ${amp} saccade ${k}`);
      }
    }
  });
  test('EOG: transisi mulus 40 ms (monoton, tanpa overshoot), plato rata sebelum dan sesudah', () => {
    const amp = 1e-3;
    const x = eog({ eogAmp: amp });
    const i0 = Math.round(saccadeTime(0, 2) * fs);
    close(x[i0 - 1], -amp / 2, 1e-15);
    close(x[i0 + 400 + 5], amp / 2, 1e-12);
    for (let i = i0; i < i0 + 400; i++) assert.ok(x[i + 1] >= x[i] - 1e-18, `monoton di ${i}`);
    assert.ok(Math.max(...x.subarray(i0, i0 + 1000)) <= amp / 2 + 1e-12, 'tanpa overshoot');
  });
  test('EOG: jumlah saccade mengikuti selang; kedip = pulsa setinggi amplitudo kedip di atas plato', () => {
    // posisi mata bergantian −amp/2 ↔ +amp/2, jadi tiap saccade melintasi 0 satu kali
    const x = eog({ eogAmp: 0.5e-3, eogInterval: 1 });
    let crossings = 0;
    for (let i = 1; i < x.length; i++) if (Math.sign(x[i]) !== Math.sign(x[i - 1])) crossings++;
    assert.equal(crossings, 10, 'saccade pada 0,75; 1,75; … 9,75 s');
    const b = generateSignal({ source: 'eog', duration: 10, eogBlink: true, eogBlinkAmp: 0.8e-3, eogAmp: 0.5e-3, eogInterval: 2 }).clean;
    close(b[17500], 0.25e-3 + 0.8e-3, 1e-9, 'kedip di 1,75 s: plato +amp/2 + amplitudo kedip');
  });
  test('drift DC (EOG): rampa linear dengan laju yang diatur', () => {
    const noise = makeDisturbance(100000, fs, { drift: { on: true, amp: 50e-6 } });
    close(noise[0], 0, 1e-18);
    close(noise[40000], 50e-6 * 4, 1e-12);
    close(noise[99999], 50e-6 * 9.9999, 1e-12);
  });

  // =========================================================================
  console.log('profil: preset rekomendasi pada pipeline');
  // =========================================================================
  for (const p of PROFILES) {
    test(`preset ${p.id}: tanpa saturasi, tanpa clip ADC, tanpa aliasing — nilai bawaan dan semua gangguan milik profil aktif`, () => {
      const own = p.disturbances.map((d) => d.id).filter((id) => id !== 'alias'); // alias = demo aliasing disengaja
      for (const on of [false, true]) {
        const prm = defaultParams(p.id);
        if (on) for (const id of own) prm.signal.disturbances[id].on = true;
        const r = runPipeline(prm);
        const tag = `${p.id}${on ? ' + gangguan' : ''}`;
        assert.equal(r.stages.amp.saturated, false, `${tag}: saturasi ${r.stages.amp.clippedPercent}% (puncak ${peakAbs(r.stages.amp.y)} V)`);
        assert.equal(r.stages.adc.quant.clippedCount, 0, `${tag}: clip ADC`);
        const above = powerAboveNyquist(r.stages.adc.input, fs, prm.adc.fs);
        assert.ok(above < 0.01, `${tag}: daya di atas fs/2 = ${above}`);
        const tones = [];
        for (const id of own) if (prm.signal.disturbances[id].on && prm.signal.disturbances[id].freq && id !== 'baseline' && id !== 'motion') tones.push({ nama: id, f: prm.signal.disturbances[id].freq, amp: 1 });
        assert.ok(analyzeAliasing(tones, prm.adc.fs, 0).every((t) => !t.above), `${tag}: nada di atas Nyquist`);
        // preset memakai rentang ADC dengan layak: puncak ≥ 5 % rentang, dan LSB di elektroda ≤ target profil
        assert.ok(peakAbs(r.stages.amp.y) >= 0.05 * prm.adc.vRef, `${tag}: rentang ADC terpakai`);
        assert.ok(r.stages.adc.quant.lsb / prm.amplifier.gain <= p.lsbTarget, `${tag}: LSB di elektroda ${r.stages.adc.quant.lsb / prm.amplifier.gain}`);
      }
    });
  }
  test('kontrol-negatif: tanpa AA, nada 1500 Hz pada fs 2000 Hz (profil EMG) terdeteksi dan muncul di 500 Hz', () => {
    const prm = defaultParams('emg');
    prm.filter = { ...DEFAULT_FILTER_PARAMS, type: 'none' };
    prm.adc.antiAlias = false;
    prm.signal.emgLevel = 0;
    prm.signal.disturbances.alias = { on: true, amp: 0.5e-3, freq: 1500 };
    const r = runPipeline(prm);
    const [t] = analyzeAliasing([{ nama: 'alias', f: 1500, amp: 0.5e-3 * 1000 }], 2000, r.stages.adc.quant.lsb / 2);
    assert.ok(t.visible && t.above && t.fAlias === 500);
    const sp = amplitudeSpectrum(r.stages.adc.quant.xq, 2000);
    let k = 1;
    for (let i = 1; i < sp.amp.length; i++) if (sp.amp[i] > sp.amp[k]) k = i;
    close(sp.f[k], 500, sp.df, 'puncak spektrum');
    close(sp.amp[k], 0.5, 0.5 * 0.2, 'amplitudo (fs membagi 10 kHz → eksak, kebocoran Hann ≤ 1,4 dB)');
  });

  // =========================================================================
  console.log('profil: ganti profil lalu kembali ke ECG');
  // =========================================================================
  test('ganti profil lalu kembali ke ECG: parameter dan keluaran pipeline identik dengan semula', () => {
    const digest = (prm) => {
      const r = runPipeline(prm);
      return [sha(r.stages.ecg.x), sha(r.stages.amp.y), sha(r.stages.filt.y), sha(r.stages.adc.quant.codes)].join('|');
    };
    const frozenBefore = JSON.stringify(DEFAULT_SIGNAL_PARAMS);
    const first = defaultParams('ecg');
    const jsonFirst = JSON.stringify(first);
    const h0 = digest(first);
    for (const id of ['emg', 'eeg', 'eog', 'sine', 'emg', 'eeg']) {
      const other = defaultParams(id);
      other.signal.disturbances.mains.on = true; // mengubah salinan tidak boleh bocor
      other.amplifier.gain = 5;
      digest(other);
    }
    const again = defaultParams('ecg');
    assert.equal(JSON.stringify(again), jsonFirst, 'parameter ECG identik');
    assert.equal(digest(again), h0, 'keluaran pipeline ECG identik');
    assert.equal(JSON.stringify(DEFAULT_SIGNAL_PARAMS), frozenBefore, 'DEFAULT_SIGNAL_PARAMS tidak berubah');
    again.signal.hr = 120; // salinan terpisah: mengubah satu tidak mengubah yang lain
    assert.equal(defaultParams('ecg').signal.hr, 72);
  });
  test('generateSignal ECG tidak terpengaruh pembangkitan profil lain (tanpa state tersembunyi)', () => {
    const a = generateSignal({ source: 'ecg' }).x;
    for (const id of ['emg', 'eeg', 'eog']) generateSignal({ source: id, duration: 2 });
    assert.equal(sha(generateSignal({ source: 'ecg' }).x), sha(a));
  });

  // =========================================================================
  console.log('rentang parameter diperluas');
  // =========================================================================
  test('gain bebas hingga 10^5: Vout = G·Vin; saturasi pada rail yang diatur', () => {
    const x = Float64Array.from([10e-6, -10e-6, 5e-6, 0]);
    const r = amplify(x, { gain: 1e5, vSat: 2.5 });
    assert.deepEqual(Array.from(r.y), [1, -1, 0.5, 0]);
    assert.equal(r.saturated, false);
    const big = amplify(Float64Array.from([30e-6, -30e-6]), { gain: 1e5, vSat: 2.5 });
    assert.deepEqual(Array.from(big.y), [2.5, -2.5]);
    close(big.maxGainNoClip, 2.5 / 30e-6, 1e-6);
    for (const [gain, vSat] of [[1e5, 0.7], [1e4, 2.5], [1, 5]]) {
      const v = validateAmplifier(x, amplify(x, { gain, vSat }));
      assert.ok(v.rows.every((row) => row.ok), `G=${gain}, Vsat=${vSat}`);
    }
  });
  test('bit 1–24: level = 2^N, LSB = 2·Vref/2^N, kode dalam rentang, error ≤ LSB/2; validasi lolos (N ≥ 6)', () => {
    for (let bits = 1; bits <= 24; bits++) {
      const vRef = 2.5;
      const q = quantize(Float64Array.from([0, 0.123, -0.9, 1.7, -2.4]), { bits, vRef });
      assert.equal(q.levels, 2 ** bits, `${bits} bit`);
      close(q.lsb, (2 * vRef) / 2 ** bits, 1e-18);
      assert.equal(q.codeMax - q.codeMin + 1, 2 ** bits);
      assert.ok(q.codes.every((c) => c >= q.codeMin && c <= q.codeMax));
      for (let i = 0; i < q.codes.length; i++) if (!q.clipped[i]) assert.ok(Math.abs(q.err[i]) <= q.lsb / 2 + 1e-15, `${bits} bit, i=${i}`);
      const v = validateAdc(bits, vRef);
      assert.ok(v.rows.filter((row) => !row.assumption).every((row) => row.ok), `validasi ${bits} bit: ${v.rows.filter((row) => !row.ok && !row.assumption).map((row) => row.nama)}`);
      if (bits >= 6) assert.ok(v.rows.every((row) => row.ok), `validasi penuh ${bits} bit`);
    }
  });
  test('fs hingga 4000 Hz: jumlah sampel = durasi × fs; fs yang membagi 10 kHz tepat → sampel eksak', () => {
    const x = synthSine({ duration: 2, fs, freq: 450, amp: 1 });
    for (const f of [20, 100, 250, 500, 1000, 2000, 2500, 4000]) {
      const s = sample(x, fs, f);
      close(s.n, 2 * f, 1, `fs ${f}`);
    }
    for (const f of [1000, 2000, 2500]) {
      const s = sample(x, fs, f);
      let me = 0;
      for (let k = 0; k < s.n; k++) me = Math.max(me, Math.abs(s.y[k] - Math.sin(2 * Math.PI * 450 * k / f)));
      assert.ok(me < 1e-9, `fs ${f} (pembagi 10 kHz): galat ${me}`);
    }
  });
  test('fs 4000 Hz (rasio 2,5): galat interpolasi linear ≤ 1 − cos(πf/10 kHz); frekuensi alias tetap benar', () => {
    // terukur pada fs 4000: rasio amplitudo 0,9999 (10 Hz), 0,9999 (70 Hz), 0,995 (450 Hz), 0,951 (1 kHz)
    for (const f of [10, 70, 450, 1000]) {
      const x = synthSine({ duration: 4, fs, freq: f, amp: 1 });
      const s = sample(x, fs, 4000);
      const a = toneAmplitude(s.y, 4000, f);
      const bound = 1 - Math.cos((Math.PI * f) / fs);
      // batas tercapai persis di f = fs/4 (citra modulasi menimpa nada asli), jadi beri kelonggaran 1 %
      assert.ok(Math.abs(1 - a) <= bound * 1.01 + 1e-6, `f=${f}: amplitudo ${a}, batas ${bound}`);
    }
    for (const [f, fa] of [[2500, 1500], [3000, 1000], [4500, 500]]) {
      assert.equal(aliasFrequency(f, 4000).fAlias, fa);
      const x = synthSine({ duration: 4, fs, freq: f, amp: 1 });
      const sp = amplitudeSpectrum(sample(x, fs, 4000).y, 4000);
      let k = 1;
      for (let i = 1; i < sp.amp.length; i++) if (sp.amp[i] > sp.amp[k]) k = i;
      close(sp.f[k], fa, sp.df, `puncak spektrum untuk ${f} Hz`);
    }
  });
  test('redaman anti-aliasing di fs/2 bergantung pada fs (warping bilinear): −15,6 dB (≤ 500 Hz) … ≈ −19 dB (4000 Hz)', () => {
    const at = (f) => magnitudeDb(designAntiAlias(f, fs).sections, fs, f / 2);
    for (const f of [100, 250, 500]) close(at(f), -15.65, 0.2, `fs ${f}`);
    assert.ok(at(1000) < at(500) && at(2000) < at(1000) && at(4000) < at(2000), 'makin curam di fs tinggi');
    close(at(4000), -19.4, 0.5, 'fs 4000');
  });
  test('CSV: 24 bit dan 1 bit — kode·LSB = tegangan; waktu = n/fs pada fs 4000 Hz', () => {
    for (const bits of [1, 8, 24]) {
      const prm = defaultParams('eeg');
      prm.adc = { ...prm.adc, fs: 4000, bits, antiAlias: false };
      prm.signal.duration = 2;
      const { adc } = runPipeline(prm).stages;
      const lines = adcToCsv(adc).trim().split('\n');
      assert.equal(lines.length - 1, 8000);
      for (const n of [0, 1, 2, 3999, 7999]) {
        const [t, code, v] = lines[n + 1].split(',').map(Number);
        assert.equal(code, adc.quant.codes[n], `${bits} bit, n=${n}`);
        close(t, n / 4000, 5e-7, 'waktu');
        assert.equal(Math.round(v / adc.quant.lsb), code, `${bits} bit: tegangan/LSB → kode, n=${n}`);
      }
    }
    assert.equal(adcToCsv(runPipeline(Object.assign(defaultParams('emg'), {})).stages.adc).split('\n')[2].split(',')[0], '0.000500');
  });
  test('panel RC: fc ≥ 0,45·10 kHz → "tinggi", fc < 0,01 Hz → "rendah", di antaranya tervalidasi', () => {
    const R = 1e4;
    const at = (fc) => validateRc(R, 1 / (2 * Math.PI * R * fc), fs);
    for (const fc of [4500, 6000]) { const v = at(fc); assert.ok(v.outOfRange && v.limit === 'high' && v.rows.every((r) => r.na), `${fc}`); }
    for (const fc of [0.001, 0.009]) { const v = at(fc); assert.ok(v.outOfRange && v.limit === 'low' && v.rows.every((r) => r.na), `${fc}`); }
    for (const fc of [RC_FC_MIN, 0.05, 1, 100, 2000, 4400]) { const v = at(fc); assert.ok(!v.outOfRange && v.rows.every((r) => r.ok), `fc ${fc}`); }
  });
  test('notch kaskade (addNotch): BPF 20–450 Hz + notch 50 Hz meredam ≥ 20 dB di 50 Hz; tepi pita terukur pada baseSections', () => {
    const f = designFilter({ ...DEFAULT_FILTER_PARAMS, type: 'bpf', bpf: { fLow: 20, fHigh: 450 }, addNotch: true }, fs);
    assert.equal(f.sections.length, 3);
    assert.equal(f.baseSections.length, 2);
    assert.ok(magnitudeDb(f.sections, fs, 50) <= -20, `${magnitudeDb(f.sections, fs, 50)}`);
    close(magnitudeDb(f.sections, fs, 200), 0, 0.3, 'passband');
    const m3 = measureMinus3dB(f.baseSections, fs);
    assert.equal(m3.freqs.length, 2);
    close(m3.freqs[0], 20, 0.05);
    close(m3.freqs[1], 450, 1);
    // perilaku v1 tanpa opsi: tidak berubah
    const plain = designFilter({ ...DEFAULT_FILTER_PARAMS, type: 'bpf' }, fs);
    assert.equal(plain.sections.length, 2);
    assert.equal(plain.baseSections, plain.sections);
    assert.equal(designFilter({ ...DEFAULT_FILTER_PARAMS, type: 'none', addNotch: true }, fs).sections.length, 1);
    assert.equal(designFilter({ ...DEFAULT_FILTER_PARAMS, type: 'notch', addNotch: true }, fs).sections.length, 1);
    assert.ok(FILTER_PRESETS.bpf.some((p) => p.fLow === 20 && p.fHigh === 450));
    assert.ok(FILTER_PRESETS.bpf.some((p) => p.fLow === 0.5 && p.fHigh === 70));
    assert.ok(FILTER_PRESETS.lpf.some((p) => p.fc === 30));
  });
  test('format: satuan sumbu otomatis µV / mV / V dan teks tegangan hingga nV', () => {
    assert.equal(voltUnit(40e-6).unit, 'µV');
    assert.equal(voltUnit(1.4e-3).unit, 'mV');
    assert.equal(voltUnit(0.99e-3).unit, 'mV');
    assert.equal(voltUnit(1.5).unit, 'V');
    close(voltUnit(40e-6).k, 1e6, 0);
    assert.equal(fmtVolt(2.4e-6), '2,40 µV');
    assert.equal(fmtVolt(2.4e-7), '240,00 nV'); // di bawah 1 µV ditampilkan dalam nV
    assert.equal(fmtVolt(2.4e-9), '2,40 nV');
    assert.equal(fmtTrim(2), '2');
    assert.equal(fmtTrim(2.5), '2,5');
    assert.equal(fmtTrim(2.25), '2,25');
  });
}
