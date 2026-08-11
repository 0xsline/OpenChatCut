import assert from 'node:assert/strict';
import type { AgentContext } from './context';
import type { AgentSettings } from './settings/agentSettings';
import { TOOL_SCHEMAS } from './tools';
import {
  effectiveToolInvocationArgs,
  policyForTool,
  validateAgentToolInvocation,
} from './execution-policy';
import {
  guardRequestForPolicy,
  runtimeGuardForTool,
  type RuntimeGuardRequest,
} from './runtime-guard';
import { executeOpenChatCutTool } from './codex/runtime';
import {
  digestAgentToolArgs, startAgentRun, type AgentRunRecorder, type ToolOutcomeInput,
} from './runtime-ledger';
import { isExternalDraftTool, isExternalRealTool } from './external-tool-policy';
import { ExternalApprovalGate } from './external-approval-gate';
import { formatToolApprovalDetails } from './approval-details';
import { externalToolSchemas } from './external-tool-schemas';
import { loadAgentRuntimeSidecar, purgeAgentRuntime } from '../persist/agentRuntimeStore';

const runCodeSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'run_code')!;
const transcribeSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'transcribe_track')!;
const designSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'manage_design_style')!;
const ctx = {
  getProjectId: () => 'approval-policy-verify',
  getState: () => ({ items: [], transitions: [] }),
} as unknown as AgentContext;
const settings = {} as AgentSettings;

function recorder(log: string[]): AgentRunRecorder {
  return {
    recordToolRequested: async () => { log.push('requested'); return { argsDigest: 'd'.repeat(64) }; },
    recordApprovalRequested: async () => { log.push('approval-requested'); return { approvalId: 'approval-1' }; },
    recordApprovalDecision: async () => { log.push('approval-decided'); },
    recordToolStarted: async () => { log.push('started'); },
    recordToolOutcome: async (input: ToolOutcomeInput) => { log.push(`outcome:${input.outcome.kind}`); },
    archiveToolResult: async () => null,
  } as unknown as AgentRunRecorder;
}

async function executeDesign(
  args: Record<string, unknown>,
  log: string[],
  runRecorder?: AgentRunRecorder,
  onGuard?: (guard: RuntimeGuardRequest) => Promise<'allow-once' | 'deny'>,
) {
  return executeOpenChatCutTool(designSchema, args, {
    ctx, settings, runRecorder, toolCallId: crypto.randomUUID(),
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [designSchema], onEvent: () => undefined,
    resolveGuard: async () => null, onSkillGuard: onGuard,
    executeTool: async () => { log.push('global-mutation'); return { ok: true }; },
  });
}

