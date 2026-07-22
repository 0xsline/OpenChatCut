import assert from 'node:assert/strict';
import { replayActions } from '../editor/store';
import { activeTimeline } from '../editor/types';
import { INITIAL } from '../editor/initial';
import { docFromTimeline } from '../persist/projectStore';
import {
  captureExternalToolActions,
  createExternalEditSession,
  forkExternalEditSession,
  isExternalEditSessionStale,
  restoreExternalEditSession,
  reviewExternalEditSession,
} from './external-edit-session';
import { isExternalDraftTool, isExternalReadTool } from './external-tool-policy';

const base = docFromTimeline({ ...INITIAL, items: [] });
const session = createExternalEditSession(base, 'Codex');
assert.equal(session.status, 'drafting');
assert.equal(session.approvalMode, 'manual');
assert.match(session.baseRevision, /^v\d+-[0-9a-f]{8}$/);
assert.equal(isExternalEditSessionStale(session, base), false);

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

const reviewed = reviewExternalEditSession(staged, 'Create a vertical cut');
assert.equal(reviewed.status, 'awaiting_review');
assert.equal(reviewed.draft, null);
assert.equal(reviewed.proposal?.title, 'Codex');
assert.equal(reviewed.proposal?.summary, 'Create a vertical cut');

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
const restoredDiscard = restoreExternalEditSession({
  sessionId: session.id,
  clientName: session.clientName,
  status: 'discarded',
  baseRevision: session.baseRevision,
  createdAt: session.createdAt,
  operationCount: staged.operationCount,
  proposal: null,
}, base);
assert.equal(restoredDiscard.status, 'discarded');
assert.equal(restoredDiscard.operationCount, 1);
assert.equal(restoredDiscard.approvalMode, 'manual');

assert(isExternalDraftTool('set_aspect_ratio'));
assert(isExternalReadTool('read_project'));
assert(!isExternalDraftTool('delete_project'));
assert(!isExternalDraftTool('submit_render_job'));

console.log('external edit session checks passed');
