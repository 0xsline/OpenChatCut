import type { TimelineItem } from '../editor/types';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(',')}}`;
}

function hashRenderIdentity(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 33) + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** A render key identifies an MG asset plus its effective property values and duration. */
export function motionGraphicRenderKey(item: TimelineItem): string {
  const assetId = item.templateId ?? item.id;
  const properties = stableJson(item.props);
  const duration = Math.max(1, Math.round(item.durationInFrames));
  return hashRenderIdentity(`${assetId}\0${properties}\0${duration}`);
}

export function motionGraphicRenderFilename(itemOrKey: TimelineItem | string): string {
  const key = typeof itemOrKey === 'string' ? itemOrKey : motionGraphicRenderKey(itemOrKey);
  return `mg-${key}.mov`;
}
