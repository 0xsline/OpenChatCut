export { MULTICAM_TOOL_SCHEMAS, MULTICAM_TOOL_NAMES } from './schemas/multicam-tools';
// Professional timeline tools: persistent multicam sync/switch and linked edit groups.
import type { AgentContext } from '../context';
import { setLinkGroup, unlinkItems } from '../../editor/linkGroups';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';
import { planPersistentCamSwitch } from '../../multicam/changeCam';
import { coveredFrames, planCamSwitch } from '../../editor/camSwitch';
import type { TimelineItem, TimelineState } from '../../editor/types';

type Args = Record<string, unknown>;

let fallbackId = 0;
const makeId = (): string => globalThis.crypto?.randomUUID?.()
  ?? `timeline_group_${Date.now().toString(36)}_${fallbackId++}`;

function resolveItemIds(state: TimelineState, rawIds: readonly string[]): { ids: string[] } | { error: string } {
  const ids: string[] = [];
  for (const id of rawIds) {
    const hit = state.items.find((item) => item.id === id || item.id.startsWith(id));
    if (!hit) return { error: `item not found: ${id}` };
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids };
}

function execManageLinkGroup(args: Args, ctx: Pick<AgentContext, 'getState' | 'commands'>): unknown {
  const state = ctx.getState();
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  const resolved = resolveItemIds(state, rawIds);
  if ('error' in resolved) return resolved;
  const action = String(args.action ?? '');
  if (action === 'unlink') {
    if (!resolved.ids.length) return { error: 'unlink needs at least 1 item' };
    const next = unlinkItems(state, resolved.ids);
    if (next !== state) ctx.commands.applyState(next);
    return { ok: true, changed: next !== state, itemIds: resolved.ids };
  }
  const mode = action === 'link' ? 'linked' : action === 'sync_lock' ? 'sync-lock' : null;
  if (!mode) return { error: 'action must be link|sync_lock|unlink' };
  if (resolved.ids.length < 2) return { error: `${action} needs at least 2 items` };
  const anchorRef = String(args.anchorItemId ?? '');
  const anchor = anchorRef
    ? resolved.ids.find((id) => id === anchorRef || id.startsWith(anchorRef))
    : resolved.ids[0];
  if (!anchor) return { error: 'anchorItemId must be included in itemIds' };
  const groupId = makeId();
  const next = setLinkGroup(state, { id: groupId, itemIds: resolved.ids, anchorItemId: anchor, mode });
  if (next !== state) ctx.commands.applyState(next);
  return { ok: true, changed: next !== state, groupId, mode, anchorItemId: anchor, itemIds: resolved.ids };
}

type MulticamSyncSnapshot = {
  projectId: string | null;
  timelineId: string | null;
  projectRevision: string;
  stateRevision: string;
  state: TimelineState;
};

/**
 * Capture immutable serialized revisions rather than retaining object identity:
 * nested editor state may be mutated in place while audio decode/alignment is
 * awaiting. The full state covers items, tracks (including locks), multicam
 * groups and item/asset source revisions.
 */
function captureMulticamSyncSnapshot(
  ctx: Pick<AgentContext, 'getProjectId' | 'getDoc' | 'getState'>,
): MulticamSyncSnapshot {
  const projectId = ctx.getProjectId?.() ?? null;
  const doc = ctx.getDoc();
  const state = ctx.getState();
  const stateTimelineId = (state as TimelineState & { id?: unknown }).id;
  return {
    projectId,
    timelineId: typeof stateTimelineId === 'string' ? stateTimelineId : doc.activeTimelineId ?? null,
    projectRevision: JSON.stringify(doc),
    stateRevision: JSON.stringify(state),
    state,
  };
}

function staleMulticamSyncReason(
  captured: MulticamSyncSnapshot,
  current: MulticamSyncSnapshot,
): 'project_changed' | 'timeline_changed' | 'timeline_state_changed' | 'project_state_changed' | null {
  if (captured.projectId !== current.projectId) return 'project_changed';
  if (captured.timelineId !== current.timelineId) return 'timeline_changed';
  if (captured.stateRevision !== current.stateRevision) return 'timeline_state_changed';
  if (captured.projectRevision !== current.projectRevision) return 'project_state_changed';
  return null;
}

