export type EditItemBucket = 'adds' | 'updates' | 'deletes';

type AllowedFields = Readonly<Record<string, true>>;

const EFFECT_ADD_KEYS: AllowedFields = {
  type: true,
  targetItemId: true,
  assetId: true,
  propertyOverrides: true,
};
const TRANSITION_ADD_KEYS: AllowedFields = {
  type: true,
  assetId: true,
  incomingItemId: true,
  outgoingItemId: true,
  durationInFrames: true,
  trackId: true,
  fromFrame: true,
};
const AUDIO_ADD_KEYS: AllowedFields = {
  type: true,
  assetId: true,
  track: true,
  trackId: true,
  startFrame: true,
  fromFrame: true,
};
const MOTION_GRAPHIC_ADD_KEYS: AllowedFields = AUDIO_ADD_KEYS;
const EFFECT_UPDATE_KEYS: AllowedFields = {
  type: true,
  targetItemId: true,
  id: true,
  effectId: true,
  assetId: true,
  propertyOverrides: true,
};
const TRANSITION_UPDATE_KEYS: AllowedFields = {
  type: true,
  id: true,
  assetId: true,
  transitionType: true,
  durationInFrames: true,
};
const EFFECT_DELETE_KEYS: AllowedFields = {
  type: true,
  targetItemId: true,
  id: true,
  effectId: true,
  assetId: true,
};
const TRANSITION_DELETE_KEYS: AllowedFields = { type: true, id: true };

/** Closest allowed key by edit distance (cap 3) for actionable spelling hints. */
export function didYouMean(got: string, allowed: readonly string[]): string | null {
  const normalized = got.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of allowed) {
    const target = candidate.toLowerCase();
    const row = Array.from({ length: target.length + 1 }, (_, index) => index);
    for (let sourceIndex = 1; sourceIndex <= normalized.length; sourceIndex += 1) {
      let diagonal = row[0]!;
      row[0] = sourceIndex;
      for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
        const prior = row[targetIndex]!;
        const cost = normalized[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1;
        row[targetIndex] = Math.min(row[targetIndex]! + 1, row[targetIndex - 1]! + 1, diagonal + cost);
        diagonal = prior;
      }
    }
    const distance = row[target.length]!;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 3 ? best : null;
}

/** Reject keys not in the allowed set; optionally give the media-replacement guidance. */
export function rejectUnknownFields(
  entry: Record<string, unknown>,
  allowed: AllowedFields,
  options?: { banAssetId?: boolean },
): string | null {
  if (options?.banAssetId && entry.assetId !== undefined) {
    return (
      'assetId cannot be updated on an existing timeline item.\n\n'
      + 'To replace media, use one edit_item batch with deletes:[{id:"old item id"}] and '
      + 'adds:[{type:"video|audio|image|gif|svg|motion-graphic", assetId:"new asset id", trackId, '
      + 'fromFrame, durationInFrames}] (read the old item first and reuse its timing). '
      + 'srcInFrame / fades / props are not add fields — set them with a follow-up edit_item '
      + 'update on the new item id after this batch applies.'
    );
  }
  const allowedList = Object.keys(allowed);
  for (const key of Object.keys(entry)) {
    if (allowed[key]) continue;
    const hint = didYouMean(key, allowedList);
    return hint
      ? `unknown field "${key}". Did you mean "${hint}"?\n\nUse only supported fields from the edit_item schema. If this was a spelling variant, retry with the exact field name from the tool description.`
      : `unknown field "${key}".\n\nUse only supported fields from the edit_item schema. Supported: ${allowedList.join(', ')}.`;
  }
  return null;
}

/** Specialized effect/transition/library validators share this exact unknown-field policy. */
export function rejectSpecializedUnknownFields(
  bucket: EditItemBucket,
  type: string,
  entry: Record<string, unknown>,
): string | null {
  let allowed: AllowedFields | null = null;
  if (bucket === 'adds') {
    if (type === 'effect') allowed = EFFECT_ADD_KEYS;
    else if (type === 'transition') allowed = TRANSITION_ADD_KEYS;
    else if (type === 'audio') allowed = AUDIO_ADD_KEYS;
    else if (type === 'motion-graphic') allowed = MOTION_GRAPHIC_ADD_KEYS;
  } else if (bucket === 'updates') {
    if (type === 'effect') allowed = EFFECT_UPDATE_KEYS;
    else if (type === 'transition') allowed = TRANSITION_UPDATE_KEYS;
  } else if (type === 'effect' || !type) {
    allowed = EFFECT_DELETE_KEYS;
  } else if (type === 'transition') {
    allowed = TRANSITION_DELETE_KEYS;
  }
  return allowed ? rejectUnknownFields(entry, allowed) : null;
}
