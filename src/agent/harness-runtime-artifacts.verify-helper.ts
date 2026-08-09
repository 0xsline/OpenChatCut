import assert from 'node:assert/strict';
import type { AgentContext } from './context';
import type { AgentSettings } from './settings/agentSettings';
import { TOOL_SCHEMAS } from './tools';
import {
  agentArtifactRefOf,
  redactTextForAgentRuntime,
  sanitizeJsonForArtifact,
} from './runtime-artifact';
import {
  compactToolResultForModel,
  compactToolResultForTransport,
} from './tool-result-compaction';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  purgeAgentRuntime,
  recoverInterruptedAgentRuns,
  sha256Text,
} from '../persist/agentRuntimeStore';
import {
  digestAgentToolArgs,
  startAgentRun,
  type AgentRunRecorder,
} from './runtime-ledger';
import { executeOpenChatCutTool } from './codex/runtime';
import { execAgentRuntimeTool } from './tools/agent-runtime-tools';

const projectId = 'harness-runtime-verify';
const aspectSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'set_aspect_ratio')!;
const ctx = {
  getProjectId: () => projectId,
  getState: () => ({ items: [], transitions: [] }),
} as unknown as AgentContext;
const settings = {} as AgentSettings;

async function createPrivacyRecorder(): Promise<AgentRunRecorder> {
  const rawPrompt = 'password: abc';
  const recorder = await startAgentRun({ projectId, userInput: rawPrompt, askOnly: false });
  await recorder.configure({
    modelId: 'fixture-model password=abc',
    backend: 'fixture-backend token=abc',
  });
  const rawArgs = { accessToken: 'abc' };
  const { argsDigest } = await recorder.recordToolRequested({
    toolCallId: 'privacy-args-call', toolName: 'fixture_tool', args: rawArgs,
  });
  assert.equal(argsDigest, await sha256Text(JSON.stringify(rawArgs)));
  assert.notEqual(argsDigest, await sha256Text(sanitizeJsonForArtifact(rawArgs)!.body));
  await recorder.recordToolOutcome({
    toolCallId: 'error-echo-call', toolName: 'fixture_tool', argsDigest,
    outcome: {
      kind: 'terminal_failure', code: 'provider_password=abc',
      summary: 'Provider echoed password: abc',
    },
  });
  const run = (await loadAgentRuntimeSidecar(projectId)).runs
    .find((item) => item.runId === recorder.runId)!;
  assert.notEqual(run.userInputDigest, await sha256Text(rawPrompt));
  assert.equal(run.userInputDigest, await sha256Text(redactTextForAgentRuntime(rawPrompt)));
  assert.equal(run.events.find((event) => event.toolCallId === 'privacy-args-call')?.argsDigest, argsDigest);
  assert.doesNotMatch(JSON.stringify(run), /\babc\b/);
  assert.match(JSON.stringify(run), /\[REDACTED\]/);
  return recorder;
}

async function verifyArchivedLargeResult(recorder: AgentRunRecorder): Promise<string> {
  const live = {
    rows: [{ value: '字'.repeat(20_000), apiKey: 'must-not-persist' }],
    __images: [{ base64: 'a'.repeat(20_000), mediaType: 'image/jpeg' }],
  };
  const keysBefore = Object.keys(live);
  const execution = await executeOpenChatCutTool(aspectSchema, { ratio: '9:16' }, {
    ctx, settings, runRecorder: recorder, toolCallId: 'artifact-call',
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [aspectSchema],
    onEvent: () => undefined, resolveGuard: async () => null,
    executeTool: async () => live,
  });
  assert.equal(execution.success, true);
  assert.deepEqual(Object.keys(live), keysBefore, 'artifact metadata remains non-enumerable');
  assert.equal(live.rows[0]!.apiKey, 'must-not-persist', 'live/UI result remains exact');
  const ref = agentArtifactRefOf(execution.result);
  assert.ok(ref);
  assert.ok(JSON.stringify(compactToolResultForModel(execution.result)).length < 2_000);
  const transport = compactToolResultForTransport(execution.result, true) as typeof live & { artifactId: string };
  assert.equal(transport.__images[0]!.base64, live.__images[0]!.base64);
  assert.equal(transport.artifactId, ref!.artifactId);
  const artifact = await loadAgentArtifact(projectId, ref!.artifactId);
  assert.ok(artifact);
  assert.equal(await sha256Text(artifact!.body), artifact!.bodySha256);
  const expected = sanitizeJsonForArtifact(live)!;
  assert.equal(artifact!.body, expected.body);
  assert.equal(artifact!.bodySha256, await sha256Text(expected.body));
  assert.notEqual(artifact!.bodySha256, await sha256Text(JSON.stringify(live)));
  assert.doesNotMatch(artifact!.body, /must-not-persist|"a{100}/);
  const page = await execAgentRuntimeTool('read_agent_artifact', {
    artifactId: ref!.artifactId, pointer: '/rows/0/value', offset: 0, limit: 12_000,
  }, ctx) as { content: string; nextOffset: number; hasMore: boolean };
  assert.ok(JSON.stringify(page).length <= 12_000);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextOffset > 0);
  return ref!.artifactId;
}

