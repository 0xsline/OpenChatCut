// On-device ASR model catalog — single source for settings, downloads, and runtime loading.
//
// tiny/base/small use the onnx-community exports (transformers.js v3+ era): they keep
// the same q8 weights, but the export layout halves CPU inference memory (measured
// -49% RSS on whisper-base q8) and unlocks fp16 / per-module dtype for WebGPU.
// medium stays on Xenova/whisper-medium: the onnx-community medium repo is not
// reachable via HF API/CDN (401), and keeping the old entry preserves already
// downloaded model data (compat-first rule).

export interface AsrModelFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface AsrModelEntry {
  readonly id: 'tiny' | 'base' | 'small' | 'medium';
  readonly modelId: string;
  readonly revision: string;
  readonly files: readonly AsrModelFile[];
  readonly label: string;
  readonly sizeLabel: string;
  readonly language: string;
  readonly note: string;
}

export const ASR_MODELS: readonly AsrModelEntry[] = [
  {
    id: 'tiny', modelId: 'onnx-community/whisper-tiny', revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
    files: [
      { path: 'config.json', sizeBytes: 2243, sha256: '46aeea0a406afbeb563fc8e59ca10609203df4299af6a83f73752fef369efd2d' },
      { path: 'generation_config.json', sizeBytes: 3772, sha256: 'f5c67e5a4f7102f8cb4d058bc95da276bbc19eeec997267c3bb0f25ef68facd1' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 10124990, sha256: '2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 30719241, sha256: '25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3' },
    ],
    label: 'Whisper Tiny', sizeLabel: '约 40MB', language: '中 / 英', note: '最快最省，适合低配置设备；识别精度一般。',
  },
  {
    id: 'base', modelId: 'onnx-community/whisper-base', revision: '1846881b6b3a3024392c1eea3ad983695bc23925',
    files: [
      { path: 'config.json', sizeBytes: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', sizeBytes: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 23201314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 53693315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' },
    ],
    label: 'Whisper Base', sizeLabel: '约 80MB', language: '中 / 英', note: '轻量均衡，日常口播可用。',
  },
  {
    id: 'small', modelId: 'onnx-community/whisper-small', revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    files: [
      { path: 'config.json', sizeBytes: 2227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', sizeBytes: 3893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 92326160, sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 156750845, sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
    ],
    label: 'Whisper Small', sizeLabel: '约 250MB', language: '中 / 英', note: '推荐：中英文识别均衡，简体输出，词级时间戳稳定。',
  },
  {
    id: 'medium', modelId: 'Xenova/whisper-medium', revision: '8c5b90880ab9f79487ab33613413431bf661d595',
    files: [
      { path: 'config.json', sizeBytes: 2256, sha256: 'a9c2ef0290a8fa3d203231dd01a074891b7f595d5d305ead2aac8ac5e6e47105' },
      { path: 'generation_config.json', sizeBytes: 3694, sha256: 'c57f39da43ff86f60451a1c978743ca48fd995ac5d7e3c3534f856d0bed57770' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 313468028, sha256: '7d6b4a00e441271646327f8a71b6e1bd1a305013cd914b51ddd76919c59ee3af' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 462661606, sha256: '2cdd6d06ebdf9d993d21117bfeeb7e9b399521b7766d3df77c54a85d6dcf3c08' },
    ],
    label: 'Whisper Medium', sizeLabel: '约 1.1GB', language: '中 / 英', note: '精度最高但体积大、转写较慢；追求效果时选择。',
  },
];

export const ASR_MODEL_FILES: readonly string[] = ASR_MODELS[0].files.map((file) => file.path);
export const ASR_MODEL_TIERS: readonly string[] = ['', 'tiny', 'base', 'small', 'medium'] as const;

export function asrModelEntry(id: string): AsrModelEntry | undefined {
  return ASR_MODELS.find((entry) => entry.id === id);
}

export function asrModelFile(modelId: string, revision: string, path: string): AsrModelFile | undefined {
  const model = ASR_MODELS.find((entry) => entry.modelId === modelId && entry.revision === revision);
  return model?.files.find((file) => file.path === path);
}

export type AsrDownloadStatus = 'idle' | 'downloading' | 'done' | 'error';
export interface AsrDownloadTask {
  id: string;
  status: AsrDownloadStatus;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  error?: string;
}
