import assert from 'node:assert/strict';
import { replayActions } from '../editor/store';
import { activeTimeline } from '../editor/types';
import { INITIAL } from '../editor/initial';
import { docFromTimeline } from '../persist/projectStore';
import {
  captureExternalToolActions,
  createExternalEditSession,
  finishExternalEditSession,
  forkExternalEditSession,
  isExternalEditSessionStale,
  restoreExternalEditSession,
  reviewExternalEditSession,
  revisionOf,
} from './external-edit-session';
import { ExternalSessionRunLedger } from './external-run-ledger';
export const base = docFromTimeline({ ...INITIAL, items: [] });
export function sessionStatus(value: unknown): unknown {
  assert(value && typeof value === 'object' && 'status' in value);
  return value.status;
}
export function agentRunId(value: unknown): string {
  assert(value && typeof value === 'object' && 'agentRunId' in value);
  const id = value.agentRunId;
  if (typeof id !== 'string') throw new Error('Expected external edit session to expose agentRunId');
  return id;
}
export function needsConfirmation(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && 'needs_confirmation' in value
    && value.needs_confirmation === true,
  );
}
const session = createExternalEditSession(base, 'Codex');
assert.equal(session.status, 'drafting');
assert.equal(session.approvalMode, 'manual');
assert.match(session.baseRevision, /^v\d+-[0-9a-f]{8}$/);
assert.equal(isExternalEditSessionStale(session, base), false);
const reorderedBase = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
assert.equal(
  revisionOf(reorderedBase),
  revisionOf(base),
  'semantic revisions are stable across JSON object-key order changes',
);

const autoSession = createExternalEditSession(base, 'Codex', 'auto');
assert.equal(autoSession.approvalMode, 'auto');
assert.throws(() => createExternalEditSession(base, 'Codex', 'invalid'), /approvalMode/);

const isolatedCall = forkExternalEditSession(session);
isolatedCall.draft!.commands.setAspect(1080, 1920, 'contain');
const staged = captureExternalToolActions(
  isolatedCall,
  'set_aspect_ratio',
  { width: 1080, height: 1920 },
);
assert.equal(activeTimeline(base).width, 1920, 'live/base project must remain unchanged while drafting');
assert.equal(staged.draft!.getState().width, 1080);
assert.equal(staged.operations.length, 1);

export const reviewed = reviewExternalEditSession(staged, 'Create a vertical cut');
assert.equal(reviewed.status, 'awaiting_review');
assert.equal(reviewed.draft, null);
assert.equal(reviewed.proposal?.title, 'Codex');
assert.equal(reviewed.proposal?.summary, 'Create a vertical cut');
export async function reviewedWithRun(projectId: string) {
  const run = await ExternalSessionRunLedger.start(
    projectId,
    reviewed.clientName,
    reviewed.id,
  );
  const pending = {
    sessionId: reviewed.id,
    clientName: reviewed.clientName,
    approvalMode: 'manual' as const,
    status: 'awaiting_review' as const,
    baseRevision: reviewed.baseRevision,
    createdAt: reviewed.createdAt,
    operationCount: reviewed.operationCount,
    agentRunId: run.runId,
    proposal: { ...reviewed.proposal!, agentRunId: run.runId },
  };
  await run.disconnect();
  return pending;
}


const actions = reviewed.proposal!.options[0].operations.flatMap((operation) => operation.actions);
const applied = replayActions(base, actions);
assert.equal(activeTimeline(applied).width, 1080);
assert.equal(activeTimeline(applied).height, 1920);
assert.equal(isExternalEditSessionStale(session, applied), true);

const restored = restoreExternalEditSession({
  sessionId: reviewed.id,
  clientName: reviewed.clientName,
  approvalMode: 'auto',
  status: 'rejected',
  baseRevision: reviewed.baseRevision,
  createdAt: reviewed.createdAt,
  operationCount: reviewed.operationCount,
  proposal: reviewed.proposal!,
}, base);
assert.equal(restored.status, 'rejected');
assert.equal(restored.approvalMode, 'auto');
assert.equal(restored.proposal, null);
const restoredLegacyDiscard = restoreExternalEditSession({
  sessionId: session.id,
  clientName: session.clientName,
  status: 'discarded',
  baseRevision: session.baseRevision,
  createdAt: session.createdAt,
  operationCount: staged.operationCount,
  proposal: null,
}, base);
assert.equal(restoredLegacyDiscard.status, 'cancelled', 'legacy discarded sessions normalize to cancelled');
assert.equal(restoredLegacyDiscard.operationCount, 1);
assert.equal(restoredLegacyDiscard.approvalMode, 'manual');

for (const outcome of ['applied', 'rejected', 'cancelled', 'stale', 'failed'] as const) {
  assert.equal(finishExternalEditSession(session, outcome).status, outcome);
}
