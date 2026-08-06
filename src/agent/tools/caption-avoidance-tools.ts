import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import type { TimelineState } from '../../editor/types';
import { analyzeAssetGeometry } from '../../geometry/visual-geometry';
import { captionFaceConflicts, suggestCaptionAvoidance } from '../../geometry/caption-collision';
import { layoutsOf, type CaptionSet } from '../../geometry/caption-qa';

type Args = Record<string, unknown>;

export const CAPTION_AVOIDANCE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'apply_caption_avoidance',
    description: [
      'Analyze the caption source video (visual geometry: person segmentation + face) and move caption layouts that cover the speaker\'s face to a clear spot.',
      'Only layouts that collide with the face are adjusted (vertical offset); everything else is untouched. Uses the geometry cache; first call analyzes the source (a few seconds for short clips).',
      'Returns how many layouts were adjusted and where they moved. Call when the user complains captions cover the face, or proactively after adding captions to a talking-head video.',
    ].join(' '),
    input_schema: { type: 'object', properties: {} },
  },
];

export const CAPTION_AVOIDANCE_TOOL_NAMES: ReadonlySet<string> = new Set(CAPTION_AVOIDANCE_TOOL_SCHEMAS.map((tool) => tool.name));

/** Caption sets with their owning track id (state.captions has no track). */
function captionSetsWithTracks(state: TimelineState): Array<{ set: CaptionSet; trackId: string | null }> {
  const out: Array<{ set: CaptionSet; trackId: string | null }> = [];
  for (const [trackId, track] of Object.entries(state.tracks ?? {})) {
    if (track?.kind === 'caption' && track.captions) out.push({ set: track.captions as CaptionSet, trackId });
  }
  if (state.captions?.enabled && !out.some((entry) => entry.set === state.captions)) {
    out.push({ set: state.captions as CaptionSet, trackId: null });
  }
  return out.filter((entry) => entry.set.enabled !== false);
}

export async function execCaptionAvoidanceTool(name: string, _args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'apply_caption_avoidance') return { error: `unknown tool ${name}` };
  const state = ctx.getState();
  const doc = ctx.getDoc();

  const summary: Array<{ source: string; adjusted: number; details: string[] }> = [];
  let analyzedSources = 0;
  for (const { set, trackId } of captionSetsWithTracks(state)) {
    const sourceItemId = set.sourceItemId;
    const item = sourceItemId ? state.items.find((candidate) => candidate.id === sourceItemId) : undefined;
    const asset = item?.src ? doc.assets.find((candidate) => candidate.src === item.src) : undefined;
    if (!asset) continue;
    analyzedSources += 1;

    const { geometry } = await analyzeAssetGeometry(asset);
    if (!geometry) continue;
    const conflicts = captionFaceConflicts(geometry, layoutsOf(set));
    if (!conflicts.length) {
      summary.push({ source: asset.name, adjusted: 0, details: [] });
      continue;
    }
    const details: string[] = [];
    const next: CaptionSet = { ...set, layout: set.layout ? { ...set.layout } : undefined, sourceEntries: set.sourceEntries?.map((entry) => ({ ...entry })) };
    let adjusted = 0;
    for (const conflict of conflicts) {
      const suggestion = suggestCaptionAvoidance(conflict);
      if (!suggestion) {
        details.push(`无法避让（脸部占满画面）`);
        continue;
      }
      const layout = conflict.layout;
      // Which slot does this layout belong to: the set layout or a source entry?
      const key = (l: { anchor?: string; offsetXRatio?: number; offsetYRatio?: number }) =>
        `${l.anchor ?? 'bottom-center'}|${l.offsetXRatio ?? 0}|${l.offsetYRatio ?? 0}`;
      const layoutKey = key(layout);
      if (next.layout && key(next.layout) === layoutKey) {
        next.layout = { ...next.layout, offsetYRatio: suggestion.offsetYRatio };
        adjusted += 1;
        details.push(`整体布局移至人脸${suggestion.side === 'above' ? '上方' : '下方'}`);
      } else {
        const entry = next.sourceEntries?.find((source) => key(source) === layoutKey);
        if (entry) {
          entry.offsetYRatio = suggestion.offsetYRatio;
          adjusted += 1;
          details.push(`字幕条「${entry.id}」移至人脸${suggestion.side === 'above' ? '上方' : '下方'}`);
        }
      }
    }
    if (adjusted) {
      ctx.commands.setCaptions(next as never, trackId ?? undefined);
    }
    summary.push({ source: asset.name, adjusted, details });
  }

  if (!analyzedSources) {
    return { ok: false, error: '没有找到字幕源素材（caption 需要挂在有转写的视频/音频片段上）' };
  }
  const total = summary.reduce((sum, entry) => sum + entry.adjusted, 0);
  return {
    ok: true,
    adjusted: total,
    sources: summary,
    note: total
      ? `已自动避让 ${total} 处字幕布局（基于人像/人脸几何）。`
      : '未检测到字幕遮挡人脸，布局无需调整。',
  };
}
