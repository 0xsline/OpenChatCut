import type {
  MulticamAngle, MulticamAngleDecision, MulticamGroup, MulticamMicRole,
  MulticamSyncEvidence, MulticamSyncMethod, TimelineItem, TimelineState,
} from '../editor/types';

export interface SyncedAnglePlacement {
  itemId: string;
  startFrame: number;
  offsetFrames: number;
  confidence: number;
  method: MulticamSyncMethod;
  evidence: Omit<MulticamSyncEvidence, 'angleId'>;
  label?: string;
  micRole?: MulticamMicRole;
}

export interface PersistMulticamOptions {
  groupId?: string;
  masterItemId?: string;
  makeId: () => string;
}

const methodForGroup = (evidence: readonly MulticamSyncEvidence[]): MulticamSyncMethod => {
  if (evidence.some((entry) => entry.method === 'audio')) return 'audio';
  if (evidence.some((entry) => entry.method === 'capture-clock')) return 'capture-clock';
  return 'source-timecode';
};

/** Create or update the durable angle sources and sync evidence in one state value. */
export function persistMulticamGroup(
  state: TimelineState,
  referenceItemId: string,
  placements: readonly SyncedAnglePlacement[],
  options: PersistMulticamOptions,
): { state: TimelineState; group: MulticamGroup } | null {
  const itemIds = new Set(placements.map((placement) => placement.itemId));
  itemIds.add(referenceItemId);
  const items = state.items.filter((item) => itemIds.has(item.id));
  if (items.length !== itemIds.size || items.length < 2) return null;

  const current = options.groupId
    ? state.multicamGroups?.find((group) => group.id === options.groupId)
    : state.multicamGroups?.find((group) =>
        items.some((item) => item.multicamGroupId === group.id)
        || group.angles.some((angle) => itemIds.has(angle.itemId)));
  const groupId = current?.id ?? options.groupId ?? options.makeId();
  const placementByItem = new Map(placements.map((placement) => [placement.itemId, placement]));
  const previousByItem = new Map(items.map((item) => [
    item.id,
    current?.angles.find((angle) => angle.itemId === item.id || angle.id === item.multicamAngleId),
  ]));
  const angleIdByItem = new Map<string, string>();
  for (const item of items) {
    angleIdByItem.set(item.id, previousByItem.get(item.id)?.id ?? item.multicamAngleId ?? options.makeId());
  }

  const reference = state.items.find((item) => item.id === referenceItemId)!;
  const referenceAngleId = angleIdByItem.get(referenceItemId)!;
  const referencePlacement: SyncedAnglePlacement = placementByItem.get(referenceItemId) ?? {
    itemId: referenceItemId,
    startFrame: reference.startFrame,
    offsetFrames: 0,
    confidence: 1,
    method: placements[0]?.method ?? current?.syncMethod ?? 'audio',
    evidence: {
      method: placements[0]?.method ?? current?.syncMethod ?? 'audio',
      confidence: 1,
      offsetFrames: 0,
    },
    micRole: 'reference',
  };
  placementByItem.set(referenceItemId, referencePlacement);

  const nextItems = state.items.map((item) => {
    if (!itemIds.has(item.id)) return item;
    const placement = placementByItem.get(item.id)!;
    return {
      ...item,
      startFrame: placement.startFrame,
      multicamGroupId: groupId,
      multicamAngleId: angleIdByItem.get(item.id),
    };
  });
  const nextItemById = new Map(nextItems.map((item) => [item.id, item]));
  let sourcePlacementChanged = false;
  const updatedAngles: MulticamAngle[] = items.map((item) => {
    const previous = previousByItem.get(item.id);
    const placement = placementByItem.get(item.id)!;
    const nextItem = nextItemById.get(item.id)!;
    if (previous && (
      previous.source.startFrame !== nextItem.startFrame
      || previous.source.track !== nextItem.track
    )) sourcePlacementChanged = true;
    const source = previous
      ? { ...previous.source, startFrame: nextItem.startFrame, track: nextItem.track }
      : nextItem;
    return {
      id: angleIdByItem.get(item.id)!,
      itemId: previous?.itemId ?? item.id,
      source,
      label: placement.label ?? previous?.label ?? item.name,
      micRole: placement.micRole ?? previous?.micRole
        ?? (item.id === referenceItemId ? 'reference' : item.kind === 'audio' ? 'scratch' : 'camera'),
      offsetFrames: placement.offsetFrames,
      confidence: placement.confidence,
    };
  });
  const updatedAngleIds = new Set(updatedAngles.map((angle) => angle.id));
  const angles = [
    ...(current?.angles.filter((angle) => !updatedAngleIds.has(angle.id)) ?? []),
    ...updatedAngles,
  ];
  const updatedEvidence = updatedAngles.map((angle) => {
    const item = items.find((candidate) => angleIdByItem.get(candidate.id) === angle.id)!;
    const placement = placementByItem.get(item.id)!;
    return { ...placement.evidence, angleId: angle.id };
  });
  const evidence = [
    ...(current?.evidence.filter((entry) => !updatedAngleIds.has(entry.angleId)) ?? []),
    ...updatedEvidence,
  ];
  const masterItemId = options.masterItemId ?? referenceItemId;
  const masterAngleId = angleIdByItem.get(masterItemId) ?? current?.masterAngleId ?? referenceAngleId;
  const group: MulticamGroup = {
    id: groupId,
    referenceAngleId,
    masterAngleId,
    angles,
    syncMethod: methodForGroup(evidence),
    evidence,
    ...(current?.decisions?.length && !sourcePlacementChanged ? { decisions: current.decisions } : {}),
  };
  const multicamGroups = [
    ...(state.multicamGroups ?? []).filter((entry) => entry.id !== groupId),
    group,
  ];
  return { state: { ...state, items: nextItems, multicamGroups }, group };
}

