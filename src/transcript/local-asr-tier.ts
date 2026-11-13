// Which local ASR tier a run uses when the user leaves the setting on "auto".
//
// "auto" means "按设备内存选择" in Settings, and the runtime used to answer it
// with a fixed `base` no matter what was downloaded. A user whose only install
// was `small` then got `Local transcription failed: … the ONNX files of Whisper
// Base are incomplete or failed verification` — an error about a model they
// never asked for, instead of the model sitting on disk. Auto now resolves
// against the catalog; only when nothing is installed at all does the run
// refuse, with the download instruction.
import { ASR_MODELS } from '../../shared/asr-models';
import { t } from '../i18n/locale';
import { TranscriptionError } from './assemblyai';
import { asrEngineReady, type LocalAsrModelStatus } from './local-asr-readiness';

/** Highest→lowest preference auto falls through when its memory pick is missing. */
const AUTO_FALLBACK_ORDER: readonly string[] = ['large-v3-turbo', 'medium', 'small', 'base', 'tiny'];

const tierByModelId = new Map<string, string>(
  ASR_MODELS.map((entry) => [entry.modelId, entry.id]),
);

/**
 * The tier Settings names for this machine — "内存 ≥6GB 用 Small，否则 Base".
 * It is auto's first choice before the catalog is consulted.
 */
export function memoryPreferredAsrTier(deviceMemoryGB: number): string {
  return deviceMemoryGB >= 6 ? 'small' : 'base';
}

/** Whether `model` is loadable by at least one engine on this client. */
export function asrModelInstalled(model: LocalAsrModelStatus): boolean {
  return asrEngineReady(model, 'native') || asrEngineReady(model, 'browser');
}

/**
 * The tier `auto` resolves to: the memory-preferred tier when it is installed,
 * else the best installed tier, else null (nothing installed). `null`/unknown
 * models — catalog unreachable or not consulted — keeps the memory rule,
 * because an unreadable catalog must not change behaviour.
 */
export function autoAsrTier(
  deviceMemoryGB: number,
  models: readonly LocalAsrModelStatus[] | null | undefined,
): string | null {
  const preferred = memoryPreferredAsrTier(deviceMemoryGB);
  if (models == null) return preferred;
  const installed = new Set(
    models.filter(asrModelInstalled).map((model) => tierByModelId.get(model.modelId)),
  );
  if (installed.has(preferred)) return preferred;
  return AUTO_FALLBACK_ORDER.find((tier) => installed.has(tier)) ?? null;
}

/**
 * Refuse to start when a readable catalog lists no loadable tier at all. That
 * is the one case where the right signal is "download a model" rather than a
 * per-engine "files incomplete or failed verification" for a tier the user
 * never had. An empty catalog means an older server rather than "nothing
 * installed", so it does not block.
 */
export function assertAnyLocalAsrInstalled(models: readonly LocalAsrModelStatus[] | null | undefined): void {
  if (models == null || models.length === 0) return;
  if (models.some(asrModelInstalled)) return;
  throw new TranscriptionError(
    'service-unavailable',
    t('本地转写尚未安装任何模型：请到 设置 → 本地模型 → 本地转写 下载一个模型后再试。'),
  );
}
