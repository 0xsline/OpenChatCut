import assert from 'node:assert/strict';
import type { AgentContext } from './context';
import type { AgentSettings } from './settings/agentSettings';
import type { RuntimeGuardRequest } from './runtime-guard';
import type { GuardDecision } from './skills/costGuard';
import { TOOL_SCHEMAS } from './tools';
import {
  assertValidAgentToolSchemas,
  policyForTool,
  validateAgentToolInvocation,
} from './execution-policy';
import { sanitizeJsonForArtifact } from './runtime-artifact';
import {
  loadAgentRuntimeSidecar,
  resetAgentRuntimeStoreMemory,
} from '../persist/agentRuntimeStore';
import {
  resumeAgentRun,
  startAgentRun,
  type AgentRunRecorder,
  type ToolOutcomeInput,
} from './runtime-ledger';
import { ExternalSessionRunLedger } from './external-run-ledger';
import { executeOpenChatCutTool, type CodexToolExecution } from './codex/runtime';
import type { AgentToolSchema } from './tool-schema';
import { computeAgentRequestShapeFingerprint } from './runtime';
import type { Proposal } from './proposal';
import { isFailedToolResult } from './toolFailure';
import { verifyArtifactAndCheckpointScenarios } from './harness-runtime-artifacts.verify-helper';

const projectId = 'harness-runtime-verify';
const aspectSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'set_aspect_ratio')!;
const installSkillSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'install_skill')!;
const ctx = {
  getProjectId: () => projectId,
  getState: () => ({ items: [], transitions: [] }),
} as unknown as AgentContext;
const settings = {} as AgentSettings;

function fakeRecorder(log: string[], failure?: 'requested'): AgentRunRecorder {
  return {
    recordToolRequested: async () => {
      log.push('requested');
      if (failure === 'requested') throw new Error('durability unavailable');
      return { argsDigest: 'a'.repeat(64) };
    },
    recordApprovalRequested: async () => {
      log.push('approval-requested');
      return { approvalId: 'approval-1' };
    },
    recordApprovalDecision: async () => { log.push('approval-decided'); },
    recordToolStarted: async () => { log.push('started'); },
    recordToolOutcome: async (input: ToolOutcomeInput) => { log.push(`outcome:${input.outcome.kind}`); },
    archiveToolResult: async () => null,
  } as unknown as AgentRunRecorder;
}

async function executeWithRecorder(
  recorder: AgentRunRecorder,
  log: string[],
  executeTool: () => Promise<unknown>,
  guard: RuntimeGuardRequest | null = null,
  decision: GuardDecision = 'allow-once',
) {
  return executeOpenChatCutTool(aspectSchema, { ratio: '9:16' }, {
    ctx, settings, runRecorder: recorder, toolCallId: 'call-1',
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [aspectSchema],
    onEvent: () => undefined,
    resolveGuard: async () => guard,
    onSkillGuard: async () => { log.push('ui-decision'); return decision; },
    executeTool: async () => executeTool(),
  });
}

async function executeInstallSkill(
  log: string[],
  executeTool: () => Promise<unknown>,
  onSkillGuard?: (guard: RuntimeGuardRequest) => Promise<GuardDecision>,
): Promise<CodexToolExecution> {
  return executeOpenChatCutTool(installSkillSchema, { repo: 'owner/skill' }, {
    ctx, settings, runRecorder: fakeRecorder(log), toolCallId: crypto.randomUUID(),
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [installSkillSchema],
    onEvent: () => undefined,
    resolveGuard: async () => null,
    onSkillGuard,
    executeTool: async () => executeTool(),
  });
}

