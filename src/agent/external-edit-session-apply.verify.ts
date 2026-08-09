import assert from 'node:assert/strict';
import { makeDraft } from '../editor/store';
import { activeTimeline } from '../editor/types';
import { loadAgentRuntimeSidecar } from '../persist/agentRuntimeStore';
import { ExternalBridgeRuntime } from './external-bridge-runtime';
import {
  ExternalEditSessionOutcomeError,
  revisionOf,
} from './external-edit-session';
import {
  agentRunId,
  base,
  reviewed,
  reviewedWithRun,
  sessionStatus,
} from './external-edit-session-core.verify';
import { runtimeBinding } from './external-edit-session-runtime.verify';
const deferredApplyLive = makeDraft(base);
let deferredCommit: typeof base | null = null;
const deferredApplyRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: {
      ...deferredApplyLive.commands,
      applyDoc: (doc: typeof base) => {
        deferredCommit = doc;
      },
    },
    getState: deferredApplyLive.getState,
    getDoc: deferredApplyLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async () => ({
      projectId: 'runtime-project',
      revision: 1,
      epoch: 1,
      status: 'saved',
      saved: true,
      indexUpdated: true,
    }),
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await deferredApplyRuntime.hydrate(await reviewedWithRun('runtime-project'));
await deferredApplyRuntime.apply(new Set([0]));
assert(deferredCommit, 'the UI command receives the committed document');
deferredApplyLive.commands.applyDoc(deferredCommit);
const deferredApplyInfo = await deferredApplyRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(
  sessionStatus(deferredApplyInfo),
  'applied',
  'terminal reads survive a React-style deferred project state update',
);

const warningLive = makeDraft(base);
let warningSaveCount = 0;
const warningRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: warningLive.commands,
    getState: warningLive.getState,
    getDoc: warningLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async (projectId) => {
      warningSaveCount += 1;
      return {
        projectId,
        revision: warningSaveCount,
        epoch: 1,
        status: 'saved',
        saved: true,
        indexUpdated: false,
      };
    },
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await warningRuntime.hydrate(await reviewedWithRun('runtime-project'));
await warningRuntime.apply(new Set([0]));
assert.equal(warningSaveCount, 1, 'a successful document commit is applied exactly once');
assert.equal(activeTimeline(warningLive.getDoc()).width, 1080);
const warningInfo = await warningRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(warningInfo), 'applied');
assert(warningInfo && typeof warningInfo === 'object' && 'warning' in warningInfo);
assert.equal(
  warningInfo.warning,
  'The edit was applied, but the project list timestamp could not be updated.',
);
const repeatedWarningInfo = await warningRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(repeatedWarningInfo), 'applied');
assert.equal(warningSaveCount, 1, 'repeated terminal queries never replay the committed edit');

