import type { MediaAsset, ProjectDoc, TimelineItem, TimelineState } from '../../editor/types';
import { isFileMediaKind } from '../../editor/types';
import { sourceRevisionOf } from '../../editor/mediaSourceRevision';
import { sourceFramesToTimelineFrames, timelineFramesToSourceFrames } from '../../editor/sourceLimit';
import { copyTranscriptIdentity } from '../../transcript/identity';
import { hasOperationalTranscript } from '../../transcript/types';
import { rejectUnknownFields } from './edit-item-fields';
import type { OpResult } from './edit-item-generic-result';

const REPLACEMENT_KEYS: Readonly<Record<string, true>> = {
  type: true,
  itemId: true,
  id: true,
  assetId: true,
  sourceStartFrame: true,
  sourceDurationInFrames: true,
  srcInFrame: true,
  durationInFrames: true,
};

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
);

function findItem(items: readonly TimelineItem[], value: unknown): TimelineItem | null {
  const query = String(value ?? '').trim();
  if (!query) return null;
  return items.find((item) => item.id === query || item.id.startsWith(query)) ?? null;
}

function findAsset(assets: readonly MediaAsset[], value: unknown): MediaAsset | OpResult {
  const query = String(value ?? '').trim();
  if (!query) return { error: 'pool asset replacement needs assetId' };
  const exact = assets.find((asset) => asset.id === query);
  const matches = exact ? [exact] : assets.filter((asset) => asset.id.startsWith(query));
  if (!matches.length) return { error: `no pool asset matching "${query}"` };
  if (matches.length > 1) {
    return {
      error: `ambiguous asset prefix "${query}"`,
      candidates: matches.slice(0, 6).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })),
    };
  }
  return matches[0]!;
}

function positiveFrame(value: unknown, field: string, allowZero: boolean): number | OpResult | undefined {
  if (value === undefined) return undefined;
  const parsed = finiteNumber(value);
  const minimum = allowZero ? 0 : 1;
  if (parsed === undefined || parsed < minimum) {
    return { error: `${field} must be a finite ${allowZero ? 'non-negative' : 'positive'} frame count` };
  }
  return Math.round(parsed);
}

