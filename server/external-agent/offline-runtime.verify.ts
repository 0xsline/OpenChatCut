import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import {
  revisionOf,
  type ExternalDraftCheckpoint,
} from '../../src/agent/external-edit-session.ts';
import { isExternalServerDirectCall } from '../../src/agent/external-tool-policy.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import { ExternalEditorCallError } from './broker.ts';
import { OfflineExternalEditRuntime, type OfflineEditPersistence } from './offline-runtime.ts';
import { offlineExternalToolSchemas } from './offline-tools.ts';
import { executeOfflineTool } from './offline-executor.ts';
import type {
  OfflineCheckpointSaveInput,
  OfflineProjectCommitInput,
  OfflineStoredProject,
} from './offline-project-store.ts';

const projectId = 'offline-project';
const editorUrl = `http://localhost:5173/#/editor/${projectId}`;

function projectDoc(width = 1920, height = 1080): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width,
      height,
      items: [],
      selectedId: null,
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
    }],
  };
}

class MemoryPersistence implements OfflineEditPersistence {
  current: ProjectDoc;
  versions: ProjectDoc[] = [];
  commitCount = 0;
  checkpoint: ExternalDraftCheckpoint | null = null;

  constructor(doc: ProjectDoc) {
    this.current = structuredClone(doc);
  }

  async loadProject(id: string): Promise<OfflineStoredProject | null> {
    if (id !== projectId) return null;
    const doc = structuredClone(this.current);
    return { projectId: id, doc, revision: revisionOf(doc) };
  }
  async loadCheckpoint(
    id: string,
    expectedRevision: string,
  ): Promise<ExternalDraftCheckpoint | null> {
    if (id !== projectId || this.checkpoint?.baseRevision !== expectedRevision) return null;
    return structuredClone(this.checkpoint);
  }

  async saveCheckpoint(input: OfflineCheckpointSaveInput) {
    if (input.projectId !== projectId || revisionOf(this.current) !== input.expectedRevision) {
      return 'stale' as const;
    }
    if (!input.canSave()) return 'browser-takeover' as const;
    this.checkpoint = structuredClone(input.checkpoint);
    if (input.canSave()) return 'saved' as const;
    this.checkpoint = null;
    return 'browser-takeover' as const;
  }

  async deleteCheckpoint(id: string, sessionId: string): Promise<void> {
    if (id === projectId && this.checkpoint?.sessionId === sessionId) this.checkpoint = null;
  }

  async commitProject(input: OfflineProjectCommitInput) {
    if (!input.canCommit()) return { status: 'browser-takeover' as const };
    if (revisionOf(this.current) !== input.expectedRevision) return { status: 'stale' as const };
    this.versions.push(structuredClone(this.current));
    this.current = structuredClone(input.doc);
    this.commitCount += 1;
    return { status: 'applied' as const, revision: revisionOf(this.current), automaticVersionCreated: true };
  }
}

function editSessionId(value: unknown): string {
  assert(value && typeof value === 'object' && 'editSessionId' in value);
  const id = value.editSessionId;
  assert.equal(typeof id, 'string');
  return id;
}

const toolNames = new Set(offlineExternalToolSchemas().map((tool) => tool.name));
for (const allowed of ['begin_edit_session', 'read_timeline', 'read_project', 'read_transcript', 'read_captions', 'set_aspect_ratio', 'edit_captions', 'update_watermark']) {
  assert.equal(toolNames.has(allowed), true, `${allowed} is server-direct`);
}
for (const excluded of ['edit_item', 'manage_effects', 'view_timeline_frames', 'submit_image', 'import_media', 'download_media', 'manage_versions', 'submit_render_job']) {
  assert.equal(toolNames.has(excluded), false, `${excluded} requires the browser editor`);
}
for (const action of ['template', 'style', 'layout', 'display_text', 'source_set', 'language_mode']) {
  assert.equal(isExternalServerDirectCall('edit_captions', { action }), true, `${action} stays server-direct`);
}

const persistence = new MemoryPersistence(projectDoc());
const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence,
  isBrowserConnected: () => false,
});
assert.equal(runtime.binding().mode, 'offline');
await assert.rejects(
  () => runtime.execute('begin_edit_session', { approvalMode: 'manual' }),
  (error) => error instanceof ExternalEditorCallError
    && error.outcome === 'rejected'
    && error.message.includes(editorUrl),
);
assert.equal(persistence.commitCount, 0);

