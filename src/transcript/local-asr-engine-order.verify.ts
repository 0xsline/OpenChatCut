// Which local engine runs, and what may block it, in the real transcription
// flow. Desktop whisper.cpp needs only the GGML companion and the browser engine
// only the ONNX export, so neither may be refused over the other's files: #168
// blocked an installed desktop model behind the browser download, and the
// combined check blocked browser users whose tier later gained a companion.
import assert from 'node:assert/strict';
import { ASR_INFERENCE_CONTRACT } from '../../shared/asr-inference-contract';
import { ASR_MODELS } from '../../shared/asr-models';
import type { DesktopAsrRequest } from '../../shared/desktop-inference';
import { TranscriptionError } from './assemblyai';
import { localTranscribePathResumable } from './local-asr';

const small = ASR_MODELS.find((model) => model.id === 'small')!;
const SETTINGS_PAGE = /设置 → 本地模型 → 本地转写/;

const stored = new Map<string, string>([['cc.asrModel', 'small']]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
    removeItem: (key: string) => { stored.delete(key); },
  },
});

let nativeRequests = 0;
let nativeFailure: Error | null = null;
const inference = {
  getCapabilities: async () => ({ asr: { available: true, contractId: ASR_INFERENCE_CONTRACT.id } }),
  subscribeProgress: () => () => {},
  transcribe: async (request: DesktopAsrRequest) => {
    nativeRequests += 1;
    if (nativeFailure) throw nativeFailure;
    return {
      requestId: request.requestId, backend: 'native-cpu', text: 'desktop transcript',
      chunks: [{ text: 'desktop', start: 0, end: 400 }],
    };
  },
};

function desktopShell(present: boolean): void {
  if (present) {
    Object.defineProperty(globalThis, 'window', {
      configurable: true, value: { openChatCutDesktop: { inference } },
    });
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
}

let catalogRows: unknown[] = [];
let decodedSources = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL) => {
  if (String(input) === '/api/asr-models') {
    return new Response(JSON.stringify({ models: catalogRows }), { status: 200 });
  }
  // Only the browser engine fetches the source itself (to decode it); a 404
  // ends the run right there, which proves the engine was allowed to start.
  decodedSources += 1;
  return new Response('', { status: 404 });
}) as typeof fetch;

function installed(onnx: boolean, ggml: boolean): void {
  catalogRows = [{
    modelId: small.modelId, label: small.label,
    downloaded: onnx && ggml, onnxDownloaded: onnx, ggmlDownloaded: ggml,
  }];
}

async function transcribe(): Promise<{ text?: string; error?: unknown; notes: string[] }> {
  const notes: string[] = [];
  try {
    const result = await localTranscribePathResumable(
      '/media/uploads/clip.mp4', {}, () => {}, (note) => { if (note) notes.push(note); },
      { asrPath: '/media/uploads/clip.asr.ogg', languageCode: 'zh' },
    );
    return { text: result.text, notes };
  } catch (error) {
    return { error, notes };
  }
}

function detailOf(outcome: { error?: unknown }): string {
  assert.ok(outcome.error instanceof TranscriptionError, `expected a TranscriptionError, got ${String(outcome.error)}`);
  return outcome.error.detail ?? '';
}

function reachedBrowserDecode(outcome: { error?: unknown }): boolean {
  return outcome.error instanceof TranscriptionError && outcome.error.code === 'source-unavailable';
}

try {
  // #168: a desktop install with only the companion transcribes natively.
  desktopShell(true);
  installed(false, true);
  const ggmlOnly = await transcribe();
  assert.equal(ggmlOnly.text, 'desktop transcript', 'the installed desktop model must not wait for the browser download');
  assert.deepEqual([nativeRequests, decodedSources], [1, 0]);

  // Desktop with only the ONNX export (small/medium installed before they had a
  // companion): whisper.cpp is skipped and the browser engine runs.
  installed(true, false);
  const onnxOnlyDesktop = await transcribe();
  assert.equal(nativeRequests, 1, 'no desktop request without the companion it loads');
  assert.ok(reachedBrowserDecode(onnxOnlyDesktop), 'the browser engine must be allowed to start');
  assert.ok(onnxOnlyDesktop.notes.some((note) => note.includes('浏览器引擎')), 'the user is told which engine runs');

  // Browser client: the ONNX export alone is enough...
  desktopShell(false);
  installed(true, false);
  assert.ok(reachedBrowserDecode(await transcribe()), 'a browser install never needs the companion');
  assert.equal(decodedSources, 2);
  // ...and without it the run stops before any decoding, pointing at settings.
  installed(false, true);
  const browserMissing = detailOf(await transcribe());
  assert.match(browserMissing, /Whisper Small/);
  assert.match(browserMissing, /ONNX/);
  assert.match(browserMissing, SETTINGS_PAGE);
  assert.equal(decodedSources, 2, 'a missing ONNX export is refused before the engine starts');

  // Desktop engine fails and the fallback lacks its files: say both.
  desktopShell(true);
  nativeFailure = new Error('whisper-cli is unavailable');
  installed(false, true);
  const nativeFailed = detailOf(await transcribe());
  assert.equal(nativeRequests, 2);
  assert.match(nativeFailed, /whisper-cli is unavailable/);
  assert.match(nativeFailed, /ONNX/);
  assert.match(nativeFailed, SETTINGS_PAGE);

  // Nothing installed on desktop: no desktop request, both files named.
  nativeFailure = null;
  installed(false, false);
  const neither = detailOf(await transcribe());
  assert.equal(nativeRequests, 2);
  assert.match(neither, /GGML/);
  assert.match(neither, /ONNX/);
  assert.equal(decodedSources, 2);

  // Unknown readiness (tier not listed) blocks nothing up front.
  catalogRows = [];
  assert.equal((await transcribe()).text, 'desktop transcript');
  assert.equal(nativeRequests, 3);
} finally {
  globalThis.fetch = originalFetch;
  desktopShell(false);
}

console.log('local-asr-engine-order.verify: each engine is gated only by its own files');
