export type ModelPackId = 'rhythm-lite' | 'music-semantics-lite';

export type ModelPackCapability =
  | '节拍定位'
  | '下拍定位'
  | 'BPM 与拍号'
  | '节拍能量'
  | '音乐语义向量'
  | '音乐相似度';

export interface ModelPackFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ModelPackDefinition {
  readonly id: ModelPackId;
  readonly label: string;
  readonly description: string;
  readonly modelId: string;
  readonly revision: string;
  readonly license: 'MIT' | 'Apache-2.0';
  readonly sizeBytes: number;
  readonly recommendedMemoryBytes: number;
  readonly capabilities: readonly ModelPackCapability[];
  readonly files: readonly ModelPackFile[];
}

export type ModelPackStatus = 'absent' | 'downloading' | 'installed' | 'error';

export interface ModelPackTask {
  readonly id: ModelPackId;
  readonly status: Exclude<ModelPackStatus, 'absent'>;
  readonly bytesDone: number;
  readonly bytesTotal: number;
  readonly filesDone: number;
  readonly filesTotal: number;
  readonly error?: string;
}

export interface ModelPackCatalogEntry extends ModelPackDefinition {
  readonly status: ModelPackStatus;
  readonly installedBytes: number;
  readonly task?: ModelPackTask;
  readonly error?: string;
}

const GIB = 1024 * 1024 * 1024;

export const MODEL_PACKS = [
  {
    id: 'rhythm-lite',
    label: '节奏分析轻量包',
    description: '本地分析节拍、下拍、速度、拍号与节拍能量。',
    modelId: 'musetric/beat-this-onnx',
    revision: '4e971bd43753023e1bf961c34a0cb74985cfcb88',
    license: 'MIT',
    sizeBytes: 83_407_111,
    recommendedMemoryBytes: 1 * GIB,
    capabilities: ['节拍定位', '下拍定位', 'BPM 与拍号', '节拍能量'],
    files: [
      {
        path: 'beat_this.onnx',
        sizeBytes: 83_143_431,
        sha256: '078572af6ca47741e06a82d09525d13c793eaa8e311a8cf15e831dcd7e73f218',
      },
      {
        path: 'config.json',
        sizeBytes: 1_024,
        sha256: '56cc961ddc588c57787c20c01ec6ab483b23af1049e65bd33d599a81803acd69',
      },
      {
        path: 'mel-filterbank.bin',
        sizeBytes: 262_656,
        sha256: '1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533',
      },
    ],
  },
  {
    id: 'music-semantics-lite',
    label: '音乐语义轻量包',
    description: '在本机生成音乐语义向量，用于检索与相似度匹配。',
    modelId: 'Xenova/clap-htsat-unfused',
    revision: 'c28f2883575e590e04d3146ff0713c2448d691ba',
    license: 'Apache-2.0',
    sizeBytes: 34_302_907,
    recommendedMemoryBytes: 2 * GIB,
    capabilities: ['音乐语义向量', '音乐相似度'],
    files: [
      {
        path: 'config.json',
        sizeBytes: 699,
        sha256: '39c6d90fe29cf2cce650dd5c92c38a1e35b130d9ce0bb98585222ad687ad979b',
      },
      {
        path: 'preprocessor_config.json',
        sizeBytes: 541,
        sha256: '9739f58296aa6f9ac18008fd0150fb2649bc554985fbde86d0a4041c882ac753',
      },
      {
        path: 'onnx/audio_model_quantized.onnx',
        sizeBytes: 34_301_667,
        sha256: '3fcff2c8824e7bcb83a983f2a49edab3b60cbcf4872ac70efee517355173bd1f',
      },
    ],
  },
] as const satisfies readonly ModelPackDefinition[];

export function modelPackDefinition(id: string): ModelPackDefinition | undefined {
  return MODEL_PACKS.find((pack) => pack.id === id);
}
