/**
 * Geometry-aware caption QA against the video layers actually composited while
 * each caption group is visible. Caption-source media is timing only: an audio
 * transcript can therefore be checked against an unrelated talking-head clip.
 */

import type { MediaAsset, ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { timelineTrackIds, trackKind } from '../editor/types';
import type { CaptionLayout, CaptionsData } from '../captions/types';
import { activePage, paginate } from '../captions/types';
import {
  buildLaneGroups,
  resolveEffectiveCaptionLanes,
  type CaptionPlacementSource,
} from '../captions/lanes';
import { applyWordOverrides, resolveCaptionWordIndices, resolveCaptionWords, resolveEntryWords } from '../captions/resolve';
import { orderedCaptionSourceEntries } from '../captions/sourceOrder';
import { isManualCaptionEntry } from '../captions/manualCaptions';
import { effectivePreset } from '../captions/renderStyles';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { projectGeometryThroughItem } from './placement';
import type { ExportQaIssue } from '../export/quality';
import {
  captionFaceConflicts,
  captionLayoutKey,
  geometryWithinSourceRanges,
  type CaptionLayoutLike,
  type SourceTimeRange,
} from './caption-collision';
import { analyzeAssetGeometry, type AnalyzeResult, type VisualGeometryAsset } from './visual-geometry';

const DEFAULT_CAPTION_LAYOUT: CaptionLayoutLike = { anchor: 'bottom-center' };
const LAST_PAGE_LINGER_MS = 1_500;

/** Caption sets used by geometry-aware QA and the avoidance tool. */
export type CaptionSet = CaptionsData;

export interface CaptionGeometryTarget {
  asset: MediaAsset;
  layout: CaptionLayoutLike;
  /** Fields that must be updated together for this rendered group's placement to move. */
  placementSources: CaptionPlacementSource[];
  /** Exact composited clip whose transforms/crop/zoom project this geometry. */
  visualItem: TimelineItem;
  /** Source-media windows visible beneath this caption group. */
  sourceRanges: SourceTimeRange[];
}

interface CaptionPlacementInterval {
  startMs: number;
  endMs: number;
  layout: CaptionLayoutLike;
  placementSources: CaptionPlacementSource[];
}

function captionSetsOf(state: TimelineState): CaptionSet[] {
  const sets: CaptionSet[] = [];
  for (const track of Object.values(state.tracks ?? {})) {
    if (track?.kind === 'caption' && track.captions) sets.push(track.captions);
  }
  if (state.captions?.enabled && !sets.some((set) => set === state.captions)) sets.push(state.captions);
  return sets.filter((set) => set.enabled !== false);
}

function effectiveLayout(set: CaptionSet, layout: CaptionLayout | undefined, stackCount: number): CaptionLayoutLike {
  const hasExplicitLayout = !!layout && Object.values(layout).some((value) => value !== undefined);
  const placement = hasExplicitLayout
    ? layout
    : { ...DEFAULT_CAPTION_LAYOUT, offsetYRatio: set.template === 'netflix' ? 0.01 : 0 };
  return { ...placement, stackCount: Math.max(1, stackCount) };
}

/** Distinct policy-resolved layouts, including stacking and the implicit default. */
export function layoutsOf(set: CaptionSet): CaptionLayoutLike[] {
  if (!set.sourceEntries?.length) return [effectiveLayout(set, set.layout, 1)];
  const entries = orderedCaptionSourceEntries(set.sourceEntries).filter((entry) => entry.visible !== false);
  const layouts = resolveEffectiveCaptionLanes(set, entries).map((group) =>
    effectiveLayout(set, group.layout ?? set.layout, group.entries.length));
  const seen = new Set<string>();
  return layouts.filter((layout) => {
    const key = captionLayoutKey(layout);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function multiLaneBoundaries(set: CaptionSet, state: TimelineState, wordsPerPage: number | undefined): number[] {
  const boundaries = new Set<number>();
  for (const entry of set.sourceEntries ?? []) {
    if (entry.visible === false) continue;
    const words = resolveEntryWords(entry, state.items, state.fps);
    if (!words.length) continue;
    if (isManualCaptionEntry(entry)) {
      for (const word of words) {
        boundaries.add(word.start);
        boundaries.add(word.end);
      }
      continue;
    }
    const maxLines = set.perSource?.[entry.id]?.maxLines;
    const per = maxLines ? Math.max(1, (wordsPerPage ?? 6) * maxLines) : wordsPerPage;
    const pages = paginate(words, set.pacing, per);
    for (const page of pages) boundaries.add(page.start);
    const last = pages.at(-1);
    if (last) boundaries.add(last.end + LAST_PAGE_LINGER_MS);
  }
  return [...boundaries].sort((a, b) => a - b);
}

function multiLaneIntervals(set: CaptionSet, state: TimelineState): CaptionPlacementInterval[] {
  const wordsPerPage = effectivePreset(set).wordsPerPage;
  const boundaries = multiLaneBoundaries(set, state, wordsPerPage);
  const intervals: CaptionPlacementInterval[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const startMs = boundaries[index]!;
    const endMs = boundaries[index + 1]!;
    if (!(endMs > startMs)) continue;
    const groups = buildLaneGroups(set, state.items, state.fps, (startMs + endMs) / 2, wordsPerPage) ?? [];
    for (const group of groups) {
      intervals.push({
        startMs,
        endMs,
        layout: effectiveLayout(set, group.anchor ? {
          anchor: group.anchor,
          offsetXRatio: group.offsetXRatio,
          offsetYRatio: group.offsetYRatio,
          scale: group.scale,
          rotation: group.rotation,
          opacity: group.opacity,
        } : set.layout, group.lanes.length),
        placementSources: group.placementSources,
      });
    }
  }
  return intervals;
}

function legacyIntervals(set: CaptionSet, state: TimelineState): CaptionPlacementInterval[] {
  const words = resolveCaptionWords(set, state.items, state.fps);
  const indices = resolveCaptionWordIndices(set, state.items, state.fps);
  const display = applyWordOverrides(words, indices, set.wordOverrides);
  const pages = paginate(display.words, set.pacing, effectivePreset(set).wordsPerPage, display.breakBefore);
  return pages.flatMap((page, index) => {
    const endMs = pages[index + 1]?.start ?? page.end + LAST_PAGE_LINGER_MS;
    if (!activePage(pages, (page.start + endMs) / 2)) return [];
    return [{
      startMs: page.start,
      endMs,
      layout: effectiveLayout(set, set.layout, 1),
      placementSources: [{ kind: 'layout' as const }],
    }];
  });
}

function placementIntervals(set: CaptionSet, state: TimelineState): CaptionPlacementInterval[] {
  return set.sourceEntries?.length ? multiLaneIntervals(set, state) : legacyIntervals(set, state);
}

function assetForVisualItem(item: TimelineItem, doc: ProjectDoc): MediaAsset | null {
  if (item.sourceAssetId) {
    const byId = doc.assets.find((asset) => asset.id === item.sourceAssetId);
    if (byId) return byId;
  }
  return item.src ? doc.assets.find((asset) => asset.src === item.src) ?? null : null;
}

function visibleVideoItems(state: TimelineState): TimelineItem[] {
  const visualTracks = new Set(timelineTrackIds(state).filter((trackId) => trackKind(state, trackId) === 'video'));
  return state.items.filter((item) =>
    item.kind === 'video'
    && !!item.src
    && visualTracks.has(item.track)
    && state.tracks?.[item.track]?.hidden !== true);
}

/** Match every rendered caption interval to all composited video source windows beneath it. */
export function captionGeometryTargets(
  set: CaptionSet,
  state: TimelineState,
  doc: ProjectDoc,
): CaptionGeometryTarget[] {
  const targets = new Map<string, CaptionGeometryTarget>();
  const videos = visibleVideoItems(state);
  for (const interval of placementIntervals(set, state)) {
    const intervalStart = interval.startMs * state.fps / 1_000;
    const intervalEnd = interval.endMs * state.fps / 1_000;
    for (const item of videos) {
      const startFrame = Math.max(intervalStart, item.startFrame);
      const endFrame = Math.min(intervalEnd, item.startFrame + item.durationInFrames);
      if (!(endFrame > startFrame)) continue;
      const asset = assetForVisualItem(item, doc);
      if (!asset) continue;
      const window = sourceWindowForTimelineRange(item, startFrame - item.startFrame, endFrame - startFrame);
      const sourceRange = { startSec: window.startFrame / state.fps, endSec: window.endFrame / state.fps };
      const placementKey = interval.placementSources
        .map((source) => source.kind === 'layout' ? 'layout' : `${source.kind}:${source.kind === 'slot' ? source.slotId : source.sourceId}`)
        .join(',');
      const key = `${item.id}|${asset.id}|${interval.startMs}:${interval.endMs}|${captionLayoutKey(interval.layout)}|${placementKey}`;
      const target = targets.get(key);
      if (target) {
        target.sourceRanges.push(sourceRange);
      } else {
        targets.set(key, {
          asset,
          layout: interval.layout,
          placementSources: interval.placementSources,
          visualItem: item,
          sourceRanges: [sourceRange],
        });
      }
    }
  }
  return [...targets.values()];
}

/** Source-windowed geometry in the same composition coordinates as rendered captions. */
export function visibleGeometryForCaptionTarget(
  geometry: VisualGeometryAsset,
  state: TimelineState,
  target: CaptionGeometryTarget,
): VisualGeometryAsset {
  const projected = projectGeometryThroughItem(geometry, state, target.visualItem);
  return geometryWithinSourceRanges(projected, target.sourceRanges);
}

/** Geometry-aware caption QA issues for effective layouts over visible source windows. */
export async function captionFaceQaIssues(
  doc: ProjectDoc,
  state: TimelineState,
  signal?: AbortSignal,
): Promise<ExportQaIssue[]> {
  const issues: ExportQaIssue[] = [];
  const analyzed = new Map<string, AnalyzeResult>();
  for (const set of captionSetsOf(state)) {
    for (const target of captionGeometryTargets(set, state, doc)) {
      let result = analyzed.get(target.asset.id);
      if (!result) {
        result = await analyzeAssetGeometry(target.asset, signal);
        analyzed.set(target.asset.id, result);
      }
      if (!result.geometry) continue;
      const visibleGeometry = visibleGeometryForCaptionTarget(result.geometry, state, target);
      if (!captionFaceConflicts(visibleGeometry, [target.layout]).length) continue;
      issues.push({
        code: 'caption_covers_face',
        severity: 'warning',
        message: '字幕位置可能遮挡说话人脸部（几何检测）；建议上移或换侧。',
      });
    }
  }
  return issues;
}
