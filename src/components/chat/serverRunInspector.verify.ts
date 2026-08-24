import assert from 'node:assert/strict';
import type { AgentRunEvent, AgentRunRecord } from '../../persist/agentRuntimeTypes';
import {
  isServerRunRecord,
  serverEventDetail,
  serverEventFromAgentEvent,
  serverEventsForRun,
  serverRunAcceptance,
  serverRunTerminalReason,
} from './serverRunInspector';

const projectId = 'server-run-inspector-verify';
const runId = 'run_server_inspector';
const envelope = (id: number, type: string, data: Record<string, unknown>): AgentRunEvent => ({
  eventId: `event-${id}`, projectId, runId, sequence: id, type: type === 'tool-request' ? 'tool_requested' : type === 'tool-result' ? 'tool_outcome' : 'final', createdAt: id,
  summary: JSON.stringify({ serverEvent: { id, type, data, at: id } }),
});
const run = (events: readonly AgentRunEvent[], status: AgentRunRecord['status'] = 'failed', finalSummary?: string): AgentRunRecord => ({
  version: 1, runId, projectId, status, askOnly: false, userInputPreview: 'server:provider/model', userInputDigest: 'digest', createdAt: 1, updatedAt: 3,
  modelId: 'model', backend: 'provider', artifactIds: [], checkpointIds: [], proposalIds: [], events, ...(finalSummary ? { finalSummary } : {}),
});

const events = [
  envelope(2, 'tool-request', { toolCallId: 'call-1', name: 'inspect_timeline', argsDigest: 'args' }),
  envelope(1, 'status', { status: 'running' }),
  envelope(3, 'tool-result', { toolCallId: 'call-1', result: { ok: true } }),
  envelope(4, 'done', { status: 'failed', reason: 'server-restart' }),
  envelope(5, 'acceptance', { status: 'passed', iteration: 2, maxIterations: 3 }),
];
const projected = serverEventsForRun(run(events));
assert.deepEqual(projected.map((event) => event.id), [1, 2, 3, 4, 5]);
assert.equal(serverEventFromAgentEvent(events[0])?.data.name, 'inspect_timeline');
assert.equal(serverEventDetail(projected[1]), 'inspect_timeline');
assert.equal(serverRunTerminalReason(run(events)), 'server-restart');
assert.equal(isServerRunRecord(run(events)), true);
assert.equal(isServerRunRecord(run([{ ...events[0], summary: 'not server data' }])), true, 'server prefix remains the fallback discriminator');
assert.equal(isServerRunRecord(run([{ ...events[0], projectId: 'other', summary: 'not server data' }], 'completed')), true);
assert.equal(serverEventFromAgentEvent({ ...events[0], summary: '{"serverEvent":{"id":1,"type":"status","data":[] ,"at":1}}' }), null);
assert.equal(serverRunTerminalReason(run(events, 'failed', 'provider failed')), 'provider failed');
assert.deepEqual(serverRunAcceptance(projected), { status: 'passed', iteration: 2, maxIterations: 3 });
console.log('serverRunInspector.verify: projection and terminal reason checks passed');
