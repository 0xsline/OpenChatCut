import type { KeptSegment } from '../transcript/edit';

/**
 * Which transcript windows an audio clip should actually play, or null to play
 * the clip plainly.
 *
 * A transcript-driven clip plays the source windows its words describe. ASR run
 * over non-speech audio (a sound effect, say) hallucinates words, and obeying
 * them silences the clip with nothing on screen to explain it:
 *   1. a window that starts past the end of the media ("Music" at 24.4 s inside
 *      a 3 s sting) is never a real edit — it is dropped;
 *   2. an untouched transcript that would keep less than half the clip (one
 *      bogus word inside a 1.8 s sting) is not an edit either — it is ignored.
 * Real word deletions still win: once the user deleted a word, short windows
 * are intentional.
 */
export function audibleTranscriptSegments(
  segments: readonly KeptSegment[],
  clip: { durationInFrames: number; deletedWordCount: number; sourceDurationInFrames?: number },
): KeptSegment[] | null {
  const inside = clip.sourceDurationInFrames === undefined
    ? [...segments]
    : segments.filter((segment) => segment.srcStartFrame < clip.sourceDurationInFrames!);
  if (!inside.length) return null;
  const keptFrames = inside.reduce((total, segment) => total + segment.durFrames, 0);
  if (clip.deletedWordCount === 0 && keptFrames * 2 < clip.durationInFrames) return null;
  return inside;
}
