/**
 * cardiac-dipole.js — Model dipol jantung tunggal dan proyeksi sadapan.
 * Fungsi murni, tanpa DOM; dipakai oleh profil ECG (pilihan sadapan) dan viewer 3D.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────┐
 * │ MODEL SEDERHANA, BUKAN UNTUK PENGGUNAAN KLINIS                               │
 * │  • SATU dipol listrik tetap di pusat jantung, H(t) (vektor 3D, satuan volt   │
 * │    ekuivalen). BUKAN model volume conductor: tidak ada geometri torso,       │
 * │    konduktivitas jaringan, paru, tulang, atau efek jarak elektrode.          │
 * │  • Sadapan ekstremitas memakai vektor sadapan Einthoven yang diidealkan.     │
 * │  • Sadapan prekordial V1–V6 hanyalah PERKIRAAN KUALITATIF (arah dari pusat   │
 * │    jantung ke posisi elektrode), bukan hasil perhitungan medan potensial.    │
 * └──────────────────────────────────────────────────────────────────────────────┘
 *
 * SISTEM KOORDINAT (tubuh pasien, mengikuti konvensi vektorkardiografi):
 *   +x = ke KIRI pasien        +y = ke ATAS (kepala)        +z = ke DEPAN (anterior)
 * Satu satuan panjang pada sketsa 3D ≈ setengah lebar torso; tidak berskala anatomis.
 *
 * SUDUT FRONTAL (bidang x–y): diukur dari +x (sadapan I, 0°) ke arah BAWAH (−y):
 *   arah = (cos θ, −sin θ, 0). Jadi +60° = ke kiri-bawah, +90° = lurus ke bawah,
 *   −30° = ke kiri-atas, 180° = ke kanan, −120° = ke kanan-atas.
 *
 * DIPOL.  Tiap gelombang w ∈ {P, Q, R, S, T} adalah gaussian g_w(t) (waktu dan lebar
 * dari generator ECG yang ada, ECG_WAVES) yang mengalikan SATU vektor puncak v_w:
 *
 *       H(t) = Σ_w  g_w(t) · v_w ,       v_w = m_w · d_w
 *
 * d_w = arah satuan 3D gelombang itu (di bawah), m_w = besar vektor puncak. m_w dipilih
 * sehingga proyeksi pada sadapan II persis amplitudo ECG yang ada:
 *       v_w · L_II = amp_w · rAmp   ⇒   m_w = amp_w·rAmp / (d_w · L_II)
 * Akibatnya sinyal sadapan II dari model ini = ECG sintetis lama (galat ~1e-15), dan
 * sadapan lain adalah proyeksi dipol yang SAMA pada vektor sadapan masing-masing.
 * Tanda: d_w dipilih sehingga d_w · L_II bertanda sama dengan amp_w (Q dan S negatif
 * di sadapan II), jadi m_w > 0 dan d_w adalah arah dipol fisiologis sesungguhnya.
 *
 * ARAH GELOMBANG (tipikal buku ajar, dibulatkan; BUKAN data pasien):
 *   P  atrium : kiri-bawah, sedikit ke depan        sumbu frontal ≈ +50°, z +0,25
 *   Q  septum : kanan-(sedikit atas), ke depan      sumbu frontal ≈ 190° (= −170°), z +0,55
 *   R  vent.  : kiri-bawah, ke belakang             sumbu frontal ≈ +60°, z −0,35
 *   S  basal  : kanan-atas, ke belakang             sumbu frontal ≈ −120°, z −0,50
 *   T  repol. : kiri-bawah, searah QRS              sumbu frontal ≈ +45°, z +0,10
 *
 * SADAPAN.  Sinyal sadapan = H(t) · L_sadapan.
 *  Ekstremitas — segitiga Einthoven ideal, V_L − V_R dst.:
 *    I   = V_L − V_R   → L_I   = (1, 0, 0)                      sudut 0°      (satuan)
 *    III = V_F − V_L   → L_III = (−1/2, −√3/2, 0)               sudut +120°   (satuan)
 *    II  = V_F − V_R   → L_II  = L_I + L_III = (1/2, −√3/2, 0)  sudut +60°    (satuan)
 *  (hukum Einthoven I + III = II berlaku EKSAK karena L_II didefinisikan sebagai jumlahnya)
 *  Augmented (Goldberger) — referensi = rata-rata dua elektrode lain:
 *    aVR = V_R − (V_L + V_F)/2 = −(I + II)/2   → L = (−3/4, +√3/4, 0)  (|L| = √3/2 ≈ 0,866)
 *    aVL = V_L − (V_R + V_F)/2 =  (I − III)/2  → L = (+3/4, +√3/4, 0)  (|L| ≈ 0,866)
 *    aVF = V_F − (V_R + V_L)/2 =  (II + III)/2 → L = (0, −√3/2, 0)     (|L| ≈ 0,866)
 *  sehingga aVR + aVL + aVF = 0 (eksak). Faktor 0,866 adalah sifat sadapan augmented.
 *  Prekordial V1–V6 (referensi: terminal pusat Wilson, diasumsikan ≈ potensial rata-rata
 *  tubuh ≈ 0 untuk dipol tunggal):
 *    L_Vk = vektor satuan dari PUSAT JANTUNG (HEART_POS) ke posisi elektrode Vk di dada
 *    (ELECTRODES). Posisi elektrode mengikuti landmark klasik (V1 sela iga 4 tepi sternum
 *    kanan, V2 kiri, V4 sela iga 5 garis midklavikula, V3 di antara V2–V4, V5 garis aksila
 *    anterior, V6 garis midaksila) pada torso elips sederhana (TORSO). Ini aproksimasi
 *    "arah pandang" saja; amplitudo nyata sangat bergantung pada jarak dan jaringan.
 *  Pola kualitatif yang dihasilkan (diuji): V1 defleksi QRS dominan negatif (r kecil lalu
 *  S/R negatif dalam), V6 dominan positif, aVR seluruh gelombang terbalik.
 *
 * WAKTU.  Semua gelombang mengikuti jadwal denyut ECG yang ada: puncak R di
 * FIRST_R_TIME + k·RR (RR = 60/hr), mulai dari k = −1.
 */

