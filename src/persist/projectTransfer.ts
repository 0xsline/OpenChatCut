// Portable project packages. v2 is a newline-delimited stream: ProjectDoc is
// validated once, then each media blob is encoded/decoded in bounded chunks.
// Legacy openchatcut-project@1 JSON remains readable for cross-version transfer.
import type { ProjectDoc } from '../editor/types';
import {
  createProject, isPersistedChat, loadChat, loadCreativeMode, loadProject,
  migrateProjectDoc, purgeProject, saveChat, saveCreativeMode,
  type PersistedChat, type ProjectMigrationOptions,
} from './projectStore';
import type { ProjectMeta } from './projectStoreCoordinators';
import {
  initializeImportedAgentSession,
  persistImportedChat,
  sanitizePortableChat,
} from './projectChatTransfer';
import {
  createMediaBlobImportNamespace, discardMediaBlobImport, stageMediaBlobImport,
  type StagedMediaBlobImportEntry,
} from './mediaBlobStore';
import { sanitizeFileName } from '../media/fileName';
import { sanitizePortableProjectDoc } from './portableProject';
import {
  loadAgentRuntimeTransfer, publishTransferredAgentRuntime,
  validateProposalRuntimeTransfer,
} from './agentRuntimeTransfer';
import { purgeAgentRuntime, type AgentRuntimeSnapshot } from './agentRuntimeStore';
import { clearProposal, type StoredProposalRecord } from './proposalStore';
import {
  includeProposalUploadSrcs, loadPortableProposal, portableProposalRecord, publishTransferredProposal,
} from './projectProposalTransfer';
import {
  arrayBufferBlobPart, base64ToBytes, commitMediaBlobImport, MAX_MEDIA_ENTRY_BYTES,
  projectExportChunks, publishMediaBlobImport, rollbackMediaBlobImport, stageProjectStream,
  streamFrom,
} from './projectTransferStream';
export type { ProjectMediaManifestEntry } from './projectTransferStream';

