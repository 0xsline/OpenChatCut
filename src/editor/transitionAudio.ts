import { isAudioTransition } from './types';
import type { TimelineItem, TransitionItem } from './types';
import { sourceFrameAt } from './sourceLimit';

const FRAME_EPSILON = 0.01;

function canShareAudio(
  previous: TimelineItem,
  next: TimelineItem,
  audioTransitionPairs: Set<string>,
): boolean {
  const previousAudio = previous.denoisedSrc || previous.src;
  const nextAudio = next.denoisedSrc || next.src;
  if (!previousAudio || previousAudio !== nextAudio || previous.track !== next.track) return false;
  if (previous.startFrame + previous.durationInFrames !== next.startFrame) return false;
  if (Math.abs((previous.playbackRate ?? 1) - (next.playbackRate ?? 1)) > FRAME_EPSILON) return false;
  if (audioTransitionPairs.has(`${previous.id}:${next.id}`)) return false;
  return Math.abs(sourceFrameAt(previous, previous.durationInFrames) - sourceFrameAt(next, 0)) <= FRAME_EPSILON;
}

export function continuousVideoAudioGroups(
  items: TimelineItem[],
  transitions?: TransitionItem[],
): TimelineItem[][] {
  const audioTransitionPairs = new Set((transitions ?? [])
    .filter((transition) => transition.enabled !== false && isAudioTransition(transition.type))
    .map((transition) => `${transition.outgoingItemId}:${transition.incomingItemId}`));
  const videos = items
    .filter((item) => item.kind === 'video' && !!item.src)
    .sort((a, b) => a.track.localeCompare(b.track) || a.startFrame - b.startFrame);
  const groups: TimelineItem[][] = [];
  for (const item of videos) {
    const group = groups.at(-1);
    if (group?.length && canShareAudio(group.at(-1)!, item, audioTransitionPairs)) group.push(item);
    else groups.push([item]);
  }
  return groups.filter((group) => group.length > 1);
}
