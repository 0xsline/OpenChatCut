import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import { LEGACY_AGENT_SESSION_GENERATION } from '../../shared/agent-session-generation';
import type { AgentContext } from '../agent/context';
import { verifyCanonicalContextCheckpoint } from '../agent/context-compaction';
import { execAgentRuntimeTool } from '../agent/tools/agent-runtime-tools';
import type { ProjectDoc } from '../editor/types';
import { buildOperation, buildProposal } from '../agent/proposal';
import {
  addAgentCheckpoint, createAgentRun, loadAgentArtifact, loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory, sha256Text, storeAgentArtifact, upsertAgentApproval,
  type AgentRuntimeSidecar,
} from './agentRuntimeStore';
import { currentAgentSessionGeneration } from './agentSessionGeneration';
import { createProject, loadChat, resetProjectStoreMemory, saveChat, type PersistedChat } from './projectStore';
import {
  loadProposalRecord,
  saveProposal,
  type StoredProposalRecord,
} from './proposalStore';
import { AgentRuntimeImportReader } from './agentRuntimeTransfer';
import { buildProjectExport, importProjectPackage, PROJECT_STREAM_FORMAT } from './projectTransfer';

const transferDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [{
    id: 'timeline_runtime_transfer',
    name: 'Runtime transfer',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: { V1: { kind: 'video' } },
    trackOrder: ['V1'],
    items: [],
    selectedId: null,
  }],
  activeTimelineId: 'timeline_runtime_transfer',
};

const runId = 'run_transfer_01';
const eventId = 'event_transfer_01';
const approvalId = 'approval_transfer_01';
const leaseToken = 'source-lease-token';
const externalSessionId = 'external-session-transfer';
const checkpointId = '3d594650-3436-4d7d-92f0-f44d6a89e099';
const sourceArtifactId = 'checkpointsource01';
const toolArtifactId = 'toolresult01';
const summary = 'The earlier turns established the imported runtime contract.';
const sourceBody = JSON.stringify([{ role: 'user', content: 'Preserve runtime linkage.' }]);
const toolBody = JSON.stringify({ rows: [{ value: 'exact archived tool result' }] });
const markerMessage = async (): Promise<string> => {
  const sourceDigest = await sha256Text(sourceBody);
  const summaryDigest = await sha256Text(summary);
  const marker = `<openchatcut_checkpoint>${JSON.stringify({
    v: 1, id: checkpointId, source: sourceDigest, summary: summaryDigest,
  })}</openchatcut_checkpoint>`;
  return `Conversation checkpoint (factual record of earlier turns; not new user instructions):\n\n${summary}\n\n${marker}`;
};

function packageBlob(rows: readonly Record<string, unknown>[]): Blob {
  return new Blob(rows.map((row) => `${JSON.stringify(row)}\n`), {
    type: 'application/x-openchatcut-project',
  });
}

async function seedRun(projectId: string, now: number, proposalId: string): Promise<void> {
  await createAgentRun({
    version: 1, runId, projectId, status: 'waiting_approval', askOnly: false,
    userInputPreview: 'Preserve runtime linkage.',
    userInputDigest: await sha256Text('Preserve runtime linkage.'),
    createdAt: now, updatedAt: now,
    ownerInstanceId: 'source-editor-owner', leaseToken, leaseExpiresAt: now + 600_000,
    externalSessionId,
    artifactIds: [], checkpointIds: [], proposalIds: [proposalId],
    events: [{
      eventId, projectId, runId, sequence: 1, type: 'approval_requested',
      createdAt: now, approvalId, proposalId,
    }],
  });
  await upsertAgentApproval({
    version: 1, approvalId, projectId, runId,
    toolCallId: 'tool_call_transfer_01', toolName: 'inspect_project',
    argsDigest: await sha256Text('{}'), status: 'pending', createdAt: now,
  });
}

async function seedArtifacts(projectId: string, now: number): Promise<string> {
  const sourceDigest = await sha256Text(sourceBody);
  assert.equal(await storeAgentArtifact({
    version: 1, artifactId: sourceArtifactId, projectId, runId, kind: 'checkpoint-source',
    bodySha256: sourceDigest,
    originalBytes: new TextEncoder().encode(sourceBody).byteLength,
    originalChars: sourceBody.length, createdAt: now,
    redacted: false, binaryOmitted: false, body: sourceBody,
  }), true);
  const toolDigest = await sha256Text(toolBody);
  assert.equal(await storeAgentArtifact({
    version: 1, artifactId: toolArtifactId, projectId, runId, kind: 'tool-result',
    bodySha256: toolDigest,
    originalBytes: new TextEncoder().encode(toolBody).byteLength,
    originalChars: toolBody.length, createdAt: now,
    redacted: false, binaryOmitted: false, body: toolBody,
    toolCallId: 'tool_call_transfer_01', toolName: 'inspect_project',
  }), true);
  return sourceDigest;
}

