import assert from 'node:assert/strict';
import type { AgentContext } from './context';
import type { AgentSettings } from './settings/agentSettings';
import { TOOL_SCHEMAS } from './tools';
import {
  effectiveToolInvocationArgs,
  policyForTool,
} from './execution-policy';
import { executeOpenChatCutTool } from './codex/runtime';
import {
  digestAgentToolArgs, startAgentRun, type AgentRunRecorder,
} from './runtime-ledger';
import { isExternalDraftTool, isExternalRealTool } from './external-tool-policy';
import { ExternalApprovalGate } from './external-approval-gate';
import { formatToolApprovalDetails } from './approval-details';
import { loadAgentRuntimeSidecar, purgeAgentRuntime } from '../persist/agentRuntimeStore';

const transcribeSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'transcribe_track')!;
const designSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'manage_design_style')!;
const ctx = {
  getProjectId: () => 'policy-verify',
  getState: () => ({ items: [], transitions: [] }),
} as unknown as AgentContext;
const settings = {} as AgentSettings;

function recorder(log: string[]): AgentRunRecorder {
  return {
    recordToolRequested: async () => {
      log.push('requested');
      return { argsDigest: 'd'.repeat(64) };
    },
    recordToolStarted: async () => { log.push('started'); },
    recordToolOutcome: async () => { log.push('outcome:success'); },
    finalize: async () => undefined,
  } as unknown as AgentRunRecorder;
}

async function executeDesign(
  args: Record<string, unknown>,
  log: string[],
  runRecorder?: AgentRunRecorder,
) {
  return executeOpenChatCutTool(designSchema, args, {
    ctx, settings, runRecorder, toolCallId: crypto.randomUUID(),
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [designSchema], onEvent: () => undefined,
    executeTool: async () => { log.push('global-mutation'); return { ok: true }; },
  });
}

function verifyPoliciesAndDetails(): void {
  assert.equal(policyForTool('manage_design_style', { action: 'list' }).effect, 'read');
  assert.equal(policyForTool('manage_design_style', { action: 'apply' }).effect, 'reversible_edit');
  assert.equal(policyForTool('manage_design_style', { action: 'clear' }).recovery, 'idempotent');
  assert.equal(policyForTool('manage_design_style', { action: 'update' }).effect, 'reversible_edit');
  assert.equal(policyForTool('manage_design_style', { action: 'save' }).effect, 'persistent_local');
  assert.equal(policyForTool('manage_design_style', { action: 'update', presetId: 'owned' }).effect, 'persistent_local');
  assert.equal(policyForTool('manage_design_style', { action: 'delete' }).effect, 'persistent_local');
  assert.equal(policyForTool('manage_design_style', { action: 'update', presetId: '  ' }).effect, 'reversible_edit');
  assert.equal(isExternalDraftTool('manage_design_style'), true);
  assert.equal(isExternalRealTool('manage_design_style', { action: 'list' }), false);
  assert.equal(isExternalRealTool('manage_design_style', { action: 'save' }), true);
  assert.equal(policyForTool('run_code').effect, 'irreversible_external');
  assert.equal(policyForTool('run_code').recovery, 'outcome_unknown');
  assert.equal(policyForTool('submit_export').recovery, 'outcome_unknown');
  assert.equal(policyForTool('read_timeline').effect, 'read');
  assert.equal(policyForTool('read_timeline').recovery, 'pure');
}

function installTranscriptionProviderStorage(): Record<string, string> {
  const saved: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved[key] ?? null,
      setItem: (key: string, value: string) => { saved[key] = value; },
    },
  });
  return saved;
}

async function verifyExplicitTranscriptionProviders(): Promise<void> {
  const paidArgs = effectiveToolInvocationArgs('transcribe_track', {
    track: 'A2',
    provider: 'openai',
  });
  assert.deepEqual(paidArgs, { track: 'A2', provider: 'openai' });
  assert.deepEqual(policyForTool('transcribe_track', paidArgs), {
    effect: 'irreversible_external',
    recovery: 'outcome_unknown',
  });

  const localArgs = effectiveToolInvocationArgs('transcribe_track', {
    track: 'A2',
    provider: 'local',
  });
  assert.deepEqual(policyForTool('transcribe_track', localArgs), {
    effect: 'reversible_edit',
    recovery: 'idempotent',
  });
  let dispatchedLocalArgs: Record<string, unknown> | undefined;
  await executeOpenChatCutTool(transcribeSchema, { track: 'A2', provider: 'local' }, {
    ctx,
    settings,
    toolCatalog: TOOL_SCHEMAS,
    activeToolCatalog: [transcribeSchema],
    onEvent: () => undefined,
    executeTool: async (_name, invocationArgs) => {
      dispatchedLocalArgs = invocationArgs;
      return { ok: true };
    },
  });
  assert.deepEqual(
    dispatchedLocalArgs,
    localArgs,
    'explicit local override is the exact invocation dispatched under a cloud saved setting',
  );
  assert.notEqual(
    await digestAgentToolArgs(paidArgs),
    await digestAgentToolArgs(localArgs),
    'digest identity binds the effective provider with the exact arguments',
  );
}

