import {
  captionTrackEntries,
  trackKind,
  type TimelineItem,
  type TimelineState,
} from '../editor/types.js';
import { isBackgroundFillActive } from '../editor/backgroundFill.js';
import { sanitizeFileName } from '../media/fileName.js';
import type {
  PremiereBakeJob,
  PremiereExportIssue,
  PremiereExportPlan,
} from './premiereTypes.js';

const IDENTITY_EPSILON = 1e-6;

function differsFrom(value: number | undefined, identity: number): boolean {
  return typeof value === 'number'
    && (!Number.isFinite(value) || Math.abs(value - identity) > IDENTITY_EPSILON);
}

function hasVisualTransform(item: TimelineItem): boolean {
  const transform = item.transform;
  if (transform && (
    differsFrom(transform.scale, 1)
    || differsFrom(transform.scaleX, 1)
    || differsFrom(transform.scaleY, 1)
    || differsFrom(transform.x, 0)
    || differsFrom(transform.y, 0)
    || differsFrom(transform.rotation, 0)
    || differsFrom(transform.opacity, 1)
    || (typeof transform.borderRadius === 'number' && Math.abs(transform.borderRadius) > IDENTITY_EPSILON)
    || Object.values(transform.crop ?? {}).some((value) => typeof value === 'number'
      && (!Number.isFinite(value) || Math.abs(value) > IDENTITY_EPSILON))
  )) return true;

  return Object.entries(item.keyframes ?? {}).some(([property, frames]) => (
    property !== 'volume' && Array.isArray(frames) && frames.length > 0
  ));
}

function hasAudioFade(item: TimelineItem): boolean {
  return (item.fadeInFrames ?? 0) > 0 || (item.fadeOutFrames ?? 0) > 0;
}

function itemAudioReasons(item: TimelineItem): string[] {
  const reasons: string[] = [];
  const volumeKeyframes = item.keyframes?.volume ?? [];
  const hasNonlinearVolumeKeyframes = volumeKeyframes.some((keyframe) => (
    keyframe.easing !== undefined && keyframe.easing !== 'linear'
  ));

  if (item.denoisedSrc) reasons.push('Voice-isolation playback mixes the original and denoised media and needs an audio render.');
  if (hasNonlinearVolumeKeyframes) reasons.push('Nonlinear audio volume keyframe easing is not represented by the native XMEML mapping.');
  if (volumeKeyframes.length && hasAudioFade(item)) {
    reasons.push('Audio volume keyframes combined with fades need a rendered audio stream.');
  }

  return reasons;
}

function itemVisualReasons(item: TimelineItem, state: TimelineState): string[] {
  const reasons: string[] = [];
  switch (item.kind) {
    case 'motion-graphic': reasons.push('OpenChatCut motion graphics are rendered as a transparent video layer.'); break;
    case 'text': reasons.push('Editable OpenChatCut text is rendered as a transparent video layer.'); break;
    case 'solid': reasons.push('OpenChatCut solid layers are rendered as a transparent video layer.'); break;
    case 'svg': reasons.push('SVG media is rendered to a Premiere-compatible video layer.'); break;
    case 'gif': reasons.push('GIF media is rendered to a Premiere-compatible video layer.'); break;
    case 'sequence': break;
    default: break;
  }

  if ((item.effects?.length ?? 0) > 0) reasons.push('WebGL effects or LUTs are not native Premiere clip effects.');
  if (item.filters) reasons.push('Per-clip color or blur filters are not represented in the XML clip mapping.');
  if (hasVisualTransform(item)) reasons.push('Per-clip transform, crop, border radius, opacity, or visual keyframes are not represented in the XML clip mapping.');
  if (item.zoom) reasons.push('Animated zoom or reframe data is not represented in the XML clip mapping.');
  if (isBackgroundFillActive(state, item)) reasons.push('Blurred background fill requires the OpenChatCut compositor.');
  if (item.kind !== 'audio' && ((item.fadeInFrames ?? 0) > 0 || (item.fadeOutFrames ?? 0) > 0)) {
    reasons.push('Visual clip fades are not represented by the native Premiere clip mapping.');
  }
  return [...new Set(reasons)];
}

function jobFilename(item: TimelineItem, kind: PremiereBakeJob['kind']): string {
  const id = sanitizeFileName(item.id, 'clip').replace(/\.mov$/i, '');
  return `premiere-${id}-${kind}.mov`;
}