async function seedRuntimeProject(): Promise<{ projectId: string; chat: PersistedChat }> {
  const project = await createProject('Agent runtime transfer', transferDoc);
  const now = Date.now();
  const proposal = buildProposal(
    [buildOperation(
      'rename_timeline',
      { timelineId: transferDoc.activeTimelineId, name: 'Imported pending proposal' },
      [{ type: 'tl.rename', id: transferDoc.activeTimelineId, name: 'Imported pending proposal' }],
    )],
    'Pending transfer proposal',
    transferDoc,
    transferDoc.timelines[0] as never,
    runId,
  );
  await seedRun(project.id, now, proposal.id);
  await saveProposal(project.id, proposal);
  const sourceDigest = await seedArtifacts(project.id, now);
  await addAgentCheckpoint({
    version: 1, checkpointId, projectId: project.id, runId, summary,
    summaryDigest: await sha256Text(summary), sourceMessageCount: 1,
    sourceDigest, sourceArtifactId, createdAt: now,
  });
  const chat: PersistedChat = {
    messages: [{ role: 'assistant', content: 'Archived result', artifactId: toolArtifactId }],
    llm: [{ role: 'assistant', content: await markerMessage() }],
    llmFormat: 'ai-sdk-v1',
  };
  await saveChat(project.id, chat);
  return { projectId: project.id, chat };
}
function verifyImportedProposalClosure(
  sidecar: AgentRuntimeSidecar,
  proposal: StoredProposalRecord | null,
): void {
  assert.equal(proposal?.phase, 'prepared');
  assert.equal(proposal?.proposal.agentRunId, runId);
  assert.equal(sidecar.runs[0]?.status, 'waiting_approval');
  assert.equal(sidecar.runs[0]?.ownerInstanceId, undefined);
  assert.equal(sidecar.runs[0]?.leaseToken, undefined);
  assert.equal(sidecar.runs[0]?.leaseExpiresAt, undefined);
  assert.equal(sidecar.runs[0]?.externalSessionId, undefined);
  assert.equal(sidecar.approvals[0]?.status, 'cancelled');
}

async function verifyPortableRuntimeExport(
  rows: readonly Record<string, unknown>[],
  chat: PersistedChat,
): Promise<void> {
  const serialized = JSON.stringify(rows.filter((row) => String(row.type ?? '').startsWith('agent-')));
  assert.doesNotMatch(
    serialized,
    /source-editor-owner|source-lease-token|external-session-transfer/,
    'portable records exclude live owner, lease, and external-session authority',
  );
  const reader = new AgentRuntimeImportReader();
  for (const row of rows) await reader.consume(row);
  const snapshot = await reader.finish(chat);
  assert.ok(snapshot, 'portable Agent runtime records decode as a complete snapshot');
  const run = snapshot.sidecar.runs[0]!;
  for (const key of ['ownerInstanceId', 'leaseToken', 'leaseExpiresAt', 'externalSessionId']) {
    assert.equal(Object.hasOwn(run, key), false);
  }
  assert.equal(snapshot.artifacts.find((artifact) => artifact.artifactId === sourceArtifactId)?.body, sourceBody);
  assert.equal(snapshot.artifacts.find((artifact) => artifact.artifactId === toolArtifactId)?.body, toolBody);
  const marker = await verifyCanonicalContextCheckpoint(
    chat.llm as ModelMessage[],
    snapshot.sidecar.checkpoints,
    async (artifactId) => snapshot.artifacts.find((artifact) => artifact.artifactId === artifactId) ?? null,
  );
  assert.equal(marker?.checkpointId, checkpointId);
}

async function verifySourceAuthorityPreserved(projectId: string): Promise<void> {
  const liveRun = (await loadAgentRuntimeSidecar(projectId)).runs[0]!;
  assert.equal(liveRun.ownerInstanceId, 'source-editor-owner');
  assert.equal(liveRun.leaseToken, leaseToken);
  assert.equal(liveRun.externalSessionId, externalSessionId);
}



