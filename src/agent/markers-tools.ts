import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { MARKER_HEX, type Marker, type MarkerColor } from '../editor/types';

// manage_markers — 时间线批注(点/段),锚在帧上或某 clip 上(source manage_markers,
// 契约 marker-note-v2)。规格 §5:action + fromFrame/durationFrames/note/itemId +
// markers/updates(批量)。编辑层已全就绪(Marker 类型 + reducer addMarker/updateMarker/
// removeMarker + store 命令),这里只做薄 agent 包装:list/create/update/delete。
// transcriptSegments 锚转写段暂略(自定简化),用 fromFrame 直锚;批量走 markers/updates。

type Args = Record<string, unknown>;

const COLORS = Object.keys(MARKER_HEX) as MarkerColor[];

export const MARKERS_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'manage_markers',
    description: [
      '时间线批注/TODO 锚点(source manage_markers)。marker = 点(durationFrames 0)或段(>0),',
      'scope=project 锚在标尺帧上,scope=item 锚在某 clip 上。',
      'action: list(列全部) | create(建;可传 markers[] 批量) | update(改;可传 updates[] 批量) | delete(删)。',
      `color 取 ${COLORS.join('/')} 之一。`,
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        fromFrame: { type: 'number', description: 'create: 锚定帧(必填)。' },
        durationFrames: { type: 'number', description: '段长;0 或省略 = 点标记。' },
        note: { type: 'string', description: '批注文字。' },
        color: { type: 'string', enum: COLORS },
        scope: { type: 'string', enum: ['project', 'item'], description: 'item 需配 itemId。默认 project。' },
        itemId: { type: 'string', description: 'scope=item 时锚定的 clip id。' },
        markerId: { type: 'string', description: 'update/delete 的目标 marker id。' },
        markers: {
          type: 'array',
          description: 'create 批量:每项 {fromFrame, note?, color?, durationFrames?, scope?, itemId?}。',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description: 'update 批量:每项 {id, note?, color?, fromFrame?, durationFrames?}。',
          items: { type: 'object' },
        },
      },
      required: ['action'],
    },
  },
];

export const MARKERS_TOOL_NAMES = new Set(MARKERS_TOOL_SCHEMAS.map((t) => t.name));

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const color = (v: unknown): MarkerColor | undefined => (COLORS.includes(v as MarkerColor) ? (v as MarkerColor) : undefined);

/** create opts from a raw object (single arg or one batch entry). */
function createOpts(o: Args): { fromFrame: number; opts: Parameters<AgentContext['commands']['addMarker']>[1] } | { error: string } {
  const fromFrame = num(o.fromFrame);
  if (fromFrame === undefined) return { error: 'create requires numeric fromFrame' };
  const scope = o.scope === 'item' ? 'item' : 'project';
  if (scope === 'item' && !str(o.itemId)) return { error: 'scope "item" requires itemId' };
  return { fromFrame, opts: { note: str(o.note), color: color(o.color), durationFrames: num(o.durationFrames), scope, itemId: str(o.itemId) } };
}

/** update patch (only whitelisted, validated fields). */
function updatePatch(o: Args): Partial<Marker> {
  const patch: Partial<Marker> = {};
  const n = str(o.note); if (n !== undefined) patch.note = n;
  const c = color(o.color); if (c !== undefined) patch.color = c;
  const f = num(o.fromFrame); if (f !== undefined) patch.fromFrame = f;
  const d = num(o.durationFrames); if (d !== undefined) patch.durationFrames = d;
  return patch;
}

const summarize = (m: Marker) => ({ id: m.id, scope: m.scope, itemId: m.itemId ?? null, fromFrame: m.fromFrame, durationFrames: m.durationFrames, note: m.note, color: m.color });

export function execMarkersTool(name: string, args: Args, ctx: AgentContext): unknown {
  if (name !== 'manage_markers') return { error: `unknown tool ${name}` };
  const markers = ctx.getState().markers ?? [];

  switch (String(args.action ?? '')) {
    case 'list':
      return { markers: markers.map(summarize) };

    case 'create': {
      const batch = Array.isArray(args.markers) ? (args.markers as Args[]) : [args];
      const ids: string[] = [];
      for (const raw of batch) {
        const built = createOpts(raw);
        if ('error' in built) return { error: built.error };
        ids.push(ctx.commands.addMarker(built.fromFrame, built.opts));
      }
      return { ok: true, created: ids };
    }

    case 'update': {
      const batch = Array.isArray(args.updates) ? (args.updates as Args[]) : [args];
      const updated: string[] = [];
      for (const raw of batch) {
        const id = str(raw.markerId) ?? str(raw.id);
        if (!id) return { error: 'update requires markerId' };
        if (!markers.some((m) => m.id === id)) return { error: `no marker ${id}` };
        ctx.commands.updateMarker(id, updatePatch(raw));
        updated.push(id);
      }
      return { ok: true, updated };
    }

    case 'delete': {
      const id = str(args.markerId);
      if (!id) return { error: 'delete requires markerId' };
      if (!markers.some((m) => m.id === id)) return { error: `no marker ${id}` };
      ctx.commands.removeMarker(id);
      return { ok: true, deleted: id };
    }

    default:
      return { error: `unknown action "${args.action}"; use list|create|update|delete` };
  }
}
