// 工程导出/导入(.ccproj.json)——跨端迁移通道:桌面版 Electron
// 的 IDB 分区与浏览器独立,工程带不过去,这层补上。信封 = ProjectDoc + 聊天 +
// 创作模式 + 引用的 /media/uploads 素材(base64)。导入即重放:建新工程 → 素材写
// mediaBlobStore(留档)+ 不可达就直接重发布到本端 server——路径恒 /media/uploads/
// 与物理端解耦,时间线 src 原样可用(机制同 mediaBlobStore 的新机恢复)。
import type { ProjectDoc } from '../editor/types';
import {
  createProject, isPersistedChat, loadChat, loadCreativeMode, loadProject,
  migrateProjectDoc, saveChat, saveCreativeMode,
  type PersistedChat, type ProjectMeta,
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

/** doc 引用的 /media/uploads src 全集(素材池 + 各时间线 items),去重保序。 */
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

/** 上传名单段安全判定(与 server/media-dir isSafeUploadName 同规则,浏览器侧实现)。 */
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

/** 边界校验:导入文件是不可信输入。doc 走 migrateProjectDoc(与 IDB 读同一道闸)。 */
export function parseProjectEnvelope(text: string): { envelope: ProjectEnvelope } | { error: string } {
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
  const doc = migrateProjectDoc(r.doc);
  if (!doc) return { error: '工程数据(doc)校验不通过' };
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
  // IDB 没有(超缓存上限/其它端上传)→ 从 server 现取
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
  /** 两头都拿不到字节的 src(导出照常,导入端会缺这几个素材)。 */
  mediaMissing: string[];
}

export async function buildProjectExport(id: string, name: string): Promise<ProjectExportResult> {
  const doc = await loadProject(id);
  if (!doc) throw new Error('工程不存在或已损坏');
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
      await putMediaBlob(entry.src, blob, { name: entry.name, mime: entry.mime });  // 留档(≤缓存上限)
      if (!(await isMediaSrcReachable(entry.src))) {
        await reuploadMediaBlob({ src: entry.src, blob, name: entry.name, mime: entry.mime, bytes: blob.size, savedAt: Date.now() });
      }
      restored += 1;
    } catch {
      failed.push(entry.src);
    }
  }
  // 信封里就没带字节的(导出端两头落空)+ 本轮失败的,一并如实上报;
  // 总数 = doc 引用 ∪ 信封携带(信封可带 doc 之外的素材,如素材池外挂)。
  const carried = new Set(envelope.media.map((m) => m.src));
  const docSrcs = collectUploadSrcs(envelope.doc);
  const mediaMissing = [...docSrcs.filter((s) => !carried.has(s)), ...failed];
  const mediaTotal = new Set([...docSrcs, ...carried]).size;
  return { meta, mediaTotal, mediaRestored: restored, mediaMissing };
}
