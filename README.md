# EXG Lab — Simulator Akuisisi Biopotensial

Simulator web interaktif untuk tugas kuliah **AI-Assisted Biomedical Signal Conditioning and Data Acquisition**.
Satu rantai akuisisi disimulasikan di peramban untuk empat jenis sinyal biopotensial — **ECG, EMG permukaan,
EEG, dan EOG** (plus sinus uji) — dan setiap tahap dapat diatur serta diamati:

```
Sinyal sintetis (profil) → Amplifier → Filter → [Anti-aliasing] → Sampling → Kuantisasi → Output digital
```

> **Disclaimer — hanya untuk pembelajaran.** **Semua sinyal di sini sintetis dan berupa model yang sangat
> disederhanakan; bukan pengganti data klinis.** Aplikasi ini bukan perangkat medis, tidak mengklaim akurasi
> klinis, dan tidak boleh dipakai untuk diagnosis atau keputusan klinis.

---

## Menjalankan

Tanpa build tool, tanpa framework, tanpa dependensi. Dari folder proyek:

```bash
python3 -m http.server        # lalu buka http://localhost:8000
```

Kode memakai modul ES (`<script type="module">`) dengan path relatif, sehingga **harus** dibuka lewat server
HTTP; membuka `index.html` langsung via `file://` akan diblokir peramban.

### Pengujian

```bash
node tests/run.js             # Node.js ≥ 22, tanpa paket tambahan
```

Keluaran: daftar tes ✓/✗ per bagian dan ringkasan `N lulus, M gagal` (exit code 1 bila ada yang gagal).
Bagian-bagiannya: tiap modul mesin (`signal`, `amplifier`, `filters`, `adc`, `pipeline`), **spesifikasi tugas**
(gain, clipping, −3 dB filter, notch, ADC, aliasing 80 Hz → 20 Hz, sensitivitas pipeline), dan
`tests/profiles.test.js` (profil, preset, rentang diperluas, regresi ECG), dan `tests/dipole.test.js`
(model dipol, hukum Einthoven, pilihan sadapan pada pipeline, integritas berkas Three.js).

**Regresi ECG.** `tests/fixtures/ecg-reference.json` berisi hash SHA-256 atas byte Float64 seluruh deret, plus
sampel eksplisit, dari keluaran ECG/sinus/pipeline versi v1 (commit `3b6bea6`) sebelum mekanisme profil dibuat.
Tes membandingkannya **tanpa toleransi** (`Object.is`): keluaran ECG harus identik bit-per-bit.

---

## Struktur

| File | Isi |
|---|---|
| `index.html` | Tata letak (kontrol kiri, plot kanan), tab, CSS |
| `js/profiles/index.js` | Registri profil (`PROFILES`, `getProfile`) dan `validateProfile` |
| `js/profiles/{ecg,emg,eeg,eog,sine}.js` | Satu berkas per sinyal: generator + definisi kontrol, gangguan, preset, teks info |
| `js/profiles/common.js` | Utilitas sintesis bersama: PRNG, derau putih/berpita/pink, deret pulsa |
| `js/profiles/disturbances.js` | Pabrik definisi gangguan (toggle + slider) per profil |
| `js/profiles/params.js` | `defaultParams(id)`: merakit parameter pipeline lengkap dari sebuah profil |
| `js/cardiac-dipole.js` | Model dipol jantung tunggal dan proyeksi 12 sadapan (fungsi murni; asumsinya didokumentasikan di komentar) |
| `js/viewer3d.js` | Viewer 3D + plot 2D tersinkron; memuat Three.js secara malas dan punya jalur cadangan tanpa WebGL |
| `js/vendor/three.min.js` | Three.js r149 (UMD, MIT), berkas tunggal terkunci, tanpa CDN |
| `js/profiles/ecg-waves.js` | Konstanta gelombang PQRST (dipakai profil ECG dan model dipol) |
| `js/signal.js` | Menyatukan profil → sinyal bersih + gangguan + statistik |
| `js/amplifier.js` | Gain + hard clipping pada rail yang dapat diatur |
| `js/filters.js` | Biquad LPF/HPF/BPF/notch, notch kaskade, RC orde 1, respons frekuensi, −3 dB terukur, FFT, metrik |
| `js/adc.js` | Anti-aliasing, sampling, kuantisasi mid-tread, deteksi aliasing, ekspor CSV |
| `js/pipeline.js` | Merangkai seluruh tahap |
| `js/validation.js` | Validasi matematis teori vs simulasi |
| `js/format.js` | Format angka bergaya Indonesia, satuan V/mV/µV/nV |
| `js/ui.js` | Kontrol, plot canvas, panel info (satu-satunya modul yang menyentuh DOM) |
| `tests/run.js`, `tests/profiles.test.js` | Pengujian |

