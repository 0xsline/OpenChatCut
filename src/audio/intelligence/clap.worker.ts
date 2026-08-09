/// <reference lib="webworker" />
import {
  AutoProcessor,
  ClapAudioModelWithProjection,
  env,
  type Processor,
} from '@huggingface/transformers';
import {
  CLAP_EMBEDDING_DIMENSION,
  CLAP_MODEL_ID,
  CLAP_MODEL_REVISION,
  CLAP_SAMPLE_RATE,
  type ClapBackend,
  type ClapWorkerRequest,
  type ClapWorkerResponse,
} from './clapTypes';

const WINDOW_SAMPLES = CLAP_SAMPLE_RATE * 10;
const WINDOW_STEP_SAMPLES = CLAP_SAMPLE_RATE * 8;
const LOAD_PROGRESS_SHARE = 0.25;


const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let backend: ClapBackend | null = null;
let model: ClapAudioModelWithProjection | null = null;
let processor: Processor | null = null;
let loading: Promise<void> | null = null;

const post = (message: ClapWorkerResponse) => workerScope.postMessage(message);

env.useBrowserCache = false;
env.allowLocalModels = false;
env.allowRemoteModels = true;

function proxyHost(): string {
  const origin = workerScope.location.origin;
  if (origin === 'null') throw new Error('CLAP requires an HTTP(S) application origin');
  return `${origin}/api/hf-proxy`;
}

function progressValue(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const progress = (value as Record<string, unknown>).progress;
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
}

async function loadModel(request: Extract<ClapWorkerRequest, { type: 'load' }>): Promise<void> {
  if (backend && backend !== request.backend) {
    throw new Error(`CLAP worker is already bound to ${backend}`);
  }
  backend = request.backend;
  if (model && processor) return;
  if (loading) return loading;
  env.remoteHost = proxyHost();
  let reportedProgress = 0;
  const progress_callback = (value: unknown) => {
    const progress = progressValue(value);
    if (progress === null) return;
    reportedProgress = Math.max(reportedProgress, progress);
    post({ id: request.id, type: 'progress', progress: reportedProgress * LOAD_PROGRESS_SHARE });
  };
  loading = Promise.all([
    AutoProcessor.from_pretrained(CLAP_MODEL_ID, {
      revision: CLAP_MODEL_REVISION,
      progress_callback,
    }),
    ClapAudioModelWithProjection.from_pretrained(CLAP_MODEL_ID, {
      revision: CLAP_MODEL_REVISION,
      device: request.backend,
      dtype: 'q8',
      progress_callback,
    }),
  ]).then(([nextProcessor, nextModel]) => {
    processor = nextProcessor;
    model = nextModel;
  }).finally(() => {
    loading = null;
  });
  return loading;
}

function normalizedVector(values: ArrayLike<number>): number[] {
  if (values.length !== CLAP_EMBEDDING_DIMENSION) {
    throw new Error(`CLAP returned ${values.length} dimensions; expected ${CLAP_EMBEDDING_DIMENSION}`);
  }
  let squaredLength = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (!Number.isFinite(value)) throw new Error('CLAP returned a non-finite embedding');
    squaredLength += value * value;
  }
  const length = Math.sqrt(squaredLength);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new Error('CLAP returned a zero-length embedding');
  }
  return Array.from(values, (value) => value / length);
}

function embeddingData(output: unknown): ArrayLike<number> {
  if (!output || typeof output !== 'object') throw new Error('CLAP returned an invalid response');
  const tensor = (output as Record<string, unknown>).audio_embeds;
  if (!tensor || typeof tensor !== 'object') throw new Error('CLAP returned no audio embedding');
  const data = (tensor as Record<string, unknown>).data;
  const numericView = ArrayBuffer.isView(data) && !(data instanceof DataView) && 'length' in data;
  if (!Array.isArray(data) && !numericView) throw new Error('CLAP returned invalid embedding data');
  return data as ArrayLike<number>;
}

function windowStarts(sampleCount: number): number[] {
  const starts = [0];
  while (starts[starts.length - 1]! + WINDOW_SAMPLES < sampleCount) {
    starts.push(starts[starts.length - 1]! + WINDOW_STEP_SAMPLES);
  }
  return starts;
}

async function embedWindow(samples: Float32Array): Promise<number[]> {
  if (!model || !processor) throw new Error('CLAP model is not loaded');
  const inputs = await processor(samples);
  return normalizedVector(embeddingData(await model(inputs)));
}

function validateSamples(samples: Float32Array): void {
  if (samples.length === 0) throw new Error('CLAP audio samples are empty');
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error('CLAP audio samples contain non-finite values');
  }
}

async function embed(request: Extract<ClapWorkerRequest, { type: 'embed' }>): Promise<number[]> {
  if (request.sampleRate !== CLAP_SAMPLE_RATE) {
    throw new Error(`CLAP worker requires ${CLAP_SAMPLE_RATE} Hz mono audio`);
  }
  validateSamples(request.samples);
  const starts = windowStarts(request.samples.length);
  const mean = new Float64Array(CLAP_EMBEDDING_DIMENSION);
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const vector = await embedWindow(request.samples.slice(start, start + WINDOW_SAMPLES));
    for (let dimension = 0; dimension < mean.length; dimension += 1) {
      mean[dimension] += vector[dimension]!;
    }
    const completed = (index + 1) / starts.length;
    post({
      id: request.id,
      type: 'progress',
      progress: LOAD_PROGRESS_SHARE + completed * (1 - LOAD_PROGRESS_SHARE),
    });
  }
  return normalizedVector(mean);
}

function validateRequest(value: unknown): ClapWorkerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid CLAP worker request');
  const request = value as Record<string, unknown>;
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) {
    throw new Error('Invalid CLAP worker request id');
  }
  if (request.type === 'load' && (request.backend === 'webgpu' || request.backend === 'wasm')) {
    return request as ClapWorkerRequest;
  }
  if (request.type === 'embed' && request.samples instanceof Float32Array
    && request.sampleRate === CLAP_SAMPLE_RATE) return request as ClapWorkerRequest;
  throw new Error('Invalid CLAP worker request payload');
}

async function handleRequest(value: unknown): Promise<void> {
  const request = validateRequest(value);
  if (request.type === 'load') {
    await loadModel(request);
    post({ id: request.id, type: 'result', result: { type: 'loaded' } });
    return;
  }
  post({ id: request.id, type: 'result', result: { type: 'embedding', vector: await embed(request) } });
}

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  void handleRequest(event.data).catch((reason: unknown) => {
    const id = event.data && typeof event.data === 'object'
      && Number.isSafeInteger((event.data as { id?: unknown }).id)
      ? Number((event.data as { id: number }).id)
      : -1;
    const message = reason instanceof Error ? reason.message : String(reason);
    post({ id, type: 'error', message });
  });
};