function verifyPoliciesAndDetails(): void {
  assert.equal(policyForTool('manage_design_style', null, { action: 'list' }).effect, 'read');
  assert.equal(policyForTool('manage_design_style', null, { action: 'apply' }).effect, 'reversible_edit');
  assert.equal(policyForTool('manage_design_style', null, { action: 'clear' }).approval, 'never');
  assert.equal(policyForTool('manage_design_style', null, { action: 'update' }).effect, 'reversible_edit');
  assert.equal(policyForTool('manage_design_style', null, { action: 'save' }).effect, 'persistent_local');
  assert.equal(policyForTool('manage_design_style', null, { action: 'update', presetId: 'owned' }).approval, 'once');
  assert.equal(policyForTool('manage_design_style', null, { action: 'delete' }).approval, 'once');
  assert.equal(policyForTool('manage_design_style', null, { action: 'update', presetId: '  ' }).effect, 'reversible_edit');
  assert.equal(isExternalDraftTool('manage_design_style'), true);
  assert.equal(isExternalRealTool('manage_design_style', { action: 'list' }), false);
  assert.equal(isExternalRealTool('manage_design_style', { action: 'save' }), true);
  assert.equal(validateAgentToolInvocation(runCodeSchema, { command: 'echo ok', summary: 'safe' }, [runCodeSchema]).ok, false);
  const externalDesign = externalToolSchemas().find((schema) => schema.name === 'manage_design_style');
  assert.equal(externalDesign?.annotations?.destructiveHint, true);
  assert.equal(validateAgentToolInvocation(runCodeSchema, {
    command: 'echo ok', files: [{ path: 'input', hidden: true }],
  }, [runCodeSchema]).ok, false);
  const args = {
    command: 'rm -rf /workspace/output',
    files: [{ path: '/workspace/input', url: 'https://example.test/in?token=secret' }],
    outputs: ['/workspace/output'],
  };
  const guard = guardRequestForPolicy('run_code', args, policyForTool('run_code'), {
    skill: 'high-cost-operation', tool: 'run_code', summary: 'harmless cover text',
  });
  assert.doesNotMatch(guard?.summary ?? '', /harmless cover text/);
  assert.match(guard?.summary ?? '', /rm -rf \/workspace\/output/);
  assert.equal(guard?.details?.find((detail) => detail.kind === 'url')?.value,
    'https://example.test/in?token=[REDACTED]');
}
async function verifyTranscriptionApprovalBinding(): Promise<void> {
  const saved: Record<string, string> = {};
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved[key] ?? null,
      setItem: (key: string, value: string) => { saved[key] = value; },
    },
  });

  saved['cc.transcriptionProvider'] = 'local';
  const paidArgs = effectiveToolInvocationArgs('transcribe_track', {
    track: 'A2',
    provider: 'openai',
  });
  const paidGuard = await runtimeGuardForTool('transcribe_track', paidArgs, ctx);
  const paidPolicy = policyForTool('transcribe_track', paidGuard, paidArgs);
  assert.equal(paidPolicy.effect, 'paid_external');
  assert.equal(paidPolicy.approval, 'always');
  assert.equal(
    paidGuard?.details?.find((detail) => detail.label === '服务商')?.value,
    'openai',
    'approval display binds the explicit paid provider',
  );
  assert.equal(
    paidGuard?.details?.find((detail) => detail.label === '轨道')?.value,
    'A2',
    'approval display binds the remaining validated arguments',
  );

  saved['cc.transcriptionProvider'] = 'assemblyai';
  const localArgs = effectiveToolInvocationArgs('transcribe_track', {
    track: 'A2',
    provider: 'local',
  });
  assert.equal(await runtimeGuardForTool('transcribe_track', localArgs, ctx), null);
  let dispatchedLocalArgs: Record<string, unknown> | undefined;
  await executeOpenChatCutTool(transcribeSchema, { track: 'A2', provider: 'local' }, {
    ctx,
    settings,
    toolCatalog: TOOL_SCHEMAS,
    activeToolCatalog: [transcribeSchema],
    onEvent: () => undefined,
    resolveGuard: runtimeGuardForTool,
    onSkillGuard: async () => {
      throw new Error('local transcription must not request paid approval');
    },
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
  assert.equal(policyForTool('transcribe_track', null, localArgs).approval, 'never');
  assert.notEqual(
    await digestAgentToolArgs(paidArgs),
    await digestAgentToolArgs(localArgs),
    'approval digest identity binds the effective provider with the exact arguments',
  );

  const settingBackedArgs = effectiveToolInvocationArgs('transcribe_track', { track: 'A2' });
  assert.deepEqual(
    settingBackedArgs,
    { track: 'A2', provider: 'assemblyai' },
    'saved provider is materialized into the effective invocation before approval and execution',
  );
  let recordedArgs: Record<string, unknown> | undefined;
  let shownGuard: RuntimeGuardRequest | undefined;
  const runtimeRecorder = {
    recordToolRequested: async (input: { args: Record<string, unknown> }) => {
      recordedArgs = input.args;
      return { argsDigest: await digestAgentToolArgs(input.args) };
    },
    recordApprovalRequested: async () => ({ approvalId: 'transcribe-approval' }),
    recordApprovalDecision: async () => undefined,
    recordToolOutcome: async () => undefined,
  } as unknown as AgentRunRecorder;
  await executeOpenChatCutTool(transcribeSchema, { track: 'A2' }, {
    ctx,
    settings,
    runRecorder: runtimeRecorder,
    toolCatalog: TOOL_SCHEMAS,
    activeToolCatalog: [transcribeSchema],
    onEvent: () => undefined,
    resolveGuard: runtimeGuardForTool,
    onSkillGuard: async (guard) => {
      shownGuard = guard;
      return 'deny';
    },
    executeTool: async () => {
      throw new Error('denied transcription must not execute');
    },
  });
  assert.deepEqual(recordedArgs, settingBackedArgs);
  assert.equal(
    shownGuard?.argsDigest,
    await digestAgentToolArgs(settingBackedArgs),
    'runtime ledger and approval card share the effective invocation digest',
  );
  assert.equal(
    shownGuard?.details?.find((detail) => detail.label === '服务商')?.value,
    'assemblyai',
    'setting-backed provider is visible on the approval card',
  );
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

async function verifyDurableOwnedStyleApproval(): Promise<void> {
  const noLedger: string[] = [];
  const denied = await executeDesign(
    { action: 'save', name: 'Global' }, noLedger, undefined, async () => 'allow-once',
  );
  assert.equal(noLedger.includes('global-mutation'), false);
  assert.deepEqual(denied.result, {
    denied: true,
    note: 'User denied this persistent, paid, or irreversible operation. Do not retry automatically.',
  });
  const approved: string[] = [];
  const shown: RuntimeGuardRequest[] = [];
  await executeDesign(
    { action: 'save', name: 'Global' },
    approved,
    recorder(approved),
    async (guard) => {
      shown.push(guard);
      approved.push('ui-decision');
      return 'allow-once';
    },
  );
  assert.deepEqual(approved, [
    'requested', 'approval-requested', 'ui-decision', 'approval-decided',
    'started', 'global-mutation', 'outcome:success',
  ]);
  assert.equal(shown[0]?.argsDigest, 'd'.repeat(64));
  assert.equal(shown[0]?.details?.find((detail) => detail.kind === 'action')?.value, 'save');
  for (const action of ['list', 'apply', 'clear']) {
    const reversible: string[] = [];
    await executeDesign({ action }, reversible);
    assert.deepEqual(reversible, ['global-mutation'], `${action} remains unguarded`);
  }
}
verifyPoliciesAndDetails();
await verifyTranscriptionApprovalBinding();
await verifySecretIdentityAndRedactedLog();
await verifyExternalApprovalBinding();
await verifyDurableOwnedStyleApproval();
console.log('approval policy verifier passed');
