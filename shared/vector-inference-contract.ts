export const SEMANTIC_INFERENCE_CONTRACT = Object.freeze({
  id: 'chinese-clip-q4-224-v1',
  modelId: 'Xenova/chinese-clip-vit-base-patch16',
  revision: 'f26904860903e70e050b8f48255e5f48401816e9',
  dtype: 'q4',
  inputEdge: 224,
  embeddingDimension: 512,
  maxVectorsPerAsset: 96,
  duplicateResultLimit: 1_000,
} as const);

export const CLAP_INFERENCE_CONTRACT = Object.freeze({
  id: 'clap-q8-48khz-v1',
  modelId: 'Xenova/clap-htsat-unfused',
  revision: 'c28f2883575e590e04d3146ff0713c2448d691ba',
  dtype: 'q8',
  sampleRate: 48_000,
  embeddingDimension: 512,
  windowSeconds: 10,
} as const);

export const RHYTHM_INFERENCE_CONTRACT = Object.freeze({
  id: 'beat-this-onnx-22050-v1',
  modelId: 'musetric/beat-this-onnx',
  revision: '4e971bd43753023e1bf961c34a0cb74985cfcb88',
  sampleRate: 22_050,
  hopLength: 441,
  maxDurationSeconds: 60 * 60,
  nativeMaxDurationSeconds: 5 * 60,
  minimumSamples: 513,
  files: Object.freeze({
    model: Object.freeze({
      path: 'beat_this.onnx',
      sizeBytes: 83_143_431,
      sha256: '078572af6ca47741e06a82d09525d13c793eaa8e311a8cf15e831dcd7e73f218',
    }),
    filterbank: Object.freeze({
      path: 'mel-filterbank.bin',
      sizeBytes: 262_656,
      sha256: '1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533',
    }),
  }),
} as const);
