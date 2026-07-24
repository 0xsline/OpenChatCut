// Project export/import (.ccproj.json) - cross-end migration channel: desktop version of Electron
// The IDB partition is independent of the browser and the project cannot be carried over, so this layer will be added. Envelope = ProjectDoc + Chat +
// Creative mode + referenced /media/uploads assets (base64). Import and replay: Create new project → Material writing
// mediaBlobStore (leaving files) + If it is unreachable, it will be republished directly to the local server - the path is constant /media/uploads/
// Decoupled from the physical side, the timeline src is available as is (the mechanism is the same as mediaBlobStore's new machine recovery).
import type { ProjectDoc } from '../editor/types';
import {
  createProject, isPersistedChat, loadChat, loadCreativeMode, loadProject,
  migrateProjectDoc, saveChat, saveCreativeMode,
  type PersistedChat, type ProjectMeta, type ProjectMigrationOptions,
} from './projectStore';
import {
  getMediaBlob, isMediaSrcReachable, putMediaBlob, reuploadMediaBlob,
} from './mediaBlobStore';
import { sanitizeFileName } from '../media/fileName';

export const PROJECT_EXPORT_FORMAT = 'openchatcut-project@1';
const MEDIA_PREFIX = '/media/uploads/';
const MAX_MEDIA_ENTRY_BYTES = 512 * 1024 * 1024;

export interface ProjectMediaEntry {
  src: string;
  name: string;
  mime: string;
  bytes: number;
  dataBase64: string;
}

export interface ProjectEnvelope {
  format: typeof PROJECT_EXPORT_FORMAT;
  name: string;
  exportedAt: string;
  doc: ProjectDoc;
  chat?: PersistedChat;
  creativeMode?: string;
  media: ProjectMediaEntry[];
}

/** doc quoted /media/uploads src Complete works(Material pool + Each timeline items),Remove duplication and preserve order. */
export function collectUploadSrcs(doc: ProjectDoc): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (src: unknown): void => {
    if (typeof src === 'string' && src.startsWith(MEDIA_PREFIX) && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  };
  for (const asset of doc.assets) push(asset.src);
  for (const timeline of doc.timelines) for (const item of timeline.items) push((item as { src?: unknown }).src);
  return out;
}

/** Security judgment of upload list segment(with server/media-dir isSafeUploadName Same rules,Browser side implementation)。 */
function isSafeMediaName(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function isMediaEntry(v: unknown): v is ProjectMediaEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<ProjectMediaEntry>;
  return typeof e.src === 'string' && e.src.startsWith(MEDIA_PREFIX) && isSafeMediaName(e.src.slice(MEDIA_PREFIX.length))
    && typeof e.name === 'string' && isSafeMediaName(e.name)
    && typeof e.mime === 'string'
    && typeof e.bytes === 'number' && e.bytes > 0 && e.bytes <= MAX_MEDIA_ENTRY_BYTES
    && typeof e.dataBase64 === 'string' && e.dataBase64.length > 0;
}

/** Boundary check:Import files are untrusted input.doc go migrateProjectDoc(with IDB Read the same gate)。 */
export function parseProjectEnvelope(
  text: string,
  migrationOptions?: ProjectMigrationOptions,
): { envelope: ProjectEnvelope } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not legal JSON File' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'The file content is not an object' };
  const r = raw as Record<string, unknown>;
  if (r.format !== PROJECT_EXPORT_FORMAT) {
    return { error: `Format not recognized(need ${PROJECT_EXPORT_FORMAT})` };
  }
  if (typeof r.name !== 'string' || !r.name.trim()) return { error: 'Missing project name' };
  const doc = migrateProjectDoc(r.doc, migrationOptions);
  if (!doc) return { error: 'Engineering data(doc)Verification failed' };
  const media = Array.isArray(r.media) ? r.media.filter(isMediaEntry) : [];
  const chat = isPersistedChat(r.chat) ? r.chat : undefined;
  const creativeMode = typeof r.creativeMode === 'string' && r.creativeMode ? r.creativeMode : undefined;
  return {
    envelope: {
      format: PROJECT_EXPORT_FORMAT,
      name: r.name.trim(),
      exportedAt: typeof r.exportedAt === 'string' ? r.exportedAt : '',
      doc,
      ...(chat ? { chat } : {}),
      ...(creativeMode ? { creativeMode } : {}),
      media,
    },
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

async function mediaBlobFor(src: string): Promise<{ blob: Blob; name: string; mime: string } | null> {
  const rec = await getMediaBlob(src);
  if (rec) return { blob: rec.blob, name: rec.name, mime: rec.mime };
  // IDB does not have (super cache limit/upload from other terminals) → fetch from server
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    const name = src.slice(MEDIA_PREFIX.length);
    return { blob, name, mime: blob.type || 'application/octet-stream' };
  } catch {
    return null;
  }
}

