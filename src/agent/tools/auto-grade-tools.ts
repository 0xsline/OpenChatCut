export { AUTO_GRADE_TOOL_SCHEMAS, AUTO_GRADE_TOOL_NAMES } from './schemas/auto-grade-tools';
import type { AgentContext } from '../context';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { analyzeAutoGrade, type AutoGradeResponse } from '../../color/autoGrade';
import { sourceWindowForTimelineRange } from '../../editor/sourceLimit';

type Args = Record<string, unknown>;

function isAutoGradeTarget(item: TimelineItem, state: TimelineState): boolean {
  if (item.kind !== 'video' && item.kind !== 'image' && item.kind !== 'gif') return false;
  if (state.tracks?.[item.track]?.locked) return false;
  return /^\/media\/uploads\/[^/]+(?:\?.*)?$/.test(item.src ?? '');
}

function parseItemRefs(raw: unknown): string[] {
  return String(raw ?? '').split(',').map((id) => id.trim()).filter(Boolean);
}

function resolveTargets(state: TimelineState, refs: string[]): { targets: TimelineItem[]; missing: string[] } {
  if (!refs.length) {
    return { targets: state.items.filter((item) => isAutoGradeTarget(item, state)), missing: [] };
  }
  const targets: TimelineItem[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const hits = state.items.filter((item) => item.id === ref || item.id.startsWith(ref));
    if (hits.length === 1) {
      const item = hits[0]!;
      if (!isAutoGradeTarget(item, state)) {
        missing.push(`${ref} (not eligible: need unlocked video/image/gif under /media/uploads)`);
      } else {
        targets.push(item);
      }
    } else if (hits.length === 0) {
      missing.push(ref);
    } else {
      missing.push(`${ref} (ambiguous: ${hits.slice(0, 4).map((h) => h.id).join(',')})`);
    }
  }
  return { targets, missing };
}

export async function execAutoGradeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'auto_grade') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');
  if (action !== 'analyze' && action !== 'apply') {
    return { error: 'action must be analyze or apply' };
  }
  const state = ctx.getState();
  const { targets, missing } = resolveTargets(state, parseItemRefs(args.itemIds));
  if (!targets.length) {
    return {
      error: missing.length
        ? `no eligible clips; issues: ${missing.join('; ')}`
        : 'no eligible clips — need unlocked video/image/gif with /media/uploads src (import media first)',
      missing,
    };
  }

  const fps = state.fps || 30;
  const cache = new Map<string, Promise<AutoGradeResponse>>();
  const recommendations: Array<{
    itemId: string;
    name: string;
    filters: AutoGradeResponse['filters'];
    adjustments: string[];
    profile: AutoGradeResponse['profile'];
    stats: AutoGradeResponse['stats'];
  }> = [];
  const failures: Array<{ itemId: string; error: string }> = [];

  for (const item of targets) {
    const window = sourceWindowForTimelineRange(item, 0, item.durationInFrames);
    const startSeconds = window.startFrame / fps;
    const durationSeconds = Math.max(1 / fps, (window.endFrame - window.startFrame) / fps);
    const cacheKey = `${item.src}\u0000${startSeconds.toFixed(3)}\u0000${durationSeconds.toFixed(3)}`;
    try {
      let pending = cache.get(cacheKey);
      if (!pending) {
        pending = analyzeAutoGrade({ src: item.src!, startSeconds, durationSeconds });
        cache.set(cacheKey, pending);
      }
      const analysis = await pending;
      recommendations.push({
        itemId: item.id,
        name: item.name,
        filters: analysis.filters,
        adjustments: analysis.adjustments,
        profile: analysis.profile,
        stats: analysis.stats,
      });
    } catch (error) {
      failures.push({
        itemId: item.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!recommendations.length) {
    return {
      error: 'auto grade analysis failed for all targets',
      failures,
      missing,
    };
  }

  if (action === 'analyze') {
    return {
      ok: true,
      action,
      applied: false,
      recommendations,
      failedCount: failures.length,
      failures: failures.length ? failures : undefined,
      missing: missing.length ? missing : undefined,
      note: 'Preview only — call auto_grade action=apply to write filters (or edit_item updates with filters).',
    };
  }

  ctx.commands.batch(
    recommendations.map((row) => ({
      type: 'setFilters' as const,
      id: row.itemId,
      patch: row.filters,
    })),
    'Apply automatic color correction',
  );

  return {
    ok: true,
    action,
    applied: true,
    appliedCount: recommendations.length,
    recommendations: recommendations.map((row) => ({
      itemId: row.itemId,
      name: row.name,
      filters: row.filters,
      adjustments: row.adjustments,
    })),
    failedCount: failures.length,
    failures: failures.length ? failures : undefined,
    missing: missing.length ? missing : undefined,
    note: 'Filters committed as one undo step. Verify with inspect_color or view_timeline_frames.',
  };
}