export function validatePoolAssetReplacement(
  state: TimelineState,
  assets: readonly MediaAsset[],
  entry: Record<string, unknown>,
): OpResult {
  const unknown = rejectUnknownFields(entry, REPLACEMENT_KEYS);
  if (unknown) return { error: unknown };
  const item = findItem(state.items, entry.itemId ?? entry.id);
  if (!item) return { error: `item not found: ${String(entry.itemId ?? entry.id ?? '')}` };
  if (!isFileMediaKind(item.kind)) return { error: `pool asset replacement requires a file-backed clip, got ${item.kind}` };
  const resolved = findAsset(assets, entry.assetId);
  if ('error' in resolved) return resolved;
  const asset = resolved;
  const assetKind = asset.kind;
  if (assetKind !== 'video' && assetKind !== 'audio' && assetKind !== 'image' && assetKind !== 'gif') {
    return { error: `asset ${asset.id} is not file-backed media` };
  }
  if ((item.kind === 'audio') !== (asset.kind === 'audio')) {
    return { error: `asset ${asset.id} kind=${asset.kind} is incompatible with ${item.kind} clip ${item.id}` };
  }
  const startAlias = positiveFrame(entry.srcInFrame, 'srcInFrame', true);
  if (startAlias && typeof startAlias === 'object') return startAlias;
  const sourceStart = positiveFrame(entry.sourceStartFrame, 'sourceStartFrame', true);
  if (sourceStart && typeof sourceStart === 'object') return sourceStart;
  if (startAlias !== undefined && sourceStart !== undefined && startAlias !== sourceStart) {
    return { error: 'srcInFrame and sourceStartFrame must match when both are provided' };
  }
  const sourceDuration = positiveFrame(entry.sourceDurationInFrames, 'sourceDurationInFrames', false);
  if (sourceDuration && typeof sourceDuration === 'object') return sourceDuration;
  const timelineDuration = positiveFrame(entry.durationInFrames, 'durationInFrames', false);
  if (timelineDuration && typeof timelineDuration === 'object') return timelineDuration;
  if (sourceDuration !== undefined && timelineDuration !== undefined) {
    return { error: 'use sourceDurationInFrames or durationInFrames, not both' };
  }
  if (asset.kind === 'audio' && hasOperationalTranscript(asset)
    && (sourceStart !== undefined || startAlias !== undefined || sourceDuration !== undefined)) {
    return { error: 'raw source-frame windows are unsupported for audio assets with an operational transcript' };
  }
  const srcInFrame = asset.kind === 'video' || asset.kind === 'audio'
    ? sourceStart ?? startAlias ?? 0
    : undefined;
  const durationInFrames = sourceDuration === undefined
    ? timelineDuration ?? item.durationInFrames
    : Math.max(1, Math.round(sourceFramesToTimelineFrames(item, sourceDuration)));
  const assetDuration = finiteNumber(asset.durationInFrames) ?? 0;
  if ((asset.kind === 'video' || asset.kind === 'audio') && assetDuration > 0) {
    const sourceSpan = sourceDuration ?? timelineFramesToSourceFrames(item, durationInFrames);
    if ((srcInFrame ?? 0) + sourceSpan > assetDuration) {
      return {
        error: `source window [${srcInFrame ?? 0}, ${(srcInFrame ?? 0) + sourceSpan}) exceeds asset ${asset.id} length ${assetDuration}`,
      };
    }
  }
  return {
    ok: true,
    plan: 'replacePoolAsset',
    kind: asset.kind,
    itemId: item.id,
    assetId: asset.id,
    durationInFrames,
    srcInFrame,
    sourceStartFrame: srcInFrame ?? null,
    sourceDurationInFrames: sourceDuration
      ?? ((asset.kind === 'video' || asset.kind === 'audio')
        ? Math.round(timelineFramesToSourceFrames(item, durationInFrames))
        : null),
  };
}

export function replaceTimelineItemAsset(
  doc: ProjectDoc,
  timelineId: string,
  itemId: string,
  asset: MediaAsset,
  timing: { durationInFrames: number; srcInFrame?: number },
): ProjectDoc {
  return {
    ...doc,
    timelines: doc.timelines.map((timeline) => timeline.id !== timelineId ? timeline : {
      ...timeline,
      items: timeline.items.map((item) => {
        if (item.id !== itemId) return item;
        const {
          transcript: _transcript,
          transcriptGenerationId: _transcriptGenerationId,
          transcriptStale: _transcriptStale,
          deletedWordIdx: _deletedWordIdx,
          variants: _variants,
          silenceFrames: _silenceFrames,
          cutPadFrames: _cutPadFrames,
          gapCapsMs: _gapCapsMs,
          transcriptPlayOrder: _transcriptPlayOrder,
          denoisedSrc: _denoisedSrc,
          denoiseStrength: _denoiseStrength,
          templateId: _templateId,
          code: _code,
          props: _props,
          ...preserved
        } = item;
        return {
          ...preserved,
          kind: asset.kind as TimelineItem['kind'],
          name: asset.name,
          src: asset.src,
          sourceAssetId: asset.id,
          sourceRevision: sourceRevisionOf(asset),
          sourceContentHash: asset.sourceContentHash,
          sourceFilename: asset.sourceFilename,
          originalFilePath: asset.originalFilePath,
          width: asset.width,
          height: asset.height,
          durationInFrames: timing.durationInFrames,
          srcInFrame: asset.kind === 'video' || asset.kind === 'audio' ? timing.srcInFrame ?? 0 : undefined,
          playbackRate: asset.kind === 'video' || asset.kind === 'audio' || asset.kind === 'gif'
            ? item.playbackRate
            : undefined,
          volume: asset.kind === 'video' || asset.kind === 'audio' ? item.volume ?? 1 : undefined,
          ...copyTranscriptIdentity(asset),
        };
      }),
    }),
  };
}
