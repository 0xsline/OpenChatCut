import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { UtilityProcess } from 'electron';
import { ASR_INFERENCE_CONTRACT } from '../shared/asr-inference-contract.ts';
import { ASR_MODELS } from '../shared/asr-models.ts';
import type {
  DesktopAsrRequest,
  DesktopInferenceProgress,
} from '../shared/desktop-inference.ts';
import { NativeAsrService } from './native-asr-service.ts';
import { NativeInferenceBudget } from './native-inference-budget.ts';
import { NativeInferenceResidency } from './native-inference-residency.ts';

type KillBehavior = 'accept' | 'refuse' | 'throw';

interface ScheduledForceKill {
  readonly callback: () => void;
  readonly delayMs: number;
  canceled: boolean;
}

class FakeWorker extends EventEmitter {
  readonly posted: unknown[] = [];
  killCount = 0;
  readonly pid: number;
  private readonly killBehavior: KillBehavior;
  private readonly requestWaiters = new Map<number, () => void>();

  constructor(pid: number, killBehavior: KillBehavior = 'accept') {
    super();
    this.pid = pid;
    this.killBehavior = killBehavior;
  }

  postMessage(value: unknown): void {
    this.posted.push(value);
    const count = this.requestCount;
    for (const [target, resolve] of this.requestWaiters) {
      if (count < target) continue;
      this.requestWaiters.delete(target);
      resolve();
    }
  }

  kill(): boolean {
    this.killCount += 1;
    if (this.killBehavior === 'throw') throw new Error('forced kill failure');
    return this.killBehavior === 'accept';
  }

  get requestCount(): number {
    return this.posted.filter((value) => {
      if (typeof value !== 'object' || value === null) return false;
      return Reflect.get(value, 'type') !== 'initialize';
    }).length;
  }

  waitForRequestCount(count: number): Promise<void> {
    if (this.requestCount >= count) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.requestWaiters.set(count, resolve);
    return promise;
  }

  send(value: unknown): void {
    this.emit('message', value);
  }
}

function asUtilityProcess(worker: FakeWorker): UtilityProcess {
  return worker as unknown as UtilityProcess;
}

function assertAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const model = ASR_MODELS[0]!;
const requestId = 'cancel-active-0001';
const request: DesktopAsrRequest = {
  requestId,
  contractId: ASR_INFERENCE_CONTRACT.id,
  sourcePath: '/media/uploads/source.wav',
  modelId: model.modelId,
  revision: model.revision,
  language: 'zh',
};
const serviceOptions = {
  cacheDir: '/unused/native-asr-cache',
  platform: 'darwin' as const,
  ffmpegPath: 'ffmpeg',
  transformerRuntime: true,
};

const verification = Promise.withResolvers<{ downloaded: boolean; bytes: number }>();
const verificationWorkers: FakeWorker[] = [];
let verificationSignal: AbortSignal | undefined;
let verificationCompleted = false;
const verificationService = new NativeAsrService(serviceOptions, {
  inspectModel: async (_entry, _cacheDir, signal) => {
    verificationSignal = signal;
    try {
      return await verification.promise;
    } finally {
      verificationCompleted = true;
    }
  },
  createWorker: () => {
    const worker = new FakeWorker(1);
    verificationWorkers.push(worker);
    return asUtilityProcess(worker);
  },
});
const verificationBudget = new NativeInferenceBudget();
const verificationResidency = new NativeInferenceResidency(100);
verificationBudget.claim(3, 'cancel-verify-0001', 0);
const releaseVerificationResidency = verificationResidency.claim('asr', 60, () => {});
const verificationRequest = verificationService.preload({
  requestId: 'cancel-verify-0001',
  contractId: ASR_INFERENCE_CONTRACT.id,
  action: 'load',
  modelId: model.modelId,
  revision: model.revision,
}).finally(() => {
  releaseVerificationResidency();
  verificationBudget.release('cancel-verify-0001');
});
verificationService.cancel('cancel-verify-0001');
const verificationTurn = Promise.withResolvers<'late'>();
setImmediate(() => verificationTurn.resolve('late'));
const verificationOutcome = await Promise.race([
  verificationRequest.then(
    () => 'resolved' as const,
    (error: unknown) => error,
  ),
  verificationTurn.promise,
]);
assert.ok(assertAbortError(verificationOutcome), 'verification cancel must reject before inspection resolves');
assert.equal(verificationCompleted, false, 'terminal cancellation must not await unresolved file hashing');
assert.equal(verificationSignal?.aborted, true, 'model inspection must receive the request abort signal');
assert.equal(verificationBudget.activeCount, 0, 'verification cancellation must release request budget promptly');
const verificationEvictions: string[] = [];
const releaseAfterVerification = verificationResidency.claim(
  'semantic',
  60,
  (kind) => verificationEvictions.push(kind),
);
assert.deepEqual(verificationEvictions, ['asr'], 'verification cancellation must release residency promptly');
releaseAfterVerification();
verification.resolve({ downloaded: true, bytes: 1 });
assert.equal(verificationWorkers.length, 0, 'verification cancellation must abort before worker creation');