Mesin (amplifier, filter, ADC, pipeline) tidak mengenal jenis sinyal; ia hanya menerima deret tegangan.
Setiap tahap adalah **fungsi murni**. Setiap perubahan kontrol menjalankan ulang seluruh pipeline lalu
menggambar ulang tab yang terlihat.

### Menambah profil sinyal

Buat `js/profiles/<id>.js` berisi objek profil (lihat komentar di `profiles/index.js` dan
`validateProfile`), daftarkan di `PROFILES`. UI membangun kontrol sinyal, daftar gangguan, preset, teks info,
dan kartu penjelasan dari objek itu — tidak ada kode khusus per sinyal di `ui.js`.

### Tab

| Tab | Isi |
|---|---|
| Eksperimen 1 · Sinyal & Amplifier | Sinyal masukan, keluaran amplifier, indikator saturasi, karakteristik sinyal (sumbu µV/mV/V otomatis) |
| Eksperimen 2 · Filter | Respons frekuensi, spektrum sebelum/sesudah, overlay waktu, metrik, penjelasan + saran filter per profil |
| Eksperimen 3 · ADC | Stem sampel di atas sinyal kontinu, error kuantisasi, spektrum alias, deteksi aliasing, tabel 20 sampel |
| Eksperimen 4 · Output Digital | Konfigurasi rekomendasi profil, ringkasan + cek, plot kode ADC, ekspor CSV, tabel 20 sampel |
| Validasi Matematis | Teori vs simulasi untuk amplifier, RC, filter pipeline, dan ADC |
| Visualisasi 3D | Model dipol jantung: torso transparan, panah dipol H(t) yang bergerak, jejak VCG, vektor sadapan + proyeksi, plot 2D sinyal sadapan tersinkron (hanya profil ECG) |

---

## Profil sinyal

Memilih profil di dropdown **Jenis sinyal** membangun ulang kontrol sinyal dan daftar gangguan, mengatur durasi
bawaan, dan menerapkan **preset rekomendasi** profil (gain, filter, fs, bit, rentang ADC, rail amplifier,
anti-aliasing). Tombol "Terapkan konfigurasi rekomendasi" di Eksperimen 4 mengembalikan preset profil aktif.
Saat halaman dibuka, profil ECG dipilih dan presetnya diterapkan (termasuk anti-aliasing aktif).

Rentang "tipikal" di bawah adalah orde besaran umum yang dipakai untuk memilih rentang slider, **bukan** nilai
referensi klinis.

### ECG

| | |
|---|---|
| **Model** | Lima gaussian P, Q, R, S, T per denyut, diulang tiap interval RR (tabel offset/amplitudo/σ di bawah) |
| **Parameter** | **Sadapan** (12; bawaan II) · detak jantung 40–150 bpm (72) · amplitudo R 0,2–3 mV (1 mV) · durasi 5 s |
| **Tipikal / diagnostik** | R ≈ 0,5–2 mV · 0,05–150 Hz |
| **Gangguan** | baseline wander 0,3 Hz (0–1 mV) · jala-jala 50 Hz (0–0,5 mV) · noise putih (0–0,2 mV RMS) · alias (10–3000 Hz) |
| **Preset** | ×1000 · BPF 0,5–40 Hz · AA aktif · fs 250 Hz · 12 bit · ADC ±2 V · rail ±2 V |
| **Batas model** | Morfologi tetap; tanpa variabilitas detak, aritmia, atau artefak gerak nyata. Sadapan selain II berasal dari model dipol tunggal yang disederhanakan (lihat bagian di bawah) |

