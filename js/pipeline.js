/**
 * pipeline.js — Merangkai tahap-tahap pemrosesan:
 *   ECG → Amplifier → Filter → Sampling → Quantization → Output digital
 *
 * Setiap tahap adalah fungsi murni; pipeline hanya meneruskan keluaran satu
 * tahap menjadi masukan tahap berikutnya. Tahap yang belum diimplementasikan
 * ditandai `ready: false` dan dilewati.
 */

import { generateSignal, DEFAULT_SIGNAL_PARAMS } from './signal.js';
import { amplify, DEFAULT_AMP_PARAMS } from './amplifier.js';
import { applyFilterSpec, DEFAULT_FILTER_PARAMS } from './filters.js';
import { runAdc, DEFAULT_ADC_PARAMS } from './adc.js';

export const STAGE_DEFS = Object.freeze([
  { id: 'ecg', label: 'ECG (analog)', ready: true },
  { id: 'amp', label: 'Amplifier', ready: true },
  { id: 'filter', label: 'Filter', ready: true },
  { id: 'sampling', label: 'Sampling', ready: true },
  { id: 'quant', label: 'Kuantisasi', ready: true },
  { id: 'output', label: 'Output digital', ready: true }, // kode ADC + ekspor CSV (Eksperimen 4)
]);

export const DEFAULT_PARAMS = Object.freeze({
  signal: DEFAULT_SIGNAL_PARAMS,
  amplifier: DEFAULT_AMP_PARAMS,
  filter: DEFAULT_FILTER_PARAMS,
  adc: DEFAULT_ADC_PARAMS,
});

/**
 * Menjalankan seluruh tahap yang sudah tersedia.
 * @returns {{ params, stages: { ecg, amp, filt, adc } }}
 */
export function runPipeline(params = DEFAULT_PARAMS) {
  const ecg = generateSignal(params.signal);
  const amp = amplify(ecg.x, params.amplifier);
  // Filter bekerja pada keluaran amplifier, masih di domain analog (10 kHz).
  const filt = applyFilterSpec(amp.y, ecg.fs, params.filter ?? DEFAULT_FILTER_PARAMS);
  // ADC: [anti-aliasing] → sampling → kuantisasi.
  const adc = runAdc(filt.y, ecg.fs, params.adc ?? DEFAULT_ADC_PARAMS);
  return { params, stages: { ecg, amp, filt, adc } };
}
