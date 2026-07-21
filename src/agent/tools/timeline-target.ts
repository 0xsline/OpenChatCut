import type { AgentContext } from '../context';
import { activeTimeline, type Timeline } from '../../editor/types';

/** Resolve an optional timeline id/prefix without changing the active timeline.
 * The active timeline uses the live editor state so pending edits are included;
 * non-active timelines come from the project document. */
export function resolveTimeline(ctx: AgentContext, timelineId?: string): Timeline {
  const doc = ctx.getDoc();
  if (!timelineId) {
    const live = ctx.getState();
    const active = activeTimeline(doc);
    return {
      ...live,
      id: active.id,
      name: active.name,
      order: active.order,
    };
  }

  const query = timelineId.trim();
  const hit = doc.timelines.find((timeline) => timeline.id === query || timeline.id.startsWith(query));
  if (!hit) throw new Error(`timeline not found: ${timelineId}`);
  return hit;
}

