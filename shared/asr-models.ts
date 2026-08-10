// On-device ASR model catalog — single source for settings, downloads, and runtime loading.
//
// All tiers stay on the Xenova exports (transformers.js v2-era): they are the
// only ones whose ONNX graphs output cross-attentions, which transformers.js
// needs for word-level timestamps — the project's transcript editor depends on
// them (measured: onnx-community exports throw "Model outputs must contain
// cross attentions" on return_timestamps:'word' on both Node and browser).
//
// fp16/fp32 variants are registered per tier for the opt-in WebGPU path
// (encoder fp32 + decoder fp16 mixed dtype; measured on M5: WebGPU + fp16
// encoder yields empty transcripts, q8/int8 are unsupported on the WebGPU EP).

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
    id: 'tiny', modelId: 'Xenova/whisper-tiny', revision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
    files: [
      { path: 'config.json', sizeBytes: 2248, sha256: '2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94' },
      { path: 'generation_config.json', sizeBytes: 3716, sha256: '68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 10124910, sha256: 'fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 30727765, sha256: '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0' },
      // WebGPU mixed-dtype path (encoder fp32 + decoder fp16).
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 16519776, sha256: '975ccfeb5cb2096ef3ca858cf4e62473aac515a2af115413910a87be4d3e3886' },
      { path: 'onnx/decoder_model_merged_fp16.onnx', sizeBytes: 59603028, sha256: 'b5b6e3f37071723df3f47cf1b448a9672780b015846886336a5e712f02813541' },
      { path: 'onnx/encoder_model.onnx', sizeBytes: 32909539, sha256: '39e81b6c86a5b2b4beda1bb3145486a769d594801f780a66cad1ae72c7ad2c5e' },
    ],
    label: 'Whisper Tiny', sizeLabel: '约 100MB', language: '中 / 英', note: '最快最省，适合低配置设备；识别精度一般。',
  },
  {
    id: 'base', modelId: 'Xenova/whisper-base', revision: '64da57285918e20ea79ea5c88eed7197933abaa8',
    files: [
      { path: 'config.json', sizeBytes: 2248, sha256: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b' },
      { path: 'generation_config.json', sizeBytes: 3776, sha256: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 23200850, sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 53707539, sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861' },
      // WebGPU mixed-dtype path (encoder fp32 + decoder fp16).
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 41333198, sha256: 'b12013ba360d247e5af6805590501a94b18f14abb5ba2607f992783adcb23c73' },
      { path: 'onnx/decoder_model_merged_fp16.onnx', sizeBytes: 104742968, sha256: 'd875a521a214f62258f922933e8afe96794c03d571b4039fe08bc9000fb49ddc' },
      { path: 'onnx/encoder_model.onnx', sizeBytes: 82474863, sha256: 'f0bd7927234639c6e1f293cef18a210cee4e4aea93e200ebbe48e1d7acf6fdb1' },
    ],
    label: 'Whisper Base', sizeLabel: '约 80MB', language: '中 / 英', note: '轻量均衡，日常口播可用。',
  },
  {
    id: 'small', modelId: 'Xenova/whisper-small', revision: '2d67713f236afa48a18992566e7647f6ca848e13',
    files: [
      { path: 'config.json', sizeBytes: 2232, sha256: '5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be' },
      { path: 'generation_config.json', sizeBytes: 3837, sha256: '0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 92324809, sha256: '969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 156780950, sha256: 'fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24' },
      // WebGPU mixed-dtype path (encoder fp32 + decoder fp16).
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 176608338, sha256: '6e4af405c8b3e1f97ec74fc009de3112e39f839a3d924761ae089a15d5a70663' },
      { path: 'onnx/decoder_model_merged_fp16.onnx', sizeBytes: 308615077, sha256: '8d0e347441bdac2a62b346bbcb6fc69548651658028ec7e424ecb76c0e09ab9a' },
      { path: 'onnx/encoder_model.onnx', sizeBytes: 352839389, sha256: '31a05a14d514440e43746fdaaa8d4e8102c9543e53c5ae1111910af142041406' },
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
