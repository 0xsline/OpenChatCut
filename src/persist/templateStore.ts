// 工程模板库(manage_template):模板 = 一组 MG + 设计风格的打包。
// 一个模板就是一份打包好的 ProjectDoc(它的时间线里的 MG 片段 + designStyle +
// 携带的媒体资产)。跨工程共享(像"我的设计风格"收藏一样是全局库,不按工程分),
// 与 projectStore 共用本机服务端 KV。
// 读取时一律用 migrateProjectDoc 校验(持久化数据不可信)。
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import type { ProjectDoc } from '../editor/types';

// 全局单键:模板跨工程共享(不带 projectId),与 owned design styles 同思路。
const TEMPLATES_KEY = 'templates:all';

export interface ProjectTemplate {
  id: string;
  name: string;
  createdAt: number;
  /** 打包好的工程文档:时间线(含 MG 片段)+ designStyle + 资产池 */
  doc: ProjectDoc;
  /** 该模板携带的媒体资产 id(供 list_assets / omitAssetIds 用) */
  assetIds: string[];
}

// 边界校验:持久化数据不可信,先校验再用。doc 经 migrateProjectDoc 规整(不可信文档
// 会被拒/清洗),assetIds 只留字符串。
function toValidTemplate(v: unknown): { template: ProjectTemplate; migrated: boolean } | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectTemplate>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  let migrated = false;
  const doc = migrateProjectDoc(raw.doc, { onProgress: () => { migrated = true; } });
  if (!doc) return null;
  const assetIds = Array.isArray(raw.assetIds) ? raw.assetIds.filter((x): x is string => typeof x === 'string') : [];
  return { template: { id: raw.id, name: raw.name, createdAt: raw.createdAt, doc, assetIds }, migrated };
}

async function readAll(): Promise<ProjectTemplate[]> {
  const raw = await idbGet<unknown>(TEMPLATES_KEY);
  if (!Array.isArray(raw)) return [];
  const parsed = raw.map(toValidTemplate);
  const valid = parsed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const templates = valid.map((entry) => entry.template);
  // Upgrade the shared library only when every entry migrated successfully.
  // A corrupt sibling therefore never causes destructive partial persistence.
  if (valid.length === raw.length && valid.some((entry) => entry.migrated)) {
    try {
      await idbSet(TEMPLATES_KEY, templates);
    } catch {
      // The normalized in-memory templates are still usable; retry next read.
    }
  }
  return templates;
}

/** 全部已存模板(插入顺序,同名替换在原位)。失败一律返回空数组(不信任持久化数据)。 */
export async function listTemplates(): Promise<ProjectTemplate[]> {
  try {
    return await readAll();
  } catch {
    return [];
  }
}

export async function getTemplate(id: string): Promise<ProjectTemplate | null> {
  try {
    return (await readAll()).find((t) => t.id === id) ?? null;
  } catch {
    return null;
  }
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `tpl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/** 把一份 ProjectDoc 打包成模板(按名称去重:同名覆盖,复用原 id 并保持列表原位)。
 * assetIds = 文档资产池的全部 id(模板携带整份资产池)。 */
export async function saveTemplate(name: string, doc: ProjectDoc): Promise<ProjectTemplate> {
  const trimmed = name.trim() || '未命名模板';
  // ponytail: 携带整份资产池而非只挑被引用的资产;剪裁只引用资产是额外逻辑,YAGNI。
  const assetIds = doc.assets.map((a) => a.id);
  const current = await readAll();
  const existing = current.find((t) => t.name === trimmed);
  // ponytail: createdAt 仅为元数据,列表不按它排序(用插入顺序),故用 Date.now() 不破坏确定性。
  const entry: ProjectTemplate = { id: existing?.id ?? newId(), name: trimmed, createdAt: Date.now(), doc, assetIds };
  const next = existing ? current.map((t) => (t.id === entry.id ? entry : t)) : [...current, entry];
  try {
    await idbSet(TEMPLATES_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return entry;
}

export async function deleteTemplate(id: string): Promise<void> {
  try {
    const current = await readAll();
    await idbSet(TEMPLATES_KEY, current.filter((t) => t.id !== id));
  } catch {
    /* ignore */
  }
}
