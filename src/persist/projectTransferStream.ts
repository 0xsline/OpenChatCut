import type { ProjectDoc } from '../editor/types';
import {
  commitMediaBlobImport, createMediaBlobImportNamespace, discardMediaBlobImport,
  getMediaBlob, publishMediaBlobImport, rollbackMediaBlobImport, stageMediaBlobImport,
  type StagedMediaBlobImportEntry,
} from './mediaBlobStore';
import { AgentRuntimeImportReader, agentRuntimeRecords } from './agentRuntimeTransfer';
import type { AgentRuntimeSnapshot } from './agentRuntimeStore';
import type { PersistedChat } from './projectStore';
import type { StoredProposalRecord } from './proposalStore';

const MEDIA_PREFIX = '/media/uploads/';
export const MAX_MEDIA_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_STREAM_LINE_CHARS = 16 * 1024 * 1024;
const textEncoder = new TextEncoder();

export interface ProjectMediaManifestEntry {
  src: string;
  name: string;
  mime: string;
  bytes: number;
  sourceRevision?: string;
  sourceSize?: number;
  sourceModifiedAt?: number;
}

export interface StreamProjectManifest {
  name: string;
  doc: ProjectDoc;
  chat?: PersistedChat;
  creativeMode?: string;
  proposal?: StoredProposalRecord;
}

export interface StagedStreamProject extends StreamProjectManifest {
  carriedSrcs: string[];
  mediaRestored: number;
  runtime?: AgentRuntimeSnapshot;
  mediaImport: { namespace: string; entries: StagedMediaBlobImportEntry[] };
}

export function arrayBufferBlobPart(bytes: Uint8Array<ArrayBufferLike>): ArrayBuffer {
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

export function base64ToBytes(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('工程包媒体 base64 数据损坏');
  }
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('工程包媒体 base64 数据损坏'); }
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
  } finally { reader.releaseLock(); }
}

async function mediaBlobFor(src: string): Promise<{ blob: Blob; name: string; mime: string } | null> {
  const rec = await getMediaBlob(src);
  if (rec) return { blob: rec.blob, name: rec.name, mime: rec.mime };
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return { blob, name: src.slice(MEDIA_PREFIX.length), mime: blob.type || 'application/octet-stream' };
  } catch { return null; }
}

export async function* projectExportChunks(
  manifest: StreamProjectManifest & { format: string; type: string; exportedAt: string },
  runtime: AgentRuntimeSnapshot | null,
  srcs: readonly string[],
  missing: string[],
): AsyncGenerator<Uint8Array> {
  yield jsonLine(manifest);
  if (runtime) for await (const record of agentRuntimeRecords(runtime)) yield jsonLine(record);
  for (const src of srcs) {
    const found = await mediaBlobFor(src);
    if (!found || found.blob.size <= 0 || found.blob.size > MAX_MEDIA_ENTRY_BYTES) {
      missing.push(src);
      continue;
    }
    const asset = manifest.doc.assets.find((candidate) => candidate.src === src);
    const entry: ProjectMediaManifestEntry = {
      src, name: found.name, mime: found.mime, bytes: found.blob.size,
      ...(asset?.sourceRevision ? { sourceRevision: asset.sourceRevision } : {}),
      ...(typeof asset?.sourceSize === 'number' ? { sourceSize: asset.sourceSize } : {}),
      ...(typeof asset?.sourceModifiedAt === 'number' ? { sourceModifiedAt: asset.sourceModifiedAt } : {}),
    };
    yield jsonLine({ type: 'media-start', ...entry });
    for await (const data of base64Chunks(found.blob)) yield jsonLine({ type: 'media-chunk', data });
    yield jsonLine({ type: 'media-end', src });
  }
}

export function streamFrom(iterator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
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
      if (pending.length > MAX_STREAM_LINE_CHARS && !pending.includes('\n')) throw new Error('工程包记录超过单行上限');
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        if (newline > MAX_STREAM_LINE_CHARS) throw new Error('工程包记录超过单行上限');
        yield pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
    pending += decoder.decode();
    if (pending.length > MAX_STREAM_LINE_CHARS) throw new Error('工程包记录超过单行上限');
    if (pending) yield pending;
  } finally { reader.releaseLock(); }
}

function isSafeMediaName(name: string): boolean {
  return name.length > 0 && name.length <= 240 && !name.includes('/') && !name.includes('\\')
    && name !== '.' && name !== '..' && !name.includes('\0');
}

function mediaManifestEntry(value: Record<string, unknown>): ProjectMediaManifestEntry | null {
  const entry = value as Partial<ProjectMediaManifestEntry>;
  if (typeof entry.src !== 'string' || !entry.src.startsWith(MEDIA_PREFIX)
    || !isSafeMediaName(entry.src.slice(MEDIA_PREFIX.length))
    || typeof entry.name !== 'string' || !isSafeMediaName(entry.name)
    || typeof entry.mime !== 'string' || typeof entry.bytes !== 'number' || !Number.isInteger(entry.bytes)
    || entry.bytes <= 0 || entry.bytes > MAX_MEDIA_ENTRY_BYTES
    || (entry.sourceRevision !== undefined && typeof entry.sourceRevision !== 'string')
    || (entry.sourceSize !== undefined && (typeof entry.sourceSize !== 'number' || !Number.isFinite(entry.sourceSize)))
    || (entry.sourceModifiedAt !== undefined
      && (typeof entry.sourceModifiedAt !== 'number' || !Number.isFinite(entry.sourceModifiedAt)))) return null;
  return entry as ProjectMediaManifestEntry;
}

