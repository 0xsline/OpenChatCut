import type { AgentContext } from '../context';
import { resolveTrackId, trackAlias, type TimelineItem } from '../../editor/types';
import { packTranscriptPhrases, type TranscriptPhrase } from '../../transcript/phrases';
import { makeWordFrameMapper } from './transcript-find';

type Args = Record<string, unknown>;

interface TimelinePhrase extends TranscriptPhrase {
  track: string;
  fromFrame: number;
  toFrame: number;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function matchingItem(items: TimelineItem[], query: string): TimelineItem | { error: string } | null {
  const exact = items.filter((item) => item.id === query);
  const matches = exact.length ? exact : items.filter((item) => item.id.startsWith(query));
  if (!matches.length) return null;
  if (matches.length > 1) return { error: `itemId prefix "${query}" is ambiguous (${matches.map((item) => item.id).join(', ')})` };
  return matches[0]!;
}

function playableWordIndices(item: TimelineItem, mapper: ReturnType<typeof makeWordFrameMapper>): number[] {
  const words = item.transcript ?? [];
  const deleted = new Set(item.deletedWordIdx ?? []);
  const order = item.transcriptPlayOrder?.length
    ? item.transcriptPlayOrder
    : words.map((_, index) => index);
  const seen = new Set<number>();
  return order.filter((index) => {
    if (!Number.isInteger(index) || deleted.has(index) || seen.has(index) || mapper(index) === null) return false;
    seen.add(index);
    return true;
  });
}

function timelinePhrases(item: TimelineItem, ctx: AgentContext, args: Args): TimelinePhrase[] {
  const state = ctx.getState();
  const baseMapper = makeWordFrameMapper(item, state.fps);
  const frameCache = new Map<number, ReturnType<typeof baseMapper>>();
  const mapper = (wordIndex: number): ReturnType<typeof baseMapper> => {
    if (!frameCache.has(wordIndex)) frameCache.set(wordIndex, baseMapper(wordIndex));
    return frameCache.get(wordIndex) ?? null;
  };
  const phrases = packTranscriptPhrases(item.transcript ?? [], {
    sourceItemId: item.id,
    silenceThresholdMs: boundedNumber(args.silenceThresholdSeconds, 0.5, 0, 10) * 1000,
    maxWordsPerPhrase: boundedInteger(args.maxWordsPerPhrase, 40, 1, 100),
    wordIndices: playableWordIndices(item, mapper),
  });
  return phrases.flatMap((phrase) => {
    const firstIndex = phrase.wordRanges[0]?.[0];
    const lastRange = phrase.wordRanges.at(-1);
    const lastIndex = lastRange ? lastRange[1] - 1 : undefined;
    const first = firstIndex === undefined ? null : mapper(firstIndex);
    const last = lastIndex === undefined ? null : mapper(lastIndex);
    if (!first || !last) return [];
    return [{
      ...phrase,
      track: trackAlias(state, item.track),
      fromFrame: first.fromFrame,
      toFrame: last.toFrame,
    }];
  });
}

export function execReadTranscript(args: Args, ctx: AgentContext): unknown {
  const state = ctx.getState();
  let items = state.items.filter((item) => (item.transcript?.length ?? 0) > 0);

  const itemQuery = typeof args.itemId === 'string' ? args.itemId.trim() : '';
  if (itemQuery) {
    const item = matchingItem(items, itemQuery);
    if (!item) return { error: `no transcribed item matching "${itemQuery}"` };
    if ('error' in item) return item;
    items = [item];
  } else {
    const trackQuery = typeof args.track === 'string' ? args.track.trim() : '';
    if (trackQuery) {
      const trackId = resolveTrackId(state, trackQuery);
      if (!trackId) return { error: `no track "${trackQuery}"` };
      items = items.filter((item) => item.track === trackId);
    }
  }

  items = [...items].sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
  if (!items.length) return { error: 'no matching transcript on the timeline; call transcribe_track first' };

  const allPhrases = items.flatMap((item) => timelinePhrases(item, ctx, args));
  const offset = boundedInteger(args.offset, 0, 0, Math.max(0, allPhrases.length));
  const limit = boundedInteger(args.limit, 80, 1, 200);
  const phrases = allPhrases.slice(offset, offset + limit);
  return {
    ok: true,
    view: 'phrases',
    timeUnit: 'milliseconds',
    clips: items.length,
    phraseCount: allPhrases.length,
    returned: phrases.length,
    offset,
    hasMore: offset + phrases.length < allPhrases.length,
    phrases,
    nextOffset: offset + phrases.length < allPhrases.length ? offset + phrases.length : null,
  };
}