function verifyPoliciesAndSchemas(): void {
  assertValidAgentToolSchemas(TOOL_SCHEMAS);
  for (const schema of TOOL_SCHEMAS) assert.ok(policyForTool(schema.name));
  assert.equal(policyForTool('read_agent_artifact').effect, 'read');
  assert.equal(policyForTool('submit_render_job').recovery, 'outcome_unknown');
  assert.equal(validateAgentToolInvocation(aspectSchema, { ratio: 'invalid' }, [aspectSchema]).ok, false);
  assert.equal(validateAgentToolInvocation(aspectSchema, { ratio: '9:16' }, []).ok, false);
  const uriSchema: AgentToolSchema = {
    name: 'uri_check', description: 'verify formats',
    input_schema: {
      type: 'object', properties: { url: { type: 'string', format: 'uri' } },
      required: ['url'], additionalProperties: false,
    },
  };
  assert.equal(validateAgentToolInvocation(uriSchema, { url: 'not a uri' }, [uriSchema]).ok, false);
  assert.throws(() => assertValidAgentToolSchemas([{
    name: 'broken', description: 'broken', input_schema: { type: 'not-a-json-type' },
  } as unknown as AgentToolSchema]), /Malformed JSON schema/);
}

function verifySecretProjectionFixtures(): void {
  const secrets = [
    'userinfo-name', 'userinfo-password', 'oauth-access-secret', 'oauth-refresh-secret',
    'goog-algorithm-secret', 'goog-credential-secret', 'goog-signature-secret',
    'azure-signature-secret', 'azure-expiry-secret', 'azure-permissions-secret',
  ];
  const sanitized = sanitizeJsonForArtifact({
    userinfo: 'https://userinfo-name:userinfo-password@example.test/private',
    oauth: 'https://example.test/callback?access_token=oauth-access-secret#refresh_token=oauth-refresh-secret',
    google: 'https://storage.example.test/file?X-Goog-Algorithm=goog-algorithm-secret&X-Goog-Credential=goog-credential-secret&X-Goog-Signature=goog-signature-secret',
    azure: 'https://blob.example.test/file?sv=azure-version&sp=azure-permissions-secret&se=azure-expiry-secret&sr=b&sig=azure-signature-secret',
  });
  assert.ok(sanitized?.redacted);
  assert.doesNotMatch(sanitized!.body, new RegExp(secrets.join('|')));
  const projected = JSON.parse(sanitized!.body) as Record<string, string>;
  const userinfo = new URL(projected.userinfo!);
  assert.equal(userinfo.username, '');
  assert.equal(userinfo.password, '');
  const oauth = new URL(projected.oauth!);
  assert.equal(oauth.searchParams.get('access_token'), '[REDACTED]');
  assert.equal(new URLSearchParams(oauth.hash.slice(1)).get('refresh_token'), '[REDACTED]');
  const google = new URL(projected.google!);
  assert.equal(google.searchParams.get('X-Goog-Algorithm'), '[REDACTED]');
  assert.equal(google.searchParams.get('X-Goog-Credential'), '[REDACTED]');
  assert.equal(google.searchParams.get('X-Goog-Signature'), '[REDACTED]');
  const azure = new URL(projected.azure!);
  for (const key of ['sv', 'sp', 'se', 'sr', 'sig']) {
    assert.equal(azure.searchParams.get(key), '[REDACTED]');
  }
}


async function verifyDurableBoundary(): Promise<void> {
  const ordered: string[] = [];
  await executeWithRecorder(fakeRecorder(ordered), ordered, async () => {
    ordered.push('side-effect');
    return { ok: true };
  });
  assert.deepEqual(ordered, ['requested', 'started', 'side-effect', 'outcome:success']);
  const closed: string[] = [];
  let mutated = false;
  const failed = await executeWithRecorder(fakeRecorder(closed, 'requested'), closed, async () => {
    mutated = true;
    return { ok: true };
  });
  assert.equal(failed.success, false);
  assert.equal(mutated, false, 'durability failure must precede side effects');
  const guarded: RuntimeGuardRequest = {
    skill: 'image-gen', tool: aspectSchema.name, summary: 'guarded request',
  };
  const denied: string[] = [];
  await executeWithRecorder(fakeRecorder(denied), denied, async () => {
    throw new Error('denied tool must not execute');
  }, guarded, 'deny');
  assert.deepEqual(denied, [
    'requested', 'approval-requested', 'ui-decision', 'approval-decided', 'outcome:denied',
  ]);
  const ambiguous: string[] = [];
  const unknown = await executeWithRecorder(fakeRecorder(ambiguous), ambiguous, async () => {
    throw new Error('connection lost after provider accepted request');
  }, guarded);
  assert.equal(unknown.success, false);
  assert.equal(ambiguous.at(-1), 'outcome:outcome_unknown');
}

