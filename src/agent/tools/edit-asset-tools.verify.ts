// Runnable check: `npx tsx src/agent/edit-asset-tools.check.ts`.
// Asserts edit_asset routing + confirmImpact gate + non-MG code guard, via a mock
// ctx (no reducer / no sandbox needed — those paths are exercised elsewhere).
import assert from 'node:assert';
import type { AgentContext } from '../context';
import type { MediaAsset, TimelineItem } from '../../editor/types';
import { execEditAssetTool } from './edit-asset-tools';

interface Call { fn: string; args: unknown[]; }

const mg: MediaAsset = { id: 'mg_1', name: 'Title', kind: 'motion-graphic', src: '', durationInFrames: 90, code: 'old' };
const vid: MediaAsset = { id: 'vid_1', name: 'Clip', kind: 'video', src: '/media/uploads/a.mp4', durationInFrames: 300 };

function makeCtx(assets: MediaAsset[], items: TimelineItem[]): { ctx: AgentContext; calls: Call[] } {
  const calls: Call[] = [];
  const commands = {
    editMediaAsset: (...args: unknown[]) => { calls.push({ fn: 'editMediaAsset', args }); },
    removeMediaAsset: (...args: unknown[]) => { calls.push({ fn: 'removeMediaAsset', args }); },
  };
  const ctx = { getDoc: () => ({ assets }), getState: () => ({ items }), commands } as unknown as AgentContext;
  return { ctx, calls };
}

const run = (ctx: AgentContext, args: Record<string, unknown>) => execEditAssetTool('edit_asset', args, ctx);

// update name + props(merge)
{
  const { ctx, calls } = makeCtx([mg], []);
  const r = await run(ctx, { action: 'update', assetId: 'mg_1', name: 'New', props: { color: 'red' } }) as { updated?: string[] };
  assert.deepEqual(calls[0], { fn: 'editMediaAsset', args: ['mg_1', { name: 'New', props: { color: 'red' } }] }, 'update patches name+props');
  assert.ok(r.updated?.includes('name'));
}

// update code on non-MG asset → error, no mutation
{
  const { ctx, calls } = makeCtx([vid], []);
  const r = await run(ctx, { action: 'update', assetId: 'vid_1', code: 'const T=()=>null;' }) as { error?: string };
  assert.ok(r.error && /not a code/.test(r.error), 'video asset rejects code');
  assert.equal(calls.length, 0, 'no mutation on rejected code');
}

// delete unreferenced → removes
{
  const { ctx, calls } = makeCtx([vid], []);
  const r = await run(ctx, { action: 'delete', assetId: 'vid_1' }) as { ok?: boolean };
  assert.ok(r.ok);
  assert.equal(calls[0].fn, 'removeMediaAsset');
}

// delete referenced without confirm → needsConfirm, NO mutation
{
  const items = [{ id: 'i1', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'x', kind: 'motion-graphic', templateId: 'mg_1' }] as unknown as TimelineItem[];
  const { ctx, calls } = makeCtx([mg], items);
  const r = await run(ctx, { action: 'delete', assetId: 'mg_1' }) as { needsConfirm?: boolean; referencedBy?: number };
  assert.equal(r.needsConfirm, true, 'referenced delete needs confirm');
  assert.equal(r.referencedBy, 1);
  assert.equal(calls.length, 0, 'no delete without confirm');
}

// delete referenced WITH confirm → removes
{
  const items = [{ id: 'i1', track: 'V1', startFrame: 0, durationInFrames: 90, name: 'x', kind: 'motion-graphic', templateId: 'mg_1' }] as unknown as TimelineItem[];
  const { ctx, calls } = makeCtx([mg], items);
  const r = await run(ctx, { action: 'delete', assetId: 'mg_1', confirm: true }) as { ok?: boolean; wasReferencedBy?: number };
  assert.ok(r.ok);
  assert.equal(r.wasReferencedBy, 1);
  assert.equal(calls[0].fn, 'removeMediaAsset');
}

// unknown asset → error
{
  const { ctx } = makeCtx([mg], []);
  const r = await run(ctx, { action: 'delete', assetId: 'ghost' }) as { error?: string };
  assert.ok(r.error);
}

// eslint-disable-next-line no-console
console.log('edit-asset-tools.check: ok');