| Gelombang | Offset dari R | Amplitudo | σ |
|---|---|---|---|
| P | −200 ms | 0,15 mV | 25 ms |
| Q | −35 ms | −0,12 mV | 8 ms |
| R | 0 | 1,00 mV | 9 ms |
| S | +35 ms | −0,25 mV | 8 ms |
| T | +280 ms | 0,30 mV | 45 ms |

### EMG permukaan

| | |
|---|---|
| **Model** | Derau gaussian pita-lebar **20–450 Hz** (derau putih → HPF 20 Hz + LPF 450 Hz Butterworth orde 4) × envelope aktivasi otot |
| **Parameter** | Amplitudo puncak 0,05–5 mV (1 mV, pada kontraksi 100 %) · tingkat kontraksi 0–100 % (60 %) · pola **burst berulang** (0,5–4 burst/s, duty 40 %, tepi 20 ms) atau **tonik** (fluktuasi lambat ±10 %) · durasi 5 s |
| **Tipikal / diagnostik** | ≈ 0,05–5 mV · 20–450 Hz |
| **Gangguan** | jala-jala 50 Hz (0–500 µV) · artefak gerak frekuensi rendah (0–1 mV, 0,5–10 Hz) · baseline wander (0–500 µV) · noise putih (0–50 µV RMS) · alias |
| **Preset** | ×1000 · BPF 20–450 Hz **+ notch 50 Hz** (Q 30) · AA aktif · **fs 2000 Hz** · 16 bit · ADC ±2,5 V · rail ±2,5 V |
| **Batas model** | Tanpa unit motor, bentuk potensial aksi, kelelahan otot, atau crosstalk. Tepi pita lunak (terukur: 90 % daya di 20–450 Hz, 99,9 % di 10–900 Hz). Puncak diskalakan tepat = amplitudo × tingkat kontraksi |

fs 2000 Hz dipilih karena membagi 10 kHz tepat (sampel eksak) dan AA (fc = 0,4·fs = 800 Hz) tidak memotong
pita sEMG; fs 1000 Hz akan menempatkan fc AA di 400 Hz, di dalam pita sEMG.

### EEG

| | |
|---|---|
| **Model** | Jumlah osilasi per pita — delta 0,5–4, theta 4–8, alpha 8–13, beta 13–30, gamma 30–70 Hz (masing-masing derau berpita Butterworth orde 4) — di atas latar ≈ 1/f (Voss–McCartney) |
| **Parameter** | Amplitudo total 10–100 µV (40 µV, puncak, **mode mata terbuka**) · daya relatif tiap pita 0–100 % (δ 50, θ 30, α 40, β 20, γ 8) · daya latar 0–100 % (30) · keadaan mata terbuka/tertutup · durasi 10 s |
| **Tipikal / diagnostik** | ≈ 10–100 µV · 0,5–70 Hz |
| **Gangguan** | jala-jala 50 Hz (0–100 µV, dominan) · baseline wander (0–100 µV) · artefak kedip mata (0–200 µV, selang 1–10 s) · noise putih (0–20 µV RMS) · alias |
| **Preset** | ×10.000 · BPF 0,5–70 Hz **+ notch 50 Hz** (Q 30) · AA aktif · fs 250 Hz · **24 bit** · ADC ±2,5 V · rail ±2,5 V |
| **Batas model** | Tanpa dipol, konduksi volume, spindle, atau topografi kanal. Latar hanya mendekati 1/f: kemiringan Welch pada rekaman panjang −1,01; satu realisasi 10 s menyimpang −0,88…−1,07 antar seed |

**Mata tertutup** menaikkan amplitudo alpha ×2,5 pada skala yang sama dengan mata terbuka (amplitudo total
mengacu ke mata terbuka), sehingga daya alpha benar-benar naik. Karena tepi pita lunak, pita tetangga ikut naik
(terukur, tertutup/terbuka: alpha ×5,3, theta ×1,8, beta ×2,9; delta ×1,00 dan gamma ×1,02).

