import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess, type UtilityProcess } from 'electron';
import { modelPackDefinition, type ModelPackDefinition } from '../shared/model-packs/catalog.ts';
import {
  isDesktopClapResponse,
  isDesktopInferenceProgress,
  isDesktopInferenceRequestId,
  parseDesktopClapRequest,
  type DesktopClapRequest,
  type DesktopClapResponse,
  type DesktopHardwareCapabilities,
  type DesktopInferenceCapabilities,
  type DesktopInferenceProgress,
} from '../shared/desktop-inference.ts';
import { CLAP_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';
import { resolveDesktopInferenceCapabilities } from './native-inference-policy.ts';
import { lowerNativeWorkerPriority } from './native-worker-priority.ts';

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const LOAD_TIMEOUT_MS = 2 * 60_000;

interface PendingRequest {
  readonly action: DesktopClapRequest['action'];
  readonly resolve: (value: DesktopClapResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onProgress: (progress: DesktopInferenceProgress) => void;
  readonly timer: NodeJS.Timeout;
}

interface VerifiedPack {
  readonly fingerprint: string;
}

export interface NativeClapServiceOptions {
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

function clapPack(): ModelPackDefinition {
  const pack = modelPackDefinition('music-semantics-lite');
  if (!pack || pack.modelId !== CLAP_INFERENCE_CONTRACT.modelId
    || pack.revision !== CLAP_INFERENCE_CONTRACT.revision) {
    throw new Error('native CLAP contract does not match the verified music-semantics-lite pack');
  }
  return pack;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPack(cacheDir: string, cached: VerifiedPack | null): Promise<VerifiedPack> {
  const pack = clapPack();
  const root = await realpath(join(cacheDir, pack.modelId));
  const records: Array<{ path: string; fingerprint: string }> = [];
  for (const file of pack.files) {
    const path = await realpath(join(root, file.path));
    const traversal = relative(root, path);
    if (traversal.startsWith('..') || traversal === '') {
      throw new Error(`native CLAP pack contains an invalid path for ${file.path}`);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.sizeBytes) {
      throw new Error(`native CLAP pack file failed size verification: ${file.path}`);
    }
    records.push({ path, fingerprint: `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
  }
  const fingerprint = records.map((record) => record.fingerprint).join('|');
  if (cached?.fingerprint === fingerprint) return cached;
  for (let index = 0; index < pack.files.length; index += 1) {
    if (await sha256(records[index]!.path) !== pack.files[index]!.sha256) {
      throw new Error(`native CLAP pack file failed SHA-256 verification: ${pack.files[index]!.path}`);
    }
  }
  return { fingerprint };
}


export class NativeClapService {
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

  constructor(options: NativeClapServiceOptions) {
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
    request: DesktopClapRequest,
    onProgress: (progress: DesktopInferenceProgress) => void = () => {},
  ): Promise<DesktopClapResponse> {
    const parsed = parseDesktopClapRequest(request);
    if (this.disposed) throw new Error('native CLAP service is disposed');
    if (!this.capabilities.clap.available) {
      throw new Error(this.capabilities.clap.reason ?? 'native CLAP is unavailable');
    }
    if (this.inflight.has(parsed.requestId)) throw new Error('duplicate native CLAP request id');
    this.inflight.add(parsed.requestId);
    try {
      this.verifiedPack = await inspectPack(this.cacheDir, this.verifiedPack);
      if (this.disposed) throw new Error('native CLAP service is disposed');
      if (this.cancelRequested.has(parsed.requestId)) {
        throw new DOMException('Native CLAP request canceled', 'AbortError');
      }
      const worker = this.ensureWorker();
      return await new Promise<DesktopClapResponse>((resolve, reject) => {
        const timeoutMs = parsed.action === 'load' ? LOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const timer = setTimeout(
          () => this.failWorker(new Error('native CLAP request timed out')),
          timeoutMs,
        );
        this.pending.set(parsed.requestId, { action: parsed.action, resolve, reject, onProgress, timer });
        try {
          worker.postMessage(parsed);
        } catch (error) {
          this.failWorker(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this.inflight.delete(parsed.requestId);
      this.cancelRequested.delete(parsed.requestId);
    }
  }

  cancel(requestId: string): void {
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native CLAP request id');
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
    this.failWorker(new Error('native CLAP service is disposed'));
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker;
    const worker = utilityProcess.fork(
      fileURLToPath(new URL('./native-clap-worker.mjs', import.meta.url)),
      [],
      { serviceName: 'OpenChatCut Native CLAP' },
    );
    lowerNativeWorkerPriority(worker);
    worker.on('message', (value: unknown) => this.handleWorkerMessage(value));
    worker.on('exit', (code) => {
      if (this.worker === worker) {
        this.failWorker(new Error(`native CLAP process exited with code ${code}`));
      }
    });
    worker.postMessage({
      type: 'initialize',
      config: {
        origin: this.origin,
        cacheDir: this.cacheDir,
        platform: this.platform,
        preferredBackend: this.capabilities.clap.preferredBackend ?? 'native-cpu',
      },
    });
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      this.failWorker(new Error('invalid native CLAP worker response'));
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
    if (message.type === 'result' && isDesktopClapResponse(message.response)) {
      this.handleResult(message.response);
      return;
    }
    if (message.type === 'error'
      && isDesktopInferenceRequestId(message.requestId)
      && typeof message.message === 'string'
      && (message.name === undefined || message.name === 'Error' || message.name === 'AbortError')) {
      const error = message.name === 'AbortError'
        ? new DOMException(message.message, 'AbortError')
        : new Error(message.message);
      this.settle(message.requestId, error);
      return;
    }
    this.failWorker(new Error('invalid native CLAP worker response'));
  }

  private handleResult(response: DesktopClapResponse): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    const expectedResult = pending.action === 'load' ? 'loaded' : 'embedding';
    if (response.result.type !== expectedResult) {
      this.failWorker(new Error('native CLAP worker returned an unexpected result'));
      return;
    }
    this.settle(response.requestId, undefined, response);
  }

  private settle(requestId: string, error?: Error, response?: DesktopClapResponse): void {
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