import { ECG_WAVES, FIRST_R_TIME } from './profiles/ecg-waves.js';

// ---------------------------------------------------------------------------
// Aljabar vektor kecil
// ---------------------------------------------------------------------------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = len(a); return [a[0] / n, a[1] / n, a[2] / n]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const DEG = Math.PI / 180;

/** Arah satuan dari sudut frontal θ (derajat, dari +x ke bawah) dan komponen depan-belakang z. */
export function frontalDirection(thetaDeg, z = 0) {
  return unit([Math.cos(thetaDeg * DEG), -Math.sin(thetaDeg * DEG), z]);
}

/** Sudut frontal (derajat, −180…180) sebuah vektor: atan2(−y, x). */
export function frontalAngleDeg(v) {
  return Math.atan2(-v[1], v[0]) / DEG;
}

// ---------------------------------------------------------------------------
// Geometri sketsa: torso elips, jantung, elektrode (dipakai pula oleh viewer 3D)
// ---------------------------------------------------------------------------

/** Torso elips: x²/a² + z²/b² = 1 (penampang); viewer3d.js menggambarnya sebagai kapsul bersumbu y. */
export const TORSO = Object.freeze({ a: 1.0, b: 0.62 });

/** Pusat dipol (jantung), sedikit ke kiri, ke atas, dan ke depan torso. */
export const HEART_POS = Object.freeze([0.28, 0.35, 0.12]);

/** Titik pada permukaan dada anterior untuk x dan y tertentu. */
function chest(x, y) {
  return [x, y, TORSO.b * Math.sqrt(1 - (x * x) / (TORSO.a * TORSO.a))];
}

/** Posisi elektrode pada sketsa (sistem koordinat tubuh di atas). */
export const ELECTRODES = Object.freeze({
  RA: Object.freeze([-0.80, 1.30, 0]), // lengan kanan (di bahu kanan, ilustratif)
  LA: Object.freeze([0.80, 1.30, 0]),  // lengan kiri (di bahu kiri)
  LL: Object.freeze([0.40, -1.65, 0]), // kaki kiri (di pinggul kiri)
  V1: Object.freeze(chest(-0.10, 0.38)),
  V2: Object.freeze(chest(0.10, 0.38)),
  V3: Object.freeze(chest(0.325, 0.28)),
  V4: Object.freeze(chest(0.55, 0.18)),
  V5: Object.freeze(chest(0.85, 0.18)),
  V6: Object.freeze(chest(0.97, 0.18)),
});

// ---------------------------------------------------------------------------
// Vektor sadapan
// ---------------------------------------------------------------------------
const L_I = [1, 0, 0];
const L_III = [-0.5, -Math.sqrt(3) / 2, 0];
const L_II = [L_I[0] + L_III[0], L_I[1] + L_III[1], L_I[2] + L_III[2]]; // = (1/2, −√3/2, 0) eksak
const half = (a) => [a[0] / 2, a[1] / 2, a[2] / 2];
const L_AVR = half([-(L_I[0] + L_II[0]), -(L_I[1] + L_II[1]), 0]);
const L_AVL = half([L_I[0] - L_III[0], L_I[1] - L_III[1], 0]);
const L_AVF = half([L_II[0] + L_III[0], L_II[1] + L_III[1], 0]);

const KE = 'Sadapan ekstremitas (Einthoven/Goldberger ideal)';
const KP = 'Sadapan prekordial (perkiraan kualitatif)';

