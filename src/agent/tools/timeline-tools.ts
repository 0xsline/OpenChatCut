export { TIMELINE_TOOL_SCHEMAS, TIMELINE_TOOL_NAMES } from './schemas/timeline-tools';
import type { AgentContext } from '../context';
import { ASPECT_PRESETS, ratioLabel, timelineDuration, type AspectFit, type ProjectDoc, type Timeline } from '../../editor/types';

// manage_timelines — ONE action-based tool, not separate create/switch tools.
// Mutating actions flow through propose→apply via the project-level draft;
// list/switch behave directly.
// `projectId` is omitted because external MCP session targeting is handled elsewhere;
// these tools always operate on the open project.

type Args = Record<string, unknown>;

/** ratio preset OR explicit width/height → canvas dims (null = nothing requested) */
function resolveDims(a: { ratio?: unknown; width?: unknown; height?: unknown }): { width: number; height: number } | null | { error: string } {
  if (typeof a.ratio === 'string' && a.ratio) {
    const preset = ASPECT_PRESETS.find((p) => p.label === a.ratio);
    return preset ? { width: preset.width, height: preset.height } : { error: `unknown ratio ${a.ratio}（可选 ${ASPECT_PRESETS.map((p) => p.label).join('/')}）` };
  }
  if (typeof a.width === 'number' && typeof a.height === 'number' && a.width > 0 && a.height > 0) {
    return { width: Math.round(a.width), height: Math.round(a.height) };
  }
  return null;
}

function findTimeline(doc: ProjectDoc, id: unknown): Timeline | null {
  const q = String(id ?? '');
  if (!q) return null;
  return doc.timelines.find((t) => t.id === q || t.id.startsWith(q) || t.name === q) ?? null;
}

const describe = (t: Timeline, doc: ProjectDoc) => ({
  id: t.id, name: t.name, width: t.width, height: t.height, ratio: ratioLabel(t.width, t.height),
  active: t.id === doc.activeTimelineId, hidden: t.hidden ?? false,
  clips: t.items.length, durationInFrames: timelineDuration(t),
});

export async function execTimelineTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_timelines') return { error: `unknown tool ${name}` };
  const doc = ctx.getDoc();
  switch (String(args.action)) {
    case 'list':
      return [...doc.timelines].sort((a, b) => a.order - b.order).map((t) => describe(t, doc));

    case 'create': {
      // one entry from top-level args, or several from `timelines`
      const entries: Args[] = Array.isArray(args.timelines) && args.timelines.length
        ? (args.timelines as Args[])
        : [{ name: args.name, ratio: args.ratio, width: args.width, height: args.height }];
      const createdIds: string[] = [];
      for (const [i, e] of entries.entries()) {
        const dims = resolveDims(e);
        if (dims && 'error' in dims) return dims;
        const last = i === entries.length - 1;
        createdIds.push(ctx.commands.createTimeline({
          name: typeof e.name === 'string' ? e.name : undefined,
          ...(dims ?? {}),
          activate: last ? args.activate !== false : false, // batch: only the last entry activates
        }));
      }
      const after = ctx.getDoc();
      return { ok: true, created: createdIds.map((id) => { const t = findTimeline(after, id); return t ? describe(t, after) : id; }) };
    }

    case 'duplicate': {
      const src = findTimeline(doc, args.timelineId);
      if (!src) return { error: `no timeline ${args.timelineId}`, available: doc.timelines.map((t) => ({ id: t.id, name: t.name })) };
      const newId = ctx.commands.duplicateTimeline(src.id, {
        name: typeof args.name === 'string' ? args.name : undefined,
        activate: args.activate !== false,
      });
      const after = ctx.getDoc();
      const copy = findTimeline(after, newId);
      return copy ? { ok: true, duplicated: describe(copy, after) } : { ok: true, duplicated: newId };
    }

    case 'switch': {
      const t = findTimeline(doc, args.timelineId);
      if (!t) return { error: `no timeline ${args.timelineId}`, available: doc.timelines.map((x) => ({ id: x.id, name: x.name })) };
      ctx.commands.switchTimeline(t.id);
      return { ok: true, active: describe(t, ctx.getDoc()) };
    }

    case 'update': {
      const t = args.timelineId ? findTimeline(doc, args.timelineId) : findTimeline(doc, doc.activeTimelineId);
      if (!t) return { error: `no timeline ${args.timelineId}` };
      const changed: string[] = [];
      if (typeof args.name === 'string' && args.name.trim()) {
        ctx.commands.renameTimeline(t.id, args.name.trim());
        changed.push('name');
      }
      const dims = resolveDims(args);
      if (dims && 'error' in dims) return dims;
      const fit = typeof args.fit === 'string' ? (args.fit as AspectFit) : undefined;
      if (dims) {
        ctx.commands.retargetTimeline(t.id, dims.width, dims.height, fit);
        changed.push('canvas');
      } else if (fit) {
        ctx.commands.retargetTimeline(t.id, t.width, t.height, fit); // fit-only change
        changed.push('fit');
      }
      if (typeof args.hidden === 'boolean') {
        ctx.commands.setTimelineHidden(t.id, args.hidden);
        changed.push('hidden');
      }
      if (!changed.length) return { error: 'update 需要 name / ratio / width+height / fit / hidden 至少一项' };
      const after = ctx.getDoc();
      const updated = findTimeline(after, t.id);
      return { ok: true, changed, timeline: updated ? describe(updated, after) : t.id };
    }

    case 'delete': {
      const ids = Array.isArray(args.timelineIds) && args.timelineIds.length ? args.timelineIds : [args.timelineId];
      const deleted: string[] = [];
      const kept: string[] = [];
      for (const raw of ids) {
        const cur = ctx.getDoc();
        const t = findTimeline(cur, raw);
        if (!t) { kept.push(String(raw)); continue; }
        if (cur.timelines.length <= 1) { kept.push(t.name); continue; } // keep ≥1 (reducer guards too)
        ctx.commands.deleteTimeline(t.id);
        deleted.push(t.name);
      }
      return { ok: deleted.length > 0, deleted, ...(kept.length ? { kept, note: '至少保留一条序列/未找到的已跳过' } : {}) };
    }

    default:
      return { error: `unknown action ${args.action}（可选 list/create/duplicate/switch/update/delete）` };
  }
}
