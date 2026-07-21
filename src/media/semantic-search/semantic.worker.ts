/// <reference lib="webworker" />
import { AutoProcessor, AutoTokenizer, ChineseCLIPModel, RawImage } from '@huggingface/transformers';
import { normalizeVector } from './vectorSearch';
import { MAX_SEMANTIC_QUERY_LENGTH, SEMANTIC_MODEL_ID, type WorkerRequest, type WorkerResponse } from './types';

type Model = Awaited<ReturnType<typeof ChineseCLIPModel.from_pretrained>>;
type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type ModelInputs = Record<string, unknown>;
type ProgressInfo = { progress?: number; file?: string };
const MODEL_INPUT_EDGE = 224;
const RGBA_CHANNELS = 4;

let model: Model | null = null;
let processor: Processor | null = null;
let tokenizer: Tokenizer | null = null;
let dummyTextInputs: ModelInputs | null = null;
let dummyImageInputs: ModelInputs | null = null;
let loading: Promise<void> | null = null;
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const post = (message: WorkerResponse) => workerScope.postMessage(message);

function progressInfo(value: unknown): ProgressInfo {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    progress: typeof record.progress === 'number' ? record.progress : undefined,
    file: typeof record.file === 'string' ? record.file : undefined,
  };
}

async function loadModel(request: Extract<WorkerRequest, { type: 'load' }>): Promise<void> {
  if (model && processor && tokenizer) return;
  if (loading) return loading;
  const progress = (value: unknown) => post({ id: request.id, type: 'progress', ...progressInfo(value) });
  loading = Promise.all([
    AutoTokenizer.from_pretrained(SEMANTIC_MODEL_ID, { progress_callback: progress }),
    AutoProcessor.from_pretrained(SEMANTIC_MODEL_ID, { progress_callback: progress }),
    ChineseCLIPModel.from_pretrained(SEMANTIC_MODEL_ID, {
      device: request.device,
      dtype: 'q4',
      progress_callback: progress,
    }),
  ]).then(([nextTokenizer, nextProcessor, nextModel]) => {
    tokenizer = nextTokenizer;
    processor = nextProcessor;
    model = nextModel;
    dummyTextInputs = nextTokenizer([''], { padding: true, truncation: true }) as unknown as ModelInputs;
    const pixelCount = MODEL_INPUT_EDGE * MODEL_INPUT_EDGE * RGBA_CHANNELS;
    const blank = new RawImage(new Uint8ClampedArray(pixelCount), MODEL_INPUT_EDGE, MODEL_INPUT_EDGE, RGBA_CHANNELS);
    return nextProcessor(blank).then((inputs: unknown) => { dummyImageInputs = inputs as ModelInputs; });
  }).finally(() => { loading = null; });
  return loading;
}

async function embedText(text: string): Promise<number[]> {
  if (!model || !tokenizer || !dummyImageInputs) throw new Error('Semantic model is not loaded');
  const textInputs = tokenizer([text], { padding: true, truncation: true });
  const output: unknown = await model({ ...textInputs, ...dummyImageInputs });
  return normalizeVector(readEmbedding(output, 'text_embeds'));
}

async function embedImage(request: Extract<WorkerRequest, { type: 'embed-image' }>): Promise<number[]> {
  if (!model || !processor || !dummyTextInputs) throw new Error('Semantic model is not loaded');
  const { data, width, height } = request.frame;
  const image = new RawImage(data, width, height, RGBA_CHANNELS);
  const output: unknown = await model({ ...dummyTextInputs, ...await processor(image) });
  return normalizeVector(readEmbedding(output, 'image_embeds'));
}

function readEmbedding(output: unknown, key: 'text_embeds' | 'image_embeds'): ArrayLike<number> {
  if (!output || typeof output !== 'object') throw new Error('Semantic model returned an invalid response');
  const embedding = (output as Record<string, unknown>)[key];
  if (!embedding || typeof embedding !== 'object') throw new Error('Semantic model returned no embedding');
  const data = (embedding as Record<string, unknown>).data;
  const numericView = ArrayBuffer.isView(data) && !(data instanceof DataView) && 'length' in data;
  if (!Array.isArray(data) && !numericView) throw new Error('Semantic model returned invalid embedding data');
  const values = data as ArrayLike<number>;
  if (values.length === 0) throw new Error('Semantic model returned an empty embedding');
  return values;
}

function validateRequest(value: unknown): WorkerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid semantic worker request');
  const request = value as Record<string, unknown>;
  if (!Number.isInteger(request.id)) throw new Error('Invalid semantic worker request id');
  if (request.type === 'load' && (request.device === 'webgpu' || request.device === 'wasm')) return request as WorkerRequest;
  if (request.type === 'embed-text' && typeof request.text === 'string'
    && request.text.length > 0 && request.text.length <= MAX_SEMANTIC_QUERY_LENGTH) return request as WorkerRequest;
  if (request.type === 'embed-image' && isValidFrame(request.frame)) return request as WorkerRequest;
  throw new Error('Invalid semantic worker request payload');
}

function isValidFrame(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  if (!(frame.data instanceof Uint8ClampedArray)) return false;
  if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height)) return false;
  if ((frame.width as number) <= 0 || (frame.height as number) <= 0) return false;
  return frame.data.length === (frame.width as number) * (frame.height as number) * RGBA_CHANNELS;
}

async function handleRequest(value: unknown): Promise<void> {
  const request = validateRequest(value);
  if (request.type === 'load') await loadModel(request);
  const vector = request.type === 'embed-text'
    ? await embedText(request.text)
    : request.type === 'embed-image'
      ? await embedImage(request)
      : undefined;
  post({ id: request.id, type: 'result', vector });
}

workerScope.onmessage = (event: MessageEvent<unknown>) => {
  void handleRequest(event.data).catch((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const id = event.data && typeof event.data === 'object' && Number.isInteger((event.data as { id?: unknown }).id)
      ? Number((event.data as { id: number }).id)
      : -1;
    post({ id, type: 'error', message });
  });
};
