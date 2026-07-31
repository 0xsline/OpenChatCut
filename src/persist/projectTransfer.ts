// Portable project packages. v2 is a newline-delimited stream: ProjectDoc is
// validated once, then each media blob is encoded/decoded in bounded chunks.
// Legacy openchatcut-project@1 JSON remains readable for cross-version transfer.
import type { ProjectDoc } from '../editor/types';
import {
  createProject, isPersistedChat, loadChat, loadCreativeMode, loadProject,
  migrateProjectDoc, saveChat, saveCreativeMode,
  type PersistedChat, type ProjectMeta, type ProjectMigrationOptions,
} from './projectStore';
import {
  commitMediaBlobImport, createMediaBlobImportNamespace, discardMediaBlobImport,
  getMediaBlob, publishMediaBlobImport, rollbackMediaBlobImport, stageMediaBlobImport,
  type StagedMediaBlobImportEntry,
} from './mediaBlobStore';
import { sanitizeFileName } from '../media/fileName';

export const PROJECT_EXPORT_FORMAT = 'openchatcut-project@1';
export const PROJECT_STREAM_FORMAT = 'openchatcut-project@2';
const MEDIA_PREFIX = '/media/uploads/';
const MAX_MEDIA_ENTRY_BYTES = 512 * 1024 * 1024;
let streamPublicationQueue: Promise<void> = Promise.resolve();

function enqueueStreamPublication<T>(work: () => Promise<T>): Promise<T> {
  const run = streamPublicationQueue.catch(() => undefined).then(work);
  streamPublicationQueue = run.then(() => undefined, () => undefined);
  return run;
}

export interface ProjectMediaEntry {
  src: string;
  name: string;
  mime: string;
  bytes: number;
  sourceRevision?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
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

interface ProjectStreamManifest {
  format: typeof PROJECT_STREAM_FORMAT;
  type: 'manifest';
  name: string;
  exportedAt: string;
  doc: ProjectDoc;
  chat?: PersistedChat;
  creativeMode?: string;
}

export type ProjectMediaManifestEntry = Omit<ProjectMediaEntry, 'dataBase64'>;

interface StagedProjectImport {
  name: string;
  doc: ProjectDoc;
  chat?: PersistedChat;
  creativeMode?: string;
  carriedSrcs: string[];
  mediaRestored: number;
  mediaImport?: {
    namespace: string;
    entries: StagedMediaBlobImportEntry[];
  };
}

export interface ProjectImportOptions {
  migrationOptions?: ProjectMigrationOptions;
  /** Test/host seam for the single publish step after all validation succeeds. */
  publish?: (staged: Pick<StagedProjectImport, 'name' | 'doc' | 'chat' | 'creativeMode'>) => Promise<ProjectMeta>;
}

/** The complete set of /media/uploads src referenced by doc (asset pool + each timeline items), without duplication and order preservation. */
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
  for (const timeline of doc.timelines) {
    for (const item of timeline.items) {
      push((item as { src?: unknown }).src);
      // The apply path of isolate_voice directly links the /media/uploads path to denoisedSrc without creating assets.
      // If you miss it, the separated audio track being played will be deleted as an orphan.
      push((item as { denoisedSrc?: unknown }).denoisedSrc);
    }
  }
  return out;
}

/**
 * Get asset references from the **unreadable** original bytes of the project. The reason for migration failure may simply be "This project is an updated version.
 *'s build" - it's not broken at all, but `migrateProjectDoc` always returns null. If this kind of document is regarded as
 * "Zero reference", cleanup will delete all the assets it is using as orphans.
 *
 * This is reduced to scanning `/media/uploads/<security name>` directly in the JSON text: I would rather leave a few more files,
 * Nor can you delete assets being referenced by projects that you cannot understand.
 */
