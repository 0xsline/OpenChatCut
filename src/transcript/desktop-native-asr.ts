import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import type { DesktopAsrBackend } from '../../shared/desktop-inference';
import type { AsrConfig, AsrResult } from './local-asr-types';
import { desktopNativeInferenceEnabled } from './desktop-inference-preference';

export interface DesktopNativeAsrAttempt {
  readonly backend: DesktopAsrBackend;
  readonly result: AsrResult;
}

export interface DesktopNativeAsrOptions {
  readonly sourcePath: string;
  readonly config: AsrConfig;
  readonly language: string;
  readonly onProgress?: (progress?: number, file?: string) => void;
  readonly onFallback?: (reason: Error) => void;
}

let requestSequence = 0;

function nextRequestId(): string {
  requestSequence += 1;
  return `desktop-asr-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

export async function tryDesktopNativeAsr(
  options: DesktopNativeAsrOptions,
): Promise<DesktopNativeAsrAttempt | null> {
  if (!desktopNativeInferenceEnabled() || !options.sourcePath.startsWith('/media/uploads/')) return null;
  const api = typeof window !== 'undefined' ? window.openChatCutDesktop?.inference : undefined;
  if (!api) return null;
  try {
    const capabilities = await api.getCapabilities();
    if (!capabilities.asr.available
      || capabilities.asr.contractId !== ASR_INFERENCE_CONTRACT.id) return null;
    const requestId = nextRequestId();
    const unsubscribe = api.subscribeProgress((progress) => {
      if (progress.requestId === requestId) {
        options.onProgress?.(progress.progress, progress.file);
      }
    });
    try {
      const response = await api.transcribe({
        requestId,
        contractId: ASR_INFERENCE_CONTRACT.id,
        sourcePath: options.sourcePath,
        modelId: options.config.modelId,
        revision: options.config.revision,
        language: options.language,
      });
      return {
        backend: response.backend,
        result: { text: response.text, chunks: [...response.chunks] },
      };
    } finally {
      unsubscribe();
    }
  } catch (reason) {
    options.onFallback?.(reason instanceof Error ? reason : new Error(String(reason)));
    return null;
  }
}

export async function warmUpDesktopNativeAsr(
  config: AsrConfig,
  onProgress?: (progress?: number, file?: string) => void,
): Promise<boolean> {
  if (!desktopNativeInferenceEnabled()) return false;
  const api = typeof window !== 'undefined' ? window.openChatCutDesktop?.inference : undefined;
  if (!api) return false;
  try {
    const capabilities = await api.getCapabilities();
    if (!capabilities.asr.available
      || capabilities.asr.contractId !== ASR_INFERENCE_CONTRACT.id) return false;
    const requestId = nextRequestId();
    const unsubscribe = api.subscribeProgress((progress) => {
      if (progress.requestId === requestId) onProgress?.(progress.progress, progress.file);
    });
    try {
      await api.preloadAsr({
        requestId,
        contractId: ASR_INFERENCE_CONTRACT.id,
        action: 'load',
        modelId: config.modelId,
        revision: config.revision,
      });
      return true;
    } finally {
      unsubscribe();
    }
  } catch {
    return false;
  }
}