export async function execMulticamTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'change_cam') return execChangeCam(args, ctx);
  if (name === 'manage_link_group') return execManageLinkGroup(args, ctx);
  if (name !== 'multicam_sync') return { error: `unknown tool ${name}` };
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  if (rawIds.length < 2) return { error: 'itemIds needs at least 2 clips' };
  const ref = args.referenceItemId !== undefined ? String(args.referenceItemId) : undefined;
  if (ref && !rawIds.some((id) => id === ref || id.startsWith(ref) || ref.startsWith(id))) {
    return { error: 'referenceItemId must be included in itemIds' };
  }
  const master = args.masterItemId !== undefined ? String(args.masterItemId) : undefined;
  if (master && !rawIds.some((id) => id === master || id.startsWith(master) || master.startsWith(id))) {
    return { error: 'masterItemId must be included in itemIds' };
  }

  const captured = captureMulticamSyncSnapshot(ctx);
  const state = captured.state;
  // Resolve short ids
  const resolved: string[] = [];
  for (const id of rawIds) {
    const hit = state.items.find((x) => x.id === id || x.id.startsWith(id));
    if (!hit) return { error: `item not found: ${id}` };
    if (!canMulticamItem(hit)) return { error: `item ${hit.id} is not video/audio with media` };
    if (state.tracks?.[hit.track]?.locked) return { error: `track ${hit.track} is locked` };
    resolved.push(hit.id);
  }
  const resolvedRef = ref
    ? state.items.find((item) => item.id === ref || item.id.startsWith(ref))?.id
    : undefined;
  const resolvedMaster = master
    ? state.items.find((item) => item.id === master || item.id.startsWith(master))?.id
    : undefined;
  const groupRef = args.groupId !== undefined ? String(args.groupId) : undefined;
  const resolvedGroupId = groupRef
    ? state.multicamGroups?.find((group) => group.id === groupRef || group.id.startsWith(groupRef))?.id
    : undefined;
  if (groupRef && !resolvedGroupId) return { error: `multicam group not found: ${groupRef}` };

  const result = await runMulticamSync({
    state,
    itemIds: resolved,
    referenceItemId: resolvedRef,
    groupId: resolvedGroupId,
    masterItemId: resolvedMaster,
  });

  // No asynchronous work may inspect or commit the result before refreshing the
  // live editor snapshot. There is no await between this guard and applyState.
  const current = captureMulticamSyncSnapshot(ctx);
  const staleReason = staleMulticamSyncReason(captured, current);
  if (staleReason) {
    return {
      ok: false,
      code: 'stale',
      status: 'stale',
      stale: true,
      retryable: true,
      changed: false,
      reason: staleReason,
      projectId: captured.projectId,
      currentProjectId: current.projectId,
      timelineId: captured.timelineId,
      currentTimelineId: current.timelineId,
      message: 'Project or timeline changed while multicam sync was running; retry against the current state.',
    };
  }

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
    groupId: result.groupId,
    message: result.message,
    methods: [...new Set(result.offsets.map((offset) => offset.method))],
  };
}

/** change_cam boundary verification + planning + single batch submission (exported for verify).*/
export function execChangeCam(args: Args, ctx: Pick<AgentContext, 'getState' | 'commands'>): unknown {
  const state: TimelineState = ctx.getState();
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  const groupRef = String(args.groupId ?? '');
  const persistentGroup = groupRef
    ? state.multicamGroups?.find((entry) => entry.id === groupRef || entry.id.startsWith(groupRef))
    : state.multicamGroups?.find((entry) => {
        const matched = new Set(rawIds.flatMap((id) => {
          const angle = entry.angles.find((candidate) =>
            candidate.id === id || candidate.itemId === id
            || candidate.id.startsWith(id) || candidate.itemId.startsWith(id));
          const live = state.items.find((item) => (item.id === id || item.id.startsWith(id))
            && item.multicamGroupId === entry.id);
          return angle ? [angle.id] : live?.multicamAngleId ? [live.multicamAngleId] : [];
        }));
        return matched.size >= 2;
      });
  if (groupRef && !persistentGroup) return { error: `multicam group not found: ${groupRef}` };
  if (persistentGroup) {
    const targetRef = String(args.targetAngleId ?? args.targetItemId ?? '');
    const angle = persistentGroup.angles.find((entry) =>
      entry.id === targetRef || entry.itemId === targetRef
      || entry.id.startsWith(targetRef) || entry.itemId.startsWith(targetRef));
    if (!targetRef || !angle) return { error: 'targetAngleId must be an angle in the multicam group' };
    if (angle.source.kind !== 'video') return { error: `change_cam angles must be video clips; ${angle.itemId} is ${angle.source.kind}` };
    const fps = state.fps || 30;
    const fromSecondsRaw = Number(args.fromSeconds);
    if (!Number.isFinite(fromSecondsRaw) || fromSecondsRaw < 0) return { error: 'fromSeconds must be a finite number ≥ 0' };
    const sourceEnd = angle.source.startFrame + angle.source.durationInFrames;
    const toSecondsRaw = args.toSeconds === undefined ? sourceEnd / fps : Number(args.toSeconds);
    if (!Number.isFinite(toSecondsRaw)) return { error: 'toSeconds must be a finite number' };
    const fromFrame = Math.max(0, Math.round(fromSecondsRaw * fps));
    const toFrame = Math.round(toSecondsRaw * fps);
    const plan = planPersistentCamSwitch({
      state,
      groupId: persistentGroup.id,
      angleId: angle.id,
      fromFrame,
      toFrame,
      makeId,
    });
    if ('error' in plan) return plan;
    ctx.commands.applyState(plan.nextState);
    const sec = (frame: number) => Math.round((frame / fps) * 100) / 100;
    return {
      ok: true,
      changed: true,
      groupId: persistentGroup.id,
      targetAngleId: angle.id,
      targetItemId: angle.itemId,
      fromSeconds: sec(fromFrame),
      toSeconds: sec(toFrame),
      removedSegments: plan.removed.map((removed) => ({
        itemId: removed.itemId,
        fromSeconds: sec(removed.fromFrame),
        toSeconds: sec(removed.toFrame),
      })),
      restoredItemIds: plan.restoredItemIds,
      decision: plan.group.decisions?.find((decision) =>
        decision.angleId === angle.id && decision.fromFrame <= fromFrame && decision.toFrame >= toFrame),
      syncEvidence: plan.group.evidence.filter((evidence) => evidence.angleId === angle.id),
      message: `switched persistent multicam angle "${angle.label}" for ${sec(fromFrame)}s–${sec(toFrame)}s`,
    };
  }
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

  // Segments of the same source file are all considered target cameras (previous switching will cut one camera into multiple segments)
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
