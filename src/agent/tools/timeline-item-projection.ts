import { timelineItemAssetId } from '../../editor/mediaAssetUsage';
import { timelineFramesToSourceFrames } from '../../editor/sourceLimit';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import { trackAlias } from '../../editor/types';

function mediaLink(item: TimelineItem, assets: readonly MediaAsset[]) {
  const resolvedSourceAssetId = timelineItemAssetId(item, assets) ?? null;
  const sourceCandidates = item.src ? assets.filter((asset) => asset.src === item.src) : [];
  const linkStatus = resolvedSourceAssetId
    ? 'linked'
    : sourceCandidates.length > 1
      ? 'ambiguous'
      : item.src || item.sourceAssetId || item.templateId
        ? 'missing'
        : 'not_applicable';
  return {
    sourceAssetId: item.sourceAssetId ?? null,
    resolvedSourceAssetId,
    linkStatus,
  };
}

/** Minimal shared item state for read_project and read_timeline. */
export function projectTimelineItem(
  item: TimelineItem,
  state: TimelineState,
  assets: readonly MediaAsset[],
) {
  const hasSourceWindow = item.kind === 'video' || item.kind === 'audio';
  const sourceStartFrame = hasSourceWindow ? item.srcInFrame ?? 0 : null;
  const sourceDurationInFrames = hasSourceWindow
    ? Math.round(timelineFramesToSourceFrames(item, item.durationInFrames))
    : null;
  return {
    id: item.id,
    trackId: item.track,
    track: trackAlias(state, item.track),
    name: item.name,
    kind: item.kind,
    startFrame: item.startFrame,
    durationInFrames: item.durationInFrames,
    srcInFrame: item.srcInFrame ?? null,
    sourceStartFrame,
    sourceDurationInFrames,
    sourceEndFrameExclusive: sourceStartFrame === null || sourceDurationInFrames === null
      ? null
      : sourceStartFrame + sourceDurationInFrames,
    src: item.src ?? null,
    ...mediaLink(item, assets),
    keyframes: item.keyframes ?? null,
    transform: item.transform ?? null,
    filters: item.filters ?? null,
    volume: item.volume ?? null,
    fadeInFrames: item.fadeInFrames ?? null,
    fadeOutFrames: item.fadeOutFrames ?? null,
  };
}
