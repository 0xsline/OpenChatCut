// Runnable check: `npx tsx src/agent/tools/edit-item-batch.verify.ts`.
import assert from 'node:assert/strict';
import { executeAtomicEditBatch } from './edit-item-batch';
import type { EditItemOperation } from './edit-item-batch';
import { rejectSpecializedUnknownFields } from './edit-item-fields';
import {
  validateGenericAdd,
  validateGenericDelete,
  validateGenericUpdate,
} from './edit-item-generic';
import type { OpResult } from './edit-item-shared';
import type { TimelineState } from '../../editor/types';

type Draft = { effects: string[] };

function validateEffectDelete(draft: Draft, operation: EditItemOperation): OpResult {
  const effectId = String(operation.entry.effectId ?? '');
  if (operation.entry.unknownField !== undefined) return { error: 'unknown field "unknownField"' };
  if (!draft.effects.includes(effectId)) return { error: `effect not found: ${effectId}` };
  return { ok: true, plan: 'setEffects', effects: draft.effects.filter((id) => id !== effectId) };
}

function applyEffectDelete(draft: Draft, plan: OpResult): OpResult {
  if (plan.failApply) return { error: 'synthetic apply failure' };
  draft.effects = [...plan.effects as string[]];
  return { ok: true, remaining: draft.effects.length };
}

{
  let published: Draft = { effects: ['fx-a', 'fx-b', 'fx-c'] };
  let publishCount = 0;
  const result = executeAtomicEditBatch(
    { deletes: [{ effectId: 'fx-a' }, { effectId: 'fx-b' }] },
    {
      createDraft: () => ({ effects: [...published.effects] }),
      validate: validateEffectDelete,
      apply: applyEffectDelete,
      publish: (draft) => {
        publishCount += 1;
        published = { effects: [...draft.effects] };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.atomic, true);
  assert.equal(publishCount, 1, 'a successful batch publishes exactly once');
  assert.deepEqual(published.effects, ['fx-c'], 'later effect deletion sees the earlier deletion on the same draft');
}

{
  const persisted: Draft = { effects: ['fx-a', 'fx-b', 'fx-c'] };
  let publishCount = 0;
  const result = executeAtomicEditBatch(
    { deletes: [{ effectId: 'fx-a' }, { effectId: 'fx-b', unknownField: true }] },
    {
      createDraft: () => ({ effects: [...persisted.effects] }),
      validate: validateEffectDelete,
      apply: applyEffectDelete,
      publish: () => { publishCount += 1; },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(publishCount, 0, 'a later validator failure must not publish earlier draft mutations');
  assert.deepEqual(persisted.effects, ['fx-a', 'fx-b', 'fx-c']);
}

{
  const persisted: Draft = { effects: ['fx-a', 'fx-b'] };
  let publishCount = 0;
  let applications = 0;
  const result = executeAtomicEditBatch(
    { deletes: [{ effectId: 'fx-a' }, { effectId: 'fx-b' }] },
    {
      createDraft: () => ({ effects: [...persisted.effects] }),
      validate: validateEffectDelete,
      apply: (draft, plan) => {
        applications += 1;
        return applications === 2 ? { error: 'synthetic apply failure' } : applyEffectDelete(draft, plan);
      },
      publish: () => { publishCount += 1; },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(publishCount, 0, 'a draft-apply failure must discard the entire draft');
  assert.deepEqual(persisted.effects, ['fx-a', 'fx-b']);
}

for (const [bucket, type] of [
  ['adds', 'effect'],
  ['adds', 'transition'],
  ['adds', 'audio'],
  ['adds', 'motion-graphic'],
  ['updates', 'effect'],
  ['updates', 'transition'],
  ['deletes', 'effect'],
  ['deletes', 'transition'],
] as const) {
  assert.match(
    rejectSpecializedUnknownFields(bucket, type, { type, unknownField: true }) ?? '',
    /unknown field "unknownField"/,
    `${bucket}/${type} must reject unknown fields`,
  );
}

const emptyState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  tracks: {},
  trackOrder: [],
  items: [],
} as TimelineState;
for (const result of [
  validateGenericAdd(emptyState, [], { type: 'video', unknownField: true }),
  validateGenericUpdate(emptyState, { type: 'video', itemId: 'missing', unknownField: true }),
  validateGenericDelete(emptyState, { type: 'video', itemId: 'missing', unknownField: true }),
]) {
  assert.match(String(result.error ?? ''), /unknown field "unknownField"/);
}

console.log('edit-item-batch.verify: sequential multi-effect draft, rollback, and unknown fields ok');
