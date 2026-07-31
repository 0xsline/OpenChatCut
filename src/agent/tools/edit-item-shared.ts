import type {
  ClipEffectValue,
  TimelineItem,
  ZoomEffect,
  ZoomShape,
} from '../../editor/types';
import { ALL_FX } from '../../gl/fx/effects';
import { parseZoomLibraryId } from './library-catalog';

export type Args = Record<string, unknown>;
export type OpResult = Record<string, unknown>;

export function findItem(items: TimelineItem[], id: unknown): TimelineItem | null {
  const query = String(id ?? '');
  if (!query) return null;
  return items.find((item) => item.id === query || item.id.startsWith(query)) ?? null;
}

export function cleanOverrides(raw: unknown): Record<string, ClipEffectValue> {
  const clean: Record<string, ClipEffectValue> = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number)) clean[key] = number;
    else if (isNumericTuple(value)) clean[key] = value;
  }
  return clean;
}

function isNumericTuple(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 2
    && value.length <= 4
    && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function zoomFromOverrides(
  shape: ZoomShape,
  overrides: Record<string, ClipEffectValue>,
): ZoomEffect {
  const magnification = typeof overrides.magnification === 'number' ? overrides.magnification : 1.5;
  const focalPointX = typeof overrides.focalPointX === 'number' ? overrides.focalPointX : undefined;
  const focalPointY = typeof overrides.focalPointY === 'number' ? overrides.focalPointY : undefined;
  return {
    shape,
    magnification,
    ...(focalPointX !== undefined ? { focalPointX } : {}),
    ...(focalPointY !== undefined ? { focalPointY } : {}),
  };
}

const ZOOM_ENVELOPE_MAX_POINTS = 120;

export function envelopeFrom(raw: unknown): number[] | undefined {
  const envelope = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>).envelope
    : undefined;
  if (!Array.isArray(envelope) || envelope.length < 2 || envelope.length > ZOOM_ENVELOPE_MAX_POINTS) return undefined;
  if (!envelope.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1.5)) return undefined;
  return envelope as number[];
}

export function shapeFrom(raw: unknown): ZoomShape | undefined {
  const shape = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>).shape
    : undefined;
  return typeof shape === 'string' && parseZoomLibraryId(`library:zoom:${shape}`)
    ? shape as ZoomShape
    : undefined;
}

export function describeClip(item: TimelineItem): OpResult {
  const effects = (item.effects ?? [])
    .filter((effect) => effect.assetId in ALL_FX)
    .map((effect) => ({
      effectId: effect.id,
      assetId: effect.assetId,
      name: ALL_FX[effect.assetId]?.name,
      overrides: effect.overrides ?? {},
    }));
  return {
    itemId: item.id,
    itemKind: item.kind,
    name: item.name,
    zoom: item.zoom ?? null,
    effects,
  };
}

export function findAdjacentOutgoing(
  items: TimelineItem[],
  incoming: TimelineItem,
): TimelineItem | null {
  const prior = items.filter((item) =>
    item.id !== incoming.id
    && item.track === incoming.track
    && item.kind !== 'audio'
    && item.startFrame + item.durationInFrames <= incoming.startFrame + 2);
  if (!prior.length) return null;
  const outgoing = prior.reduce((best, item) =>
    item.startFrame + item.durationInFrames > best.startFrame + best.durationInFrames ? item : best);
  return incoming.startFrame - (outgoing.startFrame + outgoing.durationInFrames) > 2
    ? null
    : outgoing;
}