async function verifyLoadSkillBypass(recorder: AgentRunRecorder): Promise<void> {
  const schema = TOOL_SCHEMAS.find((candidate) => candidate.name === 'load_skill')!;
  const payload = {
    skill: 'fixture', files: ['SKILL.md'],
    contents: {
      'SKILL.md': '# Fixture\nOPENAI_API_KEY=live-load-skill-secret\n' + 'S'.repeat(20_000),
    },
    omittedFiles: ['references/details.md'],
  };
  const execution = await executeOpenChatCutTool(schema, { name: 'fixture' }, {
    ctx, settings, runRecorder: recorder, toolCallId: 'skill-call',
    toolCatalog: TOOL_SCHEMAS, activeToolCatalog: [schema],
    onEvent: () => undefined, resolveGuard: async () => null,
    executeTool: async () => payload,
  });
  assert.equal(execution.success, true);
  assert.equal(agentArtifactRefOf(execution.result), undefined,
    'load_skill must reach the model exactly instead of becoming an artifact placeholder');
  assert.equal((execution.result as typeof payload).contents['SKILL.md'], payload.contents['SKILL.md']);
  assert.doesNotMatch(JSON.stringify(await loadAgentRuntimeSidecar(projectId)),
    /live-load-skill-secret/, 'load_skill credentials never enter the durable run sidecar');
}

async function verifyCheckpointAndRecovery(
  recorder: AgentRunRecorder,
  artifactId: string,
): Promise<void> {
  const rawSource = [
    'Authorization: Bearer raw-secret', 'Cookie: session=cookie-secret',
    '{"apiKey":"json-secret","accessToken":"token-secret"}',
    'https://example.test/file?X-Amz-Signature=signed-secret&token=query-secret#accessToken=frag-secret',
  ].join('\\n');
  const rawSummary = 'password: summary-secret';
  const sourceText = redactTextForAgentRuntime(rawSource);
  const summary = redactTextForAgentRuntime(rawSummary);
  const sourceDigest = await sha256Text(sourceText);
  const summaryDigest = await sha256Text(summary);
  const secrets = /raw-secret|cookie-secret|json-secret|token-secret|signed-secret|query-secret|frag-secret|summary-secret/;
  assert.doesNotMatch(`${sourceText}\\n${summary}`, secrets);
  await recorder.recordCheckpoint({
    summary, summaryDigest, sourceText, sourceDigest,
    sourceMessageCount: 4, createdAt: Date.now(),
  });
  const saved = await loadAgentRuntimeSidecar(projectId);
  const checkpoint = saved.checkpoints.find((item) => item.runId === recorder.runId)!;
  const sourceArtifact = await loadAgentArtifact(projectId, checkpoint.sourceArtifactId);
  assert.ok(sourceArtifact);
  assert.equal(await sha256Text(sourceArtifact!.body), checkpoint.sourceDigest);
  assert.equal(await sha256Text(checkpoint.summary), checkpoint.summaryDigest);
  assert.doesNotMatch(`${sourceArtifact!.body}\\n${checkpoint.summary}`, secrets);
  await assert.rejects(recorder.recordCheckpoint({
    summary: rawSummary, sourceText: rawSource, sourceDigest: await sha256Text(rawSource),
    sourceMessageCount: 4, createdAt: Date.now(),
  }), /source digest mismatch/);
  await recorder.recordApprovalRequested({
    toolCallId: 'pending-call', toolName: 'submit_render_job',
    argsDigest: await digestAgentToolArgs({ projectId }), operationId: 'op-1',
  });
  const recovered = await recoverInterruptedAgentRuns(projectId, Date.now() + 1_000_000);
  assert.equal(recovered.runs.find((run) => run.runId === recorder.runId)?.status, 'interrupted');
  assert.equal(recovered.approvals.find((item) => item.toolCallId === 'pending-call')?.status, 'cancelled');
  assert.doesNotMatch(recovered.runs[0]?.userInputPreview ?? '', /\babc\b/);
  await purgeAgentRuntime(projectId);
  assert.equal(await loadAgentArtifact(projectId, artifactId), null);
  assert.equal((await loadAgentRuntimeSidecar(projectId)).runs.length, 0);
}

export async function verifyArtifactAndCheckpointScenarios(): Promise<void> {
  const recorder = await createPrivacyRecorder();
  const artifactId = await verifyArchivedLargeResult(recorder);
  await verifyLoadSkillBypass(recorder);
  await verifyCheckpointAndRecovery(recorder, artifactId);
}