async function verifyGenericApprovalBoundary(): Promise<void> {
  let executions = 0;
  const missing: string[] = [];
  const missingResult = await executeInstallSkill(missing, async () => {
    executions += 1;
    return { ok: true };
  });
  const missingOutput = missingResult.result;
  assert.equal(
    !!missingOutput && typeof missingOutput === 'object'
      && 'denied' in missingOutput && missingOutput.denied === true,
    true,
  );
  assert.equal(executions, 0, 'persistent local tools fail closed without an approval UI');

  const denied: string[] = [];
  await executeInstallSkill(denied, async () => {
    executions += 1;
    return { ok: true };
  }, async (guard) => {
    assert.equal(guard.permissionKind, 'persistent_local');
    assert.equal(guard.approval, 'once');
    return 'deny';
  });
  assert.equal(executions, 0, 'denial blocks install_skill before dispatch');

  let approvals = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await executeInstallSkill([], async () => {
      executions += 1;
      return { ok: true };
    }, async () => {
      approvals += 1;
      return 'allow-once';
    });
  }
  assert.equal(executions, 2);
  assert.equal(approvals, 2, 'allow-once is requested again instead of becoming remembered permission');
}

async function verifyAbortFence(): Promise<void> {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<unknown>();
  const ordered: string[] = [];
  let projectedToDocument = false;
  const pending = executeOpenChatCutTool(aspectSchema, { ratio: '9:16' }, {
    ctx, settings, runRecorder: fakeRecorder(ordered), signal: controller.signal,
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [aspectSchema],
    onEvent: (event) => {
      if (event.type === 'tool' && !isFailedToolResult(event.result)) projectedToDocument = true;
    },
    resolveGuard: async () => null,
    executeTool: async () => {
      entered.resolve();
      return slow.promise;
    },
  });
  await entered.promise;
  controller.abort();
  slow.resolve({ ok: true });
  const result = await pending;
  assert.equal(result.success, false);
  assert.equal(projectedToDocument, false, 'a stopped slow tool cannot project returned draft actions');
  assert.equal(ordered.at(-1), 'outcome:outcome_unknown');
}

