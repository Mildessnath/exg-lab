/**
 * filters.js — Tahap 3: pengondisian sinyal (filter).
 *
 * Semua filter dibangun dari BIQUAD orde 2 (satu "section" = 2 pole + 2 zero):
 *
 *   H(z) = (b0 + b1·z⁻¹ + b2·z⁻²) / (1 + a1·z⁻¹ + a2·z⁻²)
 *
 * Koefisien memakai rumus "Audio EQ Cookbook" (R. Bristow-Johnson): prototipe
 * analog orde 2 → transformasi bilinear dengan pre-warping, sehingga frekuensi
 * cutoff/tengah digital tepat sama dengan nilai yang diminta.
 *
 * Pilihan desain:
 *  - LPF & HPF: Butterworth orde 2 (Q = 1/√2). Butterworth dipilih karena respons
 *    magnitudonya paling datar di passband (tanpa riak), sehingga amplitudo
 *    gelombang ECG di passband tidak dibesar-besarkan, dan |H(fc)| = −3,01 dB
 *    tepat di frekuensi cutoff. Kemiringan transisi 12 dB/oktaf.
 *  - BPF: kaskade HPF Butterworth + LPF Butterworth (bukan satu biquad bandpass).
 *    Biquad bandpass tunggal hanya punya satu parameter Q sehingga puncaknya
 *    runcing dan tidak datar untuk pita lebar seperti 0,5–40 Hz (rasio ~80×).
 *    Dengan kaskade, kedua tepi pita dapat diatur independen dan passband datar.
 *    Konsekuensi: untuk pita sempit (mis. 5–15 Hz) skirt kedua filter saling
 *    menimpa sehingga gain puncak turun di bawah 0 dB (≈ −0,9 dB) dan titik
 *    −3 dB terukur (relatif terhadap puncak) bergeser dari nilai desain — lihat
 *    nilai terukur di UI.
 *  - Notch: biquad notch cookbook dengan nol tepat di f0 (redaman teoretis tak
 *    hingga) dan lebar pita −3 dB ≈ f0/Q. Q tinggi = takik sempit (hanya 50 Hz
 *    yang dibuang); Q rendah = takik lebar yang ikut memakan komponen ECG.
 *
 * Filter diterapkan secara KAUSAL (hanya maju), seperti filter perangkat keras
 * atau monitor waktu-nyata. Akibatnya ada delay dan distorsi fase non-linear —
 * bagian dari pelajaran Eksperimen 2.
 *
 * Presisi: pada fs = 10 kHz, HPF 0,5 Hz punya pole sangat dekat lingkaran satuan
 * (|p| ≈ 1 − 3·10⁻⁴). Dengan float64 dan struktur Transposed Direct Form II
 * hal ini masih stabil dan akurat.
 *
 * Semua fungsi murni.
 */

export const BUTTERWORTH_Q = Math.SQRT1_2;
const MINUS_3DB = 10 * Math.log10(2); // 3,0103 dB (setengah daya)

/** Preset per jenis filter (minimal dua per jenis, sesuai tugas). */
export const FILTER_PRESETS = Object.freeze({
  lpf: [
    { label: '40 Hz (monitor)', fc: 40 },
    { label: '100 Hz (diagnostik)', fc: 100 },
    { label: '15 Hz (terlalu rendah)', fc: 15 },
  ],
  hpf: [
    { label: '0,5 Hz (monitor)', fc: 0.5 },
    { label: '5 Hz (berlebihan)', fc: 5 },
    { label: '0,05 Hz (diagnostik)', fc: 0.05 },
  ],
  bpf: [
    { label: '0,5–40 Hz (monitor)', fLow: 0.5, fHigh: 40 },
    { label: '5–15 Hz (deteksi QRS)', fLow: 5, fHigh: 15 },
  ],
  notch: [
    { label: '50 Hz, Q = 30', f0: 50, q: 30 },
    { label: '50 Hz, Q = 5', f0: 50, q: 5 },
  ],
});