const workers: FakeWorker[] = [];
const workerWaiters = new Map<number, () => void>();
function waitForWorkerCount(count: number): Promise<void> {
  if (workers.length >= count) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  workerWaiters.set(count, resolve);
  return promise;
}
const forceKillTasks: ScheduledForceKill[] = [];
const forcedPids: number[] = [];
const service = new NativeAsrService(serviceOptions, {
  inspectModel: async () => ({ downloaded: true, bytes: 1 }),
  createWorker: () => {
    const worker = workers.length === 0
      ? new FakeWorker(101, 'refuse')
      : new FakeWorker(202, 'throw');
    workers.push(worker);
    for (const [target, resolve] of workerWaiters) {
      if (workers.length < target) continue;
      workerWaiters.delete(target);
      resolve();
    }
    return asUtilityProcess(worker);
  },
  resolveSourcePath: () => '/verified/source.wav',
  scheduleForceKill: (callback, delayMs) => {
    const task = { callback, delayMs, canceled: false };
    forceKillTasks.push(task);
    return () => { task.canceled = true; };
  },
  forceKillProcess: (pid) => forcedPids.push(pid),
});
const budget = new NativeInferenceBudget();
const residency = new NativeInferenceResidency(100);
const progress: number[] = [];

async function transcribeWithLeases(
  input: DesktopAsrRequest,
  onProgress: (value: DesktopInferenceProgress) => void,
) {
  budget.claim(7, input.requestId, 0);
  const releaseResidency = residency.claim('asr', 60, () => {});
  try {
    return await service.transcribe(input, onProgress);
  } finally {
    releaseResidency();
    budget.release(input.requestId);
  }
}

const canceledRequest = transcribeWithLeases(request, (value) => {
  if (value.progress !== undefined) progress.push(value.progress);
});
await waitForWorkerCount(1);
const firstWorker = workers[0];
assert.ok(firstWorker);
await firstWorker.waitForRequestCount(1);
assert.equal(workers.length, 1);
firstWorker.send({ type: 'progress', progress: { requestId, progress: 10 } });

const canceledOutcome = canceledRequest.then(
  () => ({ state: 'resolved' as const }),
  (error: unknown) => ({ state: 'rejected' as const, error }),
);
service.cancel(requestId);
const nextTurnAfterCancel = Promise.withResolvers<{ state: 'late' }>();
setImmediate(() => nextTurnAfterCancel.resolve({ state: 'late' }));
const promptOutcome = await Promise.race([
  canceledOutcome,
  nextTurnAfterCancel.promise,
]);
assert.equal(promptOutcome.state, 'rejected', 'cancel must reject before the next event-loop turn');
assert.ok(promptOutcome.state === 'rejected' && assertAbortError(promptOutcome.error));
assert.equal(firstWorker.killCount, 1, 'cancel must terminate the utility process');
assert.equal(budget.activeCount, 0, 'prompt rejection must release the request budget');
assert.equal(forceKillTasks.length, 1, 'a refused graceful kill must schedule force termination');
assert.equal(forceKillTasks[0]?.delayMs, 250);
forceKillTasks[0]?.callback();
assert.deepEqual(forcedPids, [101], 'the retiring utility PID must be force-killed after grace');

const evictedAfterCancel: string[] = [];
const releaseSemantic = residency.claim('semantic', 60, (kind) => evictedAfterCancel.push(kind));
assert.deepEqual(evictedAfterCancel, ['asr'], 'cancel rejection must release the active residency lease');
releaseSemantic();
residency.clear();

firstWorker.send({ type: 'progress', progress: { requestId, progress: 99 } });
firstWorker.send({
  type: 'result',
  response: { requestId, backend: 'native-cpu', text: 'stale', chunks: [] },
});
assert.deepEqual(progress, [10], 'a canceled worker must not leak late progress');