### EOG

| | |
|---|---|
| **Model** | Posisi mata horizontal berupa **perubahan tangga (saccade)** bergantian −amp/2 ↔ +amp/2 (tiap langkah tepat = `amplitudo`, transisi smoothstep 40 ms) ditambah **kedip** berupa pulsa gaussian (σ = 60 ms) |
| **Parameter** | Amplitudo saccade 0,05–3,5 mV (0,5 mV) · selang saccade 0,5–5 s (2 s) · kedip aktif/tidak · amplitudo kedip 0,05–3 mV (0,8 mV) · selang kedip 1–8 s (3,3 s) · durasi 10 s |
| **Tipikal / diagnostik** | ≈ 0,05–3,5 mV · 0,05–30 Hz (DC-coupled) |
| **Gangguan** | **drift DC** (rampa linear, 0–200 µV/s) · jala-jala 50 Hz (0–200 µV) · baseline wander (0–500 µV) · noise putih (0–50 µV RMS) · alias |
| **Preset** | ×1000 · **LPF 30 Hz tanpa HPF** · AA aktif · fs 250 Hz · 16 bit · ADC ±2 V · rail ±2 V |
| **Batas model** | Saccade seragam; tanpa hubungan sudut–tegangan, nistagmus, atau komponen vertikal terpisah |

Preset tanpa HPF karena plato langkah mengandung komponen DC: HPF 0,05 Hz saja meluruhkan plato ≈ 47 % dalam
2 s. Drift DC lolos tanpa HPF dan dapat menjenuhkan amplifier bergain tinggi.

### Sinus uji

A·sin(2πft), f 0,5–2000 Hz (10 Hz), A 0,1–2 mV (1 mV). Sinyal uji untuk gain, filter, aliasing, dan kuantisasi;
preset sama dengan ECG.

---

## Model dipol jantung dan pilihan sadapan

Dropdown **Sadapan** (profil ECG; tampil di panel kontrol sehingga berlaku untuk tab 1–4, Validasi, dan 3D)
memilih sinyal ECG yang masuk ke pipeline. **Bawaan: sadapan II**, yang identik bit-per-bit dengan ECG sebelum
fitur ini ada — memilih II tidak mengubah pipeline sama sekali.

> **Model dipol tunggal yang disederhanakan — bukan model volume conductor. Sadapan prekordial V1–V6 hanya
> perkiraan kualitatif. Tidak untuk penggunaan klinis.**

**Model** (`js/cardiac-dipole.js`). Tiap gelombang P, Q, R, S, T mengalikan satu vektor 3D tetap `v_w`
(amplitudo dan waktu gaussian dari generator ECG yang ada). Dipol `H(t) = Σ_w g_w(t)·v_w`, dan sinyal sadapan
adalah `H(t) · L_sadapan`. Besar `v_w` dipilih sehingga proyeksinya pada sadapan II persis amplitudo ECG yang ada
(R ≈ 1 mV); sinyal sadapan II dari model sama dengan ECG lama dengan galat ≈ 2·10⁻¹⁶ relatif (toleransi tes 1 %).

Koordinat tubuh: +x ke kiri pasien, +y ke atas, +z ke depan. Sudut frontal diukur dari +x (sadapan I) ke bawah:
+60° = kiri-bawah.

| Gelombang | Arah dipol (sumbu frontal, komponen depan–belakang) | Besar vektor puncak |
|---|---|---|
| P | +50°, z = +0,25 (kiri-bawah, sedikit ke depan) | 0,157 mV |
| Q | 190° = −170°, z = +0,55 (ke kanan, ke depan: vektor septum) | 0,213 mV |
| R | **+60°**, z = −0,35 (kiri-bawah, ke belakang) | 1,059 mV |
| S | −120°, z = −0,50 (kanan-atas, ke belakang: basal) | 0,280 mV |
| T | +45°, z = +0,10 | 0,312 mV |

