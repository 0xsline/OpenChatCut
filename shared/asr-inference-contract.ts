export const ASR_INFERENCE_CONTRACT = {
  id: 'whisper-q8-16khz-word-v1',
  sampleRate: 16_000,
  maxAudioSeconds: 60 * 60,
  chunkSeconds: 30,
  strideSeconds: 5,
  dtype: 'q8',
} as const;