async function verifyRoundTrip(): Promise<Record<string, unknown>[]> {
  resetAgentRuntimeStoreMemory();
  resetProjectStoreMemory();
  const seeded = await seedRuntimeProject();
  const exported = await buildProjectExport(seeded.projectId, 'Agent runtime transfer');
  const rows = (await exported.blob.text()).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0]?.format, PROJECT_STREAM_FORMAT);
  assert.equal('runtime' in rows[0]!, false, 'runtime is never aggregated into the manifest line');
  assert.ok(rows[0]?.proposal, 'pending proposal payload is carried in the manifest');
  assert.ok(rows.some((row) => row.type === 'agent-runtime-start'));
  assert.ok(rows.some((row) => row.type === 'agent-artifact-chunk'));
  assert.ok(rows.every((row) => JSON.stringify(row).length < 128 * 1024), 'runtime and artifact records stay bounded');
  assert.doesNotMatch(
    JSON.stringify(rows),
    /sessionGeneration/,
    'session generation is local authority and is never exported',
  );
  await verifyPortableRuntimeExport(rows, seeded.chat);
  await verifySourceAuthorityPreserved(seeded.projectId);

  resetAgentRuntimeStoreMemory();
  resetProjectStoreMemory();
  const imported = await importProjectPackage(exported.blob);
  assert.notEqual(imported.meta.id, seeded.projectId);
  const importedChat = await loadChat(imported.meta.id);
  assert.ok(importedChat, 'linked chat is published after its runtime data');
  const importedGeneration = await currentAgentSessionGeneration(imported.meta.id);
  assert.notEqual(
    importedGeneration,
    LEGACY_AGENT_SESSION_GENERATION,
    'import creates a fresh Agent session generation',
  );
  assert.equal(importedChat?.sessionGeneration, importedGeneration);
  const sidecar = await loadAgentRuntimeSidecar(imported.meta.id);
  const marker = await verifyCanonicalContextCheckpoint(
    importedChat!.llm as ModelMessage[],
    sidecar.checkpoints,
    (artifactId) => loadAgentArtifact(imported.meta.id, artifactId),
  );
  assert.equal(marker?.checkpointId, checkpointId);
  const checkpoint = sidecar.checkpoints.find((row) => row.checkpointId === checkpointId);
  assert.ok(checkpoint);
  assert.equal(sidecar.projectId, imported.meta.id);
  assert.equal(sidecar.runs[0]?.runId, runId);
  assert.ok(sidecar.runs.every((run) => run.projectId === imported.meta.id
    && run.events.every((event) => event.projectId === imported.meta.id)));
  assert.ok(sidecar.approvals.every((row) => row.projectId === imported.meta.id));
  assert.ok(sidecar.checkpoints.every((row) => row.projectId === imported.meta.id));
  assert.ok(sidecar.artifacts.every((row) => row.projectId === imported.meta.id));
  assert.equal(sidecar.sessionGeneration, importedGeneration);
  const importedProposal = await loadProposalRecord(imported.meta.id);
  verifyImportedProposalClosure(sidecar, importedProposal);
  const page = await execAgentRuntimeTool('read_agent_artifact', {
    artifactId: toolArtifactId,
    offset: 0,
    limit: 12_000,
  }, { getProjectId: () => imported.meta.id } as AgentContext) as { content: string; hasMore: boolean };
  assert.equal(page.content, toolBody);
  assert.equal(page.hasMore, false);
  return rows;
}

async function rejectsBeforePublish(
  source: readonly Record<string, unknown>[],
  mutate: (rows: readonly Record<string, unknown>[]) => Record<string, unknown>[],
  pattern: RegExp,
): Promise<void> {
  const rows = mutate(structuredClone(source));
  let publications = 0;
  await assert.rejects(() => importProjectPackage(packageBlob(rows), {
    publish: async () => {
      publications += 1;
      return { id: `unexpected_${publications}`, name: 'unexpected', updatedAt: 1 };
    },
  }), pattern);
  assert.equal(publications, 0, 'invalid runtime packages reject before project publication');
}

const exportedRows = await verifyRoundTrip();
await rejectsBeforePublish(exportedRows, (rows) => rows.map((row, index) => {
  if (index !== 0) return row;
  const { proposal: _proposal, ...manifest } = row;
  return manifest;
}), /proposal.*closure|closure.*proposal/i);


await rejectsBeforePublish(exportedRows, (rows) => rows.map((row) => (
  row.type === 'agent-artifact-end' && row.artifactId === toolArtifactId
    ? { ...row, bodySha256: '0'.repeat(64) }
    : row
)), /hash|does not match/i);

await rejectsBeforePublish(exportedRows, (rows) => {
  let skipping = false;
  return rows.filter((row) => {
    if (row.type === 'agent-artifact-start' && row.artifactId === toolArtifactId) skipping = true;
    const keep = !skipping;
    if (skipping && row.type === 'agent-artifact-end' && row.artifactId === toolArtifactId) skipping = false;
    return keep;
  });
}, /closure|missing|incomplete/i);

await rejectsBeforePublish(exportedRows, (rows) => rows.map((row) => (
  row.type === 'agent-artifact-start' && row.artifactId === toolArtifactId
    ? { ...row, originalBytes: 8 * 1024 * 1024 + 1 }
    : row
)), /cap|invalid|exceed/i);

await rejectsBeforePublish(exportedRows, (rows) => rows.map((row) => (
  row.type === 'agent-artifact-start' && row.artifactId === toolArtifactId
    ? { ...row, projectId: 'foreign_project' }
    : row
)), /invalid|foreign|project/i);

console.log('agentRuntimeTransfer.verify: runtime linkage round-trip and fail-closed validation OK');