Arah adalah nilai tipikal buku ajar yang dibulatkan, bukan data pasien. Besar vektor untuk amplitudo R = 1 mV.

**Vektor sadapan** (didokumentasikan lengkap di komentar `cardiac-dipole.js`):

| Sadapan | Vektor L | Definisi |
|---|---|---|
| I, II, III | satuan di 0°, +60°, +120° | segitiga Einthoven ideal; L_II = L_I + L_III |
| aVR, aVL, aVF | \|L\| = √3/2 ≈ 0,866 di −150°, −30°, +90° | Goldberger: aVR = −(I+II)/2, aVL = (I−III)/2, aVF = (II+III)/2 |
| V1–V6 | satuan, arah pusat jantung → posisi elektrode di dada | perkiraan kualitatif; posisi mengikuti landmark klasik pada torso elips |

Hukum **I + III = II**, **aVR + aVL + aVF = 0**, dan aVR = −(I + II)/2 berlaku eksak (diuji tiap sampel, galat
numerik ~10⁻¹⁹ V). Pola kualitatif yang dihasilkan (diuji): V1 r kecil lalu defleksi negatif dalam (rS), V6 q kecil
lalu R tinggi (qR), zona transisi di V3–V4, aVR seluruh gelombang terbalik, aVL praktis isoelektrik karena sumbu
QRS +60° tegak lurus pada sumbu aVL. Amplitudo gelombang R per sadapan (mV): I 0,50 · II 1,00 · III 0,50 · aVR −0,75 ·
aVL 0,00 · aVF 0,75 · V1 −0,62 · V2 −0,55 · V3 −0,17 · V4 0,28 · V5 0,57 · V6 0,68.

**Asumsi dan keterbatasan**
- Satu dipol tetap di pusat jantung; tanpa geometri torso, konduktivitas jaringan, paru, tulang, atau efek jarak.
  Karena itu amplitudo prekordial tidak realistis dan tidak boleh ditafsirkan secara klinis.
- Arah gelombang tetap sepanjang rekaman: tanpa variasi antar-pasien, penyakit, aritmia, pernapasan, atau
  perubahan posisi jantung.
- Sadapan ekstremitas memakai vektor Einthoven/Goldberger yang diidealkan (bukan posisi elektrode sebenarnya).
- Referensi sadapan prekordial (terminal pusat Wilson) diasumsikan ≈ 0 untuk dipol tunggal.
- Pada sadapan dengan R negatif atau tak dominan (aVR, aVL, V1–V3) metrik tinggi R/deviasi ST di Eksperimen 2 tidak
  ditampilkan (dinyatakan di UI); deteksi HR memakai sinyal terbalik bila perlu.
- Sketsa 3D tidak berskala anatomis.

## Visualisasi 3D

Tab **Visualisasi 3D** (hanya profil ECG; profil lain menampilkan pemberitahuan dengan tombol "Pilih profil ECG").

| Elemen | Arti |
|---|---|
| Torso transparan (kapsul elips) + kepala dan hidung | orientasi: kiri pasien di sisi kanan layar; hidung menghadap depan |
| Titik merah | pusat jantung = lokasi dipol |
| Panah oranye | dipol H(t); arah dan panjangnya mengikuti waktu simulasi (panjang dinormalkan: vektor R ≈ 0,9 satuan sketsa) |
| Garis ungu | jejak ujung panah (vektorkardiogram) untuk satu denyut; bagian yang sudah dilalui lebih terang |
| Bola abu-abu + label | elektrode RA, LA, LL, V1–V6; elektrode sadapan terpilih membesar dan biru |
| Panah biru | vektor sadapan terpilih |
| Panah hijau + garis putus | proyeksi H pada sadapan itu (panjang dan arah bertanda = nilai sinyal sadapan) |
| Plot 2D di samping | sinyal sadapan terpilih (model dipol, tanpa gangguan) dengan penanda waktu yang sinkron dengan animasi |

