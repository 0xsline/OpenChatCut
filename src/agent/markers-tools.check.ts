// Runnable check: `npx tsx src/agent/markers-tools.check.ts`.
// Asserts manage_markers exec dispatches to the store commands correctly and
// validates input (no fromFrame / item without itemId / unknown id).
import assert from 'node:assert';
import type { AgentContext } from './context';
import type { Marker } from '../editor/types';
import { execMarkersTool } from './markers-tools';

interface Call { fn: string; args: unknown[]; }

function makeCtx(markers: Marker[]): { ctx: AgentContext; calls: Call[] } {
  const calls: Call[] = [];
  let n = 0;
  const commands = {
    addMarker: (...args: unknown[]) => { calls.push({ fn: 'addMarker', args }); return `mk_${++n}`; },
    updateMarker: (...args: unknown[]) => { calls.push({ fn: 'updateMarker', args }); },
    removeMarker: (...args: unknown[]) => { calls.push({ fn: 'removeMarker', args }); },
  };
  const ctx = { getState: () => ({ markers }), commands } as unknown as AgentContext;
  return { ctx, calls };
}

const existing: Marker[] = [{ id: 'mk_a', scope: 'project', fromFrame: 30, durationFrames: 0, note: 'hi', color: 'blue' }];

// list
{
  const { ctx } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'list' }, ctx) as { markers: unknown[] };
  assert.equal(r.markers.length, 1, 'list returns existing markers');
}

// create single
{
  const { ctx, calls } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', fromFrame: 90, note: 'drop', color: 'red' }, ctx) as { created: string[] };
  assert.deepEqual(r.created, ['mk_1'], 'create returns new id');
  assert.equal(calls[0].fn, 'addMarker');
  assert.equal((calls[0].args[0] as number), 90, 'fromFrame passed');
  assert.equal((calls[0].args[1] as { color: string }).color, 'red', 'color passed');
}

// create batch
{
  const { ctx, calls } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', markers: [{ fromFrame: 1 }, { fromFrame: 2 }] }, ctx) as { created: string[] };
  assert.equal(r.created.length, 2, 'batch creates two');
  assert.equal(calls.length, 2);
}

// create validation: missing fromFrame
{
  const { ctx } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', note: 'x' }, ctx) as { error?: string };
  assert.ok(r.error, 'missing fromFrame errors');
}

// create validation: item scope without itemId
{
  const { ctx } = makeCtx([]);
  const r = execMarkersTool('manage_markers', { action: 'create', fromFrame: 5, scope: 'item' }, ctx) as { error?: string };
  assert.ok(r.error, 'item scope needs itemId');
}

// update existing
{
  const { ctx, calls } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'update', markerId: 'mk_a', note: 'changed' }, ctx) as { ok?: boolean };
  assert.ok(r.ok, 'update ok');
  assert.equal(calls[0].fn, 'updateMarker');
  assert.deepEqual(calls[0].args[1], { note: 'changed' }, 'only whitelisted patch');
}

// update unknown id
{
  const { ctx } = makeCtx(existing);
  const r = execMarkersTool('manage_markers', { action: 'update', markerId: 'nope', note: 'x' }, ctx) as { error?: string };
  assert.ok(r.error, 'unknown id errors');
}

// delete existing / unknown
{
  const { ctx, calls } = makeCtx(existing);
  assert.ok((execMarkersTool('manage_markers', { action: 'delete', markerId: 'mk_a' }, ctx) as { ok?: boolean }).ok);
  assert.equal(calls[0].fn, 'removeMarker');
  assert.ok((execMarkersTool('manage_markers', { action: 'delete', markerId: 'ghost' }, ctx) as { error?: string }).error);
}

// eslint-disable-next-line no-console
console.log('markers-tools.check: ok');
