import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';

// ── Project card poster frame cache (key=updatedAt, re-rendering will be invalidated as soon as the project changes) ──────────────────
interface ProjectThumb {
  key: number;
  dataUrl: string;
}

export async function loadProjectThumb(id: string): Promise<ProjectThumb | null> {
  const v = await idbGet<ProjectThumb>(`thumb:${id}`);
  return v && typeof v.dataUrl === 'string' && typeof v.key === 'number' ? v : null;
}

export async function saveProjectThumb(id: string, key: number, dataUrl: string): Promise<void> {
  await idbSet(`thumb:${id}`, { key, dataUrl });
}
