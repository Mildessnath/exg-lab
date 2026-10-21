/**
 * tests/dipole.test.js — Tes model dipol jantung dan pilihan sadapan.
 * Dipanggil dari tests/run.js:  dipoleTests({ test, close })
 *
 * Ambang batas diambil dari pengukuran nyata terhadap model (nilai terukur disebut di komentar).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { THREE_REVISION, createViewer } from '../js/viewer3d.js';
import { FS_ANALOG, DEFAULT_SIGNAL_PARAMS, generateSignal, synthEcg, makeTimeAxis, detectRPeaks } from '../js/signal.js';
import { runPipeline, DEFAULT_PARAMS } from '../js/pipeline.js';
import { defaultParams } from '../js/profiles/params.js';
import { getProfile, validateProfile } from '../js/profiles/index.js';
import { ECG_WAVES } from '../js/profiles/ecg-waves.js';
import {
  LEADS, LEAD_IDS, DEFAULT_LEAD, getLead, WAVE_DIRECTIONS, waveVectors, leadWaveAmplitudes, leadSignal,
  dipoleSeries, dipoleAt, projectOnLead, vcgLoop, frontalAngleDeg, ELECTRODES, HEART_POS, TORSO, MODEL_NOTES,
} from '../js/cardiac-dipole.js';

const sha = (a) => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const maxAbs = (n, f) => { let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(f(i))); return m; };

export function dipoleTests({ test, close }) {
  const fs = FS_ANALOG;
  const REF = JSON.parse(readFileSync(new URL('./fixtures/ecg-reference.json', import.meta.url), 'utf8'));
  const sigmaOf = (hr, rAmp, dur = 5) => ({ fs, duration: dur, hr, rAmp });
  /** Semua 12 sadapan untuk satu konfigurasi. */
  const allLeads = (hr = 72, rAmp = 1e-3, dur = 5) => {
    const t = makeTimeAxis(dur, fs);
    return { t, L: Object.fromEntries(LEAD_IDS.map((id) => [id, leadSignal(t, sigmaOf(hr, rAmp, dur), id)])) };
  };

  // =========================================================================
  console.log('model dipol: sadapan II dan identitas sadapan');
  // =========================================================================
  test('sadapan II dari model dipol = generator ECG lama (toleransi 1 %; terukur 2e-16 relatif)', () => {
    for (const [hr, rAmp, dur] of [[72, 1e-3, 5], [55, 2e-3, 10], [150, 0.5e-3, 3]]) {
      const t = makeTimeAxis(dur, fs);
      const ecg = synthEcg({ duration: dur, fs, hr, rAmp });
      const ii = leadSignal(t, sigmaOf(hr, rAmp, dur), 'II');
      const err = maxAbs(ecg.length, (i) => ii[i] - ecg[i]) / maxAbs(ecg.length, (i) => ecg[i]);
      assert.ok(err < 0.01, `hr ${hr}: galat relatif ${err}`);
      assert.ok(err < 1e-12, `jauh lebih kecil dari 1 %: ${err}`);
    }
  });
  test('hukum Einthoven I + III = II pada setiap sampel (berbagai HR dan amplitudo)', () => {
    for (const [hr, rAmp] of [[72, 1e-3], [40, 3e-3], [150, 0.2e-3]]) {
      const { t, L } = allLeads(hr, rAmp, 4);
      const peak = maxAbs(t.length, (i) => L.II[i]);
      const err = maxAbs(t.length, (i) => L.I[i] + L.III[i] - L.II[i]);
      assert.ok(err <= 1e-12 * peak, `hr ${hr}: ${err} vs puncak ${peak}`);
    }
  });
  test('aVR + aVL + aVF = 0, aVR = −(I + II)/2, aVL = (I − III)/2, aVF = (II + III)/2', () => {
    const { t, L } = allLeads(72, 1e-3, 5);
    const peak = maxAbs(t.length, (i) => L.II[i]);
    const tol = 1e-12 * peak;
    assert.ok(maxAbs(t.length, (i) => L.aVR[i] + L.aVL[i] + L.aVF[i]) <= tol, 'jumlah augmented');
    assert.ok(maxAbs(t.length, (i) => L.aVR[i] + (L.I[i] + L.II[i]) / 2) <= tol, 'aVR');
    assert.ok(maxAbs(t.length, (i) => L.aVL[i] - (L.I[i] - L.III[i]) / 2) <= tol, 'aVL');
    assert.ok(maxAbs(t.length, (i) => L.aVF[i] - (L.II[i] + L.III[i]) / 2) <= tol, 'aVF');
  });
  test('hukum yang sama berlaku pada sinyal yang keluar dari generateSignal (profil ECG, pilihan sadapan)', () => {
    const g = (lead) => generateSignal({ ...DEFAULT_SIGNAL_PARAMS, lead }).clean;
    const I = g('I'), II = g('II'), III = g('III'), aVR = g('aVR'), aVL = g('aVL'), aVF = g('aVF');
    const peak = maxAbs(II.length, (i) => II[i]);
    assert.ok(maxAbs(II.length, (i) => I[i] + III[i] - II[i]) <= 1e-12 * peak, 'Einthoven');
    assert.ok(maxAbs(II.length, (i) => aVR[i] + aVL[i] + aVF[i]) <= 1e-12 * peak, 'augmented');
    assert.ok(maxAbs(II.length, (i) => aVR[i] + (I[i] + II[i]) / 2) <= 1e-12 * peak, 'aVR');
  });

  // =========================================================================
  console.log('model dipol: pilihan sadapan pada pipeline');
  // =========================================================================
  test('sadapan II = hasil lama: tanpa parameter lead, lead "II", dan lead tak dikenal identik bit-per-bit dengan fixture v1', () => {
    const a = generateSignal(DEFAULT_SIGNAL_PARAMS).clean;
    assert.equal(sha(a), REF.ecgDefault.clean.sha256);
    assert.equal(sha(generateSignal({ ...DEFAULT_SIGNAL_PARAMS, lead: 'II' }).clean), REF.ecgDefault.clean.sha256);
    assert.equal(sha(generateSignal({ ...DEFAULT_SIGNAL_PARAMS, lead: 'tidak-ada' }).clean), REF.ecgDefault.clean.sha256);
    const r = runPipeline({ ...DEFAULT_PARAMS, signal: { ...DEFAULT_SIGNAL_PARAMS, lead: 'II' } });
    assert.equal(sha(r.stages.adc.quant.codes), REF.pipelineDefault.codes.sha256, 'kode ADC pipeline');
    assert.equal(sha(r.stages.amp.y), REF.pipelineDefault.amp.sha256, 'keluaran amplifier');
  });
  test('memilih sadapan lain mengubah keluaran pipeline (12 sadapan → 12 keluaran berbeda); kembali ke II mengembalikan hasil lama', () => {
    const digestOf = (lead) => {
      const prm = defaultParams('ecg');
      prm.signal.lead = lead;
      const r = runPipeline(prm);
      return [sha(r.stages.ecg.x), sha(r.stages.amp.y), sha(r.stages.adc.quant.codes)].join('|');
    };
    const base = digestOf('II');
    const seen = new Map([[base, 'II']]);
    for (const id of LEAD_IDS.filter((x) => x !== 'II')) {
      const d = digestOf(id);
      assert.ok(!seen.has(d), `sadapan ${id} menghasilkan keluaran yang sama dengan ${seen.get(d)}`);
      seen.set(d, id);
    }
    assert.equal(seen.size, 12);
    assert.equal(digestOf('V3'), digestOf('V3'), 'deterministik');
    assert.equal(digestOf('II'), base, 'kembali ke II = hasil semula');
  });
  test('generateSignal(lead) = leadSignal dari model dipol untuk sadapan selain II', () => {
    for (const id of ['I', 'III', 'aVL', 'V1', 'V5']) {
      const g = generateSignal({ ...DEFAULT_SIGNAL_PARAMS, lead: id, hr: 90, rAmp: 1.5e-3, duration: 3 }).clean;
      const t = makeTimeAxis(3, fs);
      const ref = leadSignal(t, sigmaOf(90, 1.5e-3, 3), id);
      assert.equal(sha(g), sha(ref), id);
    }
  });
  test('profil ECG: kontrol "Sadapan" = 12 sadapan, bawaan II, dikelompokkan ekstremitas/prekordial; profil lain tanpa kontrol itu', () => {
    const ecg = getProfile('ecg');
    const c = ecg.controls.find((x) => x.key === 'lead');
    assert.ok(c && c.type === 'select' && c.def === 'II');
    assert.deepEqual(c.options.map((o) => o[0]), LEAD_IDS);
    assert.deepEqual([...new Set(c.options.map((o) => o[2]))].length, 2);
    assert.equal(ecg.defaults.lead, 'II');
    assert.deepEqual(validateProfile(ecg), []);
    for (const id of ['emg', 'eeg', 'eog', 'sine']) assert.ok(!getProfile(id).controls.some((x) => x.key === 'lead'), id);
    // info profil memuat sadapan terpilih, dan HR tetap terdeteksi pada sadapan dengan R negatif
    for (const id of ['aVR', 'V1']) {
      const sig = generateSignal({ ...DEFAULT_SIGNAL_PARAMS, lead: id });
      const rows = Object.fromEntries(ecg.info({ p: sig.params, clean: sig.clean, x: sig.x, fs }));
      assert.ok(rows.Sadapan.startsWith(id), rows.Sadapan);
      assert.match(rows['HR terdeteksi dari puncak R'], /^72,0 bpm \(6 denyut\)/, `${id}: ${rows['HR terdeteksi dari puncak R']}`);
    }
  });

  // =========================================================================
  console.log('model dipol: arah gelombang dan vektor sadapan');
  // =========================================================================
  test('tiap gelombang punya arah 3D sendiri: satuan, berbeda, bertanda sama dengan amplitudo pada sadapan II (m > 0)', () => {
    const names = ECG_WAVES.map((w) => w.nama);
    assert.deepEqual(Object.keys(WAVE_DIRECTIONS), names);
    for (const n of names) close(len(WAVE_DIRECTIONS[n]), 1, 1e-12, `|d_${n}|`);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      assert.ok(len(WAVE_DIRECTIONS[names[i]].map((v, k) => v - WAVE_DIRECTIONS[names[j]][k])) > 0.05, `${names[i]} vs ${names[j]}`);
    }
    for (const w of waveVectors(1e-3)) assert.ok(w.mag > 0, `${w.nama}: besar vektor ${w.mag}`);
    // amplitudo dan waktu gaussian berasal dari generator ECG yang ada
    for (const w of waveVectors(2e-3)) {
      const ref = ECG_WAVES.find((x) => x.nama === w.nama);
      assert.equal(w.offset, ref.offset); assert.equal(w.sigma, ref.sigma);
      close(dot(w.vec, getLead('II').vec), ref.amp * 2e-3, 1e-15, `proyeksi ${w.nama} pada II`);
    }
  });
  test('sumbu frontal QRS (R) ≈ +60°; P ≈ +50°, T ≈ +45°; R mengarah ke belakang, Q ke depan', () => {
    close(frontalAngleDeg(WAVE_DIRECTIONS.R), 60, 0.01);
    close(frontalAngleDeg(WAVE_DIRECTIONS.P), 50, 0.01);
    close(frontalAngleDeg(WAVE_DIRECTIONS.T), 45, 0.01);
    assert.ok(WAVE_DIRECTIONS.R[2] < 0 && WAVE_DIRECTIONS.Q[2] > 0);
    assert.ok(WAVE_DIRECTIONS.R[0] > 0 && WAVE_DIRECTIONS.R[1] < 0, 'kiri-bawah');
  });
  test('vektor sadapan: I/II/III satuan di 0°/60°/120° (L_I + L_III = L_II eksak); augmented |L| = √3/2; prekordial = arah pusat jantung → elektrode', () => {
    const v = (id) => getLead(id).vec;
    for (const [id, ang] of [['I', 0], ['II', 60], ['III', 120]]) {
      close(len(v(id)), 1, 1e-12, id);
      close(frontalAngleDeg(v(id)), ang, 1e-9, `sudut ${id}`);
    }
    for (let k = 0; k < 3; k++) assert.equal(v('I')[k] + v('III')[k], v('II')[k]);
    for (const id of ['aVR', 'aVL', 'aVF']) close(len(v(id)), Math.sqrt(3) / 2, 1e-12, id);
    // sumbu hexaksial standar: aVR −150°, aVL −30°, aVF +90°
    close(frontalAngleDeg(v('aVR')), -150, 1e-9); close(frontalAngleDeg(v('aVL')), -30, 1e-9); close(frontalAngleDeg(v('aVF')), 90, 1e-9);
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']) {
      const e = ELECTRODES[id];
      const d = [e[0] - HEART_POS[0], e[1] - HEART_POS[1], e[2] - HEART_POS[2]];
      close(len(v(id)), 1, 1e-12, id);
      close(dot(v(id), d) / len(d), 1, 1e-12, `${id} searah pusat jantung → elektrode`);
      assert.equal(getLead(id).kualitatif, true, `${id} ditandai kualitatif`);
    }
    assert.equal(LEADS.length, 12);
    assert.equal(getLead('xyz').id, DEFAULT_LEAD);
  });
  test('geometri sketsa: elektrode dada di permukaan torso elips; V1→V6 bergerak ke kiri pasien berurutan; jantung di dalam torso', () => {
    let prev = -Infinity;
    for (const id of ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']) {
      const [x, , z] = ELECTRODES[id];
      close((x * x) / (TORSO.a ** 2) + (z * z) / (TORSO.b ** 2), 1, 1e-12, `${id} di permukaan`);
      assert.ok(x > prev, `${id} lebih ke kiri`); prev = x;
      assert.ok(z > 0, 'di dada (anterior)');
    }
    const [hx, , hz] = HEART_POS;
    assert.ok((hx * hx) / (TORSO.a ** 2) + (hz * hz) / (TORSO.b ** 2) < 1, 'jantung di dalam torso');
    assert.ok(hx > 0, 'jantung sedikit ke kiri');
  });

  // =========================================================================
  console.log('model dipol: pola kualitatif');
  // =========================================================================
  test('pola kualitatif: V1 rS, V6 qR, transisi V3–V5, aVR terbalik, aVL ≈ isoelektrik, I/II/aVF positif', () => {
    // terukur (mV) — V1: Q +0,195 R −0,623 | V6: Q −0,182 R +0,677 | QRS neto V1…V6 = −0,44 −0,45 −0,26 +0,02 +0,22 +0,32
    const a = (id) => leadWaveAmplitudes(id, 1e-3);
    const net = (id) => { const x = a(id); return x.Q + x.R + x.S; };
    assert.ok(a('V1').Q > 0 && a('V1').R < 0, 'V1: r kecil lalu defleksi negatif dalam');
    assert.ok(a('V6').Q < 0 && a('V6').R > 0, 'V6: q kecil lalu R tinggi');
    assert.ok(net('V1') < 0 && net('V2') < 0 && net('V3') < 0, 'V1–V3 neto negatif');
    assert.ok(net('V5') > 0 && net('V6') > 0, 'V5–V6 neto positif');
    assert.ok(Math.abs(net('V4')) < 0.1 * Math.abs(net('V1')), 'zona transisi di V4');
    for (const k of ['P', 'R', 'T']) assert.ok(a('aVR')[k] < 0, `aVR ${k} terbalik`);
    assert.ok(Math.abs(a('aVL').R) < 1e-3 * a('II').R, 'aVL isoelektrik untuk sumbu QRS +60° (tegak lurus)');
    for (const id of ['I', 'II', 'aVF']) assert.ok(a(id).R > 0 && a(id).T > 0, `${id} R dan T positif`);
    assert.ok(a('II').R > a('I').R && a('II').R > a('III').R, 'R tertinggi di II untuk sumbu +60°');
  });
  test('linearitas dan waktu: rAmp mengalikan seluruh sadapan; HR mengatur jarak puncak R; semua sadapan sefase dengan II', () => {
    const t = makeTimeAxis(5, fs);
    for (const id of ['I', 'aVR', 'V2', 'V6']) {
      const a = leadSignal(t, sigmaOf(72, 1e-3), id), b = leadSignal(t, sigmaOf(72, 2.5e-3), id);
      assert.ok(maxAbs(t.length, (i) => b[i] - 2.5 * a[i]) <= 1e-12 * maxAbs(t.length, (i) => b[i]), id);
    }
    for (const hr of [60, 100]) {
      const pk = detectRPeaks(leadSignal(t, sigmaOf(hr, 1e-3), 'II'), fs);
      const rr = (pk[pk.length - 1] - pk[0]) / (pk.length - 1) / fs;
      close(rr, 60 / hr, 1e-3, `RR pada ${hr} bpm`);
    }
    // saat dipol maksimum (puncak R), setiap sadapan sama dengan v_R · L
    // (dibandingkan secara absolut terhadap gelombang terbesar sadapan itu: pada aVL R ≈ 0)
    const iR = Math.round(0.3 * fs); // R pertama di 0,3 s
    for (const id of LEAD_IDS) {
      const a = leadWaveAmplitudes(id, 1e-3);
      const big = Math.max(...Object.values(a).map(Math.abs));
      const v = leadSignal(t, sigmaOf(72, 1e-3), id)[iR];
      assert.ok(Math.abs(v - a.R) <= 0.06 * big, `${id}: sinyal ${v} vs R ${a.R} (gelombang terbesar ${big})`);
    }
  });
  test('dipoleAt = dipoleSeries; H·L = leadSignal; vcgLoop berawal/berakhir ≈ 0 dan puncaknya = besar vektor R', () => {
    const t = makeTimeAxis(5, fs);
    const p = { hr: 72, rAmp: 1e-3 };
    const H = dipoleSeries(t, { fs, duration: 5, ...p });
    for (const i of [0, 100, 3000, 3017, 5000, 12345, 40000, 49999]) {
      const h = dipoleAt(t[i], p);
      for (let c = 0; c < 3; c++) close(h[c], [H.x, H.y, H.z][c][i], 1e-12 * 1e-3 + 1e-15, `H[${c}] @${i}`);
    }
    for (const id of ['I', 'V4', 'aVR']) {
      const ls = leadSignal(t, { fs, duration: 5, ...p }, id);
      for (const i of [3000, 3017, 3100, 12345]) close(projectOnLead([H.x[i], H.y[i], H.z[i]], id), ls[i], 1e-15, `${id} @${i}`);
    }
    const loop = vcgLoop(p);
    const mag = (i) => Math.hypot(loop.points[3 * i], loop.points[3 * i + 1], loop.points[3 * i + 2]);
    let pk = 0;
    for (let i = 0; i < loop.n; i++) pk = Math.max(pk, mag(i));
    assert.ok(mag(0) < 0.005 * pk && mag(loop.n - 1) < 0.005 * pk, `awal ${mag(0)} akhir ${mag(loop.n - 1)} puncak ${pk}`);
    close(pk, waveVectors(1e-3).find((w) => w.nama === 'R').mag, 0.06 * 1.06e-3, '|H| puncak ≈ vektor R');
    close(loop.span, 60 / 72, 1e-12, 'satu denyut = RR');
  });
  // =========================================================================
  console.log('visualisasi 3D: berkas vendor dan modul');
  // =========================================================================
  test('Three.js vendor terkunci: SHA-256 dan revisi 149 sesuai catatan; viewer menuntut revisi yang sama', () => {
    const buf = readFileSync(new URL('../js/vendor/three.min.js', import.meta.url));
    assert.equal(createHash('sha256').update(buf).digest('hex'), '8a5f7249903b54d30f79f708699d2fed2d6a1d0741a4cd41377d1f01bb5a2271');
    assert.equal(buf.length, 608081);
    const head = buf.subarray(0, 700).toString('utf8');
    assert.ok(head.includes('SPDX-License-Identifier: MIT'), 'lisensi MIT tetap ada di berkas');
    assert.ok(buf.toString('utf8').includes('const e="149"'), 'konstanta REVISION = 149');
    assert.ok(!buf.subarray(0, 400).toString('utf8').includes('console.warn'), 'tanpa peringatan deprecation (r150+ memilikinya)');
    // viewer3d.js diimpor statis di atas: berhasil tanpa DOM (DOM hanya dipakai di dalam fungsi)
    assert.equal(THREE_REVISION, '149');
    assert.equal(typeof createViewer, 'function');
  });
  test('dokumentasi: catatan asumsi dan keterbatasan model tersedia dan menyebut dipol tunggal, bukan volume conductor, kualitatif, bukan klinis', () => {
    const txt = MODEL_NOTES.join(' ');
    for (const k of ['dipol tunggal', 'volume conductor', 'kualitatif', 'klinis', 'Einthoven']) assert.ok(txt.includes(k), k);
  });
}
