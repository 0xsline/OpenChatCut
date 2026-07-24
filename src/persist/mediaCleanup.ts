// Material reference inventory and cleaning. Solve two things:
//   ① When deleting a project, the materials will be deleted cascade-but only files that are “no longer referenced by other projects” will be deleted (copied project sharing
//      For materials with the same name, reference counting ensures that they are not accidentally killed);
//   ② Cleaning of unowned materials - test/deleted project files left in /media/uploads/, click "All Project Documents"
//      (Including soft deletion, which can be restored and counted as a reference) Find out the reference set and delete it after confirmation.
// Delete the disk through DELETE /upload (single segment security name on the server side); the IDB media cache is cleared synchronously.
// R2 cloud objects are deliberately not moved: local deletion is reversible (it can still be retrieved when returning to the source).
import { deleteMediaBlob } from './mediaBlobStore';
import { listPacks } from '../plugins/store';
import { listProjectDocIds, listProjects, loadProject, purgeProject } from './projectStore';
import { collectUploadSrcs } from './projectTransfer';

const MEDIA_PREFIX = '/media/uploads/';

export interface UploadFileInfo {
  name: string;
  bytes: number;
  mtimeMs: number;
}

/** Board list(server Scan to upload directory;dev Same as desktop API)。 */
export async function listUploadFiles(): Promise<UploadFileInfo[]> {
  const res = await fetch('/upload/list');
  if (!res.ok) throw new Error(`/upload/list → HTTP ${res.status}`);
  const body = (await res.json()) as { files?: UploadFileInfo[] };
  return Array.isArray(body.files) ? body.files : [];
}

/** Union of all references = Engineering documentation(One can be excluded id——Exclude the deleted project itself during cascade deletion)
 * ∪ Extension pack installed LUT cube upload(References are recorded in shared extended storage,Not in the project document,If you miss it, you will accidentally kill someone.)。 */
export async function collectAllUploadRefs(excludeId?: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const id of await listProjectDocIds()) {
    if (id === excludeId) continue;
    const doc = await loadProject(id);
    if (!doc) continue; // Bad documents cannot read references; their materials naturally fall into the unowned list, and the documents themselves are processed by orphan cleaning.
    for (const src of collectUploadSrcs(doc)) refs.add(src);
  }
  for (const pack of await listPacks().catch(() => [])) {
    for (const url of Object.values(pack.cubeUrls ?? {})) {
      if (url.startsWith(MEDIA_PREFIX)) refs.add(url);
    }
  }
  return refs;
}

/** pure function:Board list − reference set = No master file. */
export function unreferencedOf(files: UploadFileInfo[], refs: Set<string>): UploadFileInfo[] {
  return files.filter((f) => !refs.has(MEDIA_PREFIX + f.name));
}

/** Delete an uploaded file(Disk + IDB cache). Return server Confirm or not. */
export async function deleteUploadFile(name: string): Promise<boolean> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  await deleteMediaBlob(MEDIA_PREFIX + name).catch(() => {});
  return res.ok;
}

export interface CleanupScan {
  orphanDocsPurged: number;
  files: UploadFileInfo[];
}

/** Clean panel entrance:Clear the orphan project documents first(outside of index project:* ——smoke/remnants of old tests),
 * Then return to the current unowned file list. */
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
  return { orphanDocsPurged, files: unreferencedOf(files, refs) };
}

/** Delete project + Cascade delete their exclusive materials(Reserves that are also referenced by other projects)。 */
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
