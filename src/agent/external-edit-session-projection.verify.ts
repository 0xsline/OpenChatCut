import assert from 'node:assert/strict';
import { makeDraft } from '../editor/store';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
} from '../persist/agentRuntimeStore';
import { ExternalBridgeRuntime } from './external-bridge-runtime';
import { revisionOf } from './external-edit-session';
import { ExternalSessionRunLedger } from './external-run-ledger';
import { base } from './external-edit-session-core.verify';
const projectionLedger = await ExternalSessionRunLedger.start(
  'connected-projection-project',
  'connected projection verifier',
  'connected-projection-session',
);
const projectionInvocation = await projectionLedger.requested('read_project', {});
await projectionLedger.started(projectionInvocation);
const connectedPayload = 'recoverable-connected-result-'.repeat(1_000);
const connectedProjection = await projectionLedger.captureToolOutcome(
  projectionInvocation,
  { kind: 'success' },
  {
    authorization: 'Bearer must-not-cross-the-external-boundary',
    payload: connectedPayload,
  },
);
assert(
  connectedProjection
    && typeof connectedProjection === 'object'
    && 'artifactId' in connectedProjection,
);
assert.ok(JSON.stringify(connectedProjection).length <= 16_000);
assert.doesNotMatch(JSON.stringify(connectedProjection), /must-not-cross/);
const connectedArtifact = await loadAgentArtifact(
  'connected-projection-project',
  String(connectedProjection.artifactId),
);
assert(connectedArtifact);
const smallProjectionInvocation = await projectionLedger.requested('read_project', {});
await projectionLedger.started(smallProjectionInvocation);
const smallProjection = await projectionLedger.captureToolOutcome(
  smallProjectionInvocation,
  { kind: 'success' },
  { password: 'small-secret', ok: true },
);
assert.deepEqual(
  smallProjection,
  { password: '[REDACTED]', ok: true },
  'small connected results use the same redacted model projection',
);
assert.match(connectedArtifact.body, /recoverable-connected-result/);
assert.doesNotMatch(connectedArtifact.body, /must-not-cross-the-external-boundary/);
assert.match(connectedArtifact.body, /\[REDACTED\]/);
await projectionLedger.finalize('completed', 'Connected projection verifier completed.');

const projectedConnectedRun = (
  await loadAgentRuntimeSidecar('connected-projection-project')
).runs.find((run) => run.runId === projectionLedger.runId);
assert.equal(
  projectedConnectedRun?.events.find(
    (event) => event.toolCallId === projectionInvocation.toolCallId && event.type === 'tool_outcome',
  )?.outcome?.artifactId,
  String(connectedProjection.artifactId),
  'the connected ledger and external reply retain the same recoverable artifact id',
);
const connectedRuntimeProject = 'connected-runtime-projection-project';
const connectedRuntimeDoc = structuredClone(base);
connectedRuntimeDoc.timelines[0]!.name = 'connected-runtime-result-'.repeat(1_000);
const connectedRuntimeLive = makeDraft(connectedRuntimeDoc);
const connectedProjectionRuntime = new ExternalBridgeRuntime(
  connectedRuntimeProject,
  'connected-runtime-projection-editor',
  () => ({
    commands: connectedRuntimeLive.commands,
    getState: connectedRuntimeLive.getState,
    getDoc: connectedRuntimeLive.getDoc,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
    getProjectId: () => connectedRuntimeProject,
  }),
  () => undefined,
);
const connectedRuntimeBinding = {
  projectId: connectedRuntimeProject,
  editorInstanceId: 'connected-runtime-projection-editor',
  baseRevision: revisionOf(connectedRuntimeDoc),
};
const connectedRuntimeBegin = await connectedProjectionRuntime.execute(
  'begin_edit_session',
  {},
  connectedRuntimeBinding,
);
const connectedRuntimeSessionId = String(
  connectedRuntimeBegin
    && typeof connectedRuntimeBegin === 'object'
    && 'editSessionId' in connectedRuntimeBegin
    ? connectedRuntimeBegin.editSessionId
    : '',
);
const connectedRuntimeResult = await connectedProjectionRuntime.execute(
  'read_project',
  { editSessionId: connectedRuntimeSessionId },
  connectedRuntimeBinding,
);
assert(
  connectedRuntimeResult
    && typeof connectedRuntimeResult === 'object'
    && 'artifactId' in connectedRuntimeResult,
  'the connected runtime returns the ledger artifact projection rather than raw oversized output',
);
assert.ok(JSON.stringify(connectedRuntimeResult).length <= 16_000);
const connectedRuntimePage = await connectedProjectionRuntime.execute(
  'read_agent_artifact',
  {
    editSessionId: connectedRuntimeSessionId,
    artifactId: String(connectedRuntimeResult.artifactId),
    pointer: '/timelines/0/name',
    offset: 0,
    limit: 200,
  },
  connectedRuntimeBinding,
);
assert(
  connectedRuntimePage
    && typeof connectedRuntimePage === 'object'
    && 'content' in connectedRuntimePage
    && typeof connectedRuntimePage.content === 'string',
);
assert.match(connectedRuntimePage.content, /connected-runtime-result/);
await connectedProjectionRuntime.execute(
  'discard_edit_session',
  { editSessionId: connectedRuntimeSessionId },
  connectedRuntimeBinding,
);
