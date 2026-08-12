// On-device ASR model catalog — single source for settings, downloads, and runtime loading.
//
// Word-level timestamps require ONNX graphs that output cross-attentions.
// Older onnx-community exports (whisper-base/small/medium without the
// `_timestamped` suffix) throw "Model outputs must contain cross attentions"
// on return_timestamps:'word' on both Node and browser — so the "small" and
// "medium" tiers keep the Xenova (transformers.js v2-era) exports that work.
//
// The "base" tier now uses onnx-community/whisper-base_timestamped, the
// timestamped re-export designed for word-level timestamps. It loads much
// faster than the Xenova export and produces identical word-level output,
// while keeping the fp16/fp32 WebGPU variant slots (encoder fp32 + decoder
// fp16 mixed dtype; measured on M5: WebGPU + fp16 encoder yields empty
// transcripts, q8/int8 are unsupported on the WebGPU EP).

export interface AsrModelFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Desktop-only whisper.cpp model (GGML format) paired with an ONNX tier.
 * The desktop native-ASR worker runs whisper-cli with this file while the
 * browser path keeps the ONNX graph; both are downloaded and verified through
 * the same server-side hf-proxy channel.
 */
export interface GgmlAsrModelFile {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly revision: string;
}

export interface AsrModelEntry {
  readonly id: 'tiny' | 'base' | 'small' | 'medium';
  readonly modelId: string;
  readonly revision: string;
  readonly files: readonly AsrModelFile[];
  readonly ggmlFile?: GgmlAsrModelFile;
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
    ggmlFile: {
      fileName: 'ggml-tiny-q5_1.bin', sizeBytes: 32152673,
      sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7',
      revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
    },
    label: 'Whisper Tiny', sizeLabel: '约 100MB', language: '中 / 英', note: '最快最省，适合低配置设备；识别精度一般。',
  },
  {
    id: 'base', modelId: 'onnx-community/whisper-base_timestamped', revision: '608c49e61301901684bc36cac8f74b95ff6b5a8e',
    files: [
      { path: 'config.json', sizeBytes: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', sizeBytes: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'preprocessor_config.json', sizeBytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', sizeBytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', sizeBytes: 282682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' },
      { path: 'onnx/encoder_model_quantized.onnx', sizeBytes: 23159167, sha256: '2714484ebe1bae7c1646e8eadb768bb9d415cf11763466d21f23039a29c62e6f' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', sizeBytes: 53712708, sha256: 'cf9a8d5bcddc0917a0078135b484cedcaf44f28909cd91910abd29dced9171db' },
      // WebGPU mixed-dtype path (encoder fp32 + decoder fp16).
      { path: 'onnx/encoder_model_fp16.onnx', sizeBytes: 41270731, sha256: '2d31aa4b0c8c74c2e49a5c8d8a5640e38e75aac493cf15290f8c1466ee8c1845' },
      { path: 'onnx/decoder_model_merged_fp16.onnx', sizeBytes: 104701989, sha256: 'e6770b411d380038c3d69e9196aaf3bc9d72d848c809a24919d9a4adccb534ee' },
      { path: 'onnx/encoder_model.onnx', sizeBytes: 82451730, sha256: '7fcea817bb2be4d86729b521e5a7fcbec28fa743edfed67e882b33ff15852540' },
    ],
    ggmlFile: {
      fileName: 'ggml-base-q5_1.bin', sizeBytes: 59707625,
      sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
      revision: '5359861c739e955e79d9a303bcbc70fb988958b1',
    },
    label: 'Whisper Base', sizeLabel: '约 80MB', language: '中 / 英', note: '轻量均衡，日常口播可用；timestamped 转写更快。',
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
