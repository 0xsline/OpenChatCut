import {
  AutoProcessor,
  AutoTokenizer,
  ChineseCLIPModel,
  RawImage,
  env,
} from '@huggingface/transformers';
import type {
  DesktopInferenceBackend,
  DesktopInferenceProgress,
  DesktopSemanticRequest,
  DesktopSemanticResponse,
} from '../shared/desktop-inference.ts';
import {
  isDesktopInferenceRequestId,
  parseDesktopSemanticRequest,
} from '../shared/desktop-inference.ts';
import { SEMANTIC_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';
import {
  findDuplicateAssetsPackedInterruptible,
  normalizeVector,
} from '../src/media/semantic-search/vectorSearch.ts';

const RGBA_CHANNELS = 4;

type ModelInputs = Record<string, unknown>;
type EmbeddingKey = 'text_embeds' | 'image_embeds';

interface SemanticModel {
  (inputs: ModelInputs): Promise<unknown>;
  dispose(): Promise<void>;
}

interface SemanticProcessor {
  (image: RawImage): Promise<unknown>;
}

interface SemanticTokenizer {
  (texts: string[], options: { padding: boolean; truncation: boolean }): unknown;
}

interface NativeSemanticWorkerConfig {
  readonly origin: string;
  readonly cacheDir: string;
  readonly platform: NodeJS.Platform;
  readonly preferredBackend: DesktopInferenceBackend;
}

interface SharedSemanticInputs {
  readonly processor: SemanticProcessor;
  readonly tokenizer: SemanticTokenizer;
  readonly dummyTextInputs: ModelInputs;
  readonly dummyImageInputs: ModelInputs;
}

interface LoadedSemanticModel extends SharedSemanticInputs {
  readonly backend: DesktopInferenceBackend;
  readonly model: SemanticModel;
}

const port = process.parentPort;
if (!port) throw new Error('native semantic process requires a parent port');
let runtime: NativeSemanticWorkerConfig | null = null;
let loaded: LoadedSemanticModel | null = null;
let loading: Promise<LoadedSemanticModel> | null = null;
let queue = Promise.resolve();
const canceled = new Set<string>();

function throwIfCanceled(requestId: string): void {
  if (canceled.has(requestId)) {
    throw new DOMException('Native semantic request canceled', 'AbortError');
  }
}

function initialize(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error('invalid native semantic configuration');
  }
  const config = value as Partial<NativeSemanticWorkerConfig>;
  if (typeof config.origin !== 'string'
    || typeof config.cacheDir !== 'string' || config.cacheDir.length === 0
    || typeof config.platform !== 'string'
    || !isNativeModelBackend(config.preferredBackend)) {
    throw new Error('invalid native semantic configuration');
  }
  const origin = new URL(config.origin);
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('invalid native semantic origin');
  }
  runtime = {
    origin: origin.origin,
    cacheDir: config.cacheDir,
    platform: config.platform,
    preferredBackend: config.preferredBackend,
  };
  env.localModelPath = config.cacheDir;
  env.cacheDir = config.cacheDir;
  env.useFSCache = true;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
}

function isNativeModelBackend(value: unknown): value is DesktopInferenceBackend {
  return value === 'cuda' || value === 'directml' || value === 'native-cpu';
}

function backendDevice(backend: DesktopInferenceBackend): 'cpu' | 'cuda' | 'dml' {
  if (backend === 'directml') return 'dml';
  if (backend === 'cuda') return 'cuda';
  return 'cpu';
}

function requireRuntime(): NativeSemanticWorkerConfig {
  if (!runtime) throw new Error('native semantic process is not initialized');
  return runtime;
}

function progressInfo(value: unknown): Omit<DesktopInferenceProgress, 'requestId'> {
  if (typeof value !== 'object' || value === null) return {};
  const progress = value as { progress?: unknown; file?: unknown };
  return {
    ...(typeof progress.progress === 'number' ? { progress: progress.progress } : {}),
    ...(typeof progress.file === 'string' ? { file: progress.file } : {}),
  };
}

function postProgress(requestId: string, value: unknown): void {
  const progress: DesktopInferenceProgress = { requestId, ...progressInfo(value) };
  port.postMessage({ type: 'progress', progress });
}

async function loadSharedInputs(requestId: string): Promise<SharedSemanticInputs> {
  const progress = (value: unknown) => postProgress(requestId, value);
  const options = { revision: SEMANTIC_INFERENCE_CONTRACT.revision, progress_callback: progress };
  const [tokenizer, processor] = await Promise.all([
    AutoTokenizer.from_pretrained(SEMANTIC_INFERENCE_CONTRACT.modelId, options),
    AutoProcessor.from_pretrained(SEMANTIC_INFERENCE_CONTRACT.modelId, options),
  ]);
  const dummyTextInputs = tokenizer([''], { padding: true, truncation: true }) as unknown as ModelInputs;
  const edge = SEMANTIC_INFERENCE_CONTRACT.inputEdge;
  const blank = new RawImage(new Uint8ClampedArray(edge * edge * RGBA_CHANNELS), edge, edge, RGBA_CHANNELS);
  const dummyImageInputs = await processor(blank) as unknown as ModelInputs;
  return {
    processor: processor as unknown as SemanticProcessor,
    tokenizer: tokenizer as unknown as SemanticTokenizer,
    dummyTextInputs,
    dummyImageInputs,
  };
}

