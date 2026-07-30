// 多机位工具:multicam_sync(音频交叉相关对齐,挪 startFrame)与 change_cam
// (机位切换:区间内删其他机位的遮挡段,split/remove 无波纹 batch,一步撤销)。
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';
import { coveredFrames, planCamSwitch } from '../../editor/camSwitch';
import type { TimelineItem, TimelineState } from '../../editor/types';

export const MULTICAM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'multicam_sync',
    description: [
      'Audio-based multicam alignment. Pass 2+ video/audio itemIds from the same take;',
      'optionally set referenceItemId (defaults to first video). Repositions each follower so its picture matches',
      'the reference audio. Runs in the editor only — no cloud job. After a cut in the reference, split cutaways',
      'first then sync each piece. Returns synced/skipped ids and lag diagnostics.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Timeline item ids for all angles (reference + followers). At least 2.',
        },
        referenceItemId: {
          type: 'string',
          description: 'Optional reference angle id (must be in itemIds). Defaults to first video clip.',
        },
      },
      required: ['itemIds'],
    },
  },
  {
    name: 'change_cam',
    description: [
      'Multicam camera switch: within [fromSeconds,toSeconds) make targetItemId the visible angle by removing',
      'the overlapping segments of the OTHER listed angle clips (split at the range bounds, remove without ripple —',
      'nothing else on the timeline moves; ONE undoable batch). Angles must be video clips, aligned first via',
      'multicam_sync; clips sharing the target\'s source file count as the target angle. Audio tracks are untouched,',
      'so keep the program/reference audio on its own audio track. Call once per switch point to assemble a program.',
      'toSeconds defaults to the end of the listed group. Warns when the target does not cover the whole range.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Current clip ids of ALL angles in the multicam group (target + others). At least 2.',
        },
        targetItemId: { type: 'string', description: 'The angle to show in the range (must be in itemIds).' },
        fromSeconds: { type: 'number', description: 'Switch start, timeline seconds.' },
        toSeconds: { type: 'number', description: 'Switch end (exclusive), timeline seconds. Default: end of the group.' },
      },
      required: ['itemIds', 'targetItemId', 'fromSeconds'],
    },
  },
];

export const MULTICAM_TOOL_NAMES = new Set(MULTICAM_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

export async function execMulticamTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'change_cam') return execChangeCam(args, ctx);
  if (name !== 'multicam_sync') return { error: `unknown tool ${name}` };
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  if (rawIds.length < 2) return { error: 'itemIds needs at least 2 clips' };
  const ref = args.referenceItemId !== undefined ? String(args.referenceItemId) : undefined;
  if (ref && !rawIds.some((id) => id === ref || id.startsWith(ref) || ref.startsWith(id))) {
    return { error: 'referenceItemId must be included in itemIds' };
  }

  const state = ctx.getState();
  // Resolve short ids
  const resolved: string[] = [];
  for (const id of rawIds) {
    const hit = state.items.find((x) => x.id === id || x.id.startsWith(id));
    if (!hit) return { error: `item not found: ${id}` };
    if (!canMulticamItem(hit)) return { error: `item ${hit.id} is not video/audio with media` };
    if (state.tracks?.[hit.track]?.locked) return { error: `track ${hit.track} is locked` };
    resolved.push(hit.id);
  }

  const result = await runMulticamSync({
    state,
    itemIds: resolved,
    referenceItemId: ref,
  });

  if (result.changed && result.nextState) {
    ctx.commands.applyState(result.nextState);
  }

  return {
    ok: result.status === 'applied' || result.status === 'partial' || result.status === 'already_synced',
    status: result.status,
    changed: result.changed,
    referenceItemId: result.referenceItemId,
    syncedItemIds: result.syncedItemIds,
    skippedItemIds: result.skippedItemIds,
    offsets: result.offsets,
    message: result.message,
  };
}

/** change_cam 边界校验 + 规划 + 单 batch 提交(exported for verify)。 */
export function execChangeCam(args: Args, ctx: Pick<AgentContext, 'getState' | 'commands'>): unknown {
  const state: TimelineState = ctx.getState();
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  if (rawIds.length < 2) return { error: 'itemIds needs at least 2 angle clips (target + others)' };
  const group: TimelineItem[] = [];
  for (const id of rawIds) {
    const hit = state.items.find((x) => x.id === id || x.id.startsWith(id));
    if (!hit) return { error: `item not found: ${id}` };
    if (hit.kind !== 'video') return { error: `change_cam angles must be video clips; ${hit.id} is ${hit.kind}` };
    if (state.tracks?.[hit.track]?.locked) return { error: `track ${hit.track} is locked` };
    if (!group.some((g) => g.id === hit.id)) group.push(hit);
  }
  const targetRef = String(args.targetItemId ?? '');
  const target = targetRef ? group.find((g) => g.id === targetRef || g.id.startsWith(targetRef)) : undefined;
  if (!target) return { error: 'targetItemId must be one of itemIds' };

  const fps = state.fps || 30;
  const fromSecondsRaw = Number(args.fromSeconds);
  if (!Number.isFinite(fromSecondsRaw) || fromSecondsRaw < 0) return { error: 'fromSeconds must be a finite number ≥ 0' };
  const groupEnd = Math.max(...group.map((g) => g.startFrame + g.durationInFrames));
  const toSecondsRaw = args.toSeconds === undefined ? groupEnd / fps : Number(args.toSeconds);
  if (!Number.isFinite(toSecondsRaw)) return { error: 'toSeconds must be a finite number' };
  const fromFrame = Math.max(0, Math.round(fromSecondsRaw * fps));
  const toFrame = Math.min(groupEnd, Math.round(toSecondsRaw * fps));
  if (toFrame - fromFrame < 1) return { error: `empty switch range (${fromSecondsRaw}s → ${toSecondsRaw}s)` };

  // 同一源文件的段都算目标机位(此前的切换会把一个机位切成多段)
  const isTargetAngle = (it: TimelineItem) => it.id === target.id || (!!target.src && it.src === target.src);
  const targets = group.filter(isTargetAngle);
  const others = group.filter((it) => !isTargetAngle(it));
  if (!others.length) return { error: 'itemIds must include at least one other angle besides the target' };
  if (coveredFrames(targets, fromFrame, toFrame) === 0) {
    return { error: 'target angle has no clip in the switch range — switching would show black' };
  }

  const plan = planCamSwitch(targets, others, fromFrame, toFrame, () => crypto.randomUUID());
  const sec = (f: number) => Math.round((f / fps) * 100) / 100;
  if (!plan.actions.length) {
    return { ok: true, changed: false, removedSegments: [], message: 'target is already the only listed angle in the range' };
  }
  ctx.commands.batch(plan.actions, '切换机位');
  const gapNote = plan.coverageGapFrames > 0
    ? `; WARNING: ${sec(plan.coverageGapFrames)}s of the range has no target coverage (lower layers or black will show)`
    : '';
  return {
    ok: true,
    changed: true,
    targetItemId: target.id,
    fromSeconds: sec(fromFrame),
    toSeconds: sec(toFrame),
    removedSegments: plan.removed.map((r) => ({ itemId: r.itemId, fromSeconds: sec(r.fromFrame), toSeconds: sec(r.toFrame) })),
    coverageGapSeconds: sec(plan.coverageGapFrames),
    message: `switched to "${target.name}" for ${sec(fromFrame)}s–${sec(toFrame)}s (${plan.removed.length} segment(s) of other angles removed)${gapNote}`,
  };
}
