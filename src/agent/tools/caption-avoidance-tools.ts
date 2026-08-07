import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import type { TimelineState } from '../../editor/types';
import type { CaptionAnchor, CaptionLayoutPolicy } from '../../captions/types';
import {
  analyzeAssetGeometry,
  type VisualGeometryAsset,
} from '../../geometry/visual-geometry';
import {
  bestCaptionLayoutForGeometries,
  captionFaceConflicts,
  captionLayoutKey,
  suggestCaptionAvoidance,
  type CaptionLayoutLike,
} from '../../geometry/caption-collision';
import {
  captionGeometryTargets,
  visibleGeometryForCaptionTarget,
  type CaptionGeometryTarget,
  type CaptionSet,
} from '../../geometry/caption-qa';
import type { CaptionPlacementSource } from '../../captions/lanes';

type Args = Record<string, unknown>;

export const CAPTION_AVOIDANCE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'apply_caption_avoidance',
    description: [
      'Analyze the video layers visible beneath each rendered caption interval and move the effective caption placement away from the speaker.',
      'Uses source-timed person/face geometry, preserving already-clear layouts and updating shared layouts, entries, or policy slots according to renderer precedence.',
      'Call when the user complains captions cover the face. edit_captions also runs this automatically after enabling or adding sources.',
    ].join(' '),
    input_schema: { type: 'object', properties: {} },
  },
];

export const CAPTION_AVOIDANCE_TOOL_NAMES: ReadonlySet<string> = new Set(CAPTION_AVOIDANCE_TOOL_SCHEMAS.map((tool) => tool.name));

export interface CaptionAvoidanceResult {
  ok: boolean;
  adjusted?: number;
  error?: string;
  sources?: Array<{ source: string; adjusted: number; details: string[] }>;
  note?: string;
}

interface AnalyzedTarget {
  target: CaptionGeometryTarget;
  geometry: VisualGeometryAsset;
}

function captionSetsWithTracks(state: TimelineState): Array<{ set: CaptionSet; trackId: string | null }> {
  const out: Array<{ set: CaptionSet; trackId: string | null }> = [];
  for (const [trackId, track] of Object.entries(state.tracks ?? {})) {
    if (track?.kind === 'caption' && track.captions) out.push({ set: track.captions, trackId });
  }
  if (state.captions?.enabled && !out.some((entry) => entry.set === state.captions)) {
    out.push({ set: state.captions, trackId: null });
  }
  return out.filter((entry) => entry.set.enabled !== false);
}

function clearsEveryGeometry(geometries: readonly VisualGeometryAsset[], layout: CaptionLayoutLike): boolean {
  return geometries.every((geometry) => captionFaceConflicts(geometry, [layout]).length === 0);
}

function replacementFor(
  geometries: readonly VisualGeometryAsset[],
  current: CaptionLayoutLike,
): CaptionLayoutLike | null {
  const firstConflict = geometries
    .flatMap((geometry) => captionFaceConflicts(geometry, [current]))
    .at(0);
  if (!firstConflict) return null;
  const suggestion = suggestCaptionAvoidance(firstConflict);
  if (suggestion) {
    const shifted = { ...current, offsetYRatio: suggestion.offsetYRatio };
    if (clearsEveryGeometry(geometries, shifted)) return shifted;
  }
  const best = bestCaptionLayoutForGeometries(geometries, current);
  return captionLayoutKey(best) === captionLayoutKey(current) ? null : best;
}

function writeLayout(
  next: CaptionSet,
  sources: readonly CaptionPlacementSource[],
  layout: CaptionLayoutLike,
): boolean {
  let wrote = false;
  for (const source of sources) {
    if (source.kind === 'layout') {
      next.layout = {
        ...(next.layout ?? {}),
        anchor: layout.anchor as CaptionAnchor | undefined,
        offsetXRatio: layout.offsetXRatio,
        offsetYRatio: layout.offsetYRatio,
      };
      wrote = true;
      continue;
    }
    if (source.kind === 'entry') {
      const entry = next.sourceEntries?.find((candidate) => candidate.id === source.sourceId);
      if (!entry) continue;
      entry.anchor = layout.anchor as CaptionAnchor | undefined;
      entry.offsetXRatio = layout.offsetXRatio;
      entry.offsetYRatio = layout.offsetYRatio;
      wrote = true;
      continue;
    }
    const policy = next.layoutPolicy;
    if (policy?.mode !== 'manual-slots') continue;
    const slot = policy.slots.find((candidate) => candidate.id === source.slotId);
    if (!slot) continue;
    slot.anchor = layout.anchor as CaptionAnchor;
    slot.offsetXRatio = layout.offsetXRatio;
    slot.offsetYRatio = layout.offsetYRatio;
    wrote = true;
  }
  return wrote;
}