function sourceDimensionsKnown(state: TimelineState, item: TimelineItem): boolean {
  const asset = (item.sourceAssetId
    ? state.assets?.find((candidate) => candidate.id === item.sourceAssetId)
    : undefined)
    ?? (item.src ? state.assets?.find((candidate) => candidate.src === item.src) : undefined);
  const width = asset?.width ?? item.width;
  const height = asset?.height ?? item.height;
  return typeof width === 'number' && Number.isFinite(width) && width > 0
    && typeof height === 'number' && Number.isFinite(height) && height > 0;
}

/**
 * Make a selective Premiere handoff plan. Plain video, image, and audio
 * sources keep their source refs so Premiere can edit them directly. Only
 * clip-local features that the XML serializer cannot express become bake jobs.
 */
export function planPremiereExport(state: TimelineState): PremiereExportPlan {
  const bakeJobs: PremiereBakeJob[] = [];
  const issues: PremiereExportIssue[] = [];
  const jobByKey = new Map<string, PremiereBakeJob>();

  const addIssue = (
    severity: PremiereExportIssue['severity'],
    code: string,
    message: string,
    itemIds: readonly string[] = [],
  ): void => {
    const ids = [...new Set(itemIds)];
    const current = issues.find((issue) => issue.code === code && issue.message === message && issue.severity === severity);
    if (current) {
      current.itemIds = [...new Set([...current.itemIds, ...ids])];
      return;
    }
    issues.push({ severity, code, message, itemIds: ids });
  };

  const addJob = (item: TimelineItem, kind: PremiereBakeJob['kind'], reasons: string[]): void => {
    const key = `${item.id}:${kind}`;
    const existing = jobByKey.get(key);
    if (existing) {
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      return;
    }
    const job: PremiereBakeJob = {
      itemId: item.id,
      kind,
      filename: jobFilename(item, kind),
      reasons: [...new Set(reasons)],
    };
    jobByKey.set(key, job);
    bakeJobs.push(job);
  };

  const allItemIds = state.items.map((item) => item.id);
  const itemIdCounts = new Map<string, number>();
  for (const item of state.items) itemIdCounts.set(item.id, (itemIdCounts.get(item.id) ?? 0) + 1);
  const duplicateItemIds = new Set([...itemIdCounts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id));
  for (const id of duplicateItemIds) {
    addIssue(
      'error',
      'premiere-duplicate-item-id',
      `Timeline item id ${id || '<empty>'} is duplicated; item-scoped Premiere media cannot be matched safely.`,
      [id],
    );
  }

  // XMEML's ordinary track model is sequential. Any same-lane overlap would
  // imply an unrepresented composite, even if one of the items is disabled.
  const byTrack = new Map<string, TimelineItem[]>();
  for (const item of state.items) {
    const lane = byTrack.get(item.track) ?? [];
    lane.push(item);
    byTrack.set(item.track, lane);
  }
  for (const [trackId, lane] of byTrack) {
    const sorted = lane
      .filter((item) => Number.isFinite(item.startFrame)
        && Number.isFinite(item.durationInFrames)
        && item.durationInFrames > 0)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex++) {
      const left = sorted[leftIndex]!;
      const leftEnd = left.startFrame + left.durationInFrames;
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex++) {
        const right = sorted[rightIndex]!;
        if (right.startFrame >= leftEnd) break;
        addIssue(
          'error',
          'premiere-overlapping-items',
          `Items ${left.id} and ${right.id} overlap on track ${trackId}; same-track composites need a group render.`,
          [left.id, right.id],
        );
      }
    }
  }

  const enabledCaptions = state.captions?.enabled === true
    || captionTrackEntries(state).some((entry) => entry.captions?.enabled === true);
  if (enabledCaptions) {
    addIssue(
      'error',
      'premiere-captions-require-composite',
      'Enabled captions are a timeline-wide overlay and cannot be preserved by isolated clip bakes.',
      allItemIds,
    );
  }

  if (state.watermark?.enabled && typeof state.watermark.text === 'string' && state.watermark.text.trim()) {
    addIssue(
      'error',
      'premiere-watermark-requires-composite',
      'The enabled watermark is a timeline-wide overlay and cannot be preserved by isolated clip bakes.',
      allItemIds,
    );
  }

  for (const transition of state.transitions ?? []) {
    if (transition.enabled === false) continue;
    const audio = transition.type === 'audio-cross-fade';
    addIssue(
      'error',
      audio ? 'premiere-audio-transition-requires-group-bake' : 'premiere-transition-requires-group-bake',
      audio
        ? 'Audio transitions need a multi-clip mix render, which the selective clip baker does not provide.'
        : transition.type === 'custom-shader'
          ? 'Custom WebGL transitions need both clips and a composite render.'
          : 'Timeline transitions need both clips and a composite render.',
      [transition.outgoingItemId, transition.incomingItemId],
    );
  }

  const anchorRanges = state.items
    .filter((item) => state.tracks?.[item.track]?.role === 'anchor'
      && state.tracks?.[item.track]?.hidden !== true
      && state.tracks?.[item.track]?.muted !== true
      && !!item.src)
    .map((item) => [item.startFrame, item.startFrame + item.durationInFrames] as const);

  for (const item of state.items) {
    const kind = item.kind;
    if (duplicateItemIds.has(item.id)) continue;
    if (item.srcInFrame !== undefined
      && (typeof item.srcInFrame !== 'number' || !Number.isFinite(item.srcInFrame) || item.srcInFrame < 0)) {
      addIssue(
        'error',
        'premiere-invalid-source-in-frame',
        `${item.name}: source in-point must be a finite non-negative frame value.`,
        [item.id],
      );
      continue;
    }
    if (['video', 'audio', 'image', 'gif', 'svg'].includes(kind) && !item.src?.trim()) {
      addIssue(
        'error',
        'premiere-media-source-missing',
        `${item.name}: the media source is missing; no Premiere clip can be written.`,
        [item.id],
      );
      continue;
    }
    const sourceBearingVisual = kind !== 'audio' && kind !== 'sequence';
    const visualTrack = trackKind(state, item.track) === 'video';
    if (sourceBearingVisual && !visualTrack) {
      addIssue('error', 'premiere-visual-track-kind-mismatch', 'A visual clip is placed on a non-video track and cannot be mapped faithfully.', [item.id]);
      continue;
    }
    if (kind === 'audio' && trackKind(state, item.track) !== 'audio') {
      addIssue('error', 'premiere-audio-track-kind-mismatch', 'An audio clip is placed on a non-audio track and cannot be mapped faithfully.', [item.id]);
      continue;
    }
    if (kind === 'sequence') {
      addIssue('error', 'premiere-nested-sequence-requires-group-render', 'Nested sequences require their referenced timeline and a group render.', [item.id]);
      continue;
    }

    const track = state.tracks?.[item.track];
    const playbackRate = item.playbackRate ?? 1;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
      addIssue(
        'error',
        'premiere-invalid-playback-rate',
        'Playback speed must be a positive finite value for Premiere retiming.',
        [item.id],
      );
      continue;
    }

    const visualReasons = itemVisualReasons(item, state);
    // Disabled tracks still need valid layer bakes so that un-hiding or
    // un-muting the sequence in Premiere does not reveal an incomplete edit.
    const audioReasons = itemAudioReasons(item);
    if (track?.role === 'follower' && anchorRanges.some(([from, to]) => (
      item.startFrame < to && item.startFrame + item.durationInFrames > from
    ))) {
      addIssue(
        'error',
        'premiere-ducking-requires-mix-render',
        'Track ducking depends on overlapping clips and cannot be preserved by isolated audio bakes.',
        [item.id, ...state.items.filter((candidate) => state.tracks?.[candidate.track]?.role === 'anchor'
          && item.startFrame < candidate.startFrame + candidate.durationInFrames
          && item.startFrame + item.durationInFrames > candidate.startFrame).map((candidate) => candidate.id)],
      );
    }

    if (kind === 'audio') {
      if (audioReasons.length) {
        if (!item.src) {
          addIssue('error', 'premiere-audio-bake-source-missing', 'The audio clip needs baking but has no media source.', [item.id]);
          continue;
        }
        addJob(item, 'audio', audioReasons);
        addIssue('warning', 'premiere-audio-clip-will-be-baked', `${item.name}: ${audioReasons.join(' ')}`, [item.id]);
      }
      continue;
    }

    if (visualReasons.length) {
      if (kind === 'motion-graphic' && !item.code) {
        addIssue('error', 'premiere-motion-graphic-code-missing', 'This motion graphic has no saved render code and cannot be baked.', [item.id]);
        continue;
      }
      if (['video', 'image', 'gif', 'svg'].includes(kind) && !item.src) {
        addIssue('error', 'premiere-visual-bake-source-missing', 'The visual clip needs baking but has no media source.', [item.id]);
        continue;
      }
      addJob(item, 'visual', visualReasons);
      addIssue(
        'warning',
        'premiere-clip-will-be-baked',
        `${item.name}: ${visualReasons.join(' ')}`,
        [item.id],
      );
    }

    if (!visualReasons.length
      && sourceBearingVisual
      && visualTrack
      && track?.hidden !== true
      && ['video', 'image', 'gif', 'svg'].includes(kind)
      && !sourceDimensionsKnown(state, item)) {
      addIssue(
        'warning',
        'premiere-source-dimensions-unknown',
        `${item.name}: source dimensions are unknown, so Premiere will keep its default Basic Motion scale.`,
        [item.id],
      );
    }

    if (audioReasons.length && item.src) {
      addJob(item, 'audio', audioReasons);
      addIssue('warning', 'premiere-audio-clip-will-be-baked', `${item.name}: ${audioReasons.join(' ')}`, [item.id]);
    } else if (audioReasons.length) {
      addIssue('error', 'premiere-audio-bake-source-missing', 'The audio needs baking but has no media source.', [item.id]);
    }
  }

  return { bakeJobs, issues };
}

