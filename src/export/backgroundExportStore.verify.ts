import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { CaptionsData } from '../captions/types';
import { createArtifactExporters } from './artifactExportOperations';
import type { ExportDestination } from './exportDestination';
import { createExportRunner } from './exportRunOperation';
import type {
  ExportProgress,
  ExportTab,
  UseExportWorkflowOptions,
  WorkflowOperations,
} from './exportWorkflowTypes';
import { createExportJobStore } from './backgroundExportStore';
import { notifyAgentExportSubmitted, subscribeAgentExportJobs } from './agentExportTracking';
interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}


function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

let now = 1_000;
const store = createExportJobStore(() => ++now);
const renderGate = deferred();
const finished = deferred();
let modalNotifications = 0;
const unmountModal = store.subscribe(() => { modalNotifications += 1; });

const jobId = store.start({
  label: 'project.mp4',
  targetPath: 'Exports/project.mp4',
  async execute({ setters }) {
    setters.setBusy('rendering');
    setters.setProgress((progress) => progress ? { ...progress, phase: 'rendering', percent: 25 } : progress);
    await renderGate.promise;
    setters.setProgress((progress) => progress ? {
      ...progress,
      phase: 'completed',
      percent: 100,
      finishedAt: now,
    } : progress);
    setters.setBusy(null);
    finished.resolve();
  },
});

let duplicateRuns = 0;
const duplicateId = store.start({
  label: 'project.mp4',
  targetPath: 'Exports/project.mp4',
  async execute() { duplicateRuns += 1; },
});
await Promise.resolve();
assert.equal(duplicateId, jobId, 'an active target reuses its existing export job');
assert.equal(duplicateRuns, 0, 'rapid duplicate starts do not launch a second render');

assert.equal(store.getSnapshot().jobs[0]?.id, jobId);
unmountModal();
const notificationsAtUnmount = modalNotifications;
renderGate.resolve();
await finished.promise;
const completed = store.getSnapshot().jobs.find((job) => job.id === jobId);
assert.equal(completed?.progress.phase, 'completed');
assert.equal(completed?.busy, null);
assert.equal(modalNotifications, notificationsAtUnmount, 'unmounted modal receives no updates');
assert.equal(store.getSnapshot().jobs.length, 1, 'job state belongs to the editor store, not the modal subscription');

const cancelled = deferred();
const cancelledId = store.start({
  label: 'cancelled.mp4',
  targetPath: 'Exports/cancelled.mp4',
  async execute({ signal, setters }) {
    try {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } finally {
      setters.setProgress((progress) => progress ? { ...progress, phase: 'rendering', percent: 90 } : progress);
      setters.setProgress((progress) => progress ? {
        ...progress,
        phase: 'completed',
        percent: 100,
        finishedAt: now,
      } : progress);
      setters.setBusy(null);
      cancelled.resolve();
    }
  },
});
await Promise.resolve();
assert.equal(store.cancel(cancelledId), true);
await cancelled.promise;
await Promise.resolve();
const cancelledJob = store.getSnapshot().jobs.find((job) => job.id === cancelledId);
assert.equal(cancelledJob?.progress.phase, 'cancelled');
assert.equal(cancelledJob?.busy, null, 'terminal jobs still permit busy cleanup');

const mgItem = {
  id: 'mg-1',
  name: 'Title',
  kind: 'text',
  startFrame: 0,
  durationInFrames: 30,
  props: { text: 'Title' },
} as unknown as TimelineItem;
const timelineState = {
  fps: 30,
  items: [],
  transitions: [],
  markers: [],
} as unknown as TimelineState;
const subtitleCaptions = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  words: [{ text: 'hello', start: 0, end: 500 }],
} satisfies CaptionsData;

function workflowOptions(tab: ExportTab): UseExportWorkflowOptions {
  return {
    state: timelineState,
    projectId: 'project-lifecycle',
    projectName: 'Lifecycle',
    base: `lifecycle-${tab}`,
    tab,
    codec: 'h264',
    resolution: '1080p',
    fps: 30,
    subtitleFormat: 'srt',
    subtitleCaptions,
    nleFormat: 'fcp_xml',
    includeMg: tab === 'xml',
    mgItems: tab === 'mg' || tab === 'xml' ? [mgItem] : [],
    onClose: () => undefined,
  };
}

