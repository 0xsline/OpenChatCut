// Local ASR readiness is per engine (#168): desktop whisper.cpp needs only the
// GGML companion and the browser engine only the ONNX export. These checks pin
// the catalog parsing, the per-engine predicate, the browser precheck, and what
// the settings list shows each kind of client.
import assert from 'node:assert/strict';
import { TranscriptionError } from './assemblyai';
import {
  asrEngineReady, assertBrowserAsrReady, fetchLocalAsrCatalog, fetchLocalAsrModelStatus,
  type LocalAsrModelStatus,
} from './local-asr-readiness';
import { localAsrModelRowState } from '../components/settings/localAsrModelRow';

const originalFetch = globalThis.fetch;
const config = { device: 'wasm' as const, modelId: 'Xenova/whisper-small', revision: 'a'.repeat(40), modelTier: 'small' as const };
const SETTINGS_PAGE = /设置 → 本地模型 → 本地转写/;

const complete: LocalAsrModelStatus = {
  modelId: config.modelId, label: 'Whisper Small', downloaded: true, onnxDownloaded: true, ggmlDownloaded: true,
};
const onnxOnly: LocalAsrModelStatus = { ...complete, downloaded: false, ggmlDownloaded: false };
const ggmlOnly: LocalAsrModelStatus = { ...complete, downloaded: false, onnxDownloaded: false };
const nothing: LocalAsrModelStatus = { ...onnxOnly, onnxDownloaded: false };

function serveCatalog(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

try {
  serveCatalog({ models: [complete, { modelId: 42 }, null, { label: 'no model id' }] });
  assert.deepEqual(await fetchLocalAsrCatalog(), [complete], 'malformed catalog rows are dropped');
  assert.deepEqual(await fetchLocalAsrModelStatus(config.modelId), complete);
  assert.equal(await fetchLocalAsrModelStatus('other/model'), null, 'a tier the catalog does not list is unknown');
  serveCatalog({ error: 'unavailable' }, 500);
  assert.equal(await fetchLocalAsrCatalog(), null, 'an unreadable catalog is unknown, not empty');
  globalThis.fetch = (async () => { throw new TypeError('offline'); }) as typeof fetch;
  assert.equal(await fetchLocalAsrModelStatus(config.modelId), null, 'an unreachable server is unknown');
} finally {
  globalThis.fetch = originalFetch;
}

// Each engine reads only its own files; a server from before per-engine
// readiness reports only the complete pack, which then stands for both.
const engines = (status: LocalAsrModelStatus): boolean[] =>
  [asrEngineReady(status, 'native'), asrEngineReady(status, 'browser')];
assert.deepEqual(engines(ggmlOnly), [true, false], 'the companion alone serves whisper.cpp');
assert.deepEqual(engines(onnxOnly), [false, true], 'the ONNX export alone serves the browser engine');
assert.deepEqual(engines({ modelId: 'legacy', downloaded: true }), [true, true]);
assert.deepEqual(engines({ modelId: 'legacy', downloaded: false }), [false, false]);

function browserPrecheck(
  status: LocalAsrModelStatus | null,
  native: { readonly enabled: boolean; readonly failure?: Error },
): string | null {
  try {
    assertBrowserAsrReady(config, status, native);
    return null;
  } catch (error) {
    assert.ok(error instanceof TranscriptionError && error.code === 'service-unavailable');
    return error.detail ?? '';
  }
}

assert.equal(browserPrecheck(onnxOnly, { enabled: false }), null, 'a verified ONNX export runs without the companion');
assert.equal(browserPrecheck(onnxOnly, { enabled: true, failure: new Error('native failed') }), null,
  'the fallback runs whenever its own files are verified');
assert.equal(browserPrecheck(null, { enabled: false }), null, 'unknown readiness does not block');

const browserMissing = browserPrecheck(ggmlOnly, { enabled: false })!;
assert.match(browserMissing, /Whisper Small/, 'the message names the model the user sees in settings');
assert.match(browserMissing, /ONNX/);
assert.match(browserMissing, SETTINGS_PAGE, 'the message points at the page with the download buttons');
assert.doesNotMatch(browserMissing, /GGML|whisper\.cpp/, 'a browser client is never told about the desktop companion');

const nativeFailed = browserPrecheck(ggmlOnly, { enabled: true, failure: new Error('whisper-cli is unavailable') })!;
assert.match(nativeFailed, /whisper-cli is unavailable/, 'the desktop failure is reported');
assert.match(nativeFailed, /ONNX/);
assert.match(nativeFailed, SETTINGS_PAGE);

const neither = browserPrecheck({ ...nothing, label: undefined }, { enabled: true })!;
assert.match(neither, /GGML/, 'a desktop client learns the companion is missing too');
assert.match(neither, /ONNX/);
assert.match(neither, SETTINGS_PAGE);
assert.match(neither, /Xenova\/whisper-small/, 'without a catalog label the model id is named');

// The settings list: "downloaded" means ready for the engine this client runs
// first; a desktop client may still complete its browser fallback.
assert.deepEqual(localAsrModelRowState(onnxOnly, 'browser'), { ready: true, canDownload: false },
  'a browser client never needs the companion');
assert.deepEqual(localAsrModelRowState(ggmlOnly, 'browser'), { ready: false, canDownload: true });
assert.deepEqual(localAsrModelRowState(ggmlOnly, 'native'), { ready: true, canDownload: true },
  'a desktop client is ready with the companion and can complete the fallback');
assert.deepEqual(localAsrModelRowState(onnxOnly, 'native'), { ready: false, canDownload: true },
  'a desktop client still needs the companion it runs');
assert.deepEqual(localAsrModelRowState(complete, 'native'), { ready: true, canDownload: false });
assert.deepEqual(localAsrModelRowState(complete, 'browser'), { ready: true, canDownload: false });
assert.deepEqual(localAsrModelRowState(nothing, 'native'), { ready: false, canDownload: true });

console.log('local-asr-model-integrity.verify: per-engine readiness, browser precheck, and settings rows OK');
