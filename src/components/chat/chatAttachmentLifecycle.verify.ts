import assert from 'node:assert/strict';
import type { AgentReference } from '../../agent/context';
import {
  attachChatAttachmentPlaceholder,
  beginChatAttachmentImport,
  cancelChatAttachmentImportByReference,
  createChatAttachmentLifecycleState,
  pendingChatAttachmentCount,
  removeChatAttachmentReference,
  replaceChatAttachmentPromptToken,
  resetChatAttachmentLifecycle,
  resolveChatAttachmentImport,
} from './chatAttachmentLifecycle';

const existing: AgentReference = { id: 'existing', name: 'Existing.mp4', kind: 'video' };
const placeholder: AgentReference = { id: 'pending', name: 'Pending.mov', kind: 'video' };
const ready: AgentReference = { id: 'pending', name: 'Ready.mov', kind: 'video' };

let lifecycle = createChatAttachmentLifecycleState();
const first = beginChatAttachmentImport(lifecycle);
lifecycle = first.state;
assert.equal(
  pendingChatAttachmentCount(lifecycle),
  1,
  'probe-before-placeholder must already block message submission',
);

let references: AgentReference[] = [existing];
const attached = attachChatAttachmentPlaceholder(lifecycle, references, first.token, placeholder);
assert.equal(attached.accepted, true);
lifecycle = attached.state;
references = attached.references;
assert.deepEqual(references, [existing, placeholder]);
assert.equal(
  pendingChatAttachmentCount(lifecycle),
  1,
  'a visible blob placeholder must remain unsendable',
);

lifecycle = cancelChatAttachmentImportByReference(lifecycle, placeholder.id);
references = removeChatAttachmentReference(references, placeholder.id);
const removedThenReady = resolveChatAttachmentImport(lifecycle, references, first.token, ready);
assert.equal(removedThenReady.accepted, false, 'late ready must not undo explicit removal');
assert.deepEqual(removedThenReady.references, [existing]);

const switched = beginChatAttachmentImport(lifecycle);
lifecycle = switched.state;
const previousGeneration = switched.token;
lifecycle = resetChatAttachmentLifecycle(lifecycle);
const stalePlaceholder = attachChatAttachmentPlaceholder(
  lifecycle,
  [],
  previousGeneration,
  placeholder,
);
const staleReady = resolveChatAttachmentImport(lifecycle, [], previousGeneration, ready);
assert.equal(stalePlaceholder.accepted, false, 'project/seed switch must reject old placeholders');
assert.equal(staleReady.accepted, false, 'project/seed switch must reject old ready callbacks');
assert.deepEqual(staleReady.references, []);

lifecycle = createChatAttachmentLifecycleState();
const startedA = beginChatAttachmentImport(lifecycle);
lifecycle = startedA.state;
const startedB = beginChatAttachmentImport(lifecycle);
lifecycle = startedB.state;
const placeholderA: AgentReference = { id: 'a', name: 'A.tmp', kind: 'video' };
const placeholderB: AgentReference = { id: 'b', name: 'B.tmp', kind: 'video' };
const readyA: AgentReference = { id: 'a', name: 'A.mov', kind: 'video' };
const readyB: AgentReference = { id: 'b', name: 'B.mov', kind: 'video' };

let transition = attachChatAttachmentPlaceholder(lifecycle, [], startedA.token, placeholderA);
lifecycle = transition.state;
references = transition.references;
transition = attachChatAttachmentPlaceholder(lifecycle, references, startedB.token, placeholderB);
lifecycle = transition.state;
references = transition.references;

const bFirst = resolveChatAttachmentImport(lifecycle, references, startedB.token, readyB);
assert.equal(bFirst.accepted, true);
lifecycle = bFirst.state;
references = bFirst.references;
assert.deepEqual(references, [placeholderA, readyB], 'out-of-order ready must replace only its token');
assert.equal(pendingChatAttachmentCount(lifecycle), 1, 'the other file must keep submit blocked');
assert.equal(
  replaceChatAttachmentPromptToken('@A.tmp @B.tmp ', bFirst.previousReference!, readyB),
  '@A.tmp @B.mov ',
  'ready metadata and the visible prompt token must change together',
);

const aSecond = resolveChatAttachmentImport(lifecycle, references, startedA.token, readyA);
assert.equal(aSecond.accepted, true);
assert.deepEqual(aSecond.references, [readyA, readyB], 'completion order must not reorder references');
assert.equal(
  pendingChatAttachmentCount(aSecond.state),
  0,
  'submission becomes eligible only after every associated import is ready',
);

console.log('chatAttachmentLifecycle.verify: generation, removal, gating, and ordering invariants OK');
