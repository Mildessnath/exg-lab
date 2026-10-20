# Simulator Akuisisi Sinyal ECG

Simulator web interaktif untuk tugas kuliah **AI-Assisted Biomedical Signal Conditioning and Data Acquisition**.
Seluruh rantai akuisisi disimulasikan di peramban, dan setiap tahap dapat diatur serta diamati:

```
ECG sintetis → Amplifier → Filter → [Anti-aliasing] → Sampling → Kuantisasi → Output digital
```

> **Disclaimer — hanya untuk pembelajaran.** Sinyal adalah model sintetis yang disederhanakan.
> Aplikasi ini bukan perangkat medis dan tidak boleh dipakai untuk diagnosis atau keputusan klinis.

---

## Menjalankan

Tanpa build tool dan tanpa dependensi. Dari folder `ecg-simulator`:

```bash
python3 -m http.server        # lalu buka http://localhost:8000
```

Kode memakai modul ES (`<script type="module">`), sehingga **harus** dibuka lewat server HTTP;
membuka `index.html` langsung via `file://` akan diblokir peramban.

### Pengujian

```bash
node tests/run.js             # Node.js ≥ 22, tanpa paket tambahan
```

Keluaran: daftar tes ✓/✗ per modul dan ringkasan `N lulus, M gagal` (exit code 1 bila ada yang gagal).
Bagian **"spesifikasi tugas"** berisi tes yang diminta tugas: gain, clipping, −3 dB filter, redaman notch,
ADC (level, LSB, error), aliasing 80 Hz → 20 Hz, dan sensitivitas pipeline terhadap setiap parameter.

---

## Struktur

| File | Isi |
|---|---|
| `index.html` | Tata letak (kontrol kiri, plot kanan), tab, CSS |
| `js/signal.js` | ECG sintetis (5 gaussian PQRST), sinus uji, gangguan, statistik |
| `js/amplifier.js` | Gain + hard clipping ±2 V |
| `js/filters.js` | Biquad LPF/HPF/BPF/notch, RC orde 1, respons frekuensi, −3 dB terukur, FFT, metrik morfologi |
| `js/adc.js` | Anti-aliasing, sampling, kuantisasi mid-tread, deteksi aliasing, ekspor CSV |
| `js/pipeline.js` | Merangkai seluruh tahap |
| `js/validation.js` | Validasi matematis teori vs simulasi |
| `js/ui.js` | Kontrol, plot canvas, panel info (satu-satunya modul yang menyentuh DOM) |
| `tests/run.js` | Pengujian unit & spesifikasi |

Setiap tahap adalah **fungsi murni**: keluaran hanya bergantung pada argumen, tanpa state global.
Setiap perubahan kontrol menjalankan ulang seluruh pipeline lalu menggambar ulang tab yang terlihat.

### Tab

| Tab | Isi |
|---|---|
| Eksperimen 1 · Sinyal & Amplifier | Sinyal masukan, keluaran amplifier, indikator saturasi, karakteristik sinyal |
| Eksperimen 2 · Filter | Respons frekuensi, spektrum sebelum/sesudah, overlay waktu, metrik R/ST/SNR, penjelasan |
| Eksperimen 3 · ADC | Stem sampel di atas sinyal kontinu, error kuantisasi, spektrum alias, deteksi aliasing, tabel 20 sampel |
| Eksperimen 4 · Output Digital | Konfigurasi rekomendasi, ringkasan + cek, plot kode ADC, ekspor CSV, tabel 20 sampel |
| Validasi Matematis | Teori vs simulasi untuk amplifier, RC, filter pipeline, dan ADC |

---

## Parameter

