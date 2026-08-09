import assert from 'node:assert/strict';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  MAX_ARTIFACT_BYTES,
} from '../../src/persist/agentRuntimeStore.ts';
import { ExternalEditorCallError } from './broker.ts';
import { OfflineExternalEditRuntime } from './offline-runtime.ts';
import { executeOfflineTool } from './offline-executor.ts';
import type { OfflineProjectCommitInput } from './offline-project-store.ts';
import {
  agentRunId,
  editorUrl,
  editSessionId,
  MemoryPersistence,
  projectDoc,
  projectId,
} from './offline-runtime.verify-fixtures.ts';

async function verifyExpiryBeforeCommit(): Promise<OfflineExternalEditRuntime> {
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
  const store = new DelayedMemoryPersistence(projectDoc());
  const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
    persistence: store,
    isBrowserConnected: () => false,
  });
  const id = editSessionId(await runtime.execute('begin_edit_session', { approvalMode: 'auto' }));
  await runtime.execute('set_aspect_ratio', { editSessionId: id, ratio: '9:16' });
  const pendingReview = runtime.execute('review_edit_session', { editSessionId: id });
  await commitStarted;
  runtime.dispose();
  releaseCommit();
  await assert.rejects(
    pendingReview,
    (error) => error instanceof ExternalEditorCallError && error.outcome === 'cancelled',
  );
  assert.equal(store.commitCount, 0);
  assert.deepEqual(store.current, projectDoc(), 'expiry during commit cannot publish a partial draft');
  return runtime;
}

async function verifyAppliedAfterDispose(): Promise<OfflineExternalEditRuntime> {
  let signalAppliedCommit!: () => void;
  let releaseAppliedResult!: () => void;
  const appliedCommit = new Promise<void>((resolve) => { signalAppliedCommit = resolve; });
  const appliedResultGate = new Promise<void>((resolve) => { releaseAppliedResult = resolve; });
  class AppliedThenDelayedPersistence extends MemoryPersistence {
    override async commitProject(input: OfflineProjectCommitInput) {
      const result = await super.commitProject(input);
      signalAppliedCommit();
      await appliedResultGate;
      return result;
    }
  }
  const store = new AppliedThenDelayedPersistence(projectDoc());
  const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
    persistence: store,
    isBrowserConnected: () => false,
  });
  const id = editSessionId(await runtime.execute('begin_edit_session', { approvalMode: 'auto' }));
  await runtime.execute('set_aspect_ratio', { editSessionId: id, ratio: '9:16' });
  const review = runtime.execute('review_edit_session', { editSessionId: id });
  await appliedCommit;
  runtime.dispose();
  releaseAppliedResult();
  const applied = await review;
  assert(applied && typeof applied === 'object' && 'status' in applied);
  assert.equal(
    applied.status,
    'applied',
    'transport disposal after the durable commit cannot relabel the operation cancelled',
  );
  assert.equal(store.commitCount, 1);
  assert.equal(store.current.timelines[0].width, 1080);
  return runtime;
}

interface ProjectedScenario {
  readonly runtime: OfflineExternalEditRuntime;
  readonly sessionId: string;
  readonly begin: unknown;
  readonly artifactId: string;
}

async function projectOversizedResult(): Promise<ProjectedScenario> {
  const oversizedPayload = 'recoverable-offline-result-'.repeat(1_000);
  const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
    persistence: new MemoryPersistence(projectDoc()),
    isBrowserConnected: () => false,
    executeTool: async (name, args, context) => name === 'read_timeline'
      ? { apiKey: 'must-not-cross-the-external-boundary', payload: oversizedPayload }
      : executeOfflineTool(name, args, context),
  });
  const begin = await runtime.execute('begin_edit_session', { approvalMode: 'auto' });
  const sessionId = editSessionId(begin);
  const result = await runtime.execute('read_timeline', { editSessionId: sessionId });
  assert(result && typeof result === 'object' && 'artifactId' in result);
  assert.ok(JSON.stringify(result).length <= 16_000);
  assert.doesNotMatch(JSON.stringify(result), /must-not-cross/);
  return { runtime, sessionId, begin, artifactId: String(result.artifactId) };
}

