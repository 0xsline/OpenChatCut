// What one row of the local ASR model list shows for the current client.
import {
  asrEngineReady, type LocalAsrEngine, type LocalAsrModelStatus,
} from '../../transcript/local-asr-readiness';

export interface LocalAsrModelRowState {
  /** The engine this client runs first can load the model ("已下载"). */
  readonly ready: boolean;
  /** Files this client can use are missing; a download fetches only those. */
  readonly canDownload: boolean;
}

/**
 * A desktop client with native inference runs whisper.cpp (the GGML companion)
 * and falls back to the browser engine (the ONNX export), so it is ready with
 * the companion alone but can still complete the fallback. A browser client
 * never loads the companion, so a missing one never counts against it.
 */
export function localAsrModelRowState(
  model: LocalAsrModelStatus,
  engine: LocalAsrEngine,
): LocalAsrModelRowState {
  const ready = asrEngineReady(model, engine);
  const fallbackMissing = engine === 'native' && !asrEngineReady(model, 'browser');
  return { ready, canDownload: !ready || fallbackMissing };
}
