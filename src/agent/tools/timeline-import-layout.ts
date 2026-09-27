// Shared post-processing for imported clips: reconcile audio components with
// the video clips that already carry them, drop channel-split duplicates, and
// lay lanes out on tracks that never overlap.
//
// An OpenChatCut video clip plays its file's audio. NLE exports list that audio
// separately (EDL "A"/"A2" events beside the "V" event, FCPXML <audio>
// components or detached audio clips), so importing both would double it.
import { describeSource, type ClipFamily, type ImportReport, type ParsedClip } from './timeline-import-types';

export interface PlannedTrack {
  family: ClipFamily;
  name: string;
  clips: ParsedClip[];
}

const end = (clip: ParsedClip) => clip.startFrame + clip.durationInFrames;
const rateOf = (clip: ParsedClip) => clip.playbackRate ?? 1;
/** Source frame the clip would show at timeline frame 0: equal for clips in sync. */
const syncPoint = (clip: ParsedClip) => clip.sourceStartFrame - clip.startFrame * rateOf(clip);
const overlap = (left: ParsedClip, right: ParsedClip) => Math.min(end(left), end(right))
  - Math.max(left.startFrame, right.startFrame);

function withoutMute(clip: ParsedClip): ParsedClip {
  const { muted: _muted, ...audible } = clip;
  return audible;
}

/**
 * Merge each audio component of a video file into the in-sync video clip of the
 * same file (unmuting it when the source had split its audio off); an audio
 * component with no such clip is reported, since it cannot be carried.
 */
export function reconcileClips(clips: readonly ParsedClip[], report: ImportReport): ParsedClip[] {
  const kept = clips.filter((clip) => !clip.audioOfVideo);
  const audible = new Set<number>();
  let merged = 0;
  let longer = 0;
  for (const audio of clips.filter((clip) => clip.audioOfVideo)) {
    const match = kept
      .map((clip, index) => ({ clip, index, shared: overlap(clip, audio) }))
      .filter(({ clip, shared }) => clip.family === 'video' && clip.assetId === audio.assetId && shared > 0
        && rateOf(clip) === rateOf(audio) && Math.abs(syncPoint(clip) - syncPoint(audio)) <= 1)
      .sort((left, right) => right.shared - left.shared)[0];
    if (!match) {
      report.skipped.push({
        element: audio.from.element,
        name: audio.from.name,
        at: audio.from.at,
        reason: 'audio of a video file that is not in sync with a video clip of that file; OpenChatCut plays a video file\'s audio from its video clip',
      });
      continue;
    }
    audible.add(match.index);
    merged += 1;
    if (audio.startFrame < match.clip.startFrame - 1 || end(audio) > end(match.clip) + 1) longer += 1;
  }
  if (merged) {
    report.warnings.push(`${merged} audio component(s) of video files were merged into their video clips, which play that audio`);
  }
  if (longer) {
    report.warnings.push(`${longer} merged audio component(s) extended past their video clip (split edits); that extra audio is not imported`);
  }
  const seen = new Set<string>();
  let duplicates = 0;
  const reconciled = kept
    .map((clip, index) => (audible.has(index) && clip.muted ? withoutMute(clip) : clip))
    .filter((clip) => {
      if (clip.family !== 'audio') return true;
      const key = [clip.assetId, clip.startFrame, clip.durationInFrames, clip.sourceStartFrame, rateOf(clip)].join('|');
      if (seen.has(key)) {
        duplicates += 1;
        return false;
      }
      seen.add(key);
      return true;
    });
  if (duplicates) {
    report.warnings.push(`${duplicates} duplicate audio channel component(s) of the same file and range were merged`);
  }
  return reconciled;
}

/** Greedy interval packing: a clip goes on the first sub-track it does not overlap. */
function pack(clips: readonly ParsedClip[]): ParsedClip[][] {
  const tracks: ParsedClip[][] = [];
  for (const clip of clips.toSorted((left, right) => left.startFrame - right.startFrame)) {
    const free = tracks.find((track) => end(track[track.length - 1]!) <= clip.startFrame);
    if (free) free.push(clip);
    else tracks.push([clip]);
  }
  return tracks;
}

/**
 * Tracks in visual top-to-bottom order: video lanes from the highest down, then
 * audio lanes from the highest down. Clips of one lane that overlap (anchored
 * items of different parents, dissolve handles) get extra tracks next to it
 * instead of being shifted by the editor's collision rules.
 */
export function planTracks(clips: readonly ParsedClip[], report: ImportReport): PlannedTrack[] {
  const lanes = new Map<string, ParsedClip[]>();
  for (const clip of clips) {
    const key = `${clip.family}:${clip.lane}`;
    lanes.set(key, [...(lanes.get(key) ?? []), clip]);
  }
  const ordered = (family: ClipFamily) => [...lanes.keys()]
    .filter((key) => key.startsWith(`${family}:`))
    .map((key) => Number(key.slice(family.length + 1)))
    .sort((left, right) => right - left);
  const groups: Array<{ family: ClipFamily; clips: ParsedClip[] }> = [];
  for (const family of ['video', 'audio'] as const) {
    for (const lane of ordered(family)) {
      const packed = pack(lanes.get(`${family}:${lane}`)!);
      if (packed.length > 1) {
        const moved = packed.slice(1).reduce((sum, track) => sum + track.length, 0);
        const first = packed[1]![0]!;
        report.warnings.push(`${moved} overlapping ${family} clip(s) on one lane were placed on ${packed.length - 1} extra track(s), starting with ${describeSource(first.from)}`);
      }
      // Overflow video tracks go above their lane (later clips composite on top).
      const visual = family === 'video' ? packed.toReversed() : packed;
      groups.push(...visual.map((track) => ({ family, clips: track })));
    }
  }
  const videoCount = groups.filter((group) => group.family === 'video').length;
  let audioIndex = 0;
  return groups.map((group, index) => ({
    ...group,
    name: group.family === 'video' ? `Imported V${videoCount - index}` : `Imported A${(audioIndex += 1)}`,
  }));
}