function startArtifactExport(
  tab: Extract<ExportTab, 'mg' | 'subtitles' | 'xml'>,
  destination: ExportDestination,
  done: Deferred,
): string {
  const options = workflowOptions(tab);
  return store.start({
    label: `lifecycle-${tab}`,
    targetPath: `Exports/lifecycle-${tab}`,
    async execute({ signal, setters }) {
      const artifacts = createArtifactExporters({
        destination,
        beginTargetCommit: setters.beginTargetCommit,
        endTargetCommit: setters.endTargetCommit,
        markTargetCommitted: setters.markTargetCommitted,
        options,
        setBusy: setters.setBusy,
        setProgress: setters.setProgress,
        t: (key) => key,
      });
      const idle = async () => undefined;
      const operations: WorkflowOperations = {
        exportAudio: idle,
        exportMg: (ownerSignal) => artifacts.exportMg(ownerSignal),
        exportSubtitles: (ownerSignal) => artifacts.exportSubtitles(ownerSignal),
        exportVideo: idle,
        exportXml: (ownerSignal) => artifacts.exportXml(ownerSignal),
      };
      const run = createExportRunner({
        busy: null,
        operations,
        options,
        prepareDestination: async () => undefined,
        progress: null,
        signal,
        targetPath: `Exports/lifecycle-${tab}`,
        t: (key) => key,
        ...setters,
      });
      try {
        await run();
      } finally {
        done.resolve();
      }
    },
  });
}

function directoryDestination(
  queryPermission: () => Promise<'granted'>,
  onWrite: (value: Blob | BufferSource | string) => Promise<void>,
): ExportDestination {
  return {
    type: 'browser-directory',
    label: 'Exports',
    handle: {
      kind: 'directory',
      name: 'Exports',
      queryPermission,
      requestPermission: async () => 'granted',
      getFileHandle: async () => ({
        createWritable: async () => ({
          write: onWrite,
          close: async () => undefined,
        }),
      }),
    },
  };
}

async function verifyCancelledRenderedArtifact(
  tab: Extract<ExportTab, 'mg' | 'xml'>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const renderStarted = deferred();
  const done = deferred();
  let targetWrites = 0;
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), '/render-clip');
    renderStarted.resolve();
    const signal = init?.signal;
    assert.ok(signal);
    return await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const destination = directoryDestination(
      async () => 'granted',
      async () => { targetWrites += 1; },
    );
    const id = startArtifactExport(tab, destination, done);
    await renderStarted.promise;
    assert.equal(store.cancel(id), true);
    await done.promise;
    await Promise.resolve();
    const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
    assert.equal(targetWrites, 0, `${tab} cancellation must not write the target`);
    assert.equal(job?.progress.phase, 'cancelled');
    assert.notEqual(job?.progress.phase, 'completed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function verifyCancelledSubtitleArtifact(): Promise<void> {
  const permissionStarted = deferred();
  const permissionGate = deferred();
  const done = deferred();
  let targetWrites = 0;
  const destination = directoryDestination(
    async () => {
      permissionStarted.resolve();
      await permissionGate.promise;
      return 'granted';
    },
    async () => { targetWrites += 1; },
  );
  const id = startArtifactExport('subtitles', destination, done);
  await permissionStarted.promise;
  assert.equal(store.cancel(id), true);
  permissionGate.resolve();
  await done.promise;
  await Promise.resolve();
  const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
  assert.equal(targetWrites, 0, 'subtitle cancellation must not write the target');
  assert.equal(job?.progress.phase, 'cancelled');
  assert.notEqual(job?.progress.phase, 'completed');
}

async function verifyRunnerChecksAbortBeforeCompletion(): Promise<void> {
  const controller = new AbortController();
  const operationStarted = deferred();
  const operationGate = deferred();
  let progress: ExportProgress | null = null;
  const phases: ExportProgress['phase'][] = [];
  const setProgress = (value: ExportProgress | null | ((current: ExportProgress | null) => ExportProgress | null)) => {
    progress = typeof value === 'function' ? value(progress) : value;
    if (progress) phases.push(progress.phase);
  };
  const idle = async () => undefined;
  const operations: WorkflowOperations = {
    exportAudio: idle,
    exportMg: async () => {
      operationStarted.resolve();
      await operationGate.promise;
    },
    exportSubtitles: idle,
    exportVideo: idle,
    exportXml: idle,
  };
  const run = createExportRunner({
    busy: null,
    operations,
    options: workflowOptions('mg'),
    prepareDestination: async () => undefined,
    progress: null,
    signal: controller.signal,
    targetPath: 'Exports/lifecycle-mg',
    t: (key) => key,
    setBusy: () => undefined,
    setClock: () => undefined,
    setError: () => undefined,
    setFailure: () => undefined,
    setProgress,
    setQa: () => undefined,
  });
  const running = run();
  await operationStarted.promise;
  controller.abort(new DOMException('cancelled', 'AbortError'));
  operationGate.resolve();
  await running;
  assert.equal(phases.at(-1), 'cancelled');
  assert.equal(phases.includes('completed'), false, 'aborted work cannot report completed');
}