/**
 * Definisi sadapan. `elektrode` = elektrode yang dipakai (untuk sketsa 3D).
 * `kualitatif: true` menandai sadapan yang hanya perkiraan kualitatif.
 */
export const LEADS = Object.freeze([
  { id: 'I', grup: KE, vec: L_I, elektrode: ['LA', 'RA'], rumus: 'I = V_L − V_R' },
  { id: 'II', grup: KE, vec: L_II, elektrode: ['LL', 'RA'], rumus: 'II = V_F − V_R' },
  { id: 'III', grup: KE, vec: L_III, elektrode: ['LL', 'LA'], rumus: 'III = V_F − V_L' },
  { id: 'aVR', grup: KE, vec: L_AVR, elektrode: ['RA'], rumus: 'aVR = −(I + II)/2' },
  { id: 'aVL', grup: KE, vec: L_AVL, elektrode: ['LA'], rumus: 'aVL = (I − III)/2' },
  { id: 'aVF', grup: KE, vec: L_AVF, elektrode: ['LL'], rumus: 'aVF = (II + III)/2' },
  ...['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map((id) => ({
    id, grup: KP, kualitatif: true, elektrode: [id],
    vec: unit(sub(ELECTRODES[id], HEART_POS)),
    rumus: `arah pusat jantung → ${id}`,
  })),
].map((l) => Object.freeze(l)));

export const LEAD_IDS = Object.freeze(LEADS.map((l) => l.id));
export const DEFAULT_LEAD = 'II';
const LEAD_BY_ID = new Map(LEADS.map((l) => [l.id, l]));

/** Sadapan menurut id; id tak dikenal jatuh ke sadapan II. */
export function getLead(id) {
  return LEAD_BY_ID.get(id) ?? LEAD_BY_ID.get(DEFAULT_LEAD);
}

// ---------------------------------------------------------------------------
// Arah dan vektor puncak tiap gelombang
// ---------------------------------------------------------------------------

/** Arah satuan dipol pada puncak tiap gelombang (lihat komentar atas). */
export const WAVE_DIRECTIONS = Object.freeze({
  P: Object.freeze(frontalDirection(50, 0.25)),
  Q: Object.freeze(frontalDirection(190, 0.55)),
  R: Object.freeze(frontalDirection(60, -0.35)),
  S: Object.freeze(frontalDirection(-120, -0.5)),
  T: Object.freeze(frontalDirection(45, 0.10)),
});

/**
 * Vektor puncak v_w = m_w·d_w tiap gelombang untuk amplitudo R `rAmp` (volt).
 * @returns {Array<{nama, offset, sigma, dir, mag, vec, ampLeadII}>}  urutan = ECG_WAVES
 */
export function waveVectors(rAmp = 1e-3) {
  return ECG_WAVES.map((w) => {
    const dir = WAVE_DIRECTIONS[w.nama];
    const ampLeadII = w.amp * rAmp;
    const mag = ampLeadII / dot(dir, L_II);
    return { nama: w.nama, offset: w.offset, sigma: w.sigma, dir, mag, vec: [dir[0] * mag, dir[1] * mag, dir[2] * mag], ampLeadII };
  });
}

/** Amplitudo puncak tiap gelombang pada sadapan tertentu: v_w · L (volt). */
export function leadWaveAmplitudes(leadId, rAmp = 1e-3) {
  const L = getLead(leadId).vec;
  const out = {};
  for (const w of waveVectors(rAmp)) out[w.nama] = dot(w.vec, L);
  return out;
}

// ---------------------------------------------------------------------------
// Pembangkitan: jumlah gaussian dengan banyak kanal sekaligus
// ---------------------------------------------------------------------------

/**
 * Jumlah gaussian P,Q,R,S,T berulang tiap RR (jadwal sama dengan generator ECG) untuk
 * beberapa kanal; channels[c][w] = amplitudo gelombang w pada kanal c.
 */
function accumulate(t, { fs, duration, hr }, channels) {
  const n = t.length;
  const out = channels.map(() => new Float64Array(n));
  const rr = 60 / hr;
  for (let tR = FIRST_R_TIME - rr; tR < duration + rr; tR += rr) {
    ECG_WAVES.forEach((w, wi) => {
      const c = tR + w.offset;
      const i0 = Math.max(0, Math.ceil((c - 5 * w.sigma) * fs));
      const i1 = Math.min(n - 1, Math.floor((c + 5 * w.sigma) * fs));
      const k = 1 / (2 * w.sigma * w.sigma);
      for (let i = i0; i <= i1; i++) {
        const d = t[i] - c;
        const g = Math.exp(-d * d * k);
        for (let ch = 0; ch < out.length; ch++) out[ch][i] += channels[ch][wi] * g;
      }
    });
  }
  return out;
}