const subsequentRequest = transcribeWithLeases(request, (value) => {
  if (value.progress !== undefined) progress.push(value.progress);
});
await waitForWorkerCount(2);
const secondWorker = workers[1];
assert.ok(secondWorker);
await secondWorker.waitForRequestCount(1);
assert.equal(workers.length, 2, 'the next request must lazily create a clean worker');
firstWorker.send({ type: 'progress', progress: { requestId, progress: 98 } });
firstWorker.send({
  type: 'result',
  response: { requestId, backend: 'native-cpu', text: 'poison', chunks: [] },
});
firstWorker.emit('exit', 9);
assert.equal(forceKillTasks[0]?.canceled, true, 'retiring worker must be retained until its exit event');
const nextTurnAfterStaleResult = Promise.withResolvers<boolean>();
setImmediate(() => nextTurnAfterStaleResult.resolve(false));
const settledByRetiredWorker = await Promise.race([
  subsequentRequest.then(
    () => true,
    () => true,
  ),
  nextTurnAfterStaleResult.promise,
]);
assert.equal(settledByRetiredWorker, false, 'the retired worker must not settle a reused request id');
assert.equal(secondWorker.killCount, 0, 'the retired worker exit must not reset the new worker');

secondWorker.send({ type: 'progress', progress: { requestId, progress: 60 } });
secondWorker.send({
  type: 'result',
  response: { requestId, backend: 'native-cpu', text: 'fresh', chunks: [] },
});
const subsequentResult = await subsequentRequest;
assert.equal(subsequentResult.text, 'fresh');
assert.deepEqual(progress, [10, 60], 'only the active worker may publish progress');
assert.equal(budget.activeCount, 0, 'a successful replacement request must also release its budget');

const disposeRequest = transcribeWithLeases(
  { ...request, requestId: 'dispose-active-0001' },
  () => assert.fail('disposed requests must not publish late progress'),
);
await secondWorker.waitForRequestCount(2);
service.dispose();
await assert.rejects(disposeRequest, /native ASR service is disposed/);
assert.equal(secondWorker.killCount, 1, 'dispose must terminate the active utility process');
assert.equal(budget.activeCount, 0, 'dispose must release active request budget through terminal rejection');
assert.equal(forceKillTasks.length, 2, 'a thrown graceful kill must still schedule force termination');
assert.equal(forceKillTasks[1]?.delayMs, 250);
forceKillTasks[1]?.callback();
assert.deepEqual(forcedPids, [101, 202]);
secondWorker.emit('exit', 9);
assert.equal(forceKillTasks[1]?.canceled, true, 'forced worker retirement ends only on exit');
await assert.rejects(
  service.transcribe({ ...request, requestId: 'after-dispose-0001' }),
  /native ASR service is disposed/,
);
assert.equal(workers.length, 2, 'a disposed service must never create another worker');

const timeoutWorkers: FakeWorker[] = [];
const timeoutWorkerWaiters = new Map<number, () => void>();
const timeoutForceKillTasks: ScheduledForceKill[] = [];
const timeoutForcedPids: number[] = [];
const timeoutService = new NativeAsrService(serviceOptions, {
  inspectModel: async () => ({ downloaded: true, bytes: 1 }),
  createWorker: () => {
    const worker = new FakeWorker(timeoutWorkers.length === 0 ? 303 : 404, 'refuse');
    timeoutWorkers.push(worker);
    for (const [target, resolve] of timeoutWorkerWaiters) {
      if (timeoutWorkers.length < target) continue;
      timeoutWorkerWaiters.delete(target);
      resolve();
    }
    return asUtilityProcess(worker);
  },
  resolveSourcePath: () => '/verified/timeout-source.wav',
  scheduleForceKill: (callback, delayMs) => {
    const task = { callback, delayMs, canceled: false };
    timeoutForceKillTasks.push(task);
    return () => { task.canceled = true; };
  },
  forceKillProcess: (pid) => timeoutForcedPids.push(pid),
});
const timeoutBudget = new NativeInferenceBudget();
const timeoutResidency = new NativeInferenceResidency(100);
const timeoutProgress: number[] = [];
let timeoutBudgetReleases = 0;
let timeoutResidencyReleases = 0;