export const DEFAULT_FILTER_PARAMS = Object.freeze({
  type: 'bpf', // 'none' | 'lpf' | 'hpf' | 'bpf' | 'notch'
  lpf: { fc: 40 },
  hpf: { fc: 0.5 },
  bpf: { fLow: 0.5, fHigh: 40 },
  notch: { f0: 50, q: 30 },
});

// ---------------------------------------------------------------------------
// Desain koefisien biquad
// ---------------------------------------------------------------------------

/** Parameter antara cookbook: cos(w0) dan α = sin(w0)/(2Q). */
function cookbook(f, fs, q) {
  // Batasi agar tetap di (0, Nyquist) — di luar itu transformasi bilinear tak bermakna.
  const fc = Math.min(Math.max(f, 1e-6), 0.499 * fs);
  const w0 = (2 * Math.PI * fc) / fs;
  return { cosw: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) };
}

/** Normalisasi a0 = 1. */
function normalize(b, a) {
  const a0 = a[0];
  return { b: b.map((v) => v / a0), a: [1, a[1] / a0, a[2] / a0] };
}

/** LPF orde 2 (Butterworth bila q = 1/√2). */
export function designLowpass(fc, fs, q = BUTTERWORTH_Q) {
  const { cosw, alpha } = cookbook(fc, fs, q);
  return normalize([(1 - cosw) / 2, 1 - cosw, (1 - cosw) / 2], [1 + alpha, -2 * cosw, 1 - alpha]);
}

/** HPF orde 2 (Butterworth bila q = 1/√2). */
export function designHighpass(fc, fs, q = BUTTERWORTH_Q) {
  const { cosw, alpha } = cookbook(fc, fs, q);
  return normalize([(1 + cosw) / 2, -(1 + cosw), (1 + cosw) / 2], [1 + alpha, -2 * cosw, 1 - alpha]);
}

/** Frekuensi cutoff RC: fc = 1 / (2πRC). */
export function rcCutoff(r, c) {
  return 1 / (2 * Math.PI * r * c);
}

/**
 * LPF RC orde 1 (H(s) = 1 / (1 + sRC)) didigitalkan dengan bilinear + pre-warping,
 * sehingga |H(fc)| = −3,01 dB tepat di fc analog. Disimpan dalam format biquad
 * (b2 = a2 = 0) agar bisa memakai fungsi respons/penerapan yang sama.
 */
export function designRcLowpass(fc, fs) {
  const k = Math.tan((Math.PI * Math.min(fc, 0.499 * fs)) / fs);
  return { b: [k / (1 + k), k / (1 + k), 0], a: [1, (k - 1) / (k + 1), 0] };
}

/** Notch orde 2: nol di f0, lebar pita −3 dB ≈ f0/Q. */
export function designNotch(f0, fs, q = 30) {
  const { cosw, alpha } = cookbook(f0, fs, q);
  return normalize([1, -2 * cosw, 1], [1 + alpha, -2 * cosw, 1 - alpha]);
}

/** Angka dengan koma desimal untuk label UI berbahasa Indonesia. */
const id = (v) => String(v).replace('.', ',');

/**
 * Menerjemahkan parameter UI menjadi daftar section biquad.
 * @returns {{ type, sections: Array<{b,a}>, label: string, design: object }}
 */