/**
 * Dipol H(t) pada sumbu waktu t.
 * @param {Float64Array} t  sumbu waktu (t[i] = i/fs)
 * @param {{fs:number, duration:number, hr?:number, rAmp?:number}} p
 * @returns {{x:Float64Array, y:Float64Array, z:Float64Array}}  volt
 */
export function dipoleSeries(t, p) {
  const wv = waveVectors(p.rAmp ?? 1e-3);
  const [x, y, z] = accumulate(t, { fs: p.fs, duration: p.duration, hr: p.hr ?? 72 },
    [0, 1, 2].map((c) => wv.map((w) => w.vec[c])));
  return { x, y, z };
}

/**
 * Sinyal sadapan = H(t) · L_sadapan (volt). Sadapan II = ECG sintetis lama.
 * Memproyeksikan amplitudo per gelombang lebih dulu (linear) sehingga hanya satu kanal dihitung.
 */
export function leadSignal(t, p, leadId = DEFAULT_LEAD) {
  const L = getLead(leadId).vec;
  const amps = waveVectors(p.rAmp ?? 1e-3).map((w) => dot(w.vec, L));
  return accumulate(t, { fs: p.fs, duration: p.duration, hr: p.hr ?? 72 }, [amps])[0];
}

/**
 * H pada satu waktu `tSec` (analitik, untuk animasi per-frame). Jadwal denyut sama dengan
 * dipoleSeries: denyut k ≥ −1 dengan puncak R di FIRST_R_TIME + k·RR.
 * @returns {[number, number, number]} volt
 */
export function dipoleAt(tSec, { hr = 72, rAmp = 1e-3, wv = waveVectors(rAmp) } = {}) {
  const rr = 60 / hr;
  const kc = Math.floor((tSec - FIRST_R_TIME) / rr);
  const h = [0, 0, 0];
  for (let k = Math.max(-1, kc - 2); k <= kc + 2; k++) {
    const tR = FIRST_R_TIME + k * rr;
    for (const w of wv) {
      const d = tSec - (tR + w.offset);
      if (Math.abs(d) > 5 * w.sigma) continue;
      const g = Math.exp(-(d * d) / (2 * w.sigma * w.sigma));
      h[0] += w.vec[0] * g; h[1] += w.vec[1] * g; h[2] += w.vec[2] * g;
    }
  }
  return h;
}

/** Proyeksi skalar H·L untuk sadapan tertentu. */
export function projectOnLead(h, leadId) {
  return dot(h, getLead(leadId).vec);
}

/**
 * Jejak ujung dipol (vektorkardiogram) selama SATU denyut: jendela mulai 0,32 s sebelum
 * puncak R, panjang min(RR, 0,9 s), untuk denyut ke-`beat` (bawaan 1).
 * @returns {{t0:number, dt:number, n:number, points:Float64Array}} points = [x,y,z, x,y,z, …] (volt)
 */
export function vcgLoop({ hr = 72, rAmp = 1e-3 }, { beat = 1, dt = 0.002 } = {}) {
  const rr = 60 / hr;
  const span = Math.min(rr, 0.9);
  const t0 = FIRST_R_TIME + beat * rr - 0.32;
  const n = Math.round(span / dt) + 1;
  const wv = waveVectors(rAmp);
  const points = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const h = dipoleAt(t0 + i * dt, { hr, rAmp, wv });
    points[3 * i] = h[0]; points[3 * i + 1] = h[1]; points[3 * i + 2] = h[2];
  }
  return { t0, dt, n, points, span };
}

// ---------------------------------------------------------------------------
// Teks asumsi & keterbatasan (dipakai UI dan README)
// ---------------------------------------------------------------------------
export const MODEL_NOTES = Object.freeze([
  'Model dipol tunggal yang disederhanakan: satu dipol tetap di pusat jantung; BUKAN model volume conductor (tanpa geometri torso, konduktivitas jaringan, paru, tulang).',
  'Arah tiap gelombang P, Q, R, S, T adalah nilai tipikal buku ajar yang dibulatkan, bukan data pasien; sumbu frontal QRS ≈ +60°.',
  'Sadapan ekstremitas memakai vektor Einthoven/Goldberger yang diidealkan; I + III = II dan aVR + aVL + aVF = 0 berlaku eksak.',
  'Sadapan prekordial V1–V6 hanya perkiraan kualitatif (arah pandang dari pusat jantung ke elektrode); amplitudonya tidak realistis.',
  'Sadapan II diskalakan agar sama dengan ECG sintetis yang ada (R ≈ 1 mV); sadapan lain adalah proyeksi dipol yang sama.',
  'Tidak untuk penggunaan klinis: tanpa variasi antar-pasien, penyakit, atau aritmia; sketsa 3D tidak berskala anatomis.',
]);