async function finishMediaEntry(
  namespace: string,
  current: { entry: ProjectMediaManifestEntry; parts: ArrayBuffer[]; bytes: number },
): Promise<StagedMediaBlobImportEntry> {
  if (current.bytes !== current.entry.bytes) throw new Error(`工程包媒体大小不匹配: ${current.entry.name}`);
  const blob = new Blob(current.parts, { type: current.entry.mime });
  return stageMediaBlobImport(namespace, current.entry.src, blob, {
    name: current.entry.name,
    mime: current.entry.mime,
    sourceRevision: current.entry.sourceRevision,
    sourceSize: current.entry.sourceSize,
    sourceModifiedAt: current.entry.sourceModifiedAt,
  });
}

class StreamImportState {
  readonly namespace = createMediaBlobImportNamespace();
  readonly stagedEntries: StagedMediaBlobImportEntry[] = [];
  readonly runtimeReader = new AgentRuntimeImportReader();
  readonly packageSrcs = new Set<string>();
  readonly replacements = new Map<string, string>();
  readonly stagedByTarget = new Map<string, StagedMediaBlobImportEntry>();
  manifest: StreamProjectManifest | null = null;
  current: { entry: ProjectMediaManifestEntry; parts: ArrayBuffer[]; bytes: number } | null = null;
  mediaRestored = 0;

  async consume(record: unknown, parseManifest: (value: unknown) => StreamProjectManifest): Promise<void> {
    if (!this.manifest) { this.manifest = parseManifest(record); return; }
    if (await this.runtimeReader.consume(record)) {
      if (this.current) throw new Error('Agent runtime record interrupts a media entry.');
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('工程包媒体记录不是对象');
    const row = record as Record<string, unknown>;
    if (row.type === 'media-start') {
      if (this.current) throw new Error('工程包媒体记录未结束');
      const entry = mediaManifestEntry(row);
      if (!entry) throw new Error('工程包媒体条目校验不通过');
      if (this.packageSrcs.has(entry.src)) throw new Error(`工程包媒体 src 重复: ${entry.src}`);
      this.packageSrcs.add(entry.src);
      this.current = { entry, parts: [], bytes: 0 };
      return;
    }
    if (row.type === 'media-chunk') {
      if (!this.current || typeof row.data !== 'string') throw new Error('工程包媒体分片顺序错误');
      const bytes = base64ToBytes(row.data);
      this.current.bytes += bytes.byteLength;
      if (this.current.bytes > this.current.entry.bytes) throw new Error(`工程包媒体大小超限: ${this.current.entry.name}`);
      this.current.parts.push(arrayBufferBlobPart(bytes));
      return;
    }
    if (row.type !== 'media-end' || !this.current || row.src !== this.current.entry.src) {
      throw new Error(row.type === 'media-end' ? '工程包媒体结束记录不匹配' : '工程包含未知记录');
    }
    const staged = await finishMediaEntry(this.namespace, this.current);
    const sameTarget = this.stagedByTarget.get(staged.src);
    if (sameTarget && sameTarget.sha256 !== staged.sha256) throw new Error(`工程包媒体安全名称冲突: ${staged.src}`);
    if (!sameTarget) { this.stagedByTarget.set(staged.src, staged); this.stagedEntries.push(staged); }
    this.replacements.set(this.current.entry.src, staged.src);
    this.mediaRestored += 1;
    this.current = null;
  }

  async finish(
    rewriteDoc: (doc: ProjectDoc, replacements: ReadonlyMap<string, string>) => ProjectDoc,
    rewriteProposal: (
      proposal: StoredProposalRecord,
      replacements: ReadonlyMap<string, string>,
    ) => StoredProposalRecord,
  ): Promise<StagedStreamProject> {
    if (!this.manifest) throw new Error('工程包缺 manifest');
    if (this.current) throw new Error('工程包媒体记录被截断');
    const runtime = await this.runtimeReader.finish(this.manifest.chat);
    return {
      ...this.manifest,
      doc: rewriteDoc(this.manifest.doc, this.replacements),
      ...(this.manifest.proposal
        ? { proposal: rewriteProposal(this.manifest.proposal, this.replacements) }
        : {}),
      ...(runtime ? { runtime } : {}),
      carriedSrcs: [...new Set(this.replacements.values())],
      mediaRestored: this.mediaRestored,
      mediaImport: { namespace: this.namespace, entries: this.stagedEntries },
    };
  }
}

export async function stageProjectStream(
  file: Blob,
  parseManifest: (value: unknown) => StreamProjectManifest,
  rewriteDoc: (doc: ProjectDoc, replacements: ReadonlyMap<string, string>) => ProjectDoc,
  rewriteProposal: (
    proposal: StoredProposalRecord,
    replacements: ReadonlyMap<string, string>,
  ) => StoredProposalRecord,
): Promise<StagedStreamProject> {
  const state = new StreamImportState();
  try {
    for await (const line of textLines(file)) {
      if (!line) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error('工程包记录不是合法 JSON'); }
      await state.consume(record, parseManifest);
    }
    return await state.finish(rewriteDoc, rewriteProposal);
  } catch (error) {
    try { await discardMediaBlobImport(state.namespace); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], '工程包解析失败，临时媒体清理也失败'); }
    throw error;
  }
}

export { commitMediaBlobImport, publishMediaBlobImport, rollbackMediaBlobImport };
