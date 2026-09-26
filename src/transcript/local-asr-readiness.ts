// Per-engine readiness of the local ASR tiers, read from GET /api/asr-models.
//
// The two local engines load different files: desktop whisper.cpp reads only a
// tier's GGML companion, the browser (transformers.js) worker only its ONNX
// export. Requiring both before either could run blocked an installed desktop
// model behind a browser download it never reads (#168), and blocked every
// browser-only install once its tier gained a companion.
import { t } from '../i18n/locale';
import { TranscriptionError } from './assemblyai';
import type { AsrConfig } from './local-asr-types';

export type LocalAsrEngine = 'native' | 'browser';

/** The part of a GET /api/asr-models row that readiness depends on. */
export interface LocalAsrModelStatus {
  readonly modelId: string;
  readonly label?: string;
  /** Every file of the tier (ONNX export and companion). */
  readonly downloaded?: boolean;
  readonly onnxDownloaded?: boolean;
  readonly ggmlDownloaded?: boolean;
}

/** Whether `engine` can load the tier: whisper.cpp needs the companion, the browser the ONNX export. */
export function asrEngineReady(model: LocalAsrModelStatus, engine: LocalAsrEngine): boolean {
  const ready = engine === 'native' ? model.ggmlDownloaded : model.onnxDownloaded;
  // A server that predates per-engine readiness only reports the complete pack.
  return ready ?? model.downloaded === true;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseModelStatus(value: unknown): LocalAsrModelStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.modelId !== 'string') return null;
  return {
    modelId: record.modelId,
    label: typeof record.label === 'string' ? record.label : undefined,
    downloaded: optionalBoolean(record, 'downloaded'),
    onnxDownloaded: optionalBoolean(record, 'onnxDownloaded'),
    ggmlDownloaded: optionalBoolean(record, 'ggmlDownloaded'),
  };
}

/** The catalog rows, or null when the catalog cannot be read. */
export async function fetchLocalAsrCatalog(): Promise<LocalAsrModelStatus[] | null> {
  try {
    const response = await fetch('/api/asr-models', { cache: 'no-store' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('models' in body)
      || !Array.isArray(body.models)) return null;
    return body.models.flatMap((model: unknown) => {
      const status = parseModelStatus(model);
      return status ? [status] : [];
    });
  } catch {
    return null;
  }
}

/** The catalog row of `modelId`, or null when unknown (catalog unreadable or tier not listed). */
export async function fetchLocalAsrModelStatus(modelId: string): Promise<LocalAsrModelStatus | null> {
  return (await fetchLocalAsrCatalog())?.find((model) => model.modelId === modelId) ?? null;
}

function browserEngineMissingDetail(
  model: string,
  status: LocalAsrModelStatus,
  native: { readonly enabled: boolean; readonly failure?: Error },
): string {
  if (native.failure) {
    return t('桌面原生推理（whisper.cpp）未能完成转写：{reason}。回退到浏览器引擎需要 {model} 的 ONNX 模型文件，但尚未下载完整。请到 设置 → 本地模型 → 本地转写 下载该模型后重试。', {
      reason: native.failure.message, model,
    });
  }
  if (native.enabled && !asrEngineReady(status, 'native')) {
    return t('本地转写模型 {model} 尚未下载：桌面引擎需要的 whisper.cpp 模型文件（GGML）和浏览器引擎需要的 ONNX 模型文件都未就绪。请到 设置 → 本地模型 → 本地转写 下载该模型后再试。', { model });
  }
  return t('本地转写模型 {model} 的浏览器引擎文件（ONNX）未下载完整或校验失败。请到 设置 → 本地模型 → 本地转写 下载该模型后再试。', { model });
}

/**
 * Refuse to start the browser engine when the catalog says its ONNX export is
 * missing or failed verification: a partially downloaded model can load into a
 * broken state and produce hallucinated repeated text instead of failing.
 * Unknown readiness (catalog unreachable, tier not listed) does not block; the
 * worker still surfaces real load errors.
 */
export function assertBrowserAsrReady(
  config: AsrConfig,
  status: LocalAsrModelStatus | null,
  native: { readonly enabled: boolean; readonly failure?: Error },
): void {
  if (!status || asrEngineReady(status, 'browser')) return;
  const detail = browserEngineMissingDetail(status.label || config.modelId, status, native);
  throw new TranscriptionError('service-unavailable', detail);
}