export function designFilter(params, fs) {
  const p = { ...DEFAULT_FILTER_PARAMS, ...params };
  switch (p.type) {
    case 'lpf':
      return {
        type: 'lpf', label: `LPF Butterworth orde 2, fc = ${id(p.lpf.fc)} Hz`,
        design: { fc: p.lpf.fc }, sections: [designLowpass(p.lpf.fc, fs)],
      };
    case 'hpf':
      return {
        type: 'hpf', label: `HPF Butterworth orde 2, fc = ${id(p.hpf.fc)} Hz`,
        design: { fc: p.hpf.fc }, sections: [designHighpass(p.hpf.fc, fs)],
      };
    case 'bpf':
      return {
        type: 'bpf', label: `BPF = HPF ${id(p.bpf.fLow)} Hz + LPF ${id(p.bpf.fHigh)} Hz (Butterworth, 2 biquad)`,
        design: { fLow: p.bpf.fLow, fHigh: p.bpf.fHigh },
        sections: [designHighpass(p.bpf.fLow, fs), designLowpass(p.bpf.fHigh, fs)],
      };
    case 'notch':
      return {
        type: 'notch', label: `Notch orde 2, f0 = ${id(p.notch.f0)} Hz, Q = ${id(p.notch.q)}`,
        design: { f0: p.notch.f0, q: p.notch.q, bw: p.notch.f0 / p.notch.q },
        sections: [designNotch(p.notch.f0, fs, p.notch.q)],
      };
    default:
      return { type: 'none', label: 'Tanpa filter (bypass)', design: {}, sections: [] };
  }
}

// ---------------------------------------------------------------------------
// Penerapan filter
// ---------------------------------------------------------------------------

/**
 * Satu biquad, struktur Transposed Direct Form II.
 * State awal diisi kondisi tunak untuk masukan konstan `u0` (seperti lfilter_zi
 * di SciPy) agar tidak muncul lonjakan transien buatan di awal plot. Bawaannya
 * u0 = rerata sinyal: seolah filter sudah lama berjalan sebelum t = 0. Dengan
 * x[0] saja, offset DC ECG akan meluruh berdetik-detik pada HPF 0,05 Hz.
 */
export function applyBiquad(x, { b, a }, u0 = mean(x)) {
  const n = x.length;
  const y = new Float64Array(n);
  if (!n) return y;
  const [b0, b1, b2] = b;
  const [, a1, a2] = a;
  const dcGain = (b0 + b1 + b2) / (1 + a1 + a2);
  const u = u0;
  const yss = dcGain * u;
  let z1 = yss - b0 * u;
  let z2 = b2 * u - a2 * yss;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  return y;
}

function mean(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

/** Kaskade beberapa biquad. Tanpa section → salinan masukan. */
export function applyCascade(x, sections) {
  let y = Float64Array.from(x);
  for (const s of sections) y = applyBiquad(y, s);
  return y;
}

/** Bypass: mengembalikan salinan sinyal tanpa perubahan. */
export function bypass(x) {
  return Float64Array.from(x);
}

/** Tahap filter untuk pipeline: desain + terapkan. */
export function applyFilterSpec(x, fs, params) {
  const filter = designFilter(params, fs);
  return { y: applyCascade(x, filter.sections), filter, fs };
}

// ---------------------------------------------------------------------------
// Respons frekuensi
// ---------------------------------------------------------------------------

/** |H(f)| dalam dB untuk kaskade section, dievaluasi pada z = e^{jω}. */
export function magnitudeDb(sections, fs, f) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w), s1 = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let db = 0;
  for (const { b, a } of sections) {
    // z⁻¹ = cos ω − j sin ω, z⁻² = cos 2ω − j sin 2ω
    const nr = b[0] + b[1] * c1 + b[2] * c2;
    const ni = -(b[1] * s1 + b[2] * s2);
    const dr = 1 + a[1] * c1 + a[2] * c2;
    const di = -(a[1] * s1 + a[2] * s2);
    const num = nr * nr + ni * ni;
    const den = dr * dr + di * di;
    db += 10 * Math.log10(Math.max(num, 1e-30) / den);
  }
  return db;
}

/** n titik berjarak logaritmik dari f1 hingga f2. */
export function logspace(f1, f2, n) {
  const out = new Float64Array(n);
  const l1 = Math.log10(f1), l2 = Math.log10(f2);
  for (let i = 0; i < n; i++) out[i] = 10 ** (l1 + ((l2 - l1) * i) / (n - 1));
  return out;
}