| Tahap | Parameter | Rentang | Bawaan |
|---|---|---|---|
| Sumber | Jenis | ECG sintetis / sinus uji | ECG |
| | Detak jantung | 40–150 bpm | 72 bpm |
| | Frekuensi / amplitudo sinus | 0,5–200 Hz / 0,1–2 mV | 10 Hz / 1 mV |
| | Durasi | 2 / 5 / 10 s | 5 s |
| Gangguan | Baseline wander 0,3 Hz | 0–1 mV | 0,3 mV (nonaktif) |
| | Interferensi 50 Hz | 0–0,5 mV | 0,1 mV (nonaktif) |
| | Noise putih (RMS) | 0–0,2 mV | 0,03 mV (nonaktif) |
| | Komponen aliasing | 10–1000 Hz, 0–0,5 mV | 80 Hz, 0,1 mV (nonaktif) |
| Amplifier | Gain | ×10 / ×100 / ×1000 / bebas 1–5000 | ×1000 |
| | Saturasi | tetap | ±2 V |
| Filter | Jenis | tanpa / LPF / HPF / BPF / notch | BPF |
| | LPF fc | 1–500 Hz (preset 40, 100, 15) | 40 Hz |
| | HPF fc | 0,05–50 Hz (preset 0,5, 5, 0,05) | 0,5 Hz |
| | BPF f_L–f_H | preset 0,5–40 dan 5–15 Hz | 0,5–40 Hz |
| | Notch f0, Q | 10–500 Hz, Q 0,5–100 (preset Q 30 dan 5) | 50 Hz, Q 30 |
| ADC | fs | 100 / 250 / 500 / bebas 20–1000 Hz | 250 Hz |
| | Resolusi | 2 / 4 / 8 / 12 / bebas 1–16 bit | 12 bit |
| | Rentang | ±0,1 … ±5 V | ±2 V |
| | Anti-aliasing | Butterworth orde 8, fc = 0,4·fs | nonaktif |

Respons anti-aliasing (tidak bergantung pada fs): −3 dB di 0,4·fs, **≈ −15,6 dB di Nyquist (0,5·fs)**,
≈ −28 dB di 0,6·fs, dan baru ≈ −48 dB di 0,8·fs. Kemiringan asimtotiknya 48 dB/oktaf, tetapi redaman di
Nyquist jauh lebih kecil; komponen di antara fs/2 dan ±0,8·fs masih dapat menjadi alias yang terlihat.
Deteksi aliasing di Eksperimen 3 memakai amplitudo komponen **setelah** dikalikan respons filter Eksperimen 2
dan respons anti-aliasing (bila aktif) pada frekuensi komponen itu.

**Konfigurasi rekomendasi** (tombol di Eksperimen 4): gain ×1000, BPF 0,5–40 Hz, anti-aliasing aktif,
fs 250 Hz, 12 bit, ±2 V. Sumber dan gangguan tidak diubah.

---

## Model

**Domain analog** — disimulasikan pada 10 kHz, satuan volt. Relatif terhadap pita ECG dan fs ADC (≤ 1 kHz),
sinyal ini dianggap kontinu.

**ECG sintetis** — tiap denyut = jumlah lima gaussian `a·exp(−(t−t₀)²/2σ²)`:

| Gelombang | Offset dari R | Amplitudo | σ |
|---|---|---|---|
| P | −200 ms | 0,15 mV | 25 ms |
| Q | −35 ms | −0,12 mV | 8 ms |
| R | 0 | 1,00 mV | 9 ms |
| S | +35 ms | −0,25 mV | 8 ms |
| T | +280 ms | 0,30 mV | 45 ms |

Pada 72 bpm: RR 833 ms, QRS ≈ 102 ms, PR ≈ 199 ms, QT ≈ 421 ms (lebar ±2σ). Noise putih memakai PRNG
ber-seed sehingga deterministik.

**Amplifier** — `y = clip(G·x, ±2 V)`.

**Filter** — biquad orde 2 dengan koefisien *Audio EQ Cookbook* (bilinear + pre-warping), Transposed
Direct Form II, diterapkan kausal:
- LPF/HPF Butterworth (Q = 1/√2): passband datar, −3,01 dB tepat di fc, 12 dB/oktaf.
- BPF = kaskade HPF + LPF Butterworth (tepi pita independen).
- Notch: nol di f0, BW −3 dB ≈ f0/Q.
- Titik −3 dB **diukur** dari respons frekuensi (grid log + bisection), bukan diambil dari rumus desain.

**ADC**
- Sampling ideal `x[n] = x(n/fs)` (interpolasi linear dari grid 10 kHz).
- Kuantisasi mid-tread: Δ = 2·V_ref/2^N, kode two's complement −2^(N−1) … 2^(N−1)−1, level tertinggi
  V_ref − Δ, clip di luar rentang.
- Aliasing: f_alias = |f − k·fs| dengan k = round(f/fs); dianggap terlihat bila amplitudonya di masukan
  ADC > ½ LSB.

**Output digital** — CSV `waktu_s,kode_adc,tegangan_rekonstruksi_V` (pemisah koma, titik desimal), dengan
tegangan rekonstruksi = kode·Δ.

### Validasi matematis

| Besaran | Teori | Simulasi pembanding |
|---|---|---|
| Amplifier | Vout = G·Vin, dibatasi ±Vsat | sampel dengan \|Vin\| terbesar, Vpp |
| RC orde 1 | fc = 1/(2πRC), gain −3,01 dB di fc | −3 dB dari \|H(f)\| dan dari simulasi sinus di fc |
| Filter pipeline | fc desain | −3 dB terukur |
| ADC | 2^N, 2V_ref/2^N, LSB/2, LSB/√12, 6,02N + 1,76 | ramp seluruh rentang (level, LSB, error maks), sinus skala penuh (RMS, SQNR) |

