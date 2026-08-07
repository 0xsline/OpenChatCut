import type { CaptionsData, CaptionSourceEntry } from '../../captions/types.js';
import type { ProjectDoc, Timeline, TrackFlags } from '../../editor/types.js';
import { backfillCueIdentities, backfillTranscriptIdentity, isStableIdentity } from '../../transcript/identity.js';

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

function captionIdentity(captions: CaptionsData | null | undefined, seed: string): CaptionsData | null | undefined {
  if (!captions) return captions;
  let changed = false;
  const usedSourceIds = new Set<string>();
  const sourceIdChanges: Array<{ previous?: string; next: string }> = [];
  const sourceEntries = captions.sourceEntries?.map((entry, index): CaptionSourceEntry => {
    const previous = isStableIdentity(entry.id) ? entry.id : undefined;
    let id = previous ?? `source4_${stableHash(`${seed}\u0000${index}\u0000${entry.itemId}`)}`;
    if (usedSourceIds.has(id)) id = `${id}_${stableHash(`${seed}\u0000${index}`)}`;
    usedSourceIds.add(id);
    const words = entry.words ? backfillCueIdentities(entry.words, `${seed}\u0000${id}`) : entry.words;
    if (id !== entry.id || words !== entry.words) changed = true;
    sourceIdChanges.push({ previous, next: id });
    return id === entry.id && words === entry.words ? entry : { ...entry, id, words };
  });
  const words = captions.words ? backfillCueIdentities(captions.words, `${seed}\u0000standalone`) : captions.words;
  if (words !== captions.words) changed = true;
  let perSource = captions.perSource;
  if (perSource && sourceIdChanges.some(({ previous, next }) => previous !== next)) {
    perSource = { ...perSource };
    for (const { previous, next } of sourceIdChanges) {
      if (previous && perSource[previous] !== undefined && perSource[next] === undefined) perSource[next] = perSource[previous];
    }
    changed = true;
  }
  return changed ? { ...captions, sourceEntries, words, perSource } : captions;
}

function timelineIdentity(timeline: Timeline): Timeline {
  let changed = false;
  const items = timeline.items.map((item) => {
    const next = backfillTranscriptIdentity(item, `timeline:${timeline.id}:item:${item.id}`);
    if (next !== item) changed = true;
    return next;
  });
  const captions = captionIdentity(timeline.captions, `timeline:${timeline.id}:legacy-captions`);
  if (captions !== timeline.captions) changed = true;
  let tracks = timeline.tracks;
  if (tracks) {
    const nextTracks: Partial<Record<string, TrackFlags>> = {};
    for (const [trackId, flags] of Object.entries(tracks)) {
      if (!flags) continue;
      const trackCaptions = captionIdentity(flags.captions, `timeline:${timeline.id}:track:${trackId}`);
      nextTracks[trackId] = trackCaptions === flags.captions ? flags : { ...flags, captions: trackCaptions };
      if (trackCaptions !== flags.captions) changed = true;
    }
    if (changed) tracks = nextTracks;
  }
  return changed ? { ...timeline, items, captions, tracks } : timeline;
}

/** Finalize-time v4 enrichment also repairs already-written v4 docs from before stable identities existed. */
export function backfillProjectCaptionIdentity(doc: ProjectDoc): ProjectDoc {
  let changed = false;
  const assets = doc.assets.map((asset) => {
    const next = backfillTranscriptIdentity(asset, `project:${doc.activeTimelineId}:asset:${asset.id}`);
    if (next !== asset) changed = true;
    return next;
  });
  const timelines = doc.timelines.map((timeline) => {
    const next = timelineIdentity(timeline);
    if (next !== timeline) changed = true;
    return next;
  });
  return changed ? { ...doc, assets, timelines } : doc;
}