const failedSaveLive = makeDraft(base);
let failedSaveCount = 0;
const failedSaveRuntime = new ExternalBridgeRuntime(
  'runtime-project',
  'runtime-editor',
  () => ({
    commands: failedSaveLive.commands,
    getState: failedSaveLive.getState,
    getDoc: failedSaveLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'runtime-project',
  }),
  () => undefined,
  {
    saveProject: async (projectId) => {
      failedSaveCount += 1;
      return {
        projectId,
        revision: failedSaveCount,
        epoch: 1,
        status: 'failed',
        saved: false,
        indexUpdated: false,
        error: new Error('project save failed'),
      };
    },
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
await failedSaveRuntime.hydrate(await reviewedWithRun('runtime-project'));
await assert.rejects(
  failedSaveRuntime.apply(new Set([0])),
  (error: unknown) => (
    error instanceof ExternalEditSessionOutcomeError
    && error.outcome === 'failed'
  ),
);
assert.equal(failedSaveCount, 1);
assert.equal(
  activeTimeline(failedSaveLive.getDoc()).width,
  1920,
  'a failed document commit never reaches applyDoc',
);
const failedSaveInfo = await failedSaveRuntime.execute(
  'get_edit_session',
  { editSessionId: reviewed.id },
  runtimeBinding,
);
assert.equal(sessionStatus(failedSaveInfo), 'awaiting_review');

const proposalIdProject = 'proposal-id-project';
const proposalIdLive = makeDraft(base);
const proposalIdRuntime = new ExternalBridgeRuntime(
  proposalIdProject,
  'proposal-id-editor',
  () => ({
    commands: proposalIdLive.commands,
    getState: proposalIdLive.getState,
    getDoc: proposalIdLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => proposalIdProject,
  }),
  () => undefined,
  {
    saveProject: async (projectId) => ({
      projectId,
      revision: 1,
      epoch: 1,
      status: 'saved',
      saved: true,
      indexUpdated: true,
    }),
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async () => undefined,
  },
);
const proposalIdBinding = {
  projectId: proposalIdProject,
  editorInstanceId: 'proposal-id-editor',
  baseRevision: revisionOf(base),
};
const proposalIdBegin = await proposalIdRuntime.execute(
  'begin_edit_session',
  { approvalMode: 'auto' },
  proposalIdBinding,
);
const proposalIdSession = String(
  proposalIdBegin && typeof proposalIdBegin === 'object' && 'editSessionId' in proposalIdBegin
    ? proposalIdBegin.editSessionId
    : '',
);
const proposalRunId = agentRunId(proposalIdBegin);
await proposalIdRuntime.execute('set_aspect_ratio', {
  editSessionId: proposalIdSession,
  ratio: '9:16',
}, proposalIdBinding);
await proposalIdRuntime.execute('review_edit_session', {
  editSessionId: proposalIdSession,
}, proposalIdBinding);
const proposalRun = (await loadAgentRuntimeSidecar(proposalIdProject)).runs
  .find((run) => run.runId === proposalRunId);
assert(proposalRun);
const proposalEvents = proposalRun.events.filter((event) => event.proposalId);
assert.deepEqual(
  proposalEvents.map((event) => event.type),
  ['proposal_created', 'proposal_applied'],
);
assert.equal(proposalEvents[0]?.proposalId, proposalEvents[1]?.proposalId);
assert.notEqual(
  proposalEvents[0]?.proposalId,
  proposalRunId,
  'connected proposal ledger events use Proposal.id rather than runId/agentRunId',
);

let signalTerminalPublication!: () => void;
let releaseTerminalPublication!: () => void;
const terminalPublicationStarted = new Promise<void>((resolve) => {
  signalTerminalPublication = resolve;
});
const terminalPublicationGate = new Promise<void>((resolve) => {
  releaseTerminalPublication = resolve;
});
const committedRaceLive = makeDraft(base);
const committedRaceRuntime = new ExternalBridgeRuntime(
  'committed-race-project',
  'committed-race-editor',
  () => ({
    commands: committedRaceLive.commands,
    getState: committedRaceLive.getState,
    getDoc: committedRaceLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'committed-race-project',
  }),
  () => undefined,
  {
    saveProject: async (projectId) => ({
      projectId,
      revision: 1,
      epoch: 1,
      status: 'saved',
      saved: true,
      indexUpdated: true,
    }),
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async (_projectId, stored) => {
      if (stored.status === 'applied') {
        signalTerminalPublication();
        await terminalPublicationGate;
      }
    },
  },
);
await committedRaceRuntime.hydrate(await reviewedWithRun('committed-race-project'));
const committedRaceAbort = new AbortController();
const committedRaceApply = committedRaceRuntime.apply(
  new Set([0]),
  false,
  true,
  committedRaceAbort.signal,
);
await terminalPublicationStarted;
assert.equal(
  activeTimeline(committedRaceLive.getDoc()).width,
  1080,
  'the live EditorCommands transaction commits before terminal proposal publication',
);
committedRaceLive.commands.setAspect(1440, 1440, 'contain');
committedRaceAbort.abort('transport disposed after terminal publication started');
releaseTerminalPublication();
await committedRaceApply;
assert.equal(
  activeTimeline(committedRaceLive.getDoc()).width,
  1440,
  'a user edit during terminal publication remains newer than the applied proposal',
);

const concurrentLive = makeDraft(base);
const concurrentlySavedDocs: Array<typeof base> = [];
const concurrentProposalStatuses: string[] = [];
let concurrentStalePublished = false;
const concurrentApplyRuntime = new ExternalBridgeRuntime(
  'concurrent-apply-project',
  'concurrent-apply-editor',
  () => ({
    commands: concurrentLive.commands,
    getState: concurrentLive.getState,
    getDoc: concurrentLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => 'concurrent-apply-project',
  }),
  (snapshot) => {
    if (snapshot.stale) concurrentStalePublished = true;
  },
  {
    saveProject: async (projectId, doc) => {
      concurrentlySavedDocs.push(structuredClone(doc));
      if (concurrentlySavedDocs.length === 1) {
        concurrentLive.commands.setAspect(1440, 1440, 'contain');
      }
      return {
        projectId,
        revision: concurrentlySavedDocs.length,
        epoch: 1,
        status: 'saved',
        saved: true,
        indexUpdated: true,
      };
    },
    saveAutomaticVersion: async () => null,
    saveExternalProposal: async (_projectId, stored) => {
      concurrentProposalStatuses.push(stored.status);
    },
  },
);
await concurrentApplyRuntime.hydrate(await reviewedWithRun('concurrent-apply-project'));
await concurrentApplyRuntime.apply(new Set([0]));
assert.equal(concurrentlySavedDocs.length, 2);
assert.equal(activeTimeline(concurrentlySavedDocs[1]!).width, 1440);
assert.equal(activeTimeline(concurrentLive.getDoc()).width, 1440);
assert.equal(concurrentStalePublished, true);
assert.equal(
  concurrentProposalStatuses.includes('applied'),
  false,
  'a concurrent live edit is restored and leaves the proposal pending before terminal publication',
);
