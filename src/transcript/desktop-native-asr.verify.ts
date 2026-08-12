import assert from 'node:assert/strict';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import {
  CLAP_INFERENCE_CONTRACT,
  RHYTHM_INFERENCE_CONTRACT,
  SEMANTIC_INFERENCE_CONTRACT,
} from '../../shared/vector-inference-contract';
import type {
  DesktopAsrPreloadRequest,
  DesktopAsrRequest,
  DesktopInferenceProgress,
} from '../../shared/desktop-inference';
import {
  DESKTOP_NATIVE_INFERENCE_KEY,
  desktopNativeInferenceEnabled,
  setDesktopNativeInferenceEnabled,
} from './desktop-inference-preference';
import { tryDesktopNativeAsr, warmUpDesktopNativeAsr } from './desktop-native-asr';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string): string | null => values.get(key) ?? null,
  setItem: (key: string, value: string): void => { values.set(key, value); },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

let transcribeCalls = 0;
let preloadCalls = 0;
let unsubscribes = 0;
let progressListener: ((progress: DesktopInferenceProgress) => void) | undefined;
let shouldFail = false;
const inference = {
  setEnabled: async (_enabled: boolean): Promise<void> => {},
  getCapabilities: async () => ({
    version: 3 as const,
    platform: 'win32' as const,
    asr: {
      available: true,
      preferredBackend: 'directml' as const,
      contractId: ASR_INFERENCE_CONTRACT.id,
    },
    semantic: {
      available: true,
      preferredBackend: 'directml' as const,
      contractId: SEMANTIC_INFERENCE_CONTRACT.id,
    },
    clap: {
      available: true,
      preferredBackend: 'directml' as const,
      contractId: CLAP_INFERENCE_CONTRACT.id,
    },
    rhythm: {
      available: true,
      preferredBackend: 'directml' as const,
      contractId: RHYTHM_INFERENCE_CONTRACT.id,
    },
  }),
  preloadAsr: async (request: DesktopAsrPreloadRequest) => {
    preloadCalls += 1;
    return { requestId: request.requestId, backend: 'directml' as const, result: { type: 'loaded' as const } };
  },
  transcribe: async (request: DesktopAsrRequest) => {
    transcribeCalls += 1;
    if (shouldFail) throw new Error('forced native failure');
    progressListener?.({ requestId: request.requestId, progress: 50 });
    return {
      requestId: request.requestId,
      backend: 'directml' as const,
      text: '测试完成',
      chunks: [{ text: '测试', start: 0, end: 0.5 }],
    };
  },
  semantic: async () => { throw new Error('unused semantic mock'); },
  clap: async () => { throw new Error('unused CLAP mock'); },
  rhythm: async () => { throw new Error('unused rhythm mock'); },
  cancel: async (): Promise<void> => {},
  subscribeProgress: (listener: (progress: DesktopInferenceProgress) => void) => {
    progressListener = listener;
    return () => { unsubscribes += 1; progressListener = undefined; };
  },
};
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { openChatCutDesktop: { inference } },
});

const config = {
  device: 'wasm' as const,
  modelTier: 'base' as const,
  modelId: 'onnx-community/whisper-base',
  revision: 'a'.repeat(40),
};
const windowWithBridge = globalThis.window;
// Simulate a plain browser (no desktop bridge): native routing stays off
// and the desktop IPC is never entered.
// @ts-expect-error temporarily removing the mocked window
delete globalThis.window;
assert.equal(desktopNativeInferenceEnabled(), false, 'native routing must default off without a desktop bridge');
assert.equal(await tryDesktopNativeAsr({
  sourcePath: '/media/uploads/example.mp4', config, language: 'zh',
}), null);
assert.equal(transcribeCalls, 0, 'disabled native routing must not enter desktop IPC');
globalThis.window = windowWithBridge;
// In the desktop shell (bridge present) native routing is auto-enabled.
const originalWindow = globalThis.window;
globalThis.window = {
  openChatCutDesktop: { inference: { getCapabilities: async () => null } },
} as unknown as Window & typeof globalThis;
assert.equal(desktopNativeInferenceEnabled(), true, 'desktop shell auto-enables native routing');
const disabledStorage = new Map<string, string>([['cc.desktopNativeInference', '0']]);
assert.equal(
  desktopNativeInferenceEnabled({ getItem: (k) => disabledStorage.get(k) ?? null, setItem: () => undefined }),
  false,
  'explicit opt-out still wins in the desktop shell',
);
globalThis.window = originalWindow;

await setDesktopNativeInferenceEnabled(true);
assert.equal(values.get(DESKTOP_NATIVE_INFERENCE_KEY), '1');
const progress: number[] = [];
const result = await tryDesktopNativeAsr({
  sourcePath: '/media/uploads/example.mp4',
  config,
  language: 'zh',
  onProgress: (value) => { if (value != null) progress.push(value); },
});
assert.equal(result?.backend, 'directml');
assert.equal(result?.result.text, '测试完成');
assert.deepEqual(progress, [50]);
assert.equal(unsubscribes, 1);
assert.equal(await warmUpDesktopNativeAsr(config), true);
assert.equal(preloadCalls, 1);
assert.equal(unsubscribes, 2, 'preload requests must release progress listeners');

shouldFail = true;
let fallbackReason = '';
assert.equal(await tryDesktopNativeAsr({
  sourcePath: '/media/uploads/example.mp4',
  config,
  language: 'zh',
  onFallback: (reason) => { fallbackReason = reason.message; },
}), null);
assert.equal(fallbackReason, 'forced native failure');
assert.equal(unsubscribes, 3, 'failed requests must release progress listeners');
assert.equal(await tryDesktopNativeAsr({
  sourcePath: 'blob:untrusted', config, language: 'zh',
}), null, 'non-media paths must stay on the browser path');

console.log('desktop-native-asr.verify: auto-enable, opt-out, and browser fallback contracts OK');
