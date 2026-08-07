// On-device ASR model catalog — single source for the settings UI, the server
// download endpoints, and the runtime model selection. Model files come from
// the HF hub via the local hf-proxy (multi-source accelerated download + disk
// cache); users pick and download models themselves in Settings → 转写.

/** Files transformers.js needs for a whisper-style model (relative to repo root). */
export const ASR_MODEL_FILES: readonly string[] = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

export interface AsrModelEntry {
  /** Stable local id used by settings/runtime (LOCAL_ASR_MODEL value). */
  id: 'tiny' | 'base' | 'small' | 'medium';
  /** Hugging Face repo id fetched through the hf-proxy. */
  modelId: string;
  /** Display name in the settings list. */
  label: string;
  /** Approximate download size, human readable (measured, see download logs). */
  sizeLabel: string;
  /** Language coverage hint. */
  language: string;
  /** One-line positioning note for the settings list. */
  note: string;
}

export const ASR_MODELS: readonly AsrModelEntry[] = [
  {
    id: 'tiny',
    modelId: 'Xenova/whisper-tiny',
    label: 'Whisper Tiny',
    sizeLabel: '约 100MB',
    language: '中 / 英',
    note: '最快最省，适合低配置设备；识别精度一般。',
  },
  {
    id: 'base',
    modelId: 'Xenova/whisper-base',
    label: 'Whisper Base',
    sizeLabel: '约 80MB',
    language: '中 / 英',
    note: '轻量均衡，日常口播可用。',
  },
  {
    id: 'small',
    modelId: 'Xenova/whisper-small',
    label: 'Whisper Small',
    sizeLabel: '约 250MB',
    language: '中 / 英',
    note: '推荐：中英文识别均衡，简体输出，词级时间戳稳定。',
  },
  {
    id: 'medium',
    modelId: 'Xenova/whisper-medium',
    label: 'Whisper Medium',
    sizeLabel: '约 1.1GB',
    language: '中 / 英',
    note: '精度最高但体积大、转写较慢；追求效果时选择。',
  },
];

/** Local tier values accepted by the runtime selection ('' = auto by device memory). */
export const ASR_MODEL_TIERS: readonly string[] = ['', 'tiny', 'base', 'small', 'medium'] as const;

export function asrModelEntry(id: string): AsrModelEntry | undefined {
  return ASR_MODELS.find((entry) => entry.id === id);
}

/** Download task status shared by the server endpoints and the settings UI. */
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