export async function applyCaptionAvoidance(
  ctx: AgentContext,
  options: { maxSamples?: number } = {},
): Promise<CaptionAvoidanceResult> {
  const state = ctx.getState();
  const doc = ctx.getDoc();
  const summary: NonNullable<CaptionAvoidanceResult['sources']> = [];
  let sourceCount = 0;
  let geometryCount = 0;
  let total = 0;
  let blocked = 0;

  for (const { set, trackId } of captionSetsWithTracks(state)) {
    const targets = captionGeometryTargets(set, state, doc);
    sourceCount += targets.length;
    const analyzed: AnalyzedTarget[] = [];
    const geometryCache = new Map<string, VisualGeometryAsset>();
    for (const target of targets) {
      let geometry = geometryCache.get(target.asset.id);
      if (!geometry) {
        const result = await analyzeAssetGeometry(target.asset, undefined, options);
        if (!result.geometry) continue;
        geometry = result.geometry;
        geometryCache.set(target.asset.id, geometry);
      }
      const visibleGeometry = visibleGeometryForCaptionTarget(geometry, state, target);
      if (visibleGeometry.segments.length) analyzed.push({ target, geometry: visibleGeometry });
    }
    geometryCount += analyzed.length;
    const groups = new Map<string, AnalyzedTarget[]>();
    for (const target of analyzed) {
      const key = target.target.placementSources
        .map((source) => source.kind === 'layout' ? 'layout' : `${source.kind}:${source.kind === 'slot' ? source.slotId : source.sourceId}`)
        .join(',');
      groups.set(key, [...(groups.get(key) ?? []), target]);
    }
    const layoutPolicy: CaptionLayoutPolicy | null | undefined = set.layoutPolicy?.mode === 'manual-slots'
      ? { ...set.layoutPolicy, slots: set.layoutPolicy.slots.map((slot) => ({ ...slot })) }
      : set.layoutPolicy ? { ...set.layoutPolicy } : set.layoutPolicy;
    const next: CaptionSet = {
      ...set,
      layout: set.layout ? { ...set.layout } : undefined,
      layoutPolicy,
      sourceEntries: set.sourceEntries?.map((entry) => ({ ...entry })),
    };
    const details: string[] = [];
    let adjusted = 0;
    for (const group of groups.values()) {
      const representative = [...group].sort((a, b) =>
        (b.target.layout.stackCount ?? 1) - (a.target.layout.stackCount ?? 1))[0]!;
      const current = representative.target.layout;
      const geometries = group.map((entry) => entry.geometry);
      const hasConflict = geometries.some((geometry) => captionFaceConflicts(geometry, [current]).length > 0);
      const replacement = replacementFor(geometries, current);
      if (!replacement) {
        if (hasConflict) {
          blocked += 1;
          details.push('检测到字幕遮挡，但没有可用的安全位置，未调整');
        }
        continue;
      }
      if (!writeLayout(next, representative.target.placementSources, replacement)) {
        blocked += 1;
        details.push('有效字幕位置由不可修改的布局策略控制，未调整');
        continue;
      }
      adjusted += 1;
      const label = representative.target.placementSources
        .map((source) => source.kind === 'layout' ? '整体字幕' : source.kind === 'slot' ? `字幕槽「${source.slotId}」` : `字幕条「${source.sourceId}」`)
        .join('、');
      details.push(`${label}已避开人脸`);
    }
    if (adjusted) ctx.commands.setCaptions(next, trackId ?? undefined);
    total += adjusted;
    const names = [...new Set(analyzed.map((entry) => entry.target.asset.name))];
    if (names.length) summary.push({ source: names.join('、'), adjusted, details });
  }

  if (!sourceCount) {
    return { ok: false, error: '字幕显示期间没有找到可见的视频画面，未修改字幕布局' };
  }
  if (!geometryCount) {
    return { ok: false, error: '可见视频画面的几何分析不可用，未修改字幕布局' };
  }
  return {
    ok: true,
    adjusted: total,
    sources: summary,
    note: total
      ? `已自动避让 ${total} 处字幕布局（按可见画面与字幕时段分析人像/人脸）。`
      : blocked
        ? `检测到 ${blocked} 处字幕遮挡，但有效位置由不可修改的布局策略控制，未作修改。`
        : '未检测到字幕遮挡人脸，布局无需调整。',
  };
}

export async function execCaptionAvoidanceTool(name: string, _args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'apply_caption_avoidance') return { error: `unknown tool ${name}` };
  return applyCaptionAvoidance(ctx);
}
