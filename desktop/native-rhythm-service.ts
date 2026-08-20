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
  isDesktopRhythmResponse,
  parseDesktopRhythmRequest,
  type DesktopHardwareCapabilities,
  type DesktopInferenceCapabilities,
  type DesktopInferenceProgress,
  type DesktopRhythmRequest,
  type DesktopRhythmResponse,
} from '../shared/desktop-inference.ts';
import { RHYTHM_INFERENCE_CONTRACT } from '../shared/vector-inference-contract.ts';
import { resolveDesktopInferenceCapabilities } from './native-inference-policy.ts';
import { lowerNativeWorkerPriority } from './native-worker-priority.ts';

const REQUEST_TIMEOUT_MS = 10 * 60_000;
const LOAD_TIMEOUT_MS = 2 * 60_000;

interface PendingRequest {
  readonly resolve: (value: DesktopRhythmResponse) => void;
  readonly reject: (reason?: unknown) => void;
  readonly onProgress: (progress: DesktopInferenceProgress) => void;
  readonly timer: NodeJS.Timeout;
}

interface VerifiedPack {
  readonly fingerprint: string;
  readonly modelPath: string;
  readonly filterbankPath: string;
}

export interface NativeRhythmServiceOptions {
  readonly cacheDir: string;
  readonly platform?: NodeJS.Platform;
  readonly runtimeAvailable?: boolean;
  readonly hardware?: DesktopHardwareCapabilities;
}

const require = createRequire(import.meta.url);

function onnxRuntimeAvailable(): boolean {
  try {
    require.resolve('onnxruntime-node');
    return true;
  } catch {
    return false;
  }
}

