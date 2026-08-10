export const ASR_INFERENCE_CONTRACT = {
  id: 'whisper-q8-16khz-word-v1',
  sampleRate: 16_000,
  maxAudioSeconds: 60 * 60,
  chunkSeconds: 30,
  strideSeconds: 5,
  dtype: 'q8',
  // transformers.js v4 per-module dtypes for the WebGPU path. Measured on
  // M5: encoder fp16 on WebGPU yields empty transcripts (silent failure);
  // encoder fp32 + decoder fp16 produces full, correct text at ~1.4-1.7x the
  // wasm q8 speed. int8/q8 models are not supported on the WebGPU EP at all.
  webgpuDtype: { encoder_model: 'fp32', decoder_model_merged: 'fp16' },
} as const;