async function loadModel(
  requestId: string,
  backend: DesktopInferenceBackend,
  inputs: SharedSemanticInputs,
): Promise<LoadedSemanticModel> {
  const model = await ChineseCLIPModel.from_pretrained(SEMANTIC_INFERENCE_CONTRACT.modelId, {
    revision: SEMANTIC_INFERENCE_CONTRACT.revision,
    dtype: SEMANTIC_INFERENCE_CONTRACT.dtype,
    device: backendDevice(backend),
    progress_callback: (value: unknown) => postProgress(requestId, value),
  });
  try {
    await (model as unknown as SemanticModel)({ ...inputs.dummyTextInputs, ...inputs.dummyImageInputs });
  } catch (error) {
    await model.dispose();
    throw error;
  }
  return { backend, model: model as unknown as SemanticModel, ...inputs };
}

async function createLoadedModel(requestId: string): Promise<LoadedSemanticModel> {
  const inputs = await loadSharedInputs(requestId);
  const preferred = requireRuntime().preferredBackend;
  if (preferred === 'native-cpu') return loadModel(requestId, preferred, inputs);
  try {
    return await loadModel(requestId, preferred, inputs);
  } catch {
    return loadModel(requestId, 'native-cpu', inputs);
  }
}

async function ensureLoaded(requestId: string): Promise<LoadedSemanticModel> {
  if (loaded) return loaded;
  if (!loading) {
    loading = createLoadedModel(requestId).then((result) => {
      loaded = result;
      return result;
    }).finally(() => {
      loading = null;
    });
  }
  return loading;
}

function readEmbedding(output: unknown, key: EmbeddingKey): ArrayLike<number> {
  if (typeof output !== 'object' || output === null) {
    throw new Error('native semantic model returned an invalid response');
  }
  const embedding = (output as Record<string, unknown>)[key];
  if (typeof embedding !== 'object' || embedding === null) {
    throw new Error('native semantic model returned no embedding');
  }
  const data = (embedding as Record<string, unknown>).data;
  const numericView = ArrayBuffer.isView(data) && !(data instanceof DataView) && 'length' in data;
  if (!Array.isArray(data) && !numericView) {
    throw new Error('native semantic model returned invalid embedding data');
  }
  return data as ArrayLike<number>;
}

async function embedText(request: Extract<DesktopSemanticRequest, { action: 'embed-text' }>) {
  const active = await ensureLoaded(request.requestId);
  const textInputs = active.tokenizer([request.text], { padding: true, truncation: true }) as ModelInputs;
  const output = await active.model({ ...textInputs, ...active.dummyImageInputs });
  return { backend: active.backend, vector: normalizeVector(readEmbedding(output, 'text_embeds')) };
}

async function embedImage(request: Extract<DesktopSemanticRequest, { action: 'embed-image' }>) {
  const active = await ensureLoaded(request.requestId);
  const { data, width, height } = request.frame;
  const image = new RawImage(data, width, height, RGBA_CHANNELS);
  const imageInputs = await active.processor(image) as ModelInputs;
  const output = await active.model({ ...active.dummyTextInputs, ...imageInputs });
  return { backend: active.backend, vector: normalizeVector(readEmbedding(output, 'image_embeds')) };
}

async function respond(request: DesktopSemanticRequest): Promise<DesktopSemanticResponse> {
  if (request.action === 'load') {
    const active = await ensureLoaded(request.requestId);
    return { requestId: request.requestId, backend: active.backend, result: { type: 'loaded' } };
  }
  if (request.action === 'embed-text') {
    const result = await embedText(request);
    return { requestId: request.requestId, backend: result.backend,
      result: { type: 'embedding', vector: result.vector } };
  }
  if (request.action === 'embed-image') {
    const result = await embedImage(request);
    return { requestId: request.requestId, backend: result.backend,
      result: { type: 'embedding', vector: result.vector } };
  }
  const backend: DesktopInferenceBackend = 'native-cpu';
  const matches = await findDuplicateAssetsPackedInterruptible({
    assetIds: [...request.vectors.assetIds],
    assetVectorOffsets: request.vectors.assetVectorOffsets,
    vectorValueOffsets: request.vectors.vectorValueOffsets,
    values: request.vectors.values,
  }, request.threshold, () => throwIfCanceled(request.requestId),
  () => new Promise((resolve) => setImmediate(resolve)));
  return { requestId: request.requestId, backend, result: { type: 'duplicates', matches } };
}

async function handle(value: unknown): Promise<void> {
  const request = parseDesktopSemanticRequest(value);
  try {
    throwIfCanceled(request.requestId);
    const response = await respond(request);
    throwIfCanceled(request.requestId);
    port.postMessage({ type: 'result', response });
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    port.postMessage({ type: 'error', requestId: request.requestId, name, message });
  } finally {
    canceled.delete(request.requestId);
  }
}

port.on('message', (event) => {
  const value = event.data;
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'initialize') {
    initialize(Reflect.get(value, 'config'));
    return;
  }
  if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'cancel') {
    const requestId = Reflect.get(value, 'requestId');
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native semantic cancellation');
    canceled.add(requestId);
    return;
  }
  queue = queue.then(() => handle(value), () => handle(value));
});
