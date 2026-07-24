import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { MARKER_HEX, type Marker, type MarkerColor, type Timeline, type TimelineState } from '../../editor/types';
import { makeDraft } from '../../editor/store';
import { buildModel, type SegRow } from '../../script/serialize';
import { makeWordFrameMapper } from './transcript-find';
import { resolveTimeline } from './timeline-target';

// manage_markers — Timeline annotations (points/segments), anchored on a frame or a clip, the contract is marker-note-v2.
// Parameters include action + fromFrame/durationFrames/note/itemId +
// markers/updates (batch). The editing layer is fully ready (Marker type + reducer addMarker/updateMarker/
// removeMarker + store command), only thin agent packaging is used here: list/create/update/delete.
// transcript-backed notes:create transcriptSegments("3"/"3-5"/comma list,
// The same set of numbers as [sN] of read_script) can save fromFrame/note - the frame bit is converted by the word-level timestamp
// (makeWordFrameMapper, shared mapping with the playback layer), copy the text of the note body, and can attach the notePrefix tag;
// transcriptTrack filter track. Batch markers[] for each item are also supported.

type Args = Record<string, unknown>;

const COLORS = Object.keys(MARKER_HEX) as MarkerColor[];

export const MARKERS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_markers',
    description: [
      'Timeline annotations/TODO anchor point(contract marker-note-v2)。marker = point(durationFrames 0)or paragraph(>0),',
      'scope=project Anchor on ruler frame,scope=item Anchor in something clip on.',
      'action: list(column all) | create(build;transferable markers[] batch) | update(change;transferable updates[] batch) | delete(delete)。',
      'transcript-backed notes:When you want to annotate the transcribed original sentence,pass transcriptSegments(Active Script of [sN] Section number)+ Optional notePrefix,',
      'instead of handwriting note——fromFrame Automatically take the starting point of the first selected segment(Explicitly pass fromFrame then priority),note Text from read_script Output copy.',
      `color take ${COLORS.join('/')} one.`,
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        timelineId: { type: 'string', description: 'target timeline id or prefix; when omitted, the current timeline is used and the current timeline is not switched.' },
        fromFrame: { type: 'number', description: 'Integer timeline frame to anchor the marker at (required for create unless transcriptSegments is used).' },
        durationFrames: { type: 'number', description: 'Duan Chang;0 or omit = point mark(use transcriptSegments The selected segment is overwritten by default)。' },
        note: { type: 'string', description: 'Marker note text (required for create unless transcriptSegments is used).' },
        color: { type: 'string', enum: COLORS },
        scope: { type: 'string', enum: ['project', 'item'], description: 'item Required itemId. Default project。' },
        itemId: { type: 'string', description: 'scope=item time-anchored clip id。' },
        markerId: { type: 'string', description: 'update/delete goal marker id。' },
        transcriptSegments: { type: 'string', description: 'Active Script segment ids/ranges from timeline.md, e.g. "3-4"; note text is copied from read_script output.' },
        transcriptTrack: { type: 'string', description: 'Track filter for transcriptSegments, e.g. V1 or A1.' },
        notePrefix: { type: 'string', description: 'Optional label prefix when transcriptSegments derives the note body.' },
        markers: {
          type: 'array',
          description: 'create batch:Each item {fromFrame?, note?, color?, durationFrames?, scope?, itemId?, transcriptSegments?, transcriptTrack?, notePrefix?};fromFrame Can be saved,use transcriptSegments Positioning.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description: 'update batch:Each item {id, note?, color?, fromFrame?, durationFrames?}。',
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

/** "3" / "3-5" / "2,4-6"(tolerate s prefix,Such as "s3-s4")→ Ascending order to remove duplicate segment numbers;Illegal return null。 */
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

/** transcriptSegments → {fromFrame, durationFrames, note}. segment number and read_script of [sN]
 *  Same set of numbers(buildModel);frame bit makeWordFrameMapper Convert using word-level timestamps(Same origin as the playback layer,
 *  Keep word frames consistent);note = of selected segment keptText(That is read_script displayed text)。 */
function resolveTranscriptSegments(state: TimelineState, spec: string, trackFilter?: string): SegmentAnchor | { error: string } {
  const sns = parseSegmentSpec(spec);
  if (!sns) return { error: `transcriptSegments "${spec}" Unable to parse - use read_script Output [sN] No.,Such as "3"、"3-5" or "2,4-6"` };
  const model = buildModel(state);
  const tracks = trackFilter ? model.filter((t) => t.track.toLowerCase() === trackFilter.toLowerCase()) : model;
  if (trackFilter && !tracks.length) return { error: `transcriptTrack "${trackFilter}" Does not exist or the track has no content` };

  // Each transcribed region (= a transcribed clip) is indexed by sn; candidate = region containing all selected segments
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
    return { error: `Cannot find both containing segments ${sns.join(',')} Transcription area - first read_script Check [sN] No.${trackFilter ? '' : ',or pass transcriptTrack Narrow down the scope'}` };
  }
  if (candidates.length > 1) {
    return { error: `segment ${sns.join(',')} Appears in multiple transcription areas(${candidates.map((c) => `${c.track}:${c.itemId.slice(0, 8)}`).join(' / ')})——Biography transcriptTrack Disambiguation,or give directly fromFrame` };
  }

  const cand = candidates[0]!;
  const item = state.items.find((it) => it.id === cand.itemId);
  if (!item?.transcript?.length) return { error: `Corresponding to the transcription area clip ${cand.itemId} No more transcriptions,Please try again read_script` };
  const deleted = new Set(item.deletedWordIdx ?? []);
  const mapper = makeWordFrameMapper(item, state.fps);
  const firstRow = cand.rows.get(sns[0]!)!;
  const lastRow = cand.rows.get(sns[sns.length - 1]!)!;
  const firstGi = firstRow.wordGis.find((g) => !deleted.has(g));
  const lastGi = [...lastRow.wordGis].reverse().find((g) => !deleted.has(g));
  const f0 = firstGi === undefined ? null : mapper(firstGi);
  const f1 = lastGi === undefined ? null : mapper(lastGi);
  if (!f0 || !f1) return { error: `segment ${sns.join(',')} of words has been deleted or is no longer in playback range,Unable to locate frame -read_script Check and try again` };
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
    // Explicit fromFrame/note takes precedence; by default it is derived from the selected segment (note can be tagged with notePrefix).
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