function waitForTimeoutWorkerCount(count: number): Promise<void> {
  if (timeoutWorkers.length >= count) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  timeoutWorkerWaiters.set(count, resolve);
  return promise;
}

async function transcribeTimeoutAttempt() {
  timeoutBudget.claim(11, requestId, 0);
  const releaseResidency = timeoutResidency.claim('asr', 60, () => {});
  try {
    return await timeoutService.transcribe(request, (value) => {
      if (value.progress !== undefined) timeoutProgress.push(value.progress);
    });
  } finally {
    releaseResidency();
    timeoutResidencyReleases += 1;
    timeoutBudget.release(requestId);
    timeoutBudgetReleases += 1;
  }
}

const timedOutRequest = transcribeTimeoutAttempt();
await waitForTimeoutWorkerCount(1);
const timedOutWorker = timeoutWorkers[0];
assert.ok(timedOutWorker);
await timedOutWorker.waitForRequestCount(1);
timedOutWorker.send({ type: 'progress', progress: { requestId, progress: 5 } });
timedOutWorker.send({
  type: 'fatal',
  reason: 'model-load-timeout',
  requestId,
  message: 'typed fatal model-load deadline',
});
await assert.rejects(timedOutRequest, /typed fatal model-load deadline/);
assert.equal(timedOutWorker.killCount, 1, 'model-load timeout must retire its utility process');
assert.equal(timeoutForceKillTasks.length, 1, 'model-load timeout must schedule force termination');
assert.equal(timeoutForceKillTasks[0]?.delayMs, 250);
assert.equal(timeoutBudget.activeCount, 0, 'model-load timeout must release request budget');
assert.equal(timeoutBudgetReleases, 1, 'timed-out request budget must settle exactly once');
assert.equal(timeoutResidencyReleases, 1, 'timed-out request residency must settle exactly once');
const timeoutEvictions: string[] = [];
const releaseTimeoutSemantic = timeoutResidency.claim(
  'semantic',
  60,
  (kind) => timeoutEvictions.push(kind),
);
assert.deepEqual(timeoutEvictions, ['asr'], 'timed-out request must leave ASR residency idle');
releaseTimeoutSemantic();
timeoutResidency.clear();
timeoutForceKillTasks[0]?.callback();
assert.deepEqual(timeoutForcedPids, [303], 'timed-out utility PID must be force-killed after grace');

const timeoutRetry = transcribeTimeoutAttempt();
await waitForTimeoutWorkerCount(2);
const timeoutRetryWorker = timeoutWorkers[1];
assert.ok(timeoutRetryWorker);
await timeoutRetryWorker.waitForRequestCount(1);
assert.equal(timeoutWorkers.length, 2, 'retry must create exactly one fresh utility process');
assert.equal(timeoutRetryWorker.pid, 404, 'retry must use a fresh utility PID');
assert.equal(timedOutWorker.requestCount, 1, 'retry must never post work to the timed-out utility process');
timedOutWorker.send({ type: 'progress', progress: { requestId, progress: 99 } });
timedOutWorker.send({
  type: 'result',
  response: { requestId, backend: 'native-cpu', text: 'stale timeout result', chunks: [] },
});
const retryTurn = Promise.withResolvers<boolean>();
setImmediate(() => retryTurn.resolve(false));
const retrySettledByOldPid = await Promise.race([
  timeoutRetry.then(
    () => true,
    () => true,
  ),
  retryTurn.promise,
]);
assert.equal(retrySettledByOldPid, false, 'timed-out PID must not satisfy the retry');
timedOutWorker.emit('exit', 9);
assert.equal(timeoutForceKillTasks[0]?.canceled, true);
timeoutRetryWorker.send({ type: 'progress', progress: { requestId, progress: 50 } });
timeoutRetryWorker.send({
  type: 'result',
  response: { requestId, backend: 'native-cpu', text: 'fresh timeout retry', chunks: [] },
});
const timeoutRetryResult = await timeoutRetry;
assert.equal(timeoutRetryResult.text, 'fresh timeout retry');
assert.deepEqual(timeoutProgress, [5, 50], 'retired timeout worker must not publish late progress');
assert.equal(timeoutBudget.activeCount, 0);
assert.equal(timeoutBudgetReleases, 2, 'each timeout attempt must settle budget once');
assert.equal(timeoutResidencyReleases, 2, 'each timeout attempt must settle residency once');

console.log('native-asr-service.verify: cancel, fatal timeout retirement, worker isolation, and lease release OK');