Kontrol: putar/jeda, kecepatan (0,1×–1×), pilihan sadapan (dapat disinkronkan dengan sadapan pipeline), jejak VCG,
setel ulang kamera, penggeser waktu. Putar dengan seret, zoom dengan roda atau cubit; papan ketik: tombol panah,
+ dan −, spasi. Orbit dibuat sendiri (tanpa berkas tambahan). Setiap perubahan parameter ECG (HR, amplitudo R, durasi)
di panel kiri langsung memengaruhi model.

- **Hemat sumber daya.** `requestAnimationFrame` hanya berjalan bila tab 3D terlihat dan animasi diputar; saat jeda,
  tab lain aktif, halaman tersembunyi, atau profil non-ECG tidak ada frame yang dirender (terukur di peramban:
  ≈ 36 frame/600 ms saat diputar, 0 dalam semua keadaan lain).
- **Pemuatan malas.** `viewer3d.js` dan `three.min.js` baru dimuat saat tab 3D dibuka pertama kali.
- **Tanpa WebGL / berkas gagal dimuat.** Kotak adegan menampilkan pesan yang jelas; plot 2D, pembacaan numerik
  (H, |H|, sudut frontal, proyeksi), dan animasi waktu tetap berfungsi.
- **Aksesibilitas dan layar kecil.** Adegan punya teks alternatif statis dan ringkasan dinamis (arah, panjang, dan
  proyeksi saat ini); tata letak satu kolom di layar ≤ 900 px tanpa scroll horizontal (diuji pada lebar 390 px).

### Berkas Three.js (js/vendor/three.min.js)

| | |
|---|---|
| Versi | **Three.js r149** (paket npm `three@0.149.0`, `build/three.min.js`, UMD) |
| Ukuran / SHA-256 | 608.081 byte / `8a5f7249903b54d30f79f708699d2fed2d6a1d0741a4cd41377d1f01bb5a2271` |
| Lisensi | MIT (header lisensi tetap ada di berkas) |

Cara mengunduh ulang (hasilnya harus berhash sama; tes memeriksanya):

```bash
curl -L -o js/vendor/three.min.js https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js
sha256sum js/vendor/three.min.js        # PowerShell: Get-FileHash js\vendor\three.min.js -Algorithm SHA256
# alternatif: npm pack three@0.149.0 lalu ambil package/build/three.min.js
```

Mengapa r149: ini build UMD (`three.min.js`) **terakhir tanpa peringatan deprecation** di konsol — r150 sampai r160
mencetak `console.warn` setiap dimuat dan versi setelahnya hanya menyediakan modul ES. Viewer memeriksa
`THREE.REVISION` setelah dimuat dan menolak revisi lain. Memutakhirkan berarti mengganti berkas, hash di tes, dan
`THREE_REVISION` di `viewer3d.js` (atau memuat modul ES dengan import map).

## Parameter pipeline

| Tahap | Parameter | Rentang |
|---|---|---|
| Amplifier | Gain | ×10 / ×100 / ×1000 / bebas **×1 hingga ×100.000** (skala log) |
| | Rail amplifier (saturasi) | ±0,5 … ±5 V (mengikuti profil) |
| Filter | Jenis | tanpa / LPF / HPF / BPF / notch, ditambah opsi **+ notch** kaskade untuk LPF/HPF/BPF |
| | LPF fc / HPF fc | 1–500 Hz / 0,05–50 Hz |
| | BPF f_L–f_H | 0,05–50 Hz / 1–500 Hz (preset 0,5–40, 5–15, 20–450, 0,5–70, 0,05–30) |
| | Notch f0, Q | 10–500 Hz, Q 0,5–100 (preset Q 30 dan 5) |
| ADC | fs | 100 / 250 / 500 / bebas **20–4000 Hz** (domain analog tetap 10 kHz) |
| | Resolusi | 2 / 4 / 8 / 12 / bebas **1–24 bit** |
| | Rentang | ±0,1 … ±5 V (mengikuti profil) |
| | Anti-aliasing | Butterworth orde 8, fc = 0,4·fs (opsional) |

### Respons anti-aliasing

