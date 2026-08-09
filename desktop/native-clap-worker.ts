import {
  AutoProcessor,
  ClapAudioModelWithProjection,
  env,
  type Processor,
} from '@huggingface/transformers';
import {
  isDesktopInferenceRequestId,
  parseDesktopClapRequest,
  type DesktopClapRequest,
  type DesktopClapResponse,
  type DesktopInferenceBackend,
  type DesktopInferenceProgress,
} from '../shared/desktop-inference.ts';
import { CLAP_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';

const LOAD_PROGRESS_SHARE = 0.25;

interface NativeClapWorkerConfig {
  readonly origin: string;
  readonly cacheDir: string;
  readonly platform: NodeJS.Platform;
}

interface ActiveNativeClapWorkerConfig extends NativeClapWorkerConfig {
  readonly parsedOrigin: URL;
}

const port = process.parentPort;
if (!port) throw new Error('native CLAP process requires a parent port');

let runtime: ActiveNativeClapWorkerConfig | null = null;
let processor: Processor | null = null;
let model: ClapAudioModelWithProjection | null = null;
let backend: DesktopInferenceBackend | null = null;
let loading: Promise<void> | null = null;
let queue = Promise.resolve();
const canceled = new Set<string>();

function initialize(value: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('invalid native CLAP configuration');
  const config = value as Partial<NativeClapWorkerConfig>;
  if (typeof config.origin !== 'string'
    || typeof config.cacheDir !== 'string' || config.cacheDir.length === 0
    || (config.platform !== 'win32' && config.platform !== 'darwin')) {
    throw new Error('invalid native CLAP configuration');
  }
  const parsedOrigin = new URL(config.origin);
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
    throw new Error('invalid native CLAP origin');
  }
  runtime = { ...config as NativeClapWorkerConfig, parsedOrigin };
  env.localModelPath = config.cacheDir;
  env.cacheDir = config.cacheDir;
  env.useFSCache = true;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
}

function requireRuntime(): ActiveNativeClapWorkerConfig {
  if (!runtime) throw new Error('native CLAP process is not initialized');
  return runtime;
}

function progressInfo(value: unknown): { progress: number | null; file?: string } {
  if (typeof value !== 'object' || value === null) return { progress: null };
  const candidate = value as { progress?: unknown; file?: unknown };
  const raw = candidate.progress;
  const normalized = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw))
    : null;
  return {
    progress: normalized,
    ...(typeof candidate.file === 'string' ? { file: candidate.file } : {}),
  };
}

function loadProgressReporter(requestId: string): (value: unknown) => void {
  let reported = 0;
  return (value) => {
    if (canceled.has(requestId)) return;
    const info = progressInfo(value);
    if (info.progress === null) return;
    reported = Math.max(reported, info.progress);
    postProgress({
      requestId,
      progress: reported * LOAD_PROGRESS_SHARE,
      ...(info.file ? { file: info.file } : {}),
    });
  };
}

function postProgress(progress: DesktopInferenceProgress): void {
  port.postMessage({ type: 'progress', progress });
}

async function ensureProcessor(report: (value: unknown) => void): Promise<Processor> {
  if (processor) return processor;
  processor = await AutoProcessor.from_pretrained(CLAP_INFERENCE_CONTRACT.modelId, {
    revision: CLAP_INFERENCE_CONTRACT.revision,
    progress_callback: report,
  });
  return processor;
}

async function loadModel(
  selectedBackend: DesktopInferenceBackend,
  report: (value: unknown) => void,
): Promise<ClapAudioModelWithProjection> {
  return ClapAudioModelWithProjection.from_pretrained(CLAP_INFERENCE_CONTRACT.modelId, {
    revision: CLAP_INFERENCE_CONTRACT.revision,
    device: selectedBackend === 'directml' ? 'dml' : 'cpu',
    dtype: CLAP_INFERENCE_CONTRACT.dtype,
    progress_callback: report,
  });
}

async function loadPreferredModel(requestId: string): Promise<void> {
  const report = loadProgressReporter(requestId);
  await ensureProcessor(report);
  const preferred: DesktopInferenceBackend = requireRuntime().platform === 'win32'
    ? 'directml'
    : 'native-cpu';
  try {
    model = await loadModel(preferred, report);
    backend = preferred;
  } catch (error) {
    if (preferred !== 'directml') throw error;
    model = await loadModel('native-cpu', report);
    backend = 'native-cpu';
  }
}

async function ensureLoaded(requestId: string): Promise<DesktopInferenceBackend> {
  if (model && processor && backend) return backend;
  if (!loading) {
    loading = loadPreferredModel(requestId).finally(() => {
      loading = null;
    });
  }
  await loading;
  if (!model || !processor || !backend) throw new Error('native CLAP model failed to load');
  return backend;
}

function normalizedVector(values: ArrayLike<number>): number[] {
  if (values.length !== CLAP_INFERENCE_CONTRACT.embeddingDimension) {
    throw new Error(`CLAP returned ${values.length} dimensions; expected ${CLAP_INFERENCE_CONTRACT.embeddingDimension}`);
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

async function embed(request: Extract<DesktopClapRequest, { action: 'embed' }>): Promise<DesktopClapResponse> {
  const activeBackend = await ensureLoaded(request.requestId);
  if (!model || !processor) throw new Error('native CLAP model is not loaded');
  const inputs = await processor(request.samples);
  const vector = normalizedVector(embeddingData(await model(inputs)));
  if (!canceled.has(request.requestId)) postProgress({ requestId: request.requestId, progress: 1 });
  return { requestId: request.requestId, backend: activeBackend, result: { type: 'embedding', vector } };
}

async function execute(request: DesktopClapRequest): Promise<DesktopClapResponse> {
  if (request.action === 'embed') return embed(request);
  const activeBackend = await ensureLoaded(request.requestId);
  return { requestId: request.requestId, backend: activeBackend, result: { type: 'loaded' } };
}

function postCanceled(requestId: string): void {
  port.postMessage({
    type: 'error',
    requestId,
    name: 'AbortError',
    message: 'Native CLAP request canceled',
  });
}

async function handle(value: unknown): Promise<void> {
  const request = parseDesktopClapRequest(value);
  if (canceled.delete(request.requestId)) {
    postCanceled(request.requestId);
    return;
  }
  try {
    const response = await execute(request);
    if (canceled.delete(request.requestId)) postCanceled(request.requestId);
    else port.postMessage({ type: 'result', response });
  } catch (error) {
    if (canceled.delete(request.requestId)) {
      postCanceled(request.requestId);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', requestId: request.requestId, name: 'Error', message });
  }
}

function cancel(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const requestId = Reflect.get(value, 'requestId');
  if (isDesktopInferenceRequestId(requestId)) canceled.add(requestId);
}

port.on('message', (event) => {
  const value = event.data;
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'initialize') {
    initialize(Reflect.get(value, 'config'));
    return;
  }
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'cancel') {
    cancel(value);
    return;
  }
  queue = queue.then(() => handle(value), () => handle(value));
});