export interface ProjectExportResult {
  filename: string;
  blob: Blob;
  mediaTotal: number;
  /** Neither end can get bytes src(Export as usual,The import end will lack these materials)。 */
  mediaMissing: string[];
}

export async function buildProjectExport(id: string, name: string): Promise<ProjectExportResult> {
  const doc = await loadProject(id);
  if (!doc) throw new Error('The project does not exist or is damaged');
  const chat = await loadChat(id);
  const creativeMode = await loadCreativeMode(id);
  const srcs = collectUploadSrcs(doc);
  const media: ProjectMediaEntry[] = [];
  const mediaMissing: string[] = [];
  for (const src of srcs) {
    const found = await mediaBlobFor(src);
    if (!found || found.blob.size <= 0 || found.blob.size > MAX_MEDIA_ENTRY_BYTES) {
      mediaMissing.push(src);
      continue;
    }
    media.push({
      src,
      name: found.name,
      mime: found.mime,
      bytes: found.blob.size,
      dataBase64: await blobToBase64(found.blob),
    });
  }
  const envelope: ProjectEnvelope = {
    format: PROJECT_EXPORT_FORMAT,
    name,
    exportedAt: new Date().toISOString(),
    doc,
    ...(chat ? { chat } : {}),
    ...(creativeMode ? { creativeMode } : {}),
    media,
  };
  const safeName = sanitizeFileName(name, 'project');
  return {
    filename: `${safeName}.ccproj.json`,
    blob: new Blob([JSON.stringify(envelope)], { type: 'application/json' }),
    mediaTotal: srcs.length,
    mediaMissing,
  };
}

export interface ProjectImportResult {
  meta: ProjectMeta;
  mediaTotal: number;
  mediaRestored: number;
  mediaMissing: string[];
}

export async function applyProjectImport(envelope: ProjectEnvelope): Promise<ProjectImportResult> {
  const meta = await createProject(envelope.name, envelope.doc);
  if (envelope.chat) await saveChat(meta.id, envelope.chat);
  if (envelope.creativeMode) await saveCreativeMode(meta.id, envelope.creativeMode);

  let restored = 0;
  const failed: string[] = [];
  for (const entry of envelope.media) {
    try {
      const blob = await (await fetch(`data:${entry.mime};base64,${entry.dataBase64}`)).blob();
      await putMediaBlob(entry.src, blob, { name: entry.name, mime: entry.mime });  // Keep files (≤ cache limit)
      if (!(await isMediaSrcReachable(entry.src))) {
        await reuploadMediaBlob({ src: entry.src, blob, name: entry.name, mime: entry.mime, bytes: blob.size, savedAt: Date.now() });
      }
      restored += 1;
    } catch {
      failed.push(entry.src);
    }
  }
  // If there are no bytes in the envelope (both ends of the export end are lost) + if the current round fails, report them truthfully;
  // Total number = doc reference ∪ Envelope carrying (envelopes can carry materials other than doc, such as material pool plug-ins).
  const carried = new Set(envelope.media.map((m) => m.src));
  const docSrcs = collectUploadSrcs(envelope.doc);
  const mediaMissing = [...docSrcs.filter((s) => !carried.has(s)), ...failed];
  const mediaTotal = new Set([...docSrcs, ...carried]).size;
  return { meta, mediaTotal, mediaRestored: restored, mediaMissing };
}
