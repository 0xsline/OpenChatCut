import { maintainLinkGroups } from './linkGroups.js';
import { reconcileTimelineCaptionReferences } from '../captions/reconcileSources.js';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types.js';

/** Resolve a timeline clip to one pool master without guessing across duplicate sources. */
export function timelineItemAssetId(
  item: TimelineItem,
  assets: readonly MediaAsset[],
): string | undefined {
  if (item.sourceAssetId && assets.some((asset) => asset.id === item.sourceAssetId)) {
    return item.sourceAssetId;
  }
  if (item.kind === 'motion-graphic'
    && item.templateId
    && assets.some((asset) => asset.id === item.templateId)) {
    return item.templateId;
  }
  if (!item.src) return undefined;
  const sameSource = assets.filter((asset) => asset.src === item.src);
  if (sameSource.length === 1) return sameSource[0]!.id;
  const sameName = sameSource.filter((asset) => asset.name === item.name);
  return sameName.length === 1 ? sameName[0]!.id : undefined;
}

export function timelineItemUsesAsset(
  item: TimelineItem,
  asset: MediaAsset,
  assets: readonly MediaAsset[],
): boolean {
  return timelineItemAssetId(item, assets) === asset.id;
}

export function usedMediaAssetIds(
  doc: Pick<ProjectDoc, 'assets' | 'timelines'>,
): Set<string> {
  const used = new Set<string>();
  for (const timeline of doc.timelines) {
    for (const item of timeline.items) {
      const assetId = timelineItemAssetId(item, doc.assets);
      if (assetId) used.add(assetId);
    }
    for (const group of timeline.multicamGroups ?? []) {
      for (const angle of group.angles) {
        const assetId = timelineItemAssetId(angle.source, doc.assets);
        if (assetId) used.add(assetId);
      }
    }
  }
  return used;
}

export function mapTimelineAssetItems(
  timeline: Timeline,
  asset: MediaAsset,
  assets: readonly MediaAsset[],
  map: (item: TimelineItem) => TimelineItem,
): Timeline {
  let changed = false;
  const mapOne = (item: TimelineItem): TimelineItem => {
    if (!timelineItemUsesAsset(item, asset, assets)) return item;
    const next = map(item);
    if (next !== item) changed = true;
    return next;
  };
  const items = timeline.items.map(mapOne);
  const multicamGroups = timeline.multicamGroups?.map((group) => {
    const angles = group.angles.map((angle) => {
      const source = mapOne(angle.source);
      return source === angle.source ? angle : { ...angle, source };
    });
    return angles.every((angle, index) => angle === group.angles[index]) ? group : { ...group, angles };
  });
  return changed ? { ...timeline, items, multicamGroups } : timeline;
}

export function removeAssetFromTimeline(
  timeline: Timeline,
  asset: MediaAsset,
  assets: readonly MediaAsset[],
): Timeline {
  const removedIds = new Set(timeline.items
    .filter((item) => timelineItemUsesAsset(item, asset, assets))
    .map((item) => item.id));
  let removedMulticamAngle = false;
  const collapsedMulticamGroupIds = new Set<string>();
  const multicamGroups = timeline.multicamGroups?.flatMap((group) => {
    const angles = group.angles.filter((angle) => (
      !removedIds.has(angle.itemId)
      && !timelineItemUsesAsset(angle.source, asset, assets)
    ));
    if (angles.length !== group.angles.length) removedMulticamAngle = true;
    if (angles.length === group.angles.length) return [group];
    if (angles.length < 2) {
      collapsedMulticamGroupIds.add(group.id);
      return [];
    }
    const angleIds = new Set(angles.map((angle) => angle.id));
    const firstAngleId = angles[0]!.id;
    return [{
      ...group,
      angles,
      referenceAngleId: angleIds.has(group.referenceAngleId) ? group.referenceAngleId : firstAngleId,
      masterAngleId: angleIds.has(group.masterAngleId) ? group.masterAngleId : firstAngleId,
      evidence: group.evidence.filter((entry) => angleIds.has(entry.angleId)),
      decisions: group.decisions?.filter((entry) => angleIds.has(entry.angleId)),
    }];
  });
  if (removedIds.size === 0 && !removedMulticamAngle) return timeline;
  const items = timeline.items.flatMap((item) => {
    if (removedIds.has(item.id)) return [];
    if (!item.multicamGroupId || !collapsedMulticamGroupIds.has(item.multicamGroupId)) return [item];
    const next = { ...item };
    delete next.multicamGroupId;
    delete next.multicamAngleId;
    return [next];
  });
  const remainingIds = new Set(items.map((item) => item.id));
  const selectedIds = (timeline.selectedIds ?? (timeline.selectedId ? [timeline.selectedId] : []))
    .filter((id) => remainingIds.has(id));
  return reconcileTimelineCaptionReferences({
    ...timeline,
    items,
    transitions: timeline.transitions?.filter((transition) => (
      !removedIds.has(transition.incomingItemId)
      && !removedIds.has(transition.outgoingItemId)
    )),
    linkGroups: maintainLinkGroups(timeline.linkGroups, remainingIds),
    multicamGroups: multicamGroups?.length ? multicamGroups : undefined,
    selectedIds,
    selectedId: selectedIds[selectedIds.length - 1] ?? null,
  });
}