const begun = await runtime.execute('begin_edit_session', { approvalMode: 'auto', clientName: 'External editor' });
const sessionId = editSessionId(begun);
for (const action of ['preset_apply', 'preset_delete', 'preset_list', 'preset_rename', 'preset_save']) {
  await assert.rejects(
    () => runtime.execute('edit_captions', { editSessionId: sessionId, action }),
    (error) => error instanceof ExternalEditorCallError
      && error.outcome === 'rejected'
      && error.message.includes('browser-backed'),
  );
}
const untouchedSession = await runtime.execute('get_edit_session', { editSessionId: sessionId });
assert(untouchedSession && typeof untouchedSession === 'object' && 'operationCount' in untouchedSession);
assert.equal(untouchedSession.operationCount, 0);
assert.deepEqual(persistence.current, projectDoc());
assert.equal(persistence.commitCount, 0);
const read = await runtime.execute('read_timeline', { editSessionId: sessionId });
assert(read && typeof read === 'object');
await assert.rejects(
  () => runtime.execute('submit_render_job', { editSessionId: sessionId }),
  (error) => error instanceof ExternalEditorCallError && error.outcome === 'rejected',
);
await runtime.execute('set_aspect_ratio', { editSessionId: sessionId, ratio: '9:16', fit: 'contain' });
assert(persistence.checkpoint, 'each successful offline mutation persists a draft checkpoint');
const applied = await runtime.execute('review_edit_session', { editSessionId: sessionId, summary: 'Vertical cut' });
assert(applied && typeof applied === 'object' && 'status' in applied);
assert.equal(applied.status, 'applied');
assert.equal(persistence.current.timelines[0].width, 1080);
assert.equal(persistence.current.timelines[0].height, 1920);
assert.equal(persistence.versions.length, 1);
assert.deepEqual(persistence.versions[0], projectDoc());
assert.equal(persistence.checkpoint, null, 'applied sessions remove their draft checkpoint');

const resumeStore = new MemoryPersistence(projectDoc());
const interruptedRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: resumeStore,
  isBrowserConnected: () => false,
});
const interruptedId = editSessionId(
  await interruptedRuntime.execute('begin_edit_session', { approvalMode: 'auto' }),
);
await interruptedRuntime.execute('set_aspect_ratio', {
  editSessionId: interruptedId,
  ratio: '9:16',
});
interruptedRuntime.dispose();
assert.deepEqual(resumeStore.current, projectDoc(), 'checkpointing does not publish an unreviewed draft');
const resumedRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: resumeStore,
  isBrowserConnected: () => false,
});
const resumed = await resumedRuntime.execute('begin_edit_session', {
  approvalMode: 'auto',
  clientName: 'replacement transport',
});
assert.equal(editSessionId(resumed), interruptedId);
assert(resumed && typeof resumed === 'object' && 'resumed' in resumed);
assert.equal(resumed.resumed, true);
await resumedRuntime.execute('review_edit_session', { editSessionId: interruptedId });
assert.equal(resumeStore.current.timelines[0].width, 1080);
assert.equal(resumeStore.current.timelines[0].height, 1920);
assert.equal(resumeStore.checkpoint, null);

const concurrentStore = new MemoryPersistence(projectDoc());
const concurrentRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: concurrentStore,
  isBrowserConnected: () => false,
});
const concurrentId = editSessionId(
  await concurrentRuntime.execute('begin_edit_session', { approvalMode: 'auto' }),
);
const concurrentAspect = concurrentRuntime.execute('set_aspect_ratio', {
  editSessionId: concurrentId,
  ratio: '1:1',
  fit: 'contain',
});
const concurrentWatermark = concurrentRuntime.execute('update_watermark', {
  editSessionId: concurrentId,
  enabled: true,
  text: 'queued second',
  position: 'br',
});
await Promise.all([concurrentAspect, concurrentWatermark]);
const concurrentDraft = await concurrentRuntime.execute('get_edit_session', {
  editSessionId: concurrentId,
});
assert(concurrentDraft && typeof concurrentDraft === 'object' && 'operationCount' in concurrentDraft);
assert.equal(concurrentDraft.operationCount, 2, 'both queued mutations are captured');
await concurrentRuntime.execute('review_edit_session', { editSessionId: concurrentId });
assert.equal(concurrentStore.current.timelines[0].width, 1080);
assert.equal(concurrentStore.current.timelines[0].height, 1080);
assert.equal(concurrentStore.current.timelines[0].watermark?.text, 'queued second');
assert.equal(concurrentStore.current.timelines[0].watermark?.position, 'br');

const staleStore = new MemoryPersistence(projectDoc());
const staleRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: staleStore,
  isBrowserConnected: () => false,
});
const staleId = editSessionId(await staleRuntime.execute('begin_edit_session', { approvalMode: 'auto' }));
await staleRuntime.execute('set_aspect_ratio', { editSessionId: staleId, ratio: '9:16' });
staleStore.current = projectDoc(1280, 720);
await assert.rejects(
  () => staleRuntime.execute('review_edit_session', { editSessionId: staleId }),
  (error) => error instanceof ExternalEditorCallError && error.outcome === 'stale',
);
assert.equal(staleStore.commitCount, 0);
assert.equal(staleStore.current.timelines[0].width, 1280);

let browserConnected = false;
const takeoverStore = new MemoryPersistence(projectDoc());
const takeoverRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: takeoverStore,
  isBrowserConnected: () => browserConnected,
});
const takeoverId = editSessionId(await takeoverRuntime.execute('begin_edit_session', { approvalMode: 'auto' }));
await takeoverRuntime.execute('set_aspect_ratio', { editSessionId: takeoverId, ratio: '9:16' });
browserConnected = true;
await assert.rejects(
  () => takeoverRuntime.execute('review_edit_session', { editSessionId: takeoverId }),
  (error) => error instanceof ExternalEditorCallError && error.outcome === 'stale',
);
assert.equal(takeoverStore.commitCount, 0);
assert.deepEqual(takeoverStore.current, projectDoc());