async function verifySettingBackedTranscriptionProvider(saved: Record<string, string>): Promise<void> {
  saved['cc.transcriptionProvider'] = 'assemblyai';
  const settingBackedArgs = effectiveToolInvocationArgs('transcribe_track', { track: 'A2' });
  assert.deepEqual(
    settingBackedArgs,
    { track: 'A2', provider: 'assemblyai' },
    'saved provider is materialized into the effective invocation before execution',
  );
  let recordedArgs: Record<string, unknown> | undefined;
  const runtimeRecorder = {
    recordToolRequested: async (input: { args: Record<string, unknown> }) => {
      recordedArgs = input.args;
      return { argsDigest: await digestAgentToolArgs(input.args) };
    },
    recordToolOutcome: async () => undefined,
  } as unknown as AgentRunRecorder;
  await executeOpenChatCutTool(transcribeSchema, { track: 'A2' }, {
    ctx,
    settings,
    runRecorder: runtimeRecorder,
    toolCatalog: TOOL_SCHEMAS,
    activeToolCatalog: [transcribeSchema],
    onEvent: () => undefined,
    executeTool: async () => ({ ok: true }),
  });
  assert.deepEqual(recordedArgs, settingBackedArgs);
}

async function verifyTranscriptionProviderBinding(): Promise<void> {
  const saved = installTranscriptionProviderStorage();
  await verifyExplicitTranscriptionProviders();
  await verifySettingBackedTranscriptionProvider(saved);
}

async function verifySecretIdentityAndRedactedLog(): Promise<void> {
  const firstSecret = { accessToken: 'first-secret-value' };
  const secondSecret = { accessToken: 'second-secret-value' };
  assert.notEqual(
    await digestAgentToolArgs(firstSecret),
    await digestAgentToolArgs(secondSecret),
    'redacted-equivalent secrets remain distinct approval identities',
  );
  const firstUrl = { url: 'https://cdn.test/file?X-Amz-Signature=first-signed-value' };
  const secondUrl = { url: 'https://cdn.test/file?X-Amz-Signature=second-signed-value' };
  assert.notEqual(
    await digestAgentToolArgs(firstUrl),
    await digestAgentToolArgs(secondUrl),
    'redacted-equivalent signed URLs remain distinct approval identities',
  );
  const projectId = 'approval-digest-redaction-verify';
  await purgeAgentRuntime(projectId);
  try {
    const run = await startAgentRun({ projectId, userInput: 'digest privacy check', askOnly: false });
    const recorded = await run.recordToolRequested({
      toolCallId: 'secret-call', toolName: 'run_code', args: firstSecret,
    });
    await run.finalize('completed');
    const stored = await loadAgentRuntimeSidecar(projectId);
    const serialized = JSON.stringify(stored);
    const persistedRun = stored.runs.find((candidate) => candidate.runId === run.runId);
    const requested = persistedRun?.events.find((event) => event.type === 'tool_requested');
    assert.equal(requested?.argsDigest, recorded.argsDigest);
    assert.doesNotMatch(serialized, /first-secret-value|second-secret-value|first-signed-value|second-signed-value/);
  } finally {
    await purgeAgentRuntime(projectId);
  }
}

async function verifyExternalApprovalBinding(): Promise<void> {
  const gate = new ExternalApprovalGate();
  const args = { command: 'rm -rf /workspace/output', outputs: ['/workspace/output'] };
  const argsDigest = await digestAgentToolArgs(args);
  const presentation = formatToolApprovalDetails('run_code', args);
  const pending = await gate.request({
    sessionId: 'session', runId: 'run', toolCallId: 'call', tool: 'run_code',
    argsDigest, operationId: 'operation-1',
    summary: presentation.summary, details: presentation.details,
  }, async () => 'guard-1');
  assert.equal(pending.argsDigest, argsDigest);
  assert.match(pending.details[0]?.value ?? '', /rm -rf/);
  await gate.resolve('guard-1', true, async () => undefined);
  assert.equal(await gate.consume({
    sessionId: 'session', runId: 'run', tool: 'run_code', args, operationId: 'operation-2',
  }), null, 'approval cannot cross operation ids');
  assert.equal((await gate.consume({
    sessionId: 'session', runId: 'run', tool: 'run_code', args, operationId: 'operation-1',
  }))?.guardId, 'guard-1');
}

async function verifyDirectExecution(): Promise<void> {
  // No approval gate: every tool runs straight through, including
  // persistent-local design mutations.
  for (const action of ['save', 'list', 'apply', 'clear']) {
    const log: string[] = [];
    await executeDesign({ action, name: 'Global' }, log, recorder(log));
    assert.deepEqual(log, [
      'requested', 'started', 'global-mutation', 'outcome:success',
    ], `${action} executes without a confirmation card`);
  }
}

verifyPoliciesAndDetails();
await verifyTranscriptionProviderBinding();
await verifySecretIdentityAndRedactedLog();
await verifyExternalApprovalBinding();
await verifyDirectExecution();
console.log('execution policy verifier passed');