/** Replace an overlapping decision range and retain unaffected left/right pieces. */
export function replaceAngleDecision(
  decisions: readonly MulticamAngleDecision[] | undefined,
  replacement: MulticamAngleDecision,
  makeId: () => string,
): MulticamAngleDecision[] {
  const kept: MulticamAngleDecision[] = [];
  for (const decision of decisions ?? []) {
    if (decision.toFrame <= replacement.fromFrame || decision.fromFrame >= replacement.toFrame) {
      kept.push(decision);
      continue;
    }
    if (decision.fromFrame < replacement.fromFrame) {
      kept.push({ ...decision, toFrame: replacement.fromFrame });
    }
    if (decision.toFrame > replacement.toFrame) {
      kept.push({ ...decision, id: makeId(), fromFrame: replacement.toFrame });
    }
  }
  const sorted = [...kept, replacement].sort((a, b) => a.fromFrame - b.fromFrame);
  const merged: MulticamAngleDecision[] = [];
  for (const decision of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && previous.angleId === decision.angleId && previous.toFrame === decision.fromFrame) {
      previous.toFrame = decision.toFrame;
    } else {
      merged.push({ ...decision });
    }
  }
  return merged;
}

export function multicamItemsForGroup(
  state: TimelineState,
  group: MulticamGroup,
): TimelineItem[] {
  const angleIds = new Set(group.angles.map((angle) => angle.id));
  const itemIds = new Set(group.angles.map((angle) => angle.itemId));
  return state.items.filter((item) =>
    itemIds.has(item.id)
    || (item.multicamGroupId === group.id && !!item.multicamAngleId && angleIds.has(item.multicamAngleId)));
}

export function multicamItemsForAngle(
  state: TimelineState,
  group: MulticamGroup,
  angle: MulticamAngle,
): TimelineItem[] {
  return multicamItemsForGroup(state, group).filter((item) =>
    item.id === angle.itemId || item.multicamAngleId === angle.id);
}
