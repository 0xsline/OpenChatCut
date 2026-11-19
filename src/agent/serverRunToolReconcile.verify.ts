import assert from 'node:assert/strict';
import {
  isFrozenVerdict,
  reconcileServerTool,
  type DurableToolEvidence,
  type ServerToolReconcileInput,
} from './serverRunToolReconcile.ts';
import { policyForTool } from './execution-policy.ts';

/**
 * P3 — the browser-side reconciliation table (design note §4.1).
 *
 * Each case below is one row of that table. The two properties that matter for
 * safety are asserted everywhere: a write is never repeated without evidence
 * that it did not happen, and an unverifiable write freezes instead of guessing.
 */

const base = (overrides: Partial<ServerToolReconcileInput>): ServerToolReconcileInput => ({
  toolCallId: 'call-1',
  argsDigest: 'digest-1',
  name: 'edit_item',
  policy: policyForTool('edit_item', {}).recovery,
  durable: null,
  draft: null,
  stored: null,
  liveRevision: 'rev-base',
  baseRevision: 'rev-base',
  ...overrides,
});

// A draft action as the browser records it: the target lives on the action.
const actions = [{ type: 'trim', itemId: 'clip-1' }] as never;

// --- row 1: a durable outcome is delivered, never re-executed --------------
const reuse = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', result: { applied: true } },
}));
assert.equal(reuse.verdict, 'reuse-result');
assert.deepEqual(reuse.result, { applied: true });
assert.equal(isFrozenVerdict(reuse.verdict), false);

const confirmedFailure = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', error: 'clip not found' },
}));
assert.equal(
  confirmedFailure.verdict,
  'confirmed-failure',
  'a durable failure is a business answer, not a blocked write',
);
assert.equal(confirmedFailure.reason, 'clip not found');

// A durable record for a different invocation cannot authorise this one.
const mismatched = reconcileServerTool(base({
  argsDigest: 'digest-2',
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', result: {} },
}));
assert.equal(mismatched.verdict, 'outcome-unknown');
assert.equal(isFrozenVerdict(mismatched.verdict), true);

// --- row 2: intent without a claim means authority was never granted -------
const neverRan = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'intent' },
}));
assert.equal(neverRan.verdict, 'redispatch', 'no claim record proves the browser never got authority');
assert.equal(isFrozenVerdict(neverRan.verdict), false);

const noRecordAtAll = reconcileServerTool(base({ durable: null }));
assert.equal(noRecordAtAll.verdict, 'redispatch');

// --- row 3a: claim granted, browser has a result for this call -------------
const browserHasResult = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  stored: { result: { applied: true, revision: 12 } },
  draft: { toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions },
}));
assert.equal(
  browserHasResult.verdict,
  'submit-existing-result',
  'the browser result for exactly this call is submitted, not re-executed',
);
assert.deepEqual(browserHasResult.result, { applied: true, revision: 12 });

const storedFailure = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  stored: { error: 'timeline rejected the trim' },
}));
assert.equal(storedFailure.verdict, 'confirmed-failure');
assert.equal(storedFailure.reason, 'timeline rejected the trim');

// --- row 3b: claim granted, only a started marker or draft actions --------
const startedOnlyWrite = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  draft: { toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions },
  liveRevision: 'rev-live',
}));
assert.equal(
  startedOnlyWrite.verdict,
  'outcome-unknown',
  'draft actions prove intent, never that the live project changed',
);
assert.match(startedOnlyWrite.reason ?? '', /clip-1/, 'the freeze names the operation target');
assert.deepEqual(startedOnlyWrite.targets, ['clip-1']);

// The prompt the user sees names the target and the pause, per the design note.
const frozenPrompt = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  draft: { toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions },
  liveRevision: 'rev-live',
}));
assert.match(
  frozenPrompt.reason ?? '',
  /无法确认对 .+ 的编辑是否已生效，已暂停后续写入/,
  'the freeze message states which operation is unresolved and that writes are paused',
);

// Local document equality cannot disprove an external or unrecorded effect.
const provablyNotRun = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
}));
assert.equal(
  provablyNotRun.verdict,
  'outcome-unknown',
  'a claimed write remains unknown even if the local project is unchanged',
);

for (const name of ['submit_image', 'submit_video', 'run_code', 'submit_export']) {
  assert.equal(reconcileServerTool(base({ name, policy: policyForTool(name, {}).recovery,
    durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  })).verdict, 'outcome-unknown', `${name}: unchanged local doc cannot disprove an external effect`);
}

// --- row 3c: a landed marker is evidence only with a checkable revision ---
const landedVerified = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  draft: {
    toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions,
    landed: true, landedRevision: 'rev-live',
  },
  liveRevision: 'rev-live',
  baseRevision: 'rev-base',
}));
assert.equal(
  landedVerified.verdict,
  'outcome-unknown',
  'even a matching revision cannot supply the missing result; the run stays blocked',
);
assert.match(landedVerified.reason ?? '', /没有收到结果/);

const landedWithoutRevision = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  draft: {
    toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions, landed: true,
  },
  liveRevision: 'rev-live',
}));
assert.equal(landedWithoutRevision.verdict, 'outcome-unknown');
assert.match(
  landedWithoutRevision.reason ?? '',
  /没有可核对的项目版本/,
  'an unversioned landing marker is reported as unverifiable, not trusted',
);

const projectMovedAfterLanding = reconcileServerTool(base({
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  draft: {
    toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions,
    landed: true, landedRevision: 'rev-old',
  },
  liveRevision: 'rev-edited-by-user',
}));
assert.equal(projectMovedAfterLanding.verdict, 'outcome-unknown');
assert.match(
  projectMovedAfterLanding.reason ?? '',
  /落地后工程又被修改过/,
  'a project edited after the landing cannot be assumed to still contain it',
);

// --- pure reads may always be retried ------------------------------------
const pureRead = reconcileServerTool(base({
  name: 'read_timeline',
  policy: policyForTool('read_timeline', {}).recovery,
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
}));
assert.equal(pureRead.verdict, 'redispatch', 'a claimed pure read is safe to repeat');

// --- a new call id never re-authorises a completed write ------------------
// The resumed model has no memory of the old call id, so the same effective
// invocation has to be matched by the caller. When it is, the durable outcome
// drives the verdict regardless of the new id.
const sameEditNewCallId = reconcileServerTool(base({
  toolCallId: 'call-9',
  durable: { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', result: { applied: true } },
  draft: { toolCallId: 'call-1', argsDigest: 'digest-1', name: 'edit_item', actions, landed: true },
}));
assert.equal(
  sameEditNewCallId.verdict,
  'reuse-result',
  'an already-completed edit is reused, so a fresh call id cannot cause a second write',
);

// --- the freeze decision is the only "stop" verdict ----------------------
const verdicts: DurableToolEvidence[] = [
  { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'outcome', result: {} },
  { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'claimed' },
  { toolCallId: 'call-1', argsDigest: 'digest-1', state: 'intent' },
];
for (const durable of verdicts) {
  const decision = reconcileServerTool(base({ durable }));
  const frozen = isFrozenVerdict(decision.verdict);
  assert.equal(
    frozen,
    decision.verdict === 'outcome-unknown',
    'only outcome-unknown freezes; every other verdict is a resolution',
  );
}

console.log('serverRunToolReconcile.verify: §4.1 reconciliation table, verification-only landing evidence, and freeze-only-on-unknown passed');
