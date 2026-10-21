/**
 * profiles/params.js — Merakit parameter pipeline LENGKAP dari sebuah profil.
 *
 * Dipisah dari index.js karena memerlukan signal.js (yang sendiri mengimpor
 * registri), dan murni (tanpa DOM) agar bisa diuji di Node.
 */

import { DEFAULT_SIGNAL_PARAMS } from '../signal.js';
import { DEFAULT_FILTER_PARAMS } from '../filters.js';
import { DEFAULT_ADC_PARAMS } from '../adc.js';
import { FS_ANALOG } from './common.js';
import { getProfile } from './index.js';

/** Parameter gangguan bawaan (semua mati) untuk sebuah profil, dalam SI. */
export function defaultDisturbances(profile) {
  const out = {};
  for (const d of profile.disturbances) {
    const o = { on: false, ...(d.fixed ?? {}) };
    for (const s of d.sliders) o[s.key] = s.def * s.toSI;
    out[d.id] = o;
  }
  return out;
}

/** Parameter filter dari preset (menggabungkan dengan bawaan agar semua field ada). */
export function presetFilterParams(preset) {
  const f = preset.filter ?? {};
  return {
    ...DEFAULT_FILTER_PARAMS,
    ...f,
    lpf: { ...DEFAULT_FILTER_PARAMS.lpf, ...f.lpf },
    hpf: { ...DEFAULT_FILTER_PARAMS.hpf, ...f.hpf },
    bpf: { ...DEFAULT_FILTER_PARAMS.bpf, ...f.bpf },
    notch: { ...DEFAULT_FILTER_PARAMS.notch, ...f.notch },
  };
}

/** Bagian pipeline yang ditentukan preset rekomendasi (tanpa sinyal/gangguan). */
export function presetPipelineParams(preset) {
  return {
    amplifier: { gain: preset.gain, vSat: preset.vSat },
    filter: presetFilterParams(preset),
    adc: {
      ...DEFAULT_ADC_PARAMS,
      fs: preset.fs, bits: preset.bits, vRef: preset.vRef, antiAlias: preset.antiAlias,
    },
  };
}

/**
 * Parameter pipeline lengkap saat sebuah profil dipilih:
 * kontrol sinyal bawaan + semua gangguan mati + preset rekomendasi.
 * @returns {{ signal, amplifier, filter, adc }} — siap untuk runPipeline
 */
export function defaultParams(profileId) {
  const prof = getProfile(profileId);
  const disturbances = { ...DEFAULT_SIGNAL_PARAMS.disturbances, ...defaultDisturbances(prof) };
  return {
    signal: {
      ...DEFAULT_SIGNAL_PARAMS,
      ...prof.defaults,
      source: prof.id,
      duration: prof.defaultDuration,
      fs: FS_ANALOG,
      disturbances,
    },
    ...presetPipelineParams(prof.preset),
  };
}
