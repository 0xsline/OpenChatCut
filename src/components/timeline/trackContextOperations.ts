import type { Action } from '../../editor/reduce';
import type { CaptionsData } from '../../captions/types';
import type { TranscriptWord } from '../../transcript/types';
import { captionsOnTrack, timelineTrackIds, type TimelineState, type TrackId, type TrackKind } from '../../editor/types';

export function trackContextMenuLabels(kind: TrackKind): string[] {
  const insert = kind === 'audio' ? '插入音频' : kind === 'caption' ? '插入字幕' : '插入素材';
  return [
    insert, '闭合缝隙', '全选', '清空', '隐藏轨道',
    ...(kind === 'caption' ? [] : ['静音轨道']),
    '锁定轨道',
    ...(kind === 'caption' ? ['字幕样式', '翻译全部'] : ['自动闪避']),
    '删除轨道',
  ];
}

function closeWordGaps(words: readonly TranscriptWord[]): { words: TranscriptWord[]; changed: boolean } {
  if (words.length < 2) return { words: [...words], changed: false };
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const next: TranscriptWord[] = [{ ...sorted[0]! }];
  let cursor = sorted[0]!.end;
  let previousOriginalEnd = sorted[0]!.end;
  let changed = false;
  for (const word of sorted.slice(1)) {
    const duration = Math.max(1, word.end - word.start);
    if (word.start > previousOriginalEnd) {
      next.push({ ...word, start: cursor, end: cursor + duration });
      cursor += duration;
      changed = true;
    } else {
      next.push({ ...word });
      cursor = Math.max(cursor, word.end);
    }
    previousOriginalEnd = Math.max(previousOriginalEnd, word.end);
  }
  return { words: next, changed };
}

/** Close positive gaps in standalone/manual caption lanes while preserving overlaps and cue durations. */
export function closeCaptionTrackGaps(captions: CaptionsData): { captions: CaptionsData; changed: boolean } {
  let changed = false;
  const standalone = captions.words ? closeWordGaps(captions.words) : null;
  if (standalone?.changed) changed = true;
  const sourceEntries = captions.sourceEntries?.map((entry) => {
    if (!entry.words) return entry;
    const result = closeWordGaps(entry.words);
    if (result.changed) changed = true;
    return result.changed ? { ...entry, words: result.words } : entry;
  });
  if (!changed) return { captions, changed: false };
  return {
    changed: true,
    captions: {
      ...captions,
      ...(standalone?.changed ? { words: standalone.words } : {}),
      ...(sourceEntries ? { sourceEntries } : {}),
    },
  };
}

export interface TrackClearPlan {
  blockedReason: 'missing' | 'locked' | null;
  hasContents: boolean;
  actions: Action[];
}

/** Build an explicit, undoable clear transaction without deleting the track itself. */
export function trackClearPlan(state: TimelineState, trackId: TrackId): TrackClearPlan {
  if (!timelineTrackIds(state).includes(trackId)) return { blockedReason: 'missing', hasContents: false, actions: [] };
  if (state.tracks?.[trackId]?.locked) return { blockedReason: 'locked', hasContents: false, actions: [] };
  const itemIds = new Set(state.items.filter((item) => item.track === trackId).map((item) => item.id));
  const transitionIds = (state.transitions ?? [])
    .filter((transition) => transition.trackId === trackId
      || itemIds.has(transition.incomingItemId)
      || itemIds.has(transition.outgoingItemId))
    .map((transition) => transition.id);
  const ownsCaptions = !!captionsOnTrack(state, trackId);
  const actions: Action[] = [
    ...transitionIds.map((id): Action => ({ type: 'removeTransition', id })),
    ...[...itemIds].map((id): Action => ({ type: 'remove', id })),
    ...(ownsCaptions ? [{ type: 'setCaptions', captions: null, track: trackId } as Action] : []),
  ];
  return { blockedReason: null, hasContents: actions.length > 0, actions };
}