async function verifyArtifactFailureFence(): Promise<void> {
  const oversizedMarker = `RAW-${'x'.repeat(20_000)}`;
  const oversized = await executeWithRecorder(fakeRecorder([]), [], async () => ({
    payload: oversizedMarker,
  }));
  assert.equal(oversized.success, false);
  assert.doesNotMatch(JSON.stringify(oversized.result), /RAW-/,
    'archive refusal returns a bounded error instead of the raw oversized result');

  const circular: Record<string, unknown> = { payload: 'CIRCULAR-RAW' };
  circular.self = circular;
  const unserializable = await executeWithRecorder(fakeRecorder([]), [], async () => circular);
  assert.equal(unserializable.success, false);
  assert.doesNotMatch(JSON.stringify(unserializable.result), /CIRCULAR-RAW/,
    'serialization/digest failure cannot project the raw tool result');
}
async function verifyRequestShapeFingerprint(): Promise<void> {
  const base = { backend: 'api', modelId: 'same-model', checkpointId: 'same-checkpoint' };
  const first = await computeAgentRequestShapeFingerprint({
    ...base, system: 'prompt-A', schemas: [{ name: 'tool', description: 'schema-A' }],
  });
  const systemChanged = await computeAgentRequestShapeFingerprint({
    ...base, system: 'prompt-B', schemas: [{ name: 'tool', description: 'schema-A' }],
  });
  const schemaChanged = await computeAgentRequestShapeFingerprint({
    ...base, system: 'prompt-A', schemas: [{ name: 'tool', description: 'schema-B' }],
  });
  assert.notEqual(first.requestShapeHash, systemChanged.requestShapeHash);
  assert.notEqual(first.requestShapeHash, schemaChanged.requestShapeHash);
  assert.equal(first.systemTokens, systemChanged.systemTokens);
  assert.equal(first.toolSchemaChars, schemaChanged.toolSchemaChars);
}
async function recordUsageSamples(
  recorder: Awaited<ReturnType<typeof startAgentRun>>,
): Promise<void> {
  const shared = {
    modelId: 'same-model',
    systemDigest: 'c'.repeat(64),
    systemTokens: 120,
    historyTokens: 2_000,
    activeToolCount: 4,
    toolSchemaCount: 4,
  };
  await recorder.recordContextUsage({
    ...shared,
    requestShapeHash: 'a'.repeat(64),
    toolSchemaDigest: 'd'.repeat(64),
    toolSchemaChars: 800,
    inputTokens: 2_500,
    outputTokens: 300,
    reasoningTokens: 125,
    cacheReadTokens: 1_700,
    cacheWriteTokens: 80,
    noCacheTokens: 800,
  });
  await recorder.recordContextUsage({
    ...shared,
    requestShapeHash: 'b'.repeat(64),
    toolSchemaDigest: 'e'.repeat(64),
    toolSchemaChars: 600,
    inputTokens: 1_000,
    outputTokens: 50,
    noCacheTokens: 1_000,
    retryCount: 1,
    mediaInputCount: 2,
    mediaTokenEstimate: 2_400,
  });
}
async function verifyActualUsagePersistence(): Promise<void> {
  const recorder = await startAgentRun({
    projectId,
    userInput: 'persist provider usage',
    askOnly: true,
  });
  await recordUsageSamples(recorder);
  await recorder.finalize('completed', 'usage persisted');
  const saved = (await loadAgentRuntimeSidecar(projectId)).runs
    .find((run) => run.runId === recorder.runId);
  assert.equal(saved?.context?.modelRequestCount, 2);
  assert.equal(saved?.context?.totalInputTokens, 3_500);
  assert.equal(saved?.context?.totalFreshInputTokens, 1_880);
  assert.equal(saved?.context?.totalCacheReadTokens, 1_700);
  assert.equal(saved?.context?.totalOutputTokens, 350);
  assert.equal(saved?.context?.totalRetryCount, 1);
  assert.equal(saved?.context?.totalMediaInputs, 2);
  assert.equal(saved?.context?.cacheMissReason, 'tool_surface_changed');
  assert.deepEqual(
    saved?.events.findLast((event) => event.type === 'context_usage')?.context,
    saved?.context,
    'the latest usage event retains the run aggregate and request snapshot',
  );
}
async function verifyExternalSkillProjection(): Promise<void> {
  const root = '# Exact\ncredential-like text stays live: token=visible-to-model';
  const payload = {
    skill: 'fixture',
    file: 'SKILL.md',
    files: ['SKILL.md'],
    contents: { 'SKILL.md': root },
    omittedFiles: [],
    dependencyCheck: [],
    offset: 0,
    nextOffset: null,
    totalChars: root.length,
  };
  const ledger = await ExternalSessionRunLedger.start(
    projectId,
    'external-verifier',
    'external-load-skill',
    'external-connected',
    async () => payload,
  );
  const invocation = await ledger.requested('load_skill', { name: 'fixture' });
  const result = await ledger.executeApprovedTool(invocation, { name: 'fixture' }, ctx);
  assert.deepEqual(result, payload, 'connected load_skill receives the same exact page as local runtimes');
  await ledger.finalize('completed', 'external load_skill completed');
  const run = (await loadAgentRuntimeSidecar(projectId)).runs
    .find((candidate) => candidate.runId === ledger.runId);
  assert.deepEqual(run?.artifactIds, [],
    'external load_skill pages are not force-archived or replaced by placeholders');
  await ledger.disconnect();
}



