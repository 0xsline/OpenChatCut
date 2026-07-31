// Runnable check: `npx tsx src/agent/tools/edit-item-slip.verify.ts`.
import assert from 'node:assert/strict';
import { planSlip } from '../../editor/slip';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { applyGeneric, type GenericCommands, validateSlipUpdate } from './edit-item-generic';

const clip: TimelineItem = {
  id: 'clip-agent-a',
  track: 'video-main',
  startFrame: 100,
  durationInFrames: 80,
  name: 'Agent clip',
  kind: 'video',
  src: '/media/uploads/agent.mp4',
  srcInFrame: 20,
  playbackRate: 2,
};

const state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [clip],
  assets: [{
    id: 'asset-agent-a',
    name: 'Agent source',
    kind: 'video',
    src: clip.src!,
    durationInFrames: 200,
  }],
  selectedId: clip.id,
  trackOrder: [clip.track],
  tracks: { [clip.track]: { kind: 'video' } },
};

{
  const plan = validateSlipUpdate(state, {
    operation: 'slip',
    itemId: clip.id,
    deltaInFrames: 100,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.plan, 'slip');
  assert.equal(plan.clamped, true);
  assert.equal(plan.srcInFrame, 40, '2x 80-frame clip consumes 160 of the 200 source frames');
  assert.equal(plan.appliedDeltaInFrames, 10);

  let committedDelta: number | null = null;
  const commands = new Proxy({}, {
    get: (_target, property) => {
      if (property === 'slipItem') return (id: string, delta: number) => {
        committedDelta = delta;
        return planSlip(state, id, delta);
      };
      return () => undefined;
    },
  }) as GenericCommands;
  const result = applyGeneric(plan, commands);
  assert.equal(result?.ok, true);
  assert.equal(result?.status, 'clamped');
  assert.equal(committedDelta, 10, 'agent commit delegates one explicit slip action using the validated delta');
}

{
  const boundaryState: TimelineState = {
    ...state,
    items: [{ ...clip, srcInFrame: 40 }],
  };
  const boundary = validateSlipUpdate(boundaryState, {
    operation: 'slip',
    itemId: clip.id,
    deltaInFrames: 1,
  });
  assert.deepEqual(
    {
      ok: boundary.ok,
      status: boundary.status,
      clamped: boundary.clamped,
      appliedDeltaInFrames: boundary.appliedDeltaInFrames,
    },
    { ok: true, status: 'clamped', clamped: true, appliedDeltaInFrames: 0 },
    'a beyond-boundary request returns a structured clamped no-op',
  );
}

{
  const unknown = validateSlipUpdate(state, {
    operation: 'slip',
    itemId: 'missing',
    deltaInFrames: 1,
  });
  assert.deepEqual(
    { ok: unknown.ok, code: unknown.code },
    { ok: false, code: 'unknown-item' },
  );
}

{
  const invalid = validateSlipUpdate(state, {
    operation: 'slip',
    itemId: clip.id,
    deltaInFrames: 'later',
  });
  assert.deepEqual(
    { ok: invalid.ok, code: invalid.code },
    { ok: false, code: 'invalid-delta' },
  );
}

{
  const unknownOperation = validateSlipUpdate(state, {
    operation: 'roll', itemId: clip.id, deltaInFrames: 1,
  });
  assert.deepEqual(
    {
      ok: unknownOperation.ok,
      code: unknownOperation.code,
      supported: unknownOperation.supported,
    },
    { ok: false, code: 'unknown-operation', supported: ['slip'] },
  );
}

console.log('edit-item-slip.verify: explicit slip plan, clamped result, invalid/unknown operations, and one commit action ok');
