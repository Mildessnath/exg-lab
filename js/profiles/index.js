/**
 * profiles/index.js — Registri profil sinyal.
 *
 * Satu profil = satu mekanisme untuk seluruh jenis sinyal. Tiap profil adalah objek
 * data + generator murni dengan bentuk (lihat validateProfile):
 *
 *   id, nama, singkat, deskripsi
 *   generator(t, params) → Float64Array (V) pada domain analog 10 kHz
 *   amplitudo { tipikal:[lo,hi] (V), keterangan }   band [fLow, fHigh] (Hz, diagnostik)
 *   bandCheck { hpMax, lpMin, hpWhy, lpWhy }   lsbTarget (V di elektroda)   defaultDuration (s)
 *   repFreq(params) → [f, label]   frekuensi representatif untuk panel respons filter
 *   controls[]        kontrol sinyal (slider / select / check), satuan tampilan + toSI
 *   disturbances[]    gangguan khas (toggle + slider), lihat disturbances.js
 *   defaults          nilai bawaan parameter sinyal (SI), diturunkan dari controls
 *   preset            { gain, filter, fs, bits, vRef, vSat, antiAlias } — konfigurasi rekomendasi
 *   limits            { vSat:[min,max], vRef:[min,max] } batas slider rail amplifier & rentang ADC
 *   info(ctx)         baris panel karakteristik sinyal [[label, nilai], …]
 *   batas[]           batas model (teks) · filterAdvice (HTML) · recommendReasons[[judul, teks]]
 *
 * SEMUA SINYAL SINTETIS DAN MODEL SEDERHANA — bukan pengganti data klinis.
 */

import { ecgProfile } from './ecg.js';
import { emgProfile } from './emg.js';
import { eegProfile } from './eeg.js';
import { eogProfile } from './eog.js';
import { sineProfile } from './sine.js';

/** Urutan tampil di UI. */
export const PROFILES = Object.freeze([ecgProfile, emgProfile, eegProfile, eogProfile, sineProfile]);

const BY_ID = new Map(PROFILES.map((p) => [p.id, p]));

export const DEFAULT_PROFILE_ID = 'ecg';

/** Profil menurut id; id tak dikenal jatuh ke ECG (perilaku v1: sumber selain 'sine' = ECG). */
export function getProfile(id) {
  return BY_ID.get(id) ?? ecgProfile;
}

export const listProfiles = () => PROFILES;

/**
 * Memeriksa kelengkapan bentuk sebuah profil. Mengembalikan daftar masalah
 * (kosong = lengkap). Dipakai oleh tes agar profil baru tidak lupa field wajib.
 */
export function validateProfile(p) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  const isStr = (v) => typeof v === 'string' && v.length > 0;
  const isRange = (r) => Array.isArray(r) && r.length === 2 && r[0] < r[1];

  need(isStr(p.id), 'id');
  need(isStr(p.nama), 'nama');
  need(isStr(p.deskripsi), 'deskripsi');
  need(typeof p.generator === 'function', 'generator');
  need(p.amplitudo && isRange(p.amplitudo.tipikal), 'amplitudo.tipikal');
  need(isRange(p.band), 'band');
  need(p.bandCheck && p.bandCheck.hpMax > 0 && p.bandCheck.lpMin > 0, 'bandCheck');
  need(p.lsbTarget > 0, 'lsbTarget');
  need(typeof p.repFreq === 'function' && p.repFreq({ sineFreq: 10 })[0] > 0, 'repFreq');
  need(p.defaultDuration > 0, 'defaultDuration');
  need(Array.isArray(p.controls) && p.controls.length > 0, 'controls');
  need(Array.isArray(p.disturbances) && p.disturbances.length > 0, 'disturbances');
  need(p.defaults && typeof p.defaults === 'object', 'defaults');
  need(typeof p.info === 'function', 'info');
  need(Array.isArray(p.batas) && p.batas.length > 0, 'batas');
  need(isStr(p.filterAdvice), 'filterAdvice');
  need(Array.isArray(p.recommendReasons) && p.recommendReasons.length === 4, 'recommendReasons (4 butir)');

  const pr = p.preset ?? {};
  for (const k of ['gain', 'fs', 'bits', 'vRef', 'vSat']) need(pr[k] > 0, `preset.${k}`);
  need(pr.filter && typeof pr.filter.type === 'string', 'preset.filter.type');
  need(typeof pr.antiAlias === 'boolean', 'preset.antiAlias');
  need(p.limits && isRange(p.limits.vSat) && isRange(p.limits.vRef), 'limits');
  if (p.limits && pr.vSat) need(pr.vSat >= p.limits.vSat[0] && pr.vSat <= p.limits.vSat[1], 'preset.vSat di dalam limits.vSat');
  if (p.limits && pr.vRef) need(pr.vRef >= p.limits.vRef[0] && pr.vRef <= p.limits.vRef[1], 'preset.vRef di dalam limits.vRef');

  for (const c of p.controls ?? []) {
    need(isStr(c.key) && isStr(c.label), `kontrol ${c.key}: key/label`);
    if (c.type === 'range') {
      need(c.min < c.max && c.def >= c.min && c.def <= c.max && c.step > 0, `kontrol ${c.key}: min/max/def/step`);
      need(c.toSI > 0, `kontrol ${c.key}: toSI`);
    } else if (c.type === 'select') {
      need(Array.isArray(c.options) && c.options.some((o) => o[0] === c.def), `kontrol ${c.key}: options/def`);
    } else {
      need(c.type === 'check', `kontrol ${c.key}: tipe ${c.type}`);
    }
    need(c.key in p.defaults, `defaults memuat ${c.key}`);
  }
  for (const d of p.disturbances ?? []) {
    need(isStr(d.id) && isStr(d.label) && isStr(d.short), `gangguan ${d.id}: id/label/short`);
    need(Array.isArray(d.sliders) && d.sliders.length > 0, `gangguan ${d.id}: sliders`);
    for (const s of d.sliders ?? []) {
      need(s.min < s.max && s.def >= s.min && s.def <= s.max && s.step > 0 && s.toSI > 0, `gangguan ${d.id}.${s.key}: batas slider`);
    }
  }
  return bad;
}