export function rawUploadSrcs(raw: unknown): string[] {
  if (raw == null) return [];
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    return []; // Circular references, etc.: If they cannot be scanned, they will be handed over to the caller as "unknown".
  }
  const found = new Set<string>();
  for (const [, name] of text.matchAll(/\/media\/uploads\/([^"'\\/\s?#]+)/g)) {
    if (isSafeMediaName(name)) found.add(MEDIA_PREFIX + name);
  }
  return [...found];
}

/** Upload list segment safety determination (same rules as server/media-dir isSafeUploadName, implemented on the browser side). */
function isSafeMediaName(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  return !name.includes('/') && !name.includes('\\') && !name.includes('\0');
}

function rewriteProjectMediaSrcs(doc: ProjectDoc, replacements: ReadonlyMap<string, string>): ProjectDoc {
  if (replacements.size === 0) return doc;
  const rewritten = structuredClone(doc);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const item = value[index];
        if (typeof item === 'string') value[index] = replacements.get(item) ?? item;
        else visit(item);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (typeof item === 'string') record[key] = replacements.get(item) ?? item;
      else visit(item);
    }
  };
  visit(rewritten);
  return rewritten;
}

function isMediaEntry(v: unknown): v is ProjectMediaEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<ProjectMediaEntry>;
  return typeof e.src === 'string' && e.src.startsWith(MEDIA_PREFIX) && isSafeMediaName(e.src.slice(MEDIA_PREFIX.length))
    && typeof e.name === 'string' && isSafeMediaName(e.name)
    && typeof e.mime === 'string'
    && typeof e.bytes === 'number' && e.bytes > 0 && e.bytes <= MAX_MEDIA_ENTRY_BYTES
    && (e.sourceRevision === undefined || typeof e.sourceRevision === 'string')
    && (e.sourceSize === undefined || (typeof e.sourceSize === 'number' && Number.isFinite(e.sourceSize)))
    && (e.sourceModifiedAt === undefined || (typeof e.sourceModifiedAt === 'number' && Number.isFinite(e.sourceModifiedAt)))
    && typeof e.dataBase64 === 'string' && e.dataBase64.length > 0;
}

/** Boundary check: The imported file is an untrusted input. doc goes through migrateProjectDoc (the same gate as IDB reading). */
export function parseProjectEnvelope(
  text: string,
  migrationOptions?: ProjectMigrationOptions,
): { envelope: ProjectEnvelope } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: '不是合法的 JSON 文件' };
  }
  if (!raw || typeof raw !== 'object') return { error: '文件内容不是对象' };
  const r = raw as Record<string, unknown>;
  if (r.format !== PROJECT_EXPORT_FORMAT) {
    return { error: `格式不识别(需要 ${PROJECT_EXPORT_FORMAT})` };
  }
  if (typeof r.name !== 'string' || !r.name.trim()) return { error: '缺工程名' };
  const doc = migrateProjectDoc(r.doc, migrationOptions);
  if (!doc) return { error: '工程数据(doc)校验不通过' };
  if (!Array.isArray(r.media)) return { error: '工程包缺媒体清单' };
  if (!r.media.every(isMediaEntry)) return { error: '工程包媒体条目校验不通过' };
  const media = r.media;
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

const textEncoder = new TextEncoder();

