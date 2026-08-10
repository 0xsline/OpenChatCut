export type ModelPackId = 'rhythm-lite' | 'music-semantics-lite' | 'visual-semantics-lite';

export type ModelPackCapability =
  | '节拍定位'
  | '下拍定位'
  | 'BPM 与拍号'
  | '节拍能量'
  | '音乐语义向量'
  | '音乐相似度'
  | '画面语义向量'
  | '中文画面检索'
  | '重复镜头检测';

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
  {
    id: 'visual-semantics-lite',
    label: '画面语义轻量包',
    description: '在本机生成画面与中文文本向量，用于语义检索和重复镜头检测。',
    modelId: 'Xenova/chinese-clip-vit-base-patch16',
    revision: 'f26904860903e70e050b8f48255e5f48401816e9',
    license: 'Apache-2.0',
    sizeBytes: 178_225_758,
    recommendedMemoryBytes: 2 * GIB,
    capabilities: ['画面语义向量', '中文画面检索', '重复镜头检测'],
    files: [
      {
        path: 'config.json',
        sizeBytes: 844,
        sha256: '19447ad8c20d274f0644a6663af56286be98bd2d0e5f9472fcb318e04fcd6961',
      },
      {
        path: 'preprocessor_config.json',
        sizeBytes: 546,
        sha256: '61a78fdd2c7ac17b54b6190c0f4cb23423192c535003d52528d01e318a47608b',
      },
      {
        path: 'special_tokens_map.json',
        sizeBytes: 125,
        sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      },
      {
        path: 'tokenizer.json',
        sizeBytes: 439_124,
        sha256: '7dfbf1966ebf99d471c3796e9b457329d2b2182b817e144f1e904b957745c839',
      },
      {
        path: 'tokenizer_config.json',
        sizeBytes: 1_315,
        sha256: '38fbc894183595cc1168e36150251b2fb658197b3a49f6908cce88ae22acd52a',
      },
      {
        path: 'vocab.txt',
        sizeBytes: 109_540,
        sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
      },
      {
        path: 'onnx/model_q4.onnx',
        sizeBytes: 177_674_264,
        sha256: 'c64c40f177a8756c7831cdaa932bfb30187ef2e85266e54ec838259d34d3fe2e',
      },
    ],
  },
] as const satisfies readonly ModelPackDefinition[];

export function modelPackDefinition(id: string): ModelPackDefinition | undefined {
  return MODEL_PACKS.find((pack) => pack.id === id);
}

/**
 * User-facing install guidance for missing model packs (used by agent tools).
 * Bilingual because the assistant relays it in the user's language.
 */
export function modelPackInstallGuidance(packs: readonly { id: string }[]): string {
  const names = packs.map((pack) => {
    const def = MODEL_PACKS.find((entry) => entry.id === pack.id);
    return def ? `${def.label}（${def.id}）` : pack.id;
  }).join('、');
  return `请到 设置 → 转写 → 本地模型 下载：${names}（Settings → Transcription → Local models: ${packs.map((pack) => pack.id).join(', ')}）`;
}
