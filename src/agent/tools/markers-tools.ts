import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { MARKER_HEX, type Marker, type MarkerColor, type Timeline, type TimelineState } from '../../editor/types';
import { makeDraft } from '../../editor/store';
import { buildModel, type SegRow } from '../../script/serialize';
import { makeWordFrameMapper } from './transcript-find';
import { resolveTimeline } from './timeline-target';

// manage_markers — 时间线批注(点/段),锚在帧上或某 clip 上，契约为 marker-note-v2。
// 参数包含 action + fromFrame/durationFrames/note/itemId +
// markers/updates(批量)。编辑层已全就绪(Marker 类型 + reducer addMarker/updateMarker/
// removeMarker + store 命令),这里只做薄 agent 包装:list/create/update/delete。
// transcript-backed notes:create 传 transcriptSegments("3"/"3-5"/逗号列表,
// 与 read_script 的 [sN] 同一套编号)即可省 fromFrame/note——帧位由词级时间戳换算
// (makeWordFrameMapper,与播放层共用映射),note 正文拷贝段文本,可挂 notePrefix 标签;
// transcriptTrack 过滤轨道。批量 markers[] 的每一项同样支持。

type Args = Record<string, unknown>;

const COLORS = Object.keys(MARKER_HEX) as MarkerColor[];

