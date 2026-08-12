import assert from 'node:assert/strict';
import { assertAsrModelDownloaded } from './local-asr';
import { TranscriptionError } from './assemblyai';

const originalFetch = globalThis.fetch;
const config = { device: 'wasm' as const, modelId: 'Xenova/whisper-small', revision: 'a'.repeat(40), modelTier: 'small' as const };

async function withCatalog(models: unknown, status = 200): Promise<void> {
  globalThis.fetch = (async () => ({
    ok: status === 200,
    json: async () => ({ models }),
  })) as unknown as typeof fetch;
  try {
    await assertAsrModelDownloaded(config);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Complete model: precheck passes.
await withCatalog([{ modelId: config.modelId, downloaded: true }]);
console.log('precheck: complete model passes');

// Incomplete model: precheck throws a TranscriptionError.
let threw = false;
globalThis.fetch = (async () => ({
  ok: true,
  json: async () => ({ models: [{ modelId: config.modelId, downloaded: false }] }),
})) as unknown as typeof fetch;
try {
  await assertAsrModelDownloaded(config);
} catch (error) {
  threw = error instanceof TranscriptionError;
}
globalThis.fetch = originalFetch;
assert.equal(threw, true, 'incomplete model is rejected with a TranscriptionError');

// Unknown model id and server errors do not block (worker surfaces load errors).
await withCatalog([{ modelId: 'other/model', downloaded: false }]);
await withCatalog(null, 500);
console.log('precheck: unknown model and server errors pass through');

console.log('local-asr-model-integrity.verify: ok');