Kemiringan asimtotik orde 8 adalah 48 dB/oktaf, tetapi redaman di dekat fc masih landai. Terukur (desain
sebenarnya, untuk fs ≤ 500 Hz): −3 dB di 0,4·fs, **≈ −15,6 dB di Nyquist (0,5·fs)**, ≈ −28 dB di 0,6·fs, dan baru
≈ −48 dB di 0,8·fs. Komponen di antara fs/2 dan ±0,8·fs karenanya masih dapat menjadi alias yang terlihat.

**Redaman ini bergantung pada fs untuk fs tinggi** (warping bilinear pada domain analog 10 kHz): di Nyquist
−15,6 dB (fs ≤ 500 Hz), −15,8 dB (1000 Hz), −16,5 dB (2000 Hz), −19,4 dB (4000 Hz). UI menghitung angkanya dari
desain filter yang sebenarnya.

Deteksi aliasing (Eksperimen 3) memakai amplitudo komponen **setelah** dikalikan respons filter Eksperimen 2 dan
respons anti-aliasing (bila aktif) pada frekuensi komponen itu.

---

## Model mesin

**Domain analog** — 10 kHz, satuan volt. Relatif terhadap pita sinyal dan fs ADC, dianggap kontinu.

**Amplifier** — `y = clip(G·x, ±V_sat)`; tanpa offset, noise, CMRR, atau batas bandwidth.

**Filter** — biquad orde 2 dengan koefisien *Audio EQ Cookbook* (bilinear + pre-warping), Transposed Direct
Form II, kausal. LPF/HPF Butterworth (Q = 1/√2); BPF = kaskade HPF + LPF; notch dengan BW −3 dB ≈ f0/Q.
Titik −3 dB **diukur** dari respons frekuensi. Pada BPF + notch, tepi pita diukur pada kaskade tanpa notch.

**ADC** — sampling ideal `x[n] = x(n/fs)`; kuantisasi mid-tread Δ = 2·V_ref/2^N, kode two's complement,
clip di luar rentang; aliasing f_alias = |f − k·fs|, dianggap terlihat bila amplitudonya di masukan ADC > ½ LSB.

**Output digital** — CSV `waktu_s,kode_adc,tegangan_rekonstruksi_V` (koma, titik desimal); tegangan = kode·Δ.
Diuji sampai 24 bit (kode·LSB = tegangan tanpa kehilangan presisi) dan fs 4000 Hz.

### Validasi matematis

| Besaran | Teori | Simulasi pembanding |
|---|---|---|
| Amplifier | Vout = G·Vin, dibatasi ±Vsat | sampel dengan \|Vin\| terbesar, Vpp |
| RC orde 1 | fc = 1/(2πRC), gain −3,01 dB di fc | −3 dB dari \|H(f)\| dan dari simulasi sinus di fc; jangkauan 0,01 Hz ≤ fc < 4,5 kHz, di luarnya diberi pesan |
| Filter pipeline | fc / tepi pita / BW desain | −3 dB terukur |
| ADC | 2^N, 2V_ref/2^N, LSB/2, LSB/√12, 6,02N + 1,76 | N ≤ 16: ramp seluruh rentang; N > 16: level dari kode min/maks saat saturasi dan LSB dari ramp lokal ±2000 LSB; sinus skala penuh untuk RMS dan SQNR |

---

## Asumsi

- Komponen ideal: amplifier tanpa offset, noise, CMRR, atau batas bandwidth; saturasi berupa hard clip.
- Sampling sesaat tanpa jitter dan tanpa aperture; ADC tanpa INL/DNL, offset, atau noise termal.
- Filter dianggap sudah lama berjalan sebelum t = 0 (state awal = kondisi tunak untuk rerata sinyal).
- RMS = LSB/√12 dan SQNR = 6,02N + 1,76 mengasumsikan error kuantisasi seragam dan tak berkorelasi dengan sinyal.
- Referensi "bersih" untuk metrik Eksperimen 2 adalah G × sinyal tanpa gangguan; keluaran filter disejajarkan
  dengan delay terestimasi sebelum dibandingkan.

