/**
 * Geometry-aware caption QA: warn before export when a caption layout band
 * covers the speaker's face. Reads (or computes on first use) the visual
 * geometry cache for the caption source asset; never blocks the export —
 * geometry unavailability degrades to no issues.
 */

import type { ProjectDoc, TimelineState } from '../editor/types';
import type { ExportQaIssue } from '../export/quality';
import { captionFaceConflicts, type CaptionLayoutLike } from './caption-collision';
import { analyzeAssetGeometry } from './visual-geometry';

/** Caption sets used by geometry-aware QA and the avoidance tool. */
export interface CaptionSet {
  enabled: boolean;
  layout?: CaptionLayoutLike | null;
  sourceEntries?: Array<CaptionLayoutLike & { visible?: boolean; id: string }> | null;
  sourceItemId?: string | null;
  sources?: string[] | null;
}

function captionSetsOf(state: TimelineState): CaptionSet[] {
  const sets: CaptionSet[] = [];
  const tracks = state.tracks ?? {};
  for (const track of Object.values(tracks)) {
    if (track?.kind === 'caption' && track.captions) sets.push(track.captions as CaptionSet);
  }
  if (state.captions?.enabled && !sets.some((set) => set === state.captions)) {
    sets.push(state.captions as CaptionSet);
  }
  return sets.filter((set) => set.enabled !== false);
}

/** Resolve the caption source asset for one caption set (single-source mode). */
function captionSourceAsset(set: CaptionSet, state: TimelineState, doc: ProjectDoc) {
  const sourceItemId = set.sourceItemId;
  if (!sourceItemId) return null;
  const item = state.items.find((candidate) => candidate.id === sourceItemId);
  if (!item?.src) return null;
  return doc.assets.find((asset) => asset.src === item.src) ?? null;
}

/** Distinct layouts used by one caption set (set layout + per-source overrides). */
export function layoutsOf(set: CaptionSet): CaptionLayoutLike[] {
  const layouts: CaptionLayoutLike[] = [];
  if (set.layout) layouts.push(set.layout);
  for (const source of set.sourceEntries ?? []) {
    if (source.visible === false) continue;
    if (source.anchor || source.offsetXRatio !== undefined || source.offsetYRatio !== undefined) {
      layouts.push(source);
    }
  }
  const seen = new Set<string>();
  return layouts.filter((layout) => {
    const key = `${layout.anchor ?? 'bottom-center'}|${layout.offsetXRatio ?? 0}|${layout.offsetYRatio ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Geometry-aware caption QA issues. Analyzes the caption source asset on
 * first use (cached afterwards); any failure → no issues (geometry is an
 * enhancement, never a blocker).
 */
export async function captionFaceQaIssues(
  doc: ProjectDoc,
  state: TimelineState,
  signal?: AbortSignal,
): Promise<ExportQaIssue[]> {
  const issues: ExportQaIssue[] = [];
  for (const set of captionSetsOf(state)) {
    const asset = captionSourceAsset(set, state, doc);
    if (!asset) continue;
    const { geometry } = await analyzeAssetGeometry(asset, signal);
    if (!geometry) continue;
    const conflicts = captionFaceConflicts(geometry, layoutsOf(set));
    for (const conflict of conflicts) {
      issues.push({
        code: 'caption_covers_face',
        severity: 'warning',
        message: '字幕位置可能遮挡说话人脸部（几何检测）；建议上移或换侧。',
        ...(conflict.coverage ? {} : {}),
      });
    }
  }
  return issues;
}