export const MARKERS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_markers',
    description: [
      '时间线批注/TODO 锚点(契约 marker-note-v2)。marker = 点(durationFrames 0)或段(>0),',
      'scope=project 锚在标尺帧上,scope=item 锚在某 clip 上。',
      'action: list(列全部) | create(建;可传 markers[] 批量) | update(改;可传 updates[] 批量) | delete(删)。',
      'transcript-backed notes:要给转写原句做批注时,传 transcriptSegments(Active Script 的 [sN] 段号)+ 可选 notePrefix,',
      '代替手写 note——fromFrame 自动取首个所选段的起点(显式传 fromFrame 则优先),note 正文从 read_script 输出拷贝。',
      `color 取 ${COLORS.join('/')} 之一。`,
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        timelineId: { type: 'string', description: '目标时间线 id 或前缀；省略时使用当前时间线，不会切换当前时间线。' },
        fromFrame: { type: 'number', description: 'Integer timeline frame to anchor the marker at (required for create unless transcriptSegments is used).' },
        durationFrames: { type: 'number', description: '段长;0 或省略 = 点标记(用 transcriptSegments 时默认覆盖所选段)。' },
        note: { type: 'string', description: 'Marker note text (required for create unless transcriptSegments is used).' },
        color: { type: 'string', enum: COLORS },
        scope: { type: 'string', enum: ['project', 'item'], description: 'item 需配 itemId。默认 project。' },
        itemId: { type: 'string', description: 'scope=item 时锚定的 clip id。' },
        markerId: { type: 'string', description: 'update/delete 的目标 marker id。' },
        transcriptSegments: { type: 'string', description: 'Active Script segment ids/ranges from timeline.md, e.g. "3-4"; note text is copied from read_script output.' },
        transcriptTrack: { type: 'string', description: 'Track filter for transcriptSegments, e.g. V1 or A1.' },
        notePrefix: { type: 'string', description: 'Optional label prefix when transcriptSegments derives the note body.' },
        markers: {
          type: 'array',
          description: 'create 批量:每项 {fromFrame?, note?, color?, durationFrames?, scope?, itemId?, transcriptSegments?, transcriptTrack?, notePrefix?};fromFrame 可省,用 transcriptSegments 定位。',
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

/** "3" / "3-5" / "2,4-6"(容忍 s 前缀,如 "s3-s4")→ 升序去重段号;非法返回 null。 */
function parseSegmentSpec(spec: string): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = /^\s*s?(\d+)(?:\s*-\s*s?(\d+))?\s*$/i.exec(part);
    if (!m) return null;
    const a = parseInt(m[1]!, 10);
    const b = m[2] ? parseInt(m[2]!, 10) : a;
    if (a < 1 || b < a) return null;
    for (let n = a; n <= b; n++) out.add(n);
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

interface SegmentAnchor { fromFrame: number; durationFrames: number; note: string }

/** transcriptSegments → {fromFrame, durationFrames, note}。段号与 read_script 的 [sN]
 *  同一套编号(buildModel);帧位经 makeWordFrameMapper 用词级时间戳换算(与播放层同源,
 *  保持词帧一致);note = 所选段的 keptText(即 read_script 显示的文本)。 */
function resolveTranscriptSegments(state: TimelineState, spec: string, trackFilter?: string): SegmentAnchor | { error: string } {
  const sns = parseSegmentSpec(spec);
  if (!sns) return { error: `transcriptSegments "${spec}" 无法解析——用 read_script 输出的 [sN] 编号,如 "3"、"3-5" 或 "2,4-6"` };
  const model = buildModel(state);
  const tracks = trackFilter ? model.filter((t) => t.track.toLowerCase() === trackFilter.toLowerCase()) : model;
  if (trackFilter && !tracks.length) return { error: `transcriptTrack "${trackFilter}" 不存在或该轨无内容` };

  // 每个转写 region(= 一个转写 clip)按 sn 建索引;候选 = 含全部所选段的 region
  const candidates: { track: string; itemId: string; rows: Map<number, SegRow> }[] = [];
  for (const t of tracks) {
    for (const region of t.regions) {
      const segRows = region.rows.filter((r): r is SegRow => r.kind === 'seg');
      if (!segRows.length) continue;
      const rows = new Map(segRows.map((r) => [r.sn, r]));
      if (sns.every((n) => rows.has(n))) candidates.push({ track: t.track, itemId: segRows[0]!.itemId, rows });
    }
  }
  if (!candidates.length) {
    return { error: `找不到同时包含段 ${sns.join(',')} 的转写区域——先 read_script 核对 [sN] 编号${trackFilter ? '' : ',或传 transcriptTrack 缩小范围'}` };
  }
  if (candidates.length > 1) {
    return { error: `段 ${sns.join(',')} 在多个转写区域出现(${candidates.map((c) => `${c.track}:${c.itemId.slice(0, 8)}`).join(' / ')})——传 transcriptTrack 消歧,或直接给 fromFrame` };
  }

  const cand = candidates[0]!;
  const item = state.items.find((it) => it.id === cand.itemId);
  if (!item?.transcript?.length) return { error: `转写区域对应的 clip ${cand.itemId} 已无转写,请重新 read_script` };
  const deleted = new Set(item.deletedWordIdx ?? []);
  const mapper = makeWordFrameMapper(item, state.fps);
  const firstRow = cand.rows.get(sns[0]!)!;
  const lastRow = cand.rows.get(sns[sns.length - 1]!)!;
  const firstGi = firstRow.wordGis.find((g) => !deleted.has(g));
  const lastGi = [...lastRow.wordGis].reverse().find((g) => !deleted.has(g));
  const f0 = firstGi === undefined ? null : mapper(firstGi);
  const f1 = lastGi === undefined ? null : mapper(lastGi);
  if (!f0 || !f1) return { error: `段 ${sns.join(',')} 的词已被删除或不在播放范围内,无法定位帧——read_script 核对后重试` };
  const note = sns.map((n) => cand.rows.get(n)!.keptText).join(' ');
  return { fromFrame: f0.fromFrame, durationFrames: Math.max(0, f1.toFrame - f0.fromFrame), note };
}

/** create opts from a raw object (single arg or one batch entry). */
function createOpts(o: Args, state: TimelineState): { fromFrame: number; opts: Parameters<AgentContext['commands']['addMarker']>[1] } | { error: string } {
  const scope = o.scope === 'item' ? 'item' : 'project';
  if (scope === 'item' && !str(o.itemId)) return { error: 'scope "item" requires itemId' };
  let fromFrame = num(o.fromFrame);
  let durationFrames = num(o.durationFrames);
  let note = str(o.note);
  const spec = str(o.transcriptSegments);
  if (spec) {
    // 显式 fromFrame/note 优先；缺省时从所选段派生(note 可挂 notePrefix 标签)。
    const derived = resolveTranscriptSegments(state, spec, str(o.transcriptTrack));
    if ('error' in derived) return derived;
    if (fromFrame === undefined) fromFrame = derived.fromFrame;
    if (durationFrames === undefined) durationFrames = derived.durationFrames;
    if (note === undefined) {
      const prefix = str(o.notePrefix);
      note = prefix ? `${prefix}: ${derived.note}` : derived.note;
    }
  }
  if (fromFrame === undefined) return { error: 'create requires fromFrame (or transcriptSegments to derive it from the Active Script)' };
  return { fromFrame, opts: { note, color: color(o.color), durationFrames, scope, itemId: str(o.itemId) } };
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
  let target: Timeline;
  try {
    target = resolveTimeline(ctx, str(args.timelineId));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  // Marker commands operate on the active timeline. Point a draft project at
  // the requested target, then merge it back atomically while preserving the
  // timeline the user currently has open.
  const sourceDoc = ctx.getDoc();
  const draft = makeDraft({ ...sourceDoc, activeTimelineId: target.id });
  const state = draft.getState();
  const markers = state.markers ?? [];
  const timeline = { id: target.id, name: target.name };
  const commit = () => ctx.commands.applyDoc({ ...draft.getDoc(), activeTimelineId: sourceDoc.activeTimelineId });

  switch (String(args.action ?? '')) {
    case 'list':
      return { timeline, markers: markers.map(summarize) };

    case 'create': {
      const batch = Array.isArray(args.markers) ? (args.markers as Args[]) : [args];
      const ids: string[] = [];
      for (const raw of batch) {
        const built = createOpts(raw, state);
        if ('error' in built) return { error: built.error };
        ids.push(draft.commands.addMarker(built.fromFrame, built.opts));
      }
      commit();
      return { ok: true, timeline, created: ids };
    }

    case 'update': {
      const batch = Array.isArray(args.updates) ? (args.updates as Args[]) : [args];
      const updated: string[] = [];
      for (const raw of batch) {
        const id = str(raw.markerId) ?? str(raw.id);
        if (!id) return { error: 'update requires markerId' };
        if (!markers.some((m) => m.id === id)) return { error: `no marker ${id}` };
        draft.commands.updateMarker(id, updatePatch(raw));
        updated.push(id);
      }
      commit();
      return { ok: true, timeline, updated };
    }

    case 'delete': {
      const id = str(args.markerId);
      if (!id) return { error: 'delete requires markerId' };
      if (!markers.some((m) => m.id === id)) return { error: `no marker ${id}` };
      draft.commands.removeMarker(id);
      commit();
      return { ok: true, timeline, deleted: id };
    }

    default:
      return { error: `unknown action "${args.action}"; use list|create|update|delete` };
  }
}
