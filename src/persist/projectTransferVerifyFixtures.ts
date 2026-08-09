import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc } from '../editor/types';

export const transferVerifyDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [{
    id: 'asset_1',
    name: 'source.bin',
    kind: 'audio',
    src: '/media/uploads/source.bin',
    durationInFrames: 30,
  }],
  mediaFolders: [],
  timelines: [{
    id: 'timeline_1',
    name: 'Sequence 1',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: { A1: { kind: 'audio' } },
    trackOrder: ['A1'],
    items: [{
      id: 'clip_1',
      track: 'A1',
      startFrame: 0,
      durationInFrames: 30,
      kind: 'audio',
      name: 'source',
      src: '/media/uploads/source.bin',
      denoisedSrc: '/media/uploads/source.bin',
    }],
    selectedId: null,
  }],
  activeTimelineId: 'timeline_1',
};

export async function transferVerifyHashSrc(value: string, extension = '.bin'): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `/media/uploads/sha256-${hex}${extension}`;
}

export function transferVerifyMediaRows(
  src: string,
  value: string,
  name = src.split('/').pop() ?? 'file.bin',
): string[] {
  return [
    `${JSON.stringify({ type: 'media-start', src, name, mime: 'application/octet-stream', bytes: value.length })}\n`,
    `${JSON.stringify({ type: 'media-chunk', data: Buffer.from(value).toString('base64') })}\n`,
    `${JSON.stringify({ type: 'media-end', src })}\n`,
  ];
}