---

## Asumsi

- Komponen ideal: amplifier tanpa offset, noise, CMRR, atau batas bandwidth; saturasi berupa hard clip.
- Sampling sesaat tanpa jitter dan tanpa aperture; ADC tanpa INL/DNL, offset, atau noise termal.
- Filter dianggap sudah lama berjalan sebelum t = 0 (state awal = kondisi tunak untuk rerata sinyal),
  sehingga tidak ada transien start-up buatan.
- Rumus RMS = LSB/√12 dan SQNR = 6,02N + 1,76 mengasumsikan error kuantisasi seragam dan tidak
  berkorelasi dengan sinyal.
- Referensi "bersih" untuk metrik Eksperimen 2 adalah G × ECG tanpa gangguan; keluaran filter disejajarkan
  dengan delay terestimasi sebelum dibandingkan.

## Keterbatasan

- **ECG sangat disederhanakan**: satu sadapan, morfologi tetap, tanpa variabilitas detak, aritmia, atau
  artefak gerak nyata. Tidak cocok untuk menguji algoritma klinis.
- **Gangguan berupa nada murni** (0,3 Hz, 50 Hz tanpa harmonik) dan noise putih; EMG nyata bersifat
  nonstasioner dan berpita tertentu.
- **Domain analog = sampling 10 kHz**: filter atau komponen di atas ±4,5 kHz tidak dapat direpresentasikan.
  Panel RC menandai fc seperti itu sebagai "di luar jangkauan simulasi".
- **Rumus kuantisasi untuk N kecil**: pada 2–4 bit dengan masukan sinus, error RMS menyimpang 6–14 % dari
  LSB/√12 dan SQNR beberapa dB di bawah 6,02N + 1,76. Ini sifat rumus, bukan kesalahan simulasi: dengan
  sedikit level, error menjadi deterministik dan berkorelasi dengan sinyal. Panel validasi menandai baris
  ini "asumsi tidak berlaku (N < 6)", dan tes memverifikasi rumus dengan masukan acak seragam yang memenuhi
  asumsinya.
- **Spektrum** memakai FFT berjendela Hann pada seluruh durasi; amplitudo puncak dapat kurang hingga 1,4 dB
  bila frekuensi jatuh di antara bin.
- **Metrik ST** diukur pada titik tetap (R+100 ms terhadap R−90 ms), cocok untuk morfologi sintetis ini saja.
- Ambang "cek" di Eksperimen 4 (mis. LSB ≤ 5 µV di elektroda, HPF ≤ 0,5 Hz) adalah aturan praktis untuk
  pembelajaran, bukan kutipan standar.

---

## Deploy ke GitHub Pages

Aplikasi berupa berkas statis dengan path relatif, sehingga bisa langsung di-host GitHub Pages
(yang menyajikan `.js` dengan MIME `text/javascript`, syarat modul ES).

**Opsi A — repositori khusus (paling sederhana)**

1. Buat repositori baru di GitHub, mis. `ecg-simulator`.
2. Dari folder `ecg-simulator`:
   ```bash
   git init
   git add .
   git commit -m "Simulator akuisisi ECG"
   git branch -M main
   git remote add origin https://github.com/<username>/ecg-simulator.git
   git push -u origin main
   ```
3. Di GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pilih **Branch: `main`**, folder **`/ (root)`**, lalu **Save**.
4. Tunggu 1–2 menit; situs tersedia di `https://<username>.github.io/ecg-simulator/`.

**Opsi B — simulator berada di subfolder repositori lain**

Pages dari branch hanya bisa menyajikan `/` atau `/docs`. Pilih salah satu:
- ganti nama folder `ecg-simulator` menjadi `docs` lalu pilih folder `/docs` di Settings → Pages; atau
- pakai **Source: GitHub Actions** dengan workflow `actions/upload-pages-artifact` (`path: ecg-simulator`)
  + `actions/deploy-pages`.

**Catatan**
- Path di GitHub Pages peka huruf besar-kecil; semua impor di proyek ini huruf kecil dan relatif.
- Tidak ada folder berawalan `_`, jadi `.nojekyll` tidak diperlukan (aman bila ditambahkan).
- Setelah deploy, buka DevTools → Console untuk memastikan tidak ada error 404 pada `js/*.js`.