export const PROJECT_EXPORT_FORMAT = 'openchatcut-project@1';
export const PROJECT_STREAM_FORMAT = 'openchatcut-project@2';
const MEDIA_PREFIX = '/media/uploads/';
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
  proposal?: StoredProposalRecord;
}

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
  runtime?: AgentRuntimeSnapshot;
  proposal?: StoredProposalRecord;
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
  const migratedDoc = migrateProjectDoc(r.doc, migrationOptions);
  if (!migratedDoc) return { error: '工程数据(doc)校验不通过' };
  const doc = sanitizePortableProjectDoc(migratedDoc);
  if (!Array.isArray(r.media)) return { error: '工程包缺媒体清单' };
  if (!r.media.every(isMediaEntry)) return { error: '工程包媒体条目校验不通过' };
  const media = r.media;
  const chat = isPersistedChat(r.chat) ? sanitizePortableChat(r.chat) : undefined;
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
  const exportDoc = sanitizePortableProjectDoc(doc);
  const loadedChat = await loadChat(id);
  const chat = loadedChat ? sanitizePortableChat(loadedChat) : undefined;
  const proposal = await loadPortableProposal(id);
  const runtime = await loadAgentRuntimeTransfer(id, chat, proposal);
  const creativeMode = await loadCreativeMode(id);
  const srcs = includeProposalUploadSrcs(collectUploadSrcs(exportDoc), proposal);
  const mediaMissing: string[] = [];
  const manifest: ProjectStreamManifest = {
    format: PROJECT_STREAM_FORMAT,
    type: 'manifest',
    name,
    exportedAt: new Date().toISOString(),
    doc: exportDoc,
    ...(chat ? { chat } : {}),
    ...(creativeMode ? { creativeMode } : {}),
    ...(proposal ? { proposal } : {}),
  };
  const stream = streamFrom(projectExportChunks(manifest, runtime, srcs, mediaMissing));
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
  validateProposalRuntimeTransfer(staged.runtime ?? null, staged.proposal);
  if (publish) {
    const publishable = staged.runtime && staged.chat
      ? { name: staged.name, doc: staged.doc, ...(staged.creativeMode ? { creativeMode: staged.creativeMode } : {}) }
      : staged;
    const meta = await publish(publishable);
    try {
      if (staged.runtime || staged.chat || staged.proposal) {
        await initializeImportedAgentSession(meta.id);
      }
      if (staged.runtime) {
        await publishTransferredAgentRuntime(staged.runtime, meta.id, staged.proposal);
      }
      await publishTransferredProposal(meta.id, staged.proposal);
      if (staged.runtime && staged.chat) await persistImportedChat(meta.id, staged.chat);
      return meta;
    } catch (error) {
      await Promise.all([
        purgeAgentRuntime(meta.id).catch(() => undefined),
        clearProposal(meta.id).catch(() => undefined),
      ]);
      throw error;
    }
  }
  const meta = await createProject(staged.name, staged.doc);
  try {
    if (staged.runtime || staged.chat || staged.proposal) {
      await initializeImportedAgentSession(meta.id);
    }
    if (staged.runtime) {
      await publishTransferredAgentRuntime(staged.runtime, meta.id, staged.proposal);
    }
    await publishTransferredProposal(meta.id, staged.proposal);
    if (staged.chat) {
      if (staged.runtime) await persistImportedChat(meta.id, staged.chat);
      else await saveChat(meta.id, staged.chat);
    }
    if (staged.creativeMode) await saveCreativeMode(meta.id, staged.creativeMode);
    return meta;
  } catch (error) {
    await Promise.all([
      purgeAgentRuntime(meta.id).catch(() => undefined),
      clearProposal(meta.id).catch(() => undefined),
    ]);
    await purgeProject(meta.id).catch(() => undefined);
    throw error;
  }
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
      doc: sanitizePortableProjectDoc(rewriteProjectMediaSrcs(envelope.doc, replacements)),
      ...(envelope.chat ? { chat: sanitizePortableChat(envelope.chat) } : {}),
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
  const migratedDoc = migrateProjectDoc(manifest.doc, migrationOptions);
  if (!migratedDoc) throw new Error('工程数据(doc)校验不通过');
  const doc = sanitizePortableProjectDoc(migratedDoc);
  const proposal = portableProposalRecord(manifest.proposal);
  return {
    format: PROJECT_STREAM_FORMAT,
    type: 'manifest',
    name: manifest.name.trim(),
    exportedAt: typeof manifest.exportedAt === 'string' ? manifest.exportedAt : '',
    doc,
    ...(isPersistedChat(manifest.chat) ? { chat: sanitizePortableChat(manifest.chat) } : {}),
    ...(proposal ? { proposal } : {}),
    ...(typeof manifest.creativeMode === 'string' && manifest.creativeMode
      ? { creativeMode: manifest.creativeMode }
      : {}),
  };
}

async function stageStreamPackage(
  file: Blob,
  options: ProjectImportOptions,
): Promise<StagedProjectImport> {
  return stageProjectStream(
    file,
    (value) => streamManifest(value, options.migrationOptions),
    rewriteProjectMediaSrcs,
    (proposal, replacements) => portableProposalRecord(proposal, replacements)!,
  );
}

/**
 * Legacy envelope import is kept for old .ccproj.json files, but publication now
 * happens only after every carried media entry has decoded and staged.
 */
export async function applyProjectImport(
  envelope: ProjectEnvelope,
  options: ProjectImportOptions = {},
): Promise<ProjectImportResult> {
  const migratedDoc = migrateProjectDoc(envelope.doc, options.migrationOptions);
  if (!migratedDoc) throw new Error('工程数据(doc)校验不通过');
  const staged = await stageLegacyEnvelope({
    ...envelope,
    doc: sanitizePortableProjectDoc(migratedDoc),
    ...(envelope.chat ? { chat: sanitizePortableChat(envelope.chat) } : {}),
  });
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