function arrayBufferBlobPart(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  const { buffer, byteLength, byteOffset } = bytes;
  if (buffer instanceof ArrayBuffer) {
    return byteOffset === 0 && byteLength === buffer.byteLength
      ? buffer
      : buffer.slice(byteOffset, byteOffset + byteLength);
  }
  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function jsonLine(value: unknown): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(value)}\n`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('工程包媒体 base64 数据损坏');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('工程包媒体 base64 数据损坏');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function* base64Chunks(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().getReader();
  let carry = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(carry.length + value.length);
      joined.set(carry);
      joined.set(value, carry.length);
      const complete = joined.length - (joined.length % 3);
      if (complete > 0) yield bytesToBase64(joined.subarray(0, complete));
      carry = joined.slice(complete);
    }
    if (carry.length > 0) yield bytesToBase64(carry);
  } finally {
    reader.releaseLock();
  }
}

async function* projectExportChunks(
  manifest: ProjectStreamManifest,
  srcs: readonly string[],
  missing: string[],
): AsyncGenerator<Uint8Array> {
  yield jsonLine(manifest);
  for (const src of srcs) {
    const found = await mediaBlobFor(src);
    if (!found || found.blob.size <= 0 || found.blob.size > MAX_MEDIA_ENTRY_BYTES) {
      missing.push(src);
      continue;
    }
    const asset = manifest.doc.assets.find((candidate) => candidate.src === src);
    const entry: ProjectMediaManifestEntry = {
      src,
      name: found.name,
      mime: found.mime,
      bytes: found.blob.size,
      ...(asset?.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
      ...(typeof asset?.sourceSize === 'number' ? { sourceSize: asset.sourceSize } : {}),
      ...(typeof asset?.sourceModifiedAt === 'number' ? { sourceModifiedAt: asset.sourceModifiedAt } : {}),
    };
    yield jsonLine({ type: 'media-start', ...entry });
    for await (const data of base64Chunks(found.blob)) {
      yield jsonLine({ type: 'media-chunk', data });
    }
    yield jsonLine({ type: 'media-end', src });
  }
}

function streamFrom(iterator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

async function* textLines(blob: Blob): AsyncGenerator<string> {
  const reader = blob.stream().getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending) yield pending;
  } finally {
    reader.releaseLock();
  }
}

function mediaManifestEntry(value: unknown): ProjectMediaManifestEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ProjectMediaManifestEntry>;
  if (typeof entry.src !== 'string' || !entry.src.startsWith(MEDIA_PREFIX)
    || !isSafeMediaName(entry.src.slice(MEDIA_PREFIX.length))
    || typeof entry.name !== 'string' || !isSafeMediaName(entry.name)
    || typeof entry.mime !== 'string'
    || typeof entry.bytes !== 'number' || !Number.isInteger(entry.bytes)
    || entry.bytes <= 0 || entry.bytes > MAX_MEDIA_ENTRY_BYTES
    || (entry.sourceRevision !== undefined && typeof entry.sourceRevision !== 'string')
    || (entry.sourceSize !== undefined && (typeof entry.sourceSize !== 'number' || !Number.isFinite(entry.sourceSize)))
    || (entry.sourceModifiedAt !== undefined
      && (typeof entry.sourceModifiedAt !== 'number' || !Number.isFinite(entry.sourceModifiedAt)))) return null;
  return entry as ProjectMediaManifestEntry;
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
  /** Neither end can get the byte src (the export is as usual, the import end will lack these assets).*/
  mediaMissing: string[];
}

export async function buildProjectExport(id: string, name: string): Promise<ProjectExportResult> {
  const doc = await loadProject(id);
  if (!doc) throw new Error('工程不存在或已损坏');
  const chat = await loadChat(id);
  const creativeMode = await loadCreativeMode(id);
  const srcs = collectUploadSrcs(doc);
  const mediaMissing: string[] = [];
  const manifest: ProjectStreamManifest = {
    format: PROJECT_STREAM_FORMAT,
    type: 'manifest',
    name,
    exportedAt: new Date().toISOString(),
    doc,
    ...(chat ? { chat } : {}),
    ...(creativeMode ? { creativeMode } : {}),
  };
  const stream = streamFrom(projectExportChunks(manifest, srcs, mediaMissing));
  const blob = await new Response(stream, {
    headers: { 'Content-Type': 'application/x-openchatcut-project' },
  }).blob();
  const safeName = sanitizeFileName(name, 'project');
  return {
    filename: `${safeName}.ccproj`,
    blob,
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


async function publishStagedProject(
  staged: StagedProjectImport,
  publish?: ProjectImportOptions['publish'],
): Promise<ProjectMeta> {
  if (publish) return publish(staged);
  const meta = await createProject(staged.name, staged.doc);
  if (staged.chat) await saveChat(meta.id, staged.chat);
  if (staged.creativeMode) await saveCreativeMode(meta.id, staged.creativeMode);
  return meta;
}

function importResult(staged: StagedProjectImport, meta: ProjectMeta): ProjectImportResult {
  const carried = new Set(staged.carriedSrcs);
  const docSrcs = collectUploadSrcs(staged.doc);
  return {
    meta,
    mediaTotal: new Set([...docSrcs, ...carried]).size,
    mediaRestored: staged.mediaRestored,
    mediaMissing: docSrcs.filter((src) => !carried.has(src)),
  };
}

async function stageLegacyEnvelope(envelope: ProjectEnvelope): Promise<StagedProjectImport> {
  const namespace = createMediaBlobImportNamespace();
  const stagedEntries: StagedMediaBlobImportEntry[] = [];
  const stagedByTarget = new Map<string, StagedMediaBlobImportEntry>();
  const replacements = new Map<string, string>();
  let mediaRestored = 0;
  try {
    for (const entry of envelope.media) {
      if (replacements.has(entry.src)) throw new Error(`工程包媒体 src 重复: ${entry.src}`);
      const bytes = base64ToBytes(entry.dataBase64);
      if (bytes.byteLength !== entry.bytes) throw new Error(`工程包媒体大小不匹配: ${entry.name}`);
      const blob = new Blob([arrayBufferBlobPart(bytes)], { type: entry.mime });
      const staged = await stageMediaBlobImport(namespace, entry.src, blob, {
        name: entry.name,
        mime: entry.mime,
        sourceRevision: entry.sourceRevision,
        sourceSize: entry.sourceSize,
        sourceModifiedAt: entry.sourceModifiedAt,
      });
      const sameTarget = stagedByTarget.get(staged.src);
      if (sameTarget && sameTarget.sha256 !== staged.sha256) {
        throw new Error(`工程包媒体安全名称冲突: ${staged.src}`);
      }
      if (!sameTarget) {
        stagedByTarget.set(staged.src, staged);
        stagedEntries.push(staged);
      }
      replacements.set(entry.src, staged.src);
      mediaRestored += 1;
    }
    const carriedSrcs = [...new Set(replacements.values())];
    return {
      name: envelope.name,
      doc: rewriteProjectMediaSrcs(envelope.doc, replacements),
      ...(envelope.chat ? { chat: envelope.chat } : {}),
      ...(envelope.creativeMode ? { creativeMode: envelope.creativeMode } : {}),
      carriedSrcs,
      mediaRestored,
      mediaImport: { namespace, entries: stagedEntries },
    };
  } catch (error) {
    try {
      await discardMediaBlobImport(namespace);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '工程包解析失败，临时媒体清理也失败');
    }
    throw error;
  }
}

function streamManifest(
  value: unknown,
  migrationOptions?: ProjectMigrationOptions,
): ProjectStreamManifest {
  if (!value || typeof value !== 'object') throw new Error('工程包 manifest 不是对象');
  const manifest = value as Partial<ProjectStreamManifest>;
  if (manifest.format !== PROJECT_STREAM_FORMAT || manifest.type !== 'manifest') {
    throw new Error(`格式不识别(需要 ${PROJECT_STREAM_FORMAT})`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('缺工程名');
  const doc = migrateProjectDoc(manifest.doc, migrationOptions);
  if (!doc) throw new Error('工程数据(doc)校验不通过');
  return {
    format: PROJECT_STREAM_FORMAT,
    type: 'manifest',
    name: manifest.name.trim(),
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : '',
    doc,
    ...(isPersistedChat(manifest.chat) ? { chat: manifest.chat } : {}),
    ...(typeof manifest.creativeMode === 'string' && manifest.creativeMode
      ? { creativeMode: manifest.creativeMode }
      : {}),
  };
}

async function stageStreamPackage(
  file: Blob,
  options: ProjectImportOptions,
): Promise<StagedProjectImport> {
  const namespace = createMediaBlobImportNamespace();
  const stagedEntries: StagedMediaBlobImportEntry[] = [];
  let manifest: ProjectStreamManifest | null = null;
  let current: {
    entry: ProjectMediaManifestEntry;
    parts: ArrayBuffer[];
    bytes: number;
  } | null = null;
  const packageSrcs = new Set<string>();
  const replacements = new Map<string, string>();
  const stagedByTarget = new Map<string, StagedMediaBlobImportEntry>();
  let mediaRestored = 0;

  try {
    for await (const line of textLines(file)) {
      if (!line) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new Error('工程包记录不是合法 JSON');
      }
      if (!manifest) {
        manifest = streamManifest(record, options.migrationOptions);
        continue;
      }
      if (!record || typeof record !== 'object') throw new Error('工程包媒体记录不是对象');
      const row = record as Record<string, unknown>;
      if (row.type === 'media-start') {
        if (current) throw new Error('工程包媒体记录未结束');
        const entry = mediaManifestEntry(row);
        if (!entry) throw new Error('工程包媒体条目校验不通过');
        if (packageSrcs.has(entry.src)) throw new Error(`工程包媒体 src 重复: ${entry.src}`);
        packageSrcs.add(entry.src);
        current = { entry, parts: [], bytes: 0 };
        continue;
      }
      if (row.type === 'media-chunk') {
        if (!current || typeof row.data !== 'string') throw new Error('工程包媒体分片顺序错误');
        const bytes = base64ToBytes(row.data);
        current.bytes += bytes.byteLength;
        if (current.bytes > current.entry.bytes) throw new Error(`工程包媒体大小超限: ${current.entry.name}`);
        current.parts.push(arrayBufferBlobPart(bytes));
        continue;
      }
      if (row.type === 'media-end') {
        if (!current || row.src !== current.entry.src) throw new Error('工程包媒体结束记录不匹配');
        if (current.bytes !== current.entry.bytes) throw new Error(`工程包媒体大小不匹配: ${current.entry.name}`);
        const blob = new Blob(current.parts, { type: current.entry.mime });
        const staged = await stageMediaBlobImport(namespace, current.entry.src, blob, {
          name: current.entry.name,
          mime: current.entry.mime,
          sourceRevision: current.entry.sourceRevision,
          sourceSize: current.entry.sourceSize,
          sourceModifiedAt: current.entry.sourceModifiedAt,
        });
        const sameTarget = stagedByTarget.get(staged.src);
        if (sameTarget && sameTarget.sha256 !== staged.sha256) {
          throw new Error(`工程包媒体安全名称冲突: ${staged.src}`);
        }
        if (!sameTarget) {
          stagedByTarget.set(staged.src, staged);
          stagedEntries.push(staged);
        }
        replacements.set(current.entry.src, staged.src);
        mediaRestored += 1;
        current = null;
        continue;
      }
      throw new Error('工程包含未知记录');
    }

    if (!manifest) throw new Error('工程包缺 manifest');
    if (current) throw new Error('工程包媒体记录被截断');
    const carriedSrcs = [...new Set(replacements.values())];
    return {
      name: manifest.name,
      doc: rewriteProjectMediaSrcs(manifest.doc, replacements),
      ...(manifest.chat ? { chat: manifest.chat } : {}),
      ...(manifest.creativeMode ? { creativeMode: manifest.creativeMode } : {}),
      carriedSrcs,
      mediaRestored,
      mediaImport: { namespace, entries: stagedEntries },
    };
  } catch (error) {
    try {
      await discardMediaBlobImport(namespace);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '工程包解析失败，临时媒体清理也失败');
    }
    throw error;
  }
}

/**
 * Legacy envelope import is kept for old .ccproj.json files, but publication now
 * happens only after every carried media entry has decoded and staged.
 */
export async function applyProjectImport(
  envelope: ProjectEnvelope,
  options: ProjectImportOptions = {},
): Promise<ProjectImportResult> {
  const staged = await stageLegacyEnvelope(envelope);
  return enqueueStreamPublication(() => publishStreamProjectImport(staged, options));
}

/** Serialize the publication boundary; package parsing and temporary staging remain parallel. */
async function publishStreamProjectImport(
  staged: StagedProjectImport,
  options: ProjectImportOptions,
): Promise<ProjectImportResult> {
  const mediaImport = staged.mediaImport;
  if (!mediaImport) throw new Error('工程包媒体临时清单缺失');
  const mediaPublication = await publishMediaBlobImport(mediaImport.namespace, mediaImport.entries);
  let meta: ProjectMeta;
  try {
    meta = await publishStagedProject(staged, options.publish);
  } catch (error) {
    try {
      await rollbackMediaBlobImport(mediaPublication);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '工程发布失败，媒体回滚或临时清理也失败');
    }
    throw error;
  }
  try {
    await commitMediaBlobImport(mediaPublication);
  } catch {
    // Project + real media are already committed. A cleanup error must not
    // report the import as failed and invite a duplicate-project retry.
  }
  return importResult(staged, meta);
}

/** Stream v2 packages without materializing every base64 asset in one object. */
export async function importProjectPackage(
  file: Blob,
  options: ProjectImportOptions = {},
): Promise<ProjectImportResult> {
  const prefix = (await file.slice(0, 192).text()).trimStart();
  if (prefix.startsWith(`{"format":"${PROJECT_STREAM_FORMAT}"`)) {
    const staged = await stageStreamPackage(file, options);
    return enqueueStreamPublication(() => publishStreamProjectImport(staged, options));
  }
  const parsed = parseProjectEnvelope(await file.text(), options.migrationOptions);
  if ('error' in parsed) throw new Error(parsed.error);
  const staged = await stageLegacyEnvelope(parsed.envelope);
  return enqueueStreamPublication(() => publishStreamProjectImport(staged, options));
}
