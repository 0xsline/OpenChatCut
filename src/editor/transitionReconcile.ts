import { isAudioTransition, type TimelineItem, type TransitionItem } from './types';

const SEAM_TOLERANCE_FRAMES = 2;

/**
 * Remove transitions whose endpoints no longer form the actual compatible cut,
 * and clamp surviving durations to the timeline handles on both sides.
 * Endpoint ids and track ids are never guessed or retargeted.
 */
export function reconcileTransitions(
  items: readonly TimelineItem[],
  transitions: readonly TransitionItem[],
): TransitionItem[] {
  if (!transitions.length) return transitions as TransitionItem[];
  const byId = new Map(items.map((item) => [item.id, item]));
  const byTrack = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const trackItems = byTrack.get(item.track);
    if (trackItems) trackItems.push(item);
    else byTrack.set(item.track, [item]);
  }

  const reconciled: TransitionItem[] = [];
  for (const transition of transitions) {
    const outgoing = byId.get(transition.outgoingItemId);
    const incoming = byId.get(transition.incomingItemId);
    if (!outgoing || !incoming || outgoing.id === incoming.id) continue;
    if (outgoing.track !== incoming.track || transition.trackId !== incoming.track) continue;

    const audio = isAudioTransition(transition.type);
    if (audio ? outgoing.kind !== 'audio' || incoming.kind !== 'audio' : outgoing.kind === 'audio' || incoming.kind === 'audio') continue;

    const seamFrame = incoming.startFrame;
    const trackItems = byTrack.get(incoming.track);
    if (!trackItems) continue;
    let seamCoveredByThirdItem = false;
    for (const candidate of trackItems) {
      if (candidate.id === outgoing.id || candidate.id === incoming.id) continue;
      if (audio ? candidate.kind !== 'audio' : candidate.kind === 'audio') continue;
      const candidateEnd = candidate.startFrame + candidate.durationInFrames;
      if (candidate.startFrame < seamFrame && candidateEnd > seamFrame) {
        seamCoveredByThirdItem = true;
        break;
      }
    }
    if (seamCoveredByThirdItem) continue;

    let actualOutgoing: TimelineItem | undefined;
    for (const candidate of trackItems) {
      if (candidate.id === incoming.id) continue;
      if (candidate.startFrame >= seamFrame) continue;
      if (audio ? candidate.kind !== 'audio' : candidate.kind === 'audio') continue;
      const candidateEnd = candidate.startFrame + candidate.durationInFrames;
      if (candidateEnd > seamFrame + SEAM_TOLERANCE_FRAMES) continue;
      const actualEnd = actualOutgoing ? actualOutgoing.startFrame + actualOutgoing.durationInFrames : -Infinity;
      if (!actualOutgoing || candidateEnd > actualEnd
        || (candidateEnd === actualEnd && candidate.startFrame > actualOutgoing.startFrame)) {
        actualOutgoing = candidate;
      }
    }
    if (actualOutgoing?.id !== outgoing.id) continue;

    const seamDelta = incoming.startFrame - (outgoing.startFrame + outgoing.durationInFrames);
    if (Math.abs(seamDelta) > SEAM_TOLERANCE_FRAMES) continue;
    const maxDuration = Math.min(outgoing.durationInFrames, incoming.durationInFrames);
    if (maxDuration < 1) continue;
    const requested = Number.isFinite(transition.durationInFrames)
      ? Math.round(transition.durationInFrames)
      : 1;
    const durationInFrames = Math.max(1, Math.min(requested, maxDuration));
    reconciled.push(durationInFrames === transition.durationInFrames
      ? transition
      : { ...transition, durationInFrames });
  }
  // Content-unchanged → return the ORIGINAL array. reduce()'s exit relies on
  // this identity to keep no-op actions out of the undo history.
  if (reconciled.length === transitions.length
    && reconciled.every((transition, index) => transition === transitions[index])) {
    return transitions as TransitionItem[];
  }
  return reconciled;
}
