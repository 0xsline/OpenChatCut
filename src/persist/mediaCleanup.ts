// Asset reference inventory and cleaning. Solve two things:
// ① When deleting a project, cascade delete assets - but only delete files that are "no longer referenced by other projects" (copied project sharing
// Assets with the same name, reference counting ensures that they are not accidentally killed);
// ② Unowned asset cleaning - test/deleted project files left in /media/uploads/, click "All Project Documents"
// (Including soft deletion, which can be restored and counted as a reference) Find out the reference set and delete it after confirmation.
// Disk deletion goes through DELETE /upload (single segment security name on the server side); IDB media cache is cleared synchronously.
// R2 cloud objects are deliberately not moved: local deletion is reversible (it can still be retrieved when returning to the source).
import { deleteMediaBlob } from './mediaBlobStore';
import { listPacks } from '../plugins/store';
import { listProjectDocIds, listProjects, loadProject, loadRawProject, purgeProject } from './projectStore';
import { collectUploadSrcs, rawUploadSrcs } from './projectTransfer';

const MEDIA_PREFIX = '/media/uploads/';

export interface UploadFileInfo {
  name: string;
  bytes: number;
  mtimeMs: number;
}
export interface UnreferencedSourceCandidate extends UploadFileInfo {
  kind: 'unreferenced-source';
  autoDelete: false;
}

/** Disk list (server scans the upload directory; dev has the same API as the desktop). */
export async function listUploadFiles(): Promise<UploadFileInfo[]> {
  const res = await fetch('/upload/list');
  if (!res.ok) throw new Error(`/upload/list → HTTP ${res.status}`);
  const body = (await res.json()) as { files?: UploadFileInfo[] };
  return Array.isArray(body.files) ? body.files : [];
}

/** Union of all references = project document (one ID can be excluded - the deleted project itself is excluded during cascade deletion)
 * ∪ Upload the LUT cube with the extension package installed (the reference is recorded in the shared extension storage, not in the project document. If it is missed, it will be accidentally killed).*/
export async function collectAllUploadRefs(excludeId?: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const id of await listProjectDocIds()) {
    if (id === excludeId) continue;
    const doc = await loadProject(id);
    if (doc) {
      for (const src of collectUploadSrcs(doc)) refs.add(src);
      continue;
    }
    // Can't read ≠ No citation. The reason for the migration failure may simply be "This project was written by a newer version of the build"
    // (startingDocument also returns null for version > CURRENT), it's not broken at all. treated as zero reference
    // It will delete all the assets it is using, so it degenerates into scanning the path in the original bytes: it is better to keep more than to delete by mistake.
    for (const src of rawUploadSrcs(await loadRawProject(id))) refs.add(src);
  }
  for (const pack of await listPacks().catch(() => [])) {
    for (const url of Object.values(pack.cubeUrls ?? {})) {
      if (url.startsWith(MEDIA_PREFIX)) refs.add(url);
    }
  }
  return refs;
}

/** Pure function: disk list − reference set = no owner file.*/
export function unreferencedOf(files: UploadFileInfo[], refs: Set<string>): UploadFileInfo[] {
  return files.filter((f) => !refs.has(MEDIA_PREFIX + f.name));
}

/** Delete an uploaded file (disk + IDB cache). Returns whether the server confirms.*/
export async function deleteUploadFile(name: string): Promise<boolean> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  await deleteMediaBlob(MEDIA_PREFIX + name).catch(() => {});
  return res.ok;
}

export interface CleanupScan {
  orphanDocsPurged: number;
  /** Backward-compatible candidate list used by the existing confirmation dialog. */
  files: UnreferencedSourceCandidate[];
  sourceCandidates: UnreferencedSourceCandidate[];
}

/** Inventory only: orphan project records may be purged, but source uploads are
 * returned as confirmation-required candidates and are never deleted here. */
export async function scanUnreferenced(): Promise<CleanupScan> {
  const indexed = new Set((await listProjects({ includeDeleted: true })).map((m) => m.id));
  let orphanDocsPurged = 0;
  for (const id of await listProjectDocIds()) {
    if (!indexed.has(id)) {
      await purgeProject(id);
      orphanDocsPurged += 1;
    }
  }
  const [files, refs] = await Promise.all([listUploadFiles(), collectAllUploadRefs()]);
  const sourceCandidates = unreferencedOf(files, refs).map((file) => ({
    ...file,
    kind: 'unreferenced-source' as const,
    autoDelete: false as const,
  }));
  return { orphanDocsPurged, files: sourceCandidates, sourceCandidates };
}

/** Delete the project + cascade to delete its exclusive assets (reserved assets that are also referenced by other projects).*/
export async function purgeProjectCascade(id: string): Promise<{ filesDeleted: number }> {
  const doc = await loadProject(id);
  const own = doc ? collectUploadSrcs(doc) : [];
  await purgeProject(id);
  let filesDeleted = 0;
  if (own.length) {
    const refs = await collectAllUploadRefs();
    for (const src of own) {
      if (refs.has(src)) continue;
      if (await deleteUploadFile(src.slice(MEDIA_PREFIX.length))) filesDeleted += 1;
    }
  }
  return { filesDeleted };
}
