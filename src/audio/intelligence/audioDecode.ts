const MAX_AUDIO_DURATION_SECONDS = 60 * 60;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 3 * 60_000;
const METADATA_TIMEOUT_MS = 30_000;
const DECODE_TIMEOUT_MS = 3 * 60_000;
const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 192_000;

type DecodeContext = BaseAudioContext & { close?: () => Promise<void> };
type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

function assertSampleRate(sampleRate: number): void {
  if (!Number.isInteger(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new Error(`Invalid audio sample rate: ${sampleRate}`);
  }
}
function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(signal.reason === undefined ? 'Audio analysis aborted' : String(signal.reason));
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}



function sourceLimitError(maxBytes = MAX_SOURCE_BYTES): Error {
  return new Error(`source exceeds ${Math.round(maxBytes / 1024 / 1024)} MiB limit`);
}

export async function readLimitedResponseBytes(
  response: Response,
  maxBytes = MAX_SOURCE_BYTES,
): Promise<ArrayBuffer> {
  const declaredHeader = response.headers.get('content-length');
  const declared = declaredHeader === null ? Number.NaN : Number(declaredHeader);
  const hasDeclaredLength = Number.isSafeInteger(declared) && declared >= 0;
  if (hasDeclaredLength && declared > maxBytes) throw sourceLimitError(maxBytes);
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw sourceLimitError(maxBytes);
    return bytes;
  }
  const output = hasDeclaredLength ? new Uint8Array(declared) : null;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel(sourceLimitError(maxBytes)).catch(() => undefined);
      throw sourceLimitError(maxBytes);
    }
    if (output && total > output.byteLength) {
      const error = new Error('source content length changed during download');
      await reader.cancel(error).catch(() => undefined);
      throw error;
    }
    if (output) output.set(value, total - value.byteLength);
    else chunks.push(value);
  }
  if (output) {
    if (total !== output.byteLength) throw new Error('source content length changed during download');
    return output.buffer;
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

async function assertSourceDuration(src: string, signal?: AbortSignal): Promise<void> {
  if (typeof Audio === 'undefined') return;
  const media = new Audio();
  media.preload = 'metadata';
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => reject(new Error('audio metadata timed out')), METADATA_TIMEOUT_MS);
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    media.removeAttribute('src');
    media.load();
  };
  const onAbort = () => reject(signal ? abortError(signal) : new Error('Audio analysis aborted'));
  media.onloadedmetadata = () => {
    if (!Number.isFinite(media.duration) || media.duration <= MAX_AUDIO_DURATION_SECONDS) resolve();
    else reject(new Error(`Audio exceeds ${MAX_AUDIO_DURATION_SECONDS / 60}-minute analysis limit`));
  };
  media.onerror = () => reject(new Error('Unable to read audio duration metadata'));
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  else media.src = src;
  try {
    await promise;
  } finally {
    cleanup();
  }
}

async function fetchAudioBytes(src: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!src.trim()) throw new Error('Audio source URL is empty');
  throwIfAborted(signal);
  await assertSourceDuration(src, signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('audio fetch timed out'), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(src, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) throw sourceLimitError();
    return await readLimitedResponseBytes(response);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    if (controller.signal.aborted) throw new Error(`Audio fetch aborted: ${String(controller.signal.reason)}`);
    throw new Error(`Unable to fetch audio source: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function createDecodeContext(sampleRate: number): DecodeContext {
  const webkit = (globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  const Constructor = typeof AudioContext === 'undefined' ? webkit : AudioContext;
  if (Constructor) return new Constructor({ sampleRate });
  if (typeof OfflineAudioContext !== 'undefined') return new OfflineAudioContext(1, 1, sampleRate);
  throw new Error('Web Audio decoding is unavailable in this browser');
}

async function decodeBytes(
  context: DecodeContext,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<AudioBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = Promise.withResolvers<never>();
    if (signal) {
      onAbort = () => aborted.reject(abortError(signal));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timedOut = Promise.withResolvers<never>();
    timer = setTimeout(() => timedOut.reject(new Error('audio decoding timed out')), DECODE_TIMEOUT_MS);
    return await Promise.race([
      context.decodeAudioData(bytes),
      aborted.promise,
      timedOut.promise,
    ]);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new Error(`Unable to decode audio source: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function mixToMono(audio: AudioBuffer): Float32Array {
  if (audio.numberOfChannels < 1 || audio.length < 1) throw new Error('Decoded audio contains no samples');
  if (!Number.isFinite(audio.duration) || audio.duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error(`Audio exceeds ${MAX_AUDIO_DURATION_SECONDS / 60}-minute analysis limit`);
  }
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const source = audio.getChannelData(channel);
    for (let index = 0; index < source.length; index += 1) mono[index] += source[index]!;
  }
  const scale = 1 / audio.numberOfChannels;
  for (let index = 0; index < mono.length; index += 1) mono[index] *= scale;
  return mono;
}

function linearResample(samples: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  const length = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const output = new Float32Array(length);
  if (samples.length === 1) {
    output.fill(samples[0]!);
    return output;
  }
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = Math.min(samples.length - 1, index * ratio);
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    output[index] = samples[left]! + (samples[right]! - samples[left]!) * fraction;
  }
  return output;
}

async function offlineResample(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  const length = Math.max(1, Math.round((samples.length * targetRate) / sourceRate));
  const context = new OfflineAudioContext(1, length, targetRate);
  const buffer = context.createBuffer(1, samples.length, sourceRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

export async function resampleMonoSamples(
  samples: Float32Array,
  sourceRate: number,
  targetRate: number,
): Promise<Float32Array> {
  assertSampleRate(sourceRate);
  assertSampleRate(targetRate);
  if (!(samples instanceof Float32Array) || samples.length === 0) throw new Error('Audio samples are empty');
  if (samples.length / sourceRate > MAX_AUDIO_DURATION_SECONDS) {
    throw new Error(`Audio exceeds ${MAX_AUDIO_DURATION_SECONDS / 60}-minute analysis limit`);
  }
  if (sourceRate === targetRate) return samples.slice();
  if (typeof OfflineAudioContext === 'undefined') return linearResample(samples, sourceRate, targetRate);
  try {
    return await offlineResample(samples, sourceRate, targetRate);
  } catch (error) {
    if (error instanceof RangeError) throw new Error(`Unable to resample audio: ${error.message}`);
    return linearResample(samples, sourceRate, targetRate);
  }
}

export async function decodeAudioSource(
  src: string,
  sampleRate: number,
  signal?: AbortSignal,
): Promise<Float32Array> {
  assertSampleRate(sampleRate);
  const bytes = await fetchAudioBytes(src, signal);
  throwIfAborted(signal);
  const context = createDecodeContext(sampleRate);
  try {
    const decoded = await decodeBytes(context, bytes, signal);
    throwIfAborted(signal);
    const mono = mixToMono(decoded);
    const result = decoded.sampleRate === sampleRate
      ? mono
      : await resampleMonoSamples(mono, decoded.sampleRate, sampleRate);
    throwIfAborted(signal);
    return result;
  } finally {
    if (context.close) await context.close().catch(() => undefined);
  }
}
