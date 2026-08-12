import assert from 'node:assert/strict';
import { decodeAudioSource, readLimitedResponseBytes } from './audioDecode';

const oversizedStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3]));
    controller.enqueue(new Uint8Array([4, 5, 6]));
    controller.close();
  },
});
await assert.rejects(
  readLimitedResponseBytes(new Response(oversizedStream), 5),
  /source exceeds/,
  'chunked responses stop as soon as their cumulative byte limit is crossed',
);

const declaredStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.enqueue(new Uint8Array([3, 4]));
    controller.close();
  },
});
const declaredBytes = await readLimitedResponseBytes(
  new Response(declaredStream, { headers: { 'content-length': '4' } }),
  8,
);
assert.deepEqual([...new Uint8Array(declaredBytes)], [1, 2, 3, 4]);

const truncatedStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([1, 2]));
    controller.close();
  },
});
await assert.rejects(
  readLimitedResponseBytes(new Response(truncatedStream, { headers: { 'content-length': '4' } }), 8),
  /content length changed/,
  'declared response lengths cannot silently retain zero-filled bytes',
);

const originalFetch = globalThis.fetch;
const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
const originalOffline = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
let fetchInit: RequestInit | undefined;
let closed = false;
let decoded = {
  numberOfChannels: 2,
  length: 4,
  duration: 4 / 22_050,
  sampleRate: 22_050,
  getChannelData: (channel: number) => channel === 0
    ? new Float32Array([1, -1, 0.5, -0.5])
    : new Float32Array([0, 1, -0.5, 0.5]),
} as AudioBuffer;

class FakeAudioContext {
  decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    return Promise.resolve(decoded);
  }

  close(): Promise<void> {
    closed = true;
    return Promise.resolve();
  }
}

try {
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext,
  });
  Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
  globalThis.fetch = (async (_input, init) => {
    fetchInit = init;
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;

  assert.deepEqual(
    [...await decodeAudioSource('/media/uploads/test.wav', 22_050)],
    [0.5, 0, 0, 0],
  );
  assert.equal(fetchInit?.cache, 'no-store');
  assert.ok(fetchInit?.signal instanceof AbortSignal);
  assert.equal(closed, true);
  const controller = new AbortController();
  controller.abort(new DOMException('cancel decode', 'AbortError'));
  await assert.rejects(
    decodeAudioSource('/media/uploads/test.wav', 22_050, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );


  globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
  await assert.rejects(
    decodeAudioSource('/missing.wav', 22_050),
    /Unable to fetch audio source: HTTP 404/,
  );

  globalThis.fetch = (async () => new Response('', {
    headers: { 'content-length': String(513 * 1024 * 1024) },
  })) as typeof fetch;
  await assert.rejects(
    decodeAudioSource('/too-large.wav', 22_050),
    /source exceeds 512 MiB limit/,
  );

  globalThis.fetch = (async () => new Response(new Uint8Array([1]))) as typeof fetch;
  decoded = { ...decoded, duration: 3_601 };
  // Long-form audio is accepted: there is no fixed analysis duration cap.
  await assert.deepEqual(
    [...await decodeAudioSource('/long.wav', 22_050)],
    [0.5, 0, 0, 0],
    'audio longer than one hour decodes without a duration cap',
  );
  await assert.rejects(decodeAudioSource('', 22_050), /source URL is empty/);
  await assert.rejects(decodeAudioSource('/test.wav', 1), /Invalid audio sample rate/);
} finally {
  globalThis.fetch = originalFetch;
  if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
  else Reflect.deleteProperty(globalThis, 'AudioContext');
  if (originalOffline) Object.defineProperty(globalThis, 'OfflineAudioContext', originalOffline);
  else Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
}

console.log('audioDecode.verify: ok');
