import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess, type UtilityProcess } from 'electron';
import { modelPackDefinition, type ModelPackDefinition } from '../shared/model-packs/catalog.ts';
import {
  isDesktopInferenceProgress,
  isDesktopInferenceRequestId,
  isDesktopSemanticResponse,
  parseDesktopSemanticRequest,
  type DesktopHardwareCapabilities,
  type DesktopInferenceCapabilities,
  type DesktopInferenceProgress,
  type DesktopSemanticRequest,
  type DesktopSemanticResponse,
} from '../shared/desktop-inference.ts';
import { SEMANTIC_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';
import { resolveDesktopInferenceCapabilities } from './native-inference-policy.ts';
import { lowerNativeWorkerPriority } from './native-worker-priority.ts';

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const LOAD_TIMEOUT_MS = 2 * 60_000;

interface PendingRequest {
  readonly resolve: (value: DesktopSemanticResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onProgress: (progress: DesktopInferenceProgress) => void;
  readonly timer: NodeJS.Timeout;
}

interface VerifiedPack {
  readonly fingerprint: string;
}

export interface NativeSemanticServiceOptions {
  readonly origin: string;
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly transformerRuntime?: boolean;
  readonly hardware?: DesktopHardwareCapabilities;
}

const require = createRequire(import.meta.url);

function transformerRuntimeAvailable(): boolean {
  try {
    require.resolve('@huggingface/transformers');
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

function semanticPack(): ModelPackDefinition {
  const pack = modelPackDefinition('visual-semantics-lite');
  if (!pack || pack.modelId !== SEMANTIC_INFERENCE_CONTRACT.modelId
    || pack.revision !== SEMANTIC_INFERENCE_CONTRACT.revision) {
    throw new Error('native semantic contract does not match the verified visual-semantics-lite pack');
  }
  return pack;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPack(cacheDir: string, cached: VerifiedPack | null): Promise<VerifiedPack> {
  const pack = semanticPack();
  const root = await realpath(join(cacheDir, pack.modelId));
  const records: Array<{ path: string; fingerprint: string }> = [];
  for (const file of pack.files) {
    const path = await realpath(join(root, file.path));
    const traversal = relative(root, path);
    if (traversal.startsWith('..') || traversal === '') {
      throw new Error(`native semantic pack contains an invalid path for ${file.path}`);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.sizeBytes) {
      throw new Error(`native semantic pack file failed size verification: ${file.path}`);
    }
    records.push({ path, fingerprint: `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
  }
  const fingerprint = records.map((record) => record.fingerprint).join('|');
  if (cached?.fingerprint === fingerprint) return cached;
  for (let index = 0; index < pack.files.length; index += 1) {
    if (await sha256(records[index]!.path) !== pack.files[index]!.sha256) {
      throw new Error(`native semantic pack file failed SHA-256 verification: ${pack.files[index]!.path}`);
    }
  }
  return { fingerprint };
}

export class NativeSemanticService {
  private readonly origin: string;
  private readonly cacheDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly capabilities: DesktopInferenceCapabilities;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inflight = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private verifiedPack: VerifiedPack | null = null;
  private worker: UtilityProcess | null = null;
  private disposed = false;

  constructor(options: NativeSemanticServiceOptions) {
    this.origin = new URL(options.origin).origin;
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.capabilities = resolveDesktopInferenceCapabilities({
      platform: this.platform,
      transformerRuntime: options.transformerRuntime ?? transformerRuntimeAvailable(),
      ffmpegRuntime: true,
      hardware: options.hardware,
    });
  }

  getCapabilities(): DesktopInferenceCapabilities {
    return this.capabilities;
  }

  async request(
    value: DesktopSemanticRequest,
    onProgress: (progress: DesktopInferenceProgress) => void = () => {},
  ): Promise<DesktopSemanticResponse> {
    if (this.disposed) throw new Error('native semantic service is disposed');
    if (!this.capabilities.semantic.available) {
      throw new Error(this.capabilities.semantic.reason ?? 'native semantic inference is unavailable');
    }
    const request = parseDesktopSemanticRequest(value);
    if (this.inflight.has(request.requestId)) throw new Error('duplicate native semantic request id');
    this.inflight.add(request.requestId);
    try {
      if (request.action !== 'find-duplicates') {
        this.verifiedPack = await inspectPack(this.cacheDir, this.verifiedPack);
      }
      if (this.disposed) throw new Error('native semantic service is disposed');
      if (this.cancelRequested.has(request.requestId)) {
        throw new DOMException('Native semantic request canceled', 'AbortError');
      }
      const worker = this.ensureWorker();
      return await new Promise<DesktopSemanticResponse>((resolve, reject) => {
        const timeoutMs = request.action === 'load' ? LOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const timer = setTimeout(
          () => this.failWorker(new Error('native semantic request timed out')),
          timeoutMs,
        );
        this.pending.set(request.requestId, { resolve, reject, onProgress, timer });
        worker.postMessage(request);
      });
    } finally {
      this.inflight.delete(request.requestId);
      this.cancelRequested.delete(request.requestId);
    }
  }

  cancel(requestId: string): void {
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native semantic request id');
    if (!this.inflight.has(requestId)) return;
    this.cancelRequested.add(requestId);
    if (!this.pending.has(requestId)) return;
    try {
      this.worker?.postMessage({ type: 'cancel', requestId });
    } catch (error) {
      this.failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.failWorker(new Error('native semantic service is disposed'));
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const worker = utilityProcess.fork(
      fileURLToPath(new URL('./native-semantic-worker.mjs', import.meta.url)),
      [],
      { serviceName: 'OpenChatCut Native Semantic Search' },
    );
    lowerNativeWorkerPriority(worker);
    worker.on('message', (value: unknown) => this.handleWorkerMessage(value));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.failWorker(new Error(`native semantic process exited with code ${code}`));
      }
    });
    worker.postMessage({
      type: 'initialize',
      config: {
        origin: this.origin,
        cacheDir: this.cacheDir,
        platform: this.platform,
        preferredBackend: this.capabilities.semantic.preferredBackend ?? 'native-cpu',
      },
    });
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      this.failWorker(new Error('invalid native semantic worker response'));
      return;
    }
    const message = value as {
      type?: unknown;
      response?: unknown;
      progress?: unknown;
      requestId?: unknown;
      message?: unknown;
      name?: unknown;
    };
    if (message.type === 'progress' && isDesktopInferenceProgress(message.progress)) {
      this.pending.get(message.progress.requestId)?.onProgress(message.progress);
      return;
    }
    if (message.type === 'result' && isDesktopSemanticResponse(message.response)) {
      this.settle(message.response.requestId, undefined, message.response);
      return;
    }
    if (message.type === 'error' && isDesktopInferenceRequestId(message.requestId)
      && typeof message.message === 'string'
      && (message.name === undefined || message.name === 'Error' || message.name === 'AbortError')) {
      const error = message.name === 'AbortError'
        ? new DOMException(message.message, 'AbortError')
        : new Error(message.message);
      this.settle(message.requestId, error);
      return;
    }
    this.failWorker(new Error('invalid native semantic worker response'));
  }

  private settle(requestId: string, error?: Error, response?: DesktopSemanticResponse): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else if (response) pending.resolve(response);
  }

  private resetWorker(): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) worker.kill();
  }

  private failWorker(error: Error): void {
    this.resetWorker();
    for (const [requestId] of this.pending) this.settle(requestId, error);
  }
}
