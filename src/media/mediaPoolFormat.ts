import type { MediaFolder } from '../editor/types';

export function folderPath(folder: MediaFolder, folders: MediaFolder[]): string {
  const parts = [folder.name];
  const seen = new Set([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folders.find((item) => item.id === parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join('/');
}

export function durationLabel(frames: number, fps: number): string {
  const seconds = Math.max(0, Math.round(frames / fps));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