async function verifyArtifactRecovery(scenario: ProjectedScenario): Promise<void> {
  const page = await scenario.runtime.execute('read_agent_artifact', {
    editSessionId: scenario.sessionId,
    artifactId: scenario.artifactId,
    pointer: '/payload',
    offset: 0,
    limit: 200,
  });
  assert(page && typeof page === 'object' && 'content' in page && typeof page.content === 'string');
  assert.match(page.content, /recoverable-offline-result/);
  assert.ok(JSON.stringify(page).length <= 16_000);
  const artifact = await loadAgentArtifact(projectId, scenario.artifactId);
  assert(artifact);
  assert.match(artifact.body, /recoverable-offline-result/);
  assert.doesNotMatch(artifact.body, /must-not-cross-the-external-boundary/);
  assert.match(artifact.body, /\[REDACTED\]/);
}

async function verifyProjectionLedger(scenario: ProjectedScenario): Promise<void> {
  const runId = agentRunId(scenario.begin);
  await scenario.runtime.execute('set_aspect_ratio', {
    editSessionId: scenario.sessionId,
    ratio: '9:16',
  });
  await scenario.runtime.execute('review_edit_session', { editSessionId: scenario.sessionId });
  const run = (await loadAgentRuntimeSidecar(projectId)).runs.find((row) => row.runId === runId);
  assert(run);
  assert.equal(
    run.events.find(
      (event) => event.type === 'tool_outcome'
        && event.outcome?.artifactId === scenario.artifactId,
    )?.outcome?.artifactId,
    scenario.artifactId,
    'the offline ledger and external reply retain the same recoverable artifact id',
  );
  const proposalEvents = run.events.filter((event) => event.proposalId);
  assert.deepEqual(proposalEvents.map((event) => event.type), ['proposal_created', 'proposal_applied']);
  assert.equal(proposalEvents[0]?.proposalId, proposalEvents[1]?.proposalId);
  assert.notEqual(
    proposalEvents[0]?.proposalId,
    runId,
    'offline proposal ledger events use Proposal.id rather than the run id',
  );
}

async function verifyArchiveFailure(): Promise<OfflineExternalEditRuntime> {
  const store = new MemoryPersistence(projectDoc());
  const runtime = await OfflineExternalEditRuntime.create(projectId, editorUrl, {
    persistence: store,
    isBrowserConnected: () => false,
    executeTool: async (name, args, context) => {
      await executeOfflineTool(name, args, context);
      return { payload: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) };
    },
  });
  const id = editSessionId(await runtime.execute('begin_edit_session', { approvalMode: 'auto' }));
  const checkpointed = await runtime.execute('set_aspect_ratio', {
    editSessionId: id,
    ratio: '9:16',
  });
  assert(checkpointed && typeof checkpointed === 'object' && 'status' in checkpointed);
  assert.equal(checkpointed.status, 'checkpointed');
  assert.match(String('warning' in checkpointed ? checkpointed.warning : ''), /do not retry/i);
  assert(store.checkpoint, 'archive failure after checkpoint remains a successful durable edit');
  return runtime;
}

export async function verifyOfflineCommitAndProjectionScenarios(): Promise<void> {
  const expiringRuntime = await verifyExpiryBeforeCommit();
  const appliedRuntime = await verifyAppliedAfterDispose();
  const projected = await projectOversizedResult();
  await verifyArtifactRecovery(projected);
  await verifyProjectionLedger(projected);
  const archiveFailureRuntime = await verifyArchiveFailure();
  for (const runtime of [expiringRuntime, appliedRuntime, projected.runtime, archiveFailureRuntime]) {
    runtime.dispose();
  }
}