let candidateBrowserConnected = false;
let signalCandidateStarted!: () => void;
let releaseCandidate!: () => void;
const candidateStarted = new Promise<void>((resolve) => { signalCandidateStarted = resolve; });
const candidateGate = new Promise<void>((resolve) => { releaseCandidate = resolve; });
const candidateStore = new MemoryPersistence(projectDoc());
const candidateRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: candidateStore,
  isBrowserConnected: () => candidateBrowserConnected,
  executeTool: async (name, args, context) => {
    signalCandidateStarted();
    await candidateGate;
    return executeOfflineTool(name, args, context);
  },
});
const candidateId = editSessionId(
  await candidateRuntime.execute('begin_edit_session', { approvalMode: 'auto' }),
);
const staleCandidate = candidateRuntime.execute('set_aspect_ratio', {
  editSessionId: candidateId,
  ratio: '9:16',
});
await candidateStarted;
candidateBrowserConnected = true;
releaseCandidate();
await assert.rejects(
  staleCandidate,
  (error) => error instanceof ExternalEditorCallError && error.outcome === 'stale',
);
candidateBrowserConnected = false;
const staleCandidateSession = await candidateRuntime.execute('get_edit_session', {
  editSessionId: candidateId,
});
assert(
  staleCandidateSession
    && typeof staleCandidateSession === 'object'
    && 'status' in staleCandidateSession
    && 'operationCount' in staleCandidateSession,
);
assert.equal(staleCandidateSession.status, 'stale');
assert.equal(staleCandidateSession.operationCount, 0, 'stale async candidate never replaces the newer terminal generation');
assert.deepEqual(candidateStore.current, projectDoc());

const cancelledStore = new MemoryPersistence(projectDoc());
const cancelledRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: cancelledStore,
  isBrowserConnected: () => false,
});
const cancelledId = editSessionId(await cancelledRuntime.execute('begin_edit_session', { approvalMode: 'auto' }));
await cancelledRuntime.execute('set_aspect_ratio', { editSessionId: cancelledId, ratio: '9:16' });
cancelledRuntime.dispose();
assert.equal(cancelledStore.commitCount, 0);
assert.deepEqual(cancelledStore.current, projectDoc(), 'transport expiry/cancellation never writes the draft');

const raceStore = new MemoryPersistence(projectDoc());
const raceRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: raceStore,
  isBrowserConnected: () => false,
});
const raceId = editSessionId(await raceRuntime.execute('begin_edit_session', { approvalMode: 'auto' }));
await raceRuntime.execute('set_aspect_ratio', { editSessionId: raceId, ratio: '9:16' });
const racingDiscard = raceRuntime.execute('discard_edit_session', { editSessionId: raceId });
const racingReview = raceRuntime.execute('review_edit_session', { editSessionId: raceId });
const [discardOutcome, reviewOutcome] = await Promise.allSettled([racingDiscard, racingReview]);
assert.equal(discardOutcome.status, 'fulfilled');
assert(
  discardOutcome.status === 'fulfilled'
    && discardOutcome.value
    && typeof discardOutcome.value === 'object'
    && 'status' in discardOutcome.value,
);
assert.equal(discardOutcome.value.status, 'cancelled');
assert.equal(reviewOutcome.status, 'rejected', 'review cannot apply after cancellation wins the queue');
const raceSession = await raceRuntime.execute('get_edit_session', { editSessionId: raceId });
assert(raceSession && typeof raceSession === 'object' && 'status' in raceSession);
assert.equal(raceSession.status, 'cancelled');
assert.equal(raceStore.commitCount, 0);
assert.deepEqual(raceStore.current, projectDoc());

let signalCommitStarted!: () => void;
let releaseCommit!: () => void;
const commitStarted = new Promise<void>((resolve) => { signalCommitStarted = resolve; });
const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
class DelayedMemoryPersistence extends MemoryPersistence {
  override async commitProject(input: OfflineProjectCommitInput) {
    signalCommitStarted();
    await commitGate;
    return super.commitProject(input);
  }
}
const expiringStore = new DelayedMemoryPersistence(projectDoc());
const expiringRuntime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
  persistence: expiringStore,
  isBrowserConnected: () => false,
});
const expiringId = editSessionId(await expiringRuntime.execute('begin_edit_session', { approvalMode: 'auto' }));
await expiringRuntime.execute('set_aspect_ratio', { editSessionId: expiringId, ratio: '9:16' });
const pendingReview = expiringRuntime.execute('review_edit_session', { editSessionId: expiringId });
await commitStarted;
expiringRuntime.dispose();
releaseCommit();
await assert.rejects(
  pendingReview,
  (error) => error instanceof ExternalEditorCallError && error.outcome === 'cancelled',
);
assert.equal(expiringStore.commitCount, 0);
assert.deepEqual(expiringStore.current, projectDoc(), 'expiry during commit cannot publish a partial draft');

console.log('offline-runtime.verify: ok');