async function verifyProposalTerminalFence(): Promise<void> {
  const recorder = await startAgentRun({ projectId, userInput: 'proposal', askOnly: false });
  const proposal: Pick<Required<Proposal>, 'id' | 'agentRunId'> = {
    id: 'proposal-1',
    agentRunId: recorder.runId,
  };
  assert.notEqual(proposal.id, proposal.agentRunId);
  await recorder.recordProposal(proposal.id, 'created');
  await recorder.finalize('waiting_approval');
  assert.equal(await resumeAgentRun(projectId, recorder.runId), recorder,
    'proposal settlement reuses the live recorder that owns the review lease');
  let run = (await loadAgentRuntimeSidecar(projectId)).runs.find((item) => item.runId === recorder.runId)!;
  assert.deepEqual(run.proposalIds, [proposal.id]);
  assert.equal(run.events.find((event) => event.type === 'proposal_created')?.proposalId, proposal.id);
  assert.equal(proposal.agentRunId, run.runId);
  assert.equal(run.events.filter((event) => event.type === 'final').length, 0);
  await recorder.recordProposal(proposal.id, 'applied');
  run = (await loadAgentRuntimeSidecar(projectId)).runs.find((item) => item.runId === recorder.runId)!;
  assert.equal(run.events.find((event) => event.type === 'proposal_applied')?.proposalId, proposal.id);
  assert.equal(run.events.filter((event) => event.type === 'final').length, 0);
  await recorder.finalize('completed');
  run = (await loadAgentRuntimeSidecar(projectId)).runs.find((item) => item.runId === recorder.runId)!;
  await recorder.finalize('completed', 'duplicate terminal callback');
  run = (await loadAgentRuntimeSidecar(projectId)).runs.find((item) => item.runId === recorder.runId)!;
  assert.equal(run.events.filter((event) => event.type === 'final').length, 1);
}



async function verifyYoloSkipsAllGuards(): Promise<void> {
  const log: string[] = [];
  const yoloCtx = {
    getProjectId: () => projectId,
    getState: () => ({ items: [], transitions: [] }),
    getApprovalMode: () => 'auto' as const,
  } as unknown as AgentContext;
  const execution = await executeOpenChatCutTool(aspectSchema, { ratio: '9:16' }, {
    ctx: yoloCtx, settings, runRecorder: fakeRecorder(log), toolCallId: 'yolo-1',
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [aspectSchema],
    onEvent: () => undefined,
    resolveGuard: async () => ({
      skill: 'high-cost-operation', tool: aspectSchema.name, summary: 'paid op',
      permissionKind: 'persistent_local', approval: 'always',
    }),
    onSkillGuard: async () => { log.push('ui-decision'); return 'deny'; },
    executeTool: async () => { log.push('executed'); return { ok: true }; },
  });
  assert.equal(execution.success, true, 'YOLO mode executes a guarded (paid) tool');
  assert.equal(log.includes('ui-decision'), false, 'YOLO mode never shows the confirmation card');
  assert.equal(log.includes('executed'), true, 'the guarded tool actually ran');
}

resetAgentRuntimeStoreMemory();
verifyPoliciesAndSchemas();
verifySecretProjectionFixtures();
assert.equal(sanitizeJsonForArtifact({ tokenCount: 4, accessToken: 'secret' })?.redacted, true);
await verifyDurableBoundary();
await verifyGenericApprovalBoundary();
await verifyAbortFence();
await verifyArtifactFailureFence();
await verifyRequestShapeFingerprint();
await verifyActualUsagePersistence();
await verifyProposalTerminalFence();
await verifyExternalSkillProjection();
await verifyArtifactAndCheckpointScenarios();
await verifyYoloSkipsAllGuards();
console.log('harness runtime verification passed');
