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
const INITIAL_WARMUP_DELAY_MS = 4_000;

function waitForInferenceIdle(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestIdleCallback !== 'function') {
    return new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return new Promise((resolve) => {
    window.requestIdleCallback(() => resolve(), { timeout: 5_000 });
  });
}

async function warmDownloadedInferenceModels(): Promise<void> {
  const nativeEnabled = await syncDesktopNativeInferenceEnabled().catch(() => false);
  if (nativeEnabled) await waitForInferenceIdle();
  if (nativeEnabled || preferredTranscriptionProvider() === 'local') {
    await warmUpLocalAsr();
  }
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
    return () => {
      alive = false;
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(TRANSCRIPTION_PROVIDER_CHANGE_EVENT, changed);
      window.removeEventListener(DESKTOP_NATIVE_INFERENCE_CHANGE_EVENT, changed);
    };
  }, [editorOpen]);
}