/** Respons magnitudo pada sekumpulan frekuensi. */
export function frequencyResponse(sections, fs, freqs) {
  const db = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) db[i] = magnitudeDb(sections, fs, freqs[i]);
  return db;
}

/**
 * Mengukur titik −3 dB dari respons frekuensi (bukan dari rumus desain):
 * cari semua perpotongan |H| dengan (gain maksimum − 3,01 dB) pada grid log yang
 * rapat, lalu perhalus tiap perpotongan dengan bisection.
 * @returns {{ refDb: number, levelDb: number, freqs: number[] }}
 */
export function measureMinus3dB(sections, fs, { fMin = 0.001, fMax = 0.499 * fs, points = 6000 } = {}) {
  if (!sections.length) return { refDb: 0, levelDb: -MINUS_3DB, freqs: [] };
  const grid = logspace(fMin, fMax, points);
  const db = frequencyResponse(sections, fs, grid);
  let refDb = -Infinity;
  for (const v of db) if (v > refDb) refDb = v;
  const level = refDb - MINUS_3DB;
  const g = (f) => magnitudeDb(sections, fs, f) - level;
  const freqs = [];
  for (let i = 1; i < grid.length; i++) {
    const s0 = db[i - 1] - level, s1 = db[i] - level;
    if (s0 === 0) { freqs.push(grid[i - 1]); continue; }
    if (s0 * s1 < 0) {
      let lo = Math.log10(grid[i - 1]), hi = Math.log10(grid[i]);
      const sLo = Math.sign(s0);
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(g(10 ** mid)) === sLo) lo = mid; else hi = mid;
      }
      freqs.push(10 ** ((lo + hi) / 2));
    }
  }
  return { refDb, levelDb: level, freqs };
}

// ---------------------------------------------------------------------------
// Spektrum (FFT)
// ---------------------------------------------------------------------------

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** FFT radix-2 iteratif, in-place. Panjang harus pangkat 2. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len >> 1;
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = k; i < n; i += len) {
        const j = i + half;
        const tr = re[j] * wr - im[j] * wi;
        const ti = re[j] * wi + im[j] * wr;
        re[j] = re[i] - tr; im[j] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
    }
  }
}

/**
 * Spektrum amplitudo satu sisi dengan jendela Hann.
 * Rerata (DC) dibuang dulu: komponen DC tidak informatif di sini dan kebocoran
 * jendelanya akan menutupi baseline wander 0,3 Hz di bin-bin terbawah.
 * Amplitudo dikoreksi coherent gain jendela sehingga sinus beramplitudo A
 * terbaca ≈ A di puncaknya (kurang ≤ 1,4 dB bila frekuensinya jatuh di antara bin).
 * @returns {{ f: Float64Array, amp: Float64Array, df: number }}
 */
export function amplitudeSpectrum(x, fs) {
  const n = x.length;
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1 || 1));
    wsum += w;
    re[i] = (x[i] - mean) * w;
  }
  fft(re, im);
  const m = N / 2 + 1;
  const f = new Float64Array(m);
  const amp = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    f[k] = (k * fs) / N;
    amp[k] = ((k === 0 || k === N / 2 ? 1 : 2) * Math.hypot(re[k], im[k])) / (wsum || 1);
  }
  return { f, amp, df: fs / N };
}

// ---------------------------------------------------------------------------
// Evaluasi: apakah filter mempertahankan informasi fisiologis?
// ---------------------------------------------------------------------------

/**
 * Estimasi delay (s) keluaran terhadap referensi lewat korelasi silang.
 * Pencarian kasar pada sinyal yang didesimasi, lalu diperhalus di laju penuh.
 * Rentang mencakup delay negatif karena HPF memberi fase mendahului.
 */