async function verifyCommittedTargetWinsLateAbort(): Promise<void> {
  const controller = new AbortController();
  const phases: ExportProgress['phase'][] = [];
  let progress: ExportProgress | null = null;
  const setProgress = (value: ExportProgress | null | ((current: ExportProgress | null) => ExportProgress | null)) => {
    progress = typeof value === 'function' ? value(progress) : value;
    if (progress) phases.push(progress.phase);
  };
  const committed = Object.freeze({ targetCommitted: true as const });
  const idle = async () => undefined;
  const operations: WorkflowOperations = {
    exportAudio: idle,
    exportMg: async () => {
      controller.abort(new DOMException('late cancellation', 'AbortError'));
      return committed;
    },
    exportSubtitles: idle,
    exportVideo: idle,
    exportXml: idle,
  };
  await createExportRunner({
    busy: null,
    operations,
    options: workflowOptions('mg'),
    prepareDestination: async () => undefined,
    progress: null,
    signal: controller.signal,
    targetPath: 'Exports/lifecycle-mg',
    t: (key) => key,
    setBusy: () => undefined,
    setClock: () => undefined,
    setError: () => undefined,
    setFailure: () => undefined,
    setProgress,
    setQa: () => undefined,
  })();
  assert.equal(phases.at(-1), 'completed', 'a committed target is never relabelled cancelled');
  assert.equal(phases.includes('cancelled'), false);
}

async function verifyNormalArtifactExport(): Promise<void> {
  const done = deferred();
  let targetWrites = 0;
  const destination = directoryDestination(
    async () => 'granted',
    async () => { targetWrites += 1; },
  );
  const id = startArtifactExport('subtitles', destination, done);
  await done.promise;
  await Promise.resolve();
  const job = store.getSnapshot().jobs.find((entry) => entry.id === id);
  assert.equal(targetWrites, 1);
  assert.equal(job?.progress.phase, 'completed');
}

async function verifyAgentExportTracking(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    const tracked = createExportJobStore();
    let finishRequest!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finishRequest = resolve; })) as typeof fetch;
    const unsubscribe = subscribeAgentExportJobs('project-agent', tracked, (key) => key);
    notifyAgentExportSubmitted({
      renderId: 'render-agent', projectId: 'project-agent', label: 'agent.mp4', createdAt: 1_000,
    });
    const completed = new Promise<void>((resolve) => {
      const stop = tracked.subscribe(() => {
        if (tracked.getSnapshot().jobs[0]?.progress.phase !== 'completed') return;
        stop();
        resolve();
      });
    });
    await Promise.resolve();
    assert.equal(tracked.getActiveCount(), 1);
    assert.equal(tracked.getSnapshot().jobs[0]?.label, 'agent.mp4');
    finishRequest(Response.json({
      id: 'render-agent', status: 'succeeded', progress: 100,
      result: { path: '/media/uploads/agent.mp4', name: 'agent.mp4', sizeBytes: 12 },
    }));
    await completed;
    assert.equal(tracked.getActiveCount(), 0);
    assert.equal(tracked.getSnapshot().jobs[0]?.progress.outputSize, 12);
    unsubscribe();

    let deleted = false;
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted = String(url).endsWith('/render-cancel');
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const unsubscribeCancel = subscribeAgentExportJobs('project-agent', tracked, (key) => key);
    notifyAgentExportSubmitted({
      renderId: 'render-cancel', projectId: 'project-agent', label: 'cancel.mp4', createdAt: 2_000,
    });
    await Promise.resolve();
    const jobId = tracked.getSnapshot().jobs.find((job) => job.label === 'cancel.mp4')?.id;
    assert.ok(jobId);
    assert.equal(tracked.cancel(jobId), true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(deleted, true);
    assert.equal(tracked.getSnapshot().jobs.find((job) => job.id === jobId)?.progress.phase, 'cancelled');
    unsubscribeCancel();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await verifyCancelledRenderedArtifact('mg');
await verifyCancelledRenderedArtifact('xml');
await verifyCancelledSubtitleArtifact();
await verifyRunnerChecksAbortBeforeCompletion();
await verifyCommittedTargetWinsLateAbort();
await verifyNormalArtifactExport();
await verifyAgentExportTracking();

console.log('background export store verification passed');
