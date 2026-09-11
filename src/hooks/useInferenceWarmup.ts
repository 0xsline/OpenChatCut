import { useEffect } from 'react';
import {
  DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT,
  syncDesktopNativeInferenceEnabled,
} from '../transcript/desktop-inference-preference';
import { warmUpLocalAsr } from '../transcript/local-asr';
import {
  preferredTranscriptionProvider,
  TRANSCRIPTION_PROVIDER_CHANGE_EVENT,
} from '../transcript/provider';
import {
  VAD_SILENCE_REMOVAL_CHANGE_EVENT,
  vadSilenceRemovalEnabled,
} from '../audio/vadPreference';

const INITIAL_WARMUP_DELAY_MS = 4_000;

function waitForInferenceIdle(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestIdleCallback !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return new Promise((resolve) => {
    window.requestIdleCallback(() => resolve(), { timeout: 5_000 });
  });
}

/**
 * Preload the desktop native workers whose model pack is already installed.
 *
 * Pack installation is checked first on purpose: a 'load' request for a
 * missing pack fails pack verification, and both the rhythm and CLAP adapters
 * treat a failed load as "native unavailable for this session". Warming an
 * uninstalled pack would therefore disable the native path until reload.
 * Preloading never downloads a model.
 */
async function warmInstalledNativePacks(): Promise<void> {
  // Deliberate lazy boundaries below: the editor shell must not eagerly load
  // the pack client or the native worker adapters just to schedule a warm-up.
  const { fetchModelPackCatalog } = await import('../../shared/model-packs/client');
  const catalog = await fetchModelPackCatalog().catch(() => []);
  const isInstalled = (id: string) => catalog.some((pack) => pack.id === id && pack.status === 'installed');
  // Sequential: every native load claims the shared desktop inference budget.
  if (isInstalled('rhythm-lite')) {
    const { warmUpDesktopNativeRhythm } = await import('../audio/intelligence/nativeBeatThisWorkerAdapter');
    await warmUpDesktopNativeRhythm();
  }
  if (isInstalled('music-semantics-lite')) {
    const { warmUpDesktopNativeClap } = await import('../audio/intelligence/nativeClapWorkerAdapter');
    await warmUpDesktopNativeClap();
  }
  if (isInstalled('visual-semantics-lite')) {
    const { warmUpDesktopNativeSemantic } = await import('../media/semantic-search/nativeSemanticWorkerAdapter');
    await warmUpDesktopNativeSemantic();
  }
}

/** The Silero model ships with the app, so only the opt-in preference gates it. */
async function warmVadModel(): Promise<void> {
  if (!vadSilenceRemovalEnabled()) return;
  await waitForInferenceIdle();
  // Deliberate lazy boundary: the onnxruntime chunk must stay out of the
  // initial bundle, exactly as analyzeClipSilence loads it.
  const { ensureSileroVad } = await import('../audio/silero-vad');
  await ensureSileroVad();
}

async function warmDownloadedInferenceModels(): Promise<void> {
  const nativeEnabled = await syncDesktopNativeInferenceEnabled().catch(() => false);
  if (nativeEnabled) await waitForInferenceIdle();
  if (nativeEnabled || preferredTranscriptionProvider() === 'local') {
    await warmUpLocalAsr();
  }
  if (nativeEnabled) await warmInstalledNativePacks();
  await warmVadModel();
}

export function useInferenceWarmup(editorOpen: boolean): void {
  useEffect(() => {
    if (!editorOpen) return;
    let alive = true;
    let timer: number | null = null;
    let running = false;
    let rerunRequested = false;
    function schedule(delayMs = INITIAL_WARMUP_DELAY_MS): void {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void run(); }, delayMs);
    }
    async function run(): Promise<void> {
      if (!alive) return;
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      await warmDownloadedInferenceModels().catch(() => undefined);
      running = false;
      if (!alive) return;
      if (rerunRequested) {
        rerunRequested = false;
        schedule(0);
      }
    }
    const changed = () => {
      if (running) rerunRequested = true;
      else schedule(250);
    };
    void syncDesktopNativeInferenceEnabled().catch(() => undefined);
    schedule();
    window.addEventListener(TRANSCRIPTION_PROVIDER_CHANGE_EVENT, changed);
    window.addEventListener(DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT, changed);
    window.addEventListener(VAD_SILENCE_REMOVAL_CHANGE_EVENT, changed);
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(TRANSCRIPTION_PROVIDER_CHANGE_EVENT, changed);
      window.removeEventListener(DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT, changed);
      window.removeEventListener(VAD_SILENCE_REMOVAL_CHANGE_EVENT, changed);
    };
  }, [editorOpen]);
}