export function estimateDelay(ref, y, fs, { minDelay = -0.05, maxDelay = 0.1 } = {}) {
  const n = Math.min(ref.length, y.length);
  const corr = (lag, step) => {
    let s = 0;
    const i0 = Math.max(0, -lag), i1 = Math.min(n, n - lag);
    for (let i = i0; i < i1; i += step) s += ref[i] * y[i + lag];
    return s;
  };
  const dec = Math.max(1, Math.round(fs / 1000));
  let best = 0, bestVal = -Infinity;
  for (let lag = Math.round(minDelay * fs); lag <= Math.round(maxDelay * fs); lag += dec) {
    const v = corr(lag, dec);
    if (v > bestVal) { bestVal = v; best = lag; }
  }
  const coarse = best;
  for (let lag = coarse - dec; lag <= coarse + dec; lag++) {
    const v = corr(lag, 1);
    if (v > bestVal) { bestVal = v; best = lag; }
  }
  return best / fs;
}

/**
 * Metrik kualitas keluaran filter terhadap referensi bersih (G × ECG tanpa gangguan).
 * Keluaran disejajarkan dulu dengan delay terestimasi supaya galat yang dihitung
 * adalah distorsi bentuk, bukan sekadar pergeseran waktu. Semua besaran diukur
 * relatif terhadap garis dasar (segmen PR / rerata), sebab offset DC tidak
 * membawa informasi fisiologis dan memang wajar dibuang oleh HPF.
 *  - rRatio: tinggi R di atas segmen PR, terfilter / referensi (rerata semua denyut)
 *  - stDev / stDevRef: level ST (R+100 ms) dikurangi level PR (R−90 ms)
 *  - snrDb: daya referensi / daya galat, keduanya setelah rerata dibuang
 * @param {{ ref, y, fs, rPeaks?: number[], skip?: number }} o
 */
export function filterQualityMetrics({ ref, y, fs, rPeaks = [], skip = 0.5 }) {
  const delay = estimateDelay(ref, y, fs);
  const d = Math.round(delay * fs);
  const n = ref.length;
  const i0 = Math.max(Math.round(skip * fs), -d);
  const i1 = Math.min(n, n - d);
  let mRef = 0, mY = 0;
  for (let i = i0; i < i1; i++) { mRef += ref[i]; mY += y[i + d]; }
  mRef /= Math.max(1, i1 - i0);
  mY /= Math.max(1, i1 - i0);
  let pe = 0, pr = 0, cnt = 0;
  for (let i = i0; i < i1; i++) {
    const e = (y[i + d] - mY) - (ref[i] - mRef);
    pe += e * e;
    pr += (ref[i] - mRef) ** 2;
    cnt++;
  }
  const win = Math.round(0.02 * fs);
  const stOff = Math.round(0.1 * fs), prOff = Math.round(0.09 * fs);
  let rSum = 0, rCnt = 0, st = 0, stRef = 0, stCnt = 0;
  for (const p of rPeaks) {
    const q = p + d;
    if (p < i0 || q - win < 0 || q + win >= n || p + stOff >= n || q + stOff >= n || p - prOff < 0 || q - prOff < 0) continue;
    let mx = -Infinity;
    for (let i = q - win; i <= q + win; i++) if (y[i] > mx) mx = y[i];
    const rRef = ref[p] - ref[p - prOff];
    if (rRef !== 0) { rSum += (mx - y[q - prOff]) / rRef; rCnt++; }
    st += y[q + stOff] - y[q - prOff];
    stRef += ref[p + stOff] - ref[p - prOff];
    stCnt++;
  }
  return {
    delay,
    rmse: cnt ? Math.sqrt(pe / cnt) : NaN,
    snrDb: pe > 0 ? 10 * Math.log10(pr / pe) : Infinity,
    rRatio: rCnt ? rSum / rCnt : NaN,
    stDev: stCnt ? st / stCnt : NaN,
    stDevRef: stCnt ? stRef / stCnt : NaN,
    beats: stCnt,
  };
}