/** Strip all timeline-level overlays and other clips for one layer render. */
export function premiereBakeState(
  state: TimelineState,
  item: TimelineItem,
  kind: PremiereBakeJob['kind'],
): TimelineState {
  const captionsWereHidden = state.captionsHidden === true
    || (state.captionsHidden === undefined
      && captionTrackEntries(state).length > 0
      && captionTrackEntries(state).every((entry) => !entry.captions?.enabled));
  const tracks = state.tracks
    ? Object.fromEntries(Object.entries(state.tracks).map(([trackId, config]) => {
      if (!config) return [trackId, config];
      const { captions: _captions, ...withoutCaptions } = config;
      return [trackId, withoutCaptions];
    })) as TimelineState['tracks']
    : undefined;
  let bakedItem: TimelineItem = { ...item, startFrame: 0 };
  if (kind === 'visual') {
    const keyframes = item.keyframes ? { ...item.keyframes } : undefined;
    if (keyframes) delete keyframes.volume;
    bakedItem = { ...bakedItem, volume: 0, ...(keyframes ? { keyframes } : { keyframes: undefined }) };
  } else if (item.kind !== 'audio') {
    // Transcript edits on a video item alter its timeline picture/audio pairing,
    // not the continuous embedded source-audio stream. A companion audio bake
    // must preserve the media trim and rate while bypassing those speech edits.
    const {
      transcript: _transcript,
      transcriptGenerationId: _transcriptGenerationId,
      variants: _variants,
      deletedWordIdx: _deletedWordIdx,
      transcriptPlayOrder: _transcriptPlayOrder,
      silenceFrames: _silenceFrames,
      cutPadFrames: _cutPadFrames,
      gapCapsMs: _gapCapsMs,
      ...withoutTranscriptEdits
    } = item;
    const audioKeyframes = item.keyframes?.volume
      ? { volume: item.keyframes.volume }
      : undefined;
    bakedItem = {
      ...withoutTranscriptEdits,
      kind: 'audio',
      transcript: undefined,
      transcriptStale: true,
      keyframes: audioKeyframes,
      startFrame: 0,
    };
  }

  const bakedTrack = {
    ...(tracks?.[item.track] ?? {}),
    kind: kind === 'visual' ? 'video' as const : 'audio' as const,
    hidden: false,
    muted: kind === 'visual',
  };
  return {
    ...state,
    items: [bakedItem],
    selectedId: null,
    selectedIds: [],
    transitions: [],
    markers: [],
    captions: null,
    tracks: { ...(tracks ?? {}), [item.track]: bakedTrack },
    captionsHidden: captionsWereHidden,
    watermark: state.watermark ? { ...state.watermark, enabled: false, text: '' } : undefined,
  };
}