function rhythmPack(): ModelPackDefinition {
  const pack = modelPackDefinition('rhythm-lite');
  if (!pack || pack.modelId !== RHYTHM_INFERENCE_CONTRACT.modelId
    || pack.revision !== RHYTHM_INFERENCE_CONTRACT.revision) {
    throw new Error('native rhythm contract does not match the verified rhythm-lite pack');
  }
  return pack;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPack(cacheDir: string, cached: VerifiedPack | null): Promise<VerifiedPack> {
  const pack = rhythmPack();
  const root = await realpath(join(cacheDir, pack.modelId));
  const records: Array<{ path: string; fingerprint: string }> = [];
  for (const file of pack.files) {
    const path = await realpath(join(root, file.path));
    const traversal = relative(root, path);
    if (traversal.startsWith('..') || traversal === '') {
      throw new Error(`native rhythm pack contains an invalid path for ${file.path}`);
    }
    const info = await stat(path);
    if (!info.isFile() || info.size !== file.sizeBytes) {
      throw new Error(`native rhythm pack file failed size verification: ${file.path}`);
    }
    records.push({ path, fingerprint: `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` });
  }
  const fingerprint = records.map((record) => record.fingerprint).join('|');
  if (cached?.fingerprint === fingerprint) return cached;
  for (let index = 0; index < pack.files.length; index += 1) {
    if (await sha256(records[index]!.path) !== pack.files[index]!.sha256) {
      throw new Error(`native rhythm pack file failed SHA-256 verification: ${pack.files[index]!.path}`);
    }
  }
  const modelIndex = pack.files.findIndex((file) => file.path === RHYTHM_INFERENCE_CONTRACT.files.model.path);
  const filterIndex = pack.files.findIndex((file) => file.path === RHYTHM_INFERENCE_CONTRACT.files.filterbank.path);
  const modelPath = records[modelIndex]?.path;
  const filterbankPath = records[filterIndex]?.path;
  if (!modelPath || !filterbankPath) throw new Error('native rhythm pack is incomplete');
  return { fingerprint, modelPath, filterbankPath };
}

export class NativeRhythmService {
  private readonly cacheDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly capabilities: DesktopInferenceCapabilities;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inflight = new Set<string>();
  private readonly cancelRequested = new Set<string>();
  private verifiedPack: VerifiedPack | null = null;
  private worker: UtilityProcess | null = null;
  private workerFingerprint: string | null = null;
  private disposed = false;

  constructor(options: NativeRhythmServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.platform = options.platform ?? process.platform;
    this.capabilities = resolveDesktopInferenceCapabilities({
      platform: this.platform,
      transformerRuntime: false,
      rhythmRuntime: options.runtimeAvailable ?? onnxRuntimeAvailable(),
      ffmpegRuntime: true,
      hardware: options.hardware,
    });
  }

  getCapabilities(): DesktopInferenceCapabilities {
    return this.capabilities;
  }

  async request(
    value: DesktopRhythmRequest,
    onProgress: (progress: DesktopInferenceProgress) => void = () => {},
  ): Promise<DesktopRhythmResponse> {
    if (this.disposed) throw new Error('native rhythm service is disposed');
    if (!this.capabilities.rhythm.available) {
      throw new Error(this.capabilities.rhythm.reason ?? 'native rhythm inference is unavailable');
    }
    const request = parseDesktopRhythmRequest(value);
    if (this.inflight.has(request.requestId)) throw new Error('duplicate native rhythm request id');
    this.inflight.add(request.requestId);
    try {
      this.verifiedPack = await inspectPack(this.cacheDir, this.verifiedPack);
      if (this.disposed) throw new Error('native rhythm service is disposed');
      if (this.cancelRequested.has(request.requestId)) {
        throw new DOMException('Native rhythm request canceled', 'AbortError');
      }
      const worker = this.ensureWorker(this.verifiedPack);
      return await new Promise<DesktopRhythmResponse>((resolve, reject) => {
        const timeoutMs = request.action === 'load' ? LOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        const timer = setTimeout(
          () => this.failWorker(new Error('native rhythm request timed out')),
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
    if (!isDesktopInferenceRequestId(requestId)) throw new Error('invalid native rhythm request id');
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
    this.failWorker(new Error('native rhythm service is disposed'));
  }

  private ensureWorker(pack: VerifiedPack): UtilityProcess {
    if (this.worker && this.workerFingerprint === pack.fingerprint) return this.worker;
    if (this.pending.size > 0) throw new Error('native rhythm pack changed during inference');
    this.resetWorker();
    const worker = utilityProcess.fork(
      fileURLToPath(new URL('./native-rhythm-worker.mjs', import.meta.url)),
      [],
      { serviceName: 'OpenChatCut Native Rhythm' },
    );
    lowerNativeWorkerPriority(worker);
    worker.on('message', (value: unknown) => this.handleWorkerMessage(value));
    worker.on('exit', (code) => {
      if (this.worker === worker) this.failWorker(new Error(`native rhythm process exited with code ${code}`));
    });
    worker.postMessage({ type: 'initialize', config: {
      platform: this.platform,
      preferredBackend: this.capabilities.rhythm.preferredBackend ?? 'native-cpu',
      modelPath: pack.modelPath,
      filterbankPath: pack.filterbankPath,
    } });
    this.worker = worker;
    this.workerFingerprint = pack.fingerprint;
    return worker;
  }

  private handleWorkerMessage(value: unknown): void {
    if (typeof value !== 'object' || value === null) {
      this.failWorker(new Error('invalid native rhythm worker response'));
      return;
    }
    const message = value as Record<string, unknown>;
    if (message.type === 'progress' && isDesktopInferenceProgress(message.progress)) {
      this.pending.get(message.progress.requestId)?.onProgress(message.progress);
      return;
    }
    if (message.type === 'result' && isDesktopRhythmResponse(message.response)) {
      this.settle(message.response.requestId, undefined, message.response);
      return;
    }
    if (message.type === 'error' && typeof message.requestId === 'string'
      && typeof message.message === 'string'
      && (message.name === undefined || message.name === 'Error' || message.name === 'AbortError')) {
      const error = message.name === 'AbortError'
        ? new DOMException(message.message, 'AbortError')
        : new Error(message.message);
      this.settle(message.requestId, error);
      return;
    }
    this.failWorker(new Error('invalid native rhythm worker response'));
  }

  private settle(requestId: string, error?: Error, response?: DesktopRhythmResponse): void {
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
    this.workerFingerprint = null;
    if (worker) worker.kill();
  }

  private failWorker(error: Error): void {
    this.resetWorker();
    for (const [requestId] of this.pending) this.settle(requestId, error);
  }
}