## Keterbatasan

- **Semua sinyal sintetis dan sangat disederhanakan** (lihat "Batas model" tiap profil). Tidak cocok untuk menguji
  algoritma klinis dan tidak menggantikan data klinis. Rentang "tipikal" adalah orde besaran, bukan referensi.
- **Gangguan berupa nada murni** (0,3 Hz, 50 Hz tanpa harmonik), noise putih, dan pola artefak sederhana.
- **Domain analog = 10 kHz**: komponen di atas ±4,5 kHz tidak dapat direpresentasikan; panel RC menandai fc
  seperti itu (dan fc < 0,01 Hz) sebagai "di luar jangkauan simulasi".
- **Sampling dari grid 10 kHz.** fs yang membagi 10 kHz tepat (100, 250, 500, 1000, 2000, 2500 Hz) memberi sampel
  **eksak** (galat ~10⁻¹²). fs lain (mis. 4000 atau 333 Hz) memakai interpolasi linear; galat amplitudo ≤
  1 − cos(πf/10 kHz), terukur pada fs 4000 Hz: ≈ 0,1 % di 70 Hz, 0,5 % di 450 Hz, 4,9 % di 1 kHz. Frekuensi alias
  tetap benar, tetapi amplitudo alias bernada tinggi (ratusan Hz ke atas) lebih kecil dari nilai analitiknya.
  UI menampilkan catatan ini bila fs tidak membagi 10 kHz.
- **Rumus kuantisasi untuk N kecil**: pada 2–4 bit dengan masukan sinus, RMS menyimpang 6–14 % dari LSB/√12 dan
  SQNR beberapa dB di bawah 6,02N + 1,76 (error deterministik dan berkorelasi dengan sinyal). Panel validasi
  menandai baris ini "asumsi tidak berlaku (N < 6)".
- **Model dipol tunggal** (lihat bagian khusus): bukan volume conductor, V1–V6 hanya kualitatif, tidak untuk
  penggunaan klinis; sketsa 3D tidak berskala anatomis.
- **Tepi pita lunak**: pita EMG/EEG dibentuk filter Butterworth orde 4, jadi daya "bocor" ke pita tetangga
  (angka terukur ada di tabel profil).
- **Spektrum** memakai FFT berjendela Hann pada seluruh durasi; amplitudo puncak dapat kurang hingga 1,4 dB
  bila frekuensi jatuh di antara bin.
- **Metrik R/ST** hanya untuk ECG, diukur pada titik tetap (R+100 ms terhadap R−90 ms).
- Ambang "cek" di Eksperimen 4 (LSB di elektroda ≤ 5 µV untuk ECG/EMG, 0,5 µV untuk EEG, 10 µV untuk EOG;
  batas HPF/LPF per profil) adalah aturan praktis untuk pembelajaran, bukan kutipan standar.

---

## Deploy ke GitHub Pages

Aplikasi berupa berkas statis dengan path relatif, sehingga bisa langsung di-host GitHub Pages
(yang menyajikan `.js` dengan MIME `text/javascript`, syarat modul ES).

1. Buat repositori GitHub, mis. `exg-lab`.
2. Dari folder proyek:
   ```bash
   git remote add origin https://github.com/<username>/exg-lab.git
   git push -u origin main
   ```
3. Di GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pilih **Branch: `main`**,
   folder **`/ (root)`**, lalu **Save**.
4. Tunggu 1–2 menit; situs tersedia di `https://<username>.github.io/exg-lab/`.

Three.js sudah ada di `js/vendor/` (tanpa CDN), jadi tidak ada ketergantungan eksternal; berkas 608 KB itu
ikut ter-deploy dan baru diunduh peramban saat tab 3D dibuka. Path di GitHub Pages peka huruf besar-kecil; semua impor di proyek ini huruf kecil dan relatif. Tidak ada folder
berawalan `_`, jadi `.nojekyll` tidak diperlukan. Setelah deploy, buka DevTools → Console untuk memastikan tidak
ada 404 pada `js/*.js` dan `js/profiles/*.js`.
