// 版本历史(/api/versions):按工程存的具名快照列表,恢复时复用
// migrateProjectDoc 校验。与 projectStore 共用本机服务端 KV。
import { migrateProjectDoc } from './projectStore';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';
import type { ProjectDoc } from '../editor/types';

const versionsKey = (projectId: string) => `versions:${projectId}`;

export interface ProjectVersion {
  id: string;
  name: string;
  createdAt: number;
  doc: ProjectDoc;
}

// 边界校验:持久化数据不可信,先校验再用(id/name/createdAt + doc 经 migrateProjectDoc 规整)。
function toValidVersion(v: unknown): ProjectVersion | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<ProjectVersion>;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.createdAt !== 'number') return null;
  const doc = migrateProjectDoc(raw.doc);
  if (!doc) return null;
  return { id: raw.id, name: raw.name, createdAt: raw.createdAt, doc };
}

async function readAll(projectId: string): Promise<ProjectVersion[]> {
  const raw = await idbGet<unknown>(versionsKey(projectId));
  if (!Array.isArray(raw)) return [];
  return raw.map(toValidVersion).filter((v): v is ProjectVersion => v !== null);
}

/** 该工程的全部快照,最新在前。任何失败均返回空数组(不信任持久化数据)。 */
export async function listVersions(projectId: string): Promise<ProjectVersion[]> {
  try {
    return (await readAll(projectId)).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

const newId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `v_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/** 保存当前工程文档为一个具名快照(前插,最新在前)。 */
export async function saveVersion(projectId: string, name: string, doc: ProjectDoc): Promise<ProjectVersion> {
  const version: ProjectVersion = { id: newId(), name: name.trim() || '未命名版本', createdAt: Date.now(), doc };
  const current = await readAll(projectId);
  await idbSet(versionsKey(projectId), [version, ...current]);
  return version;
}

export async function deleteVersion(projectId: string, id: string): Promise<void> {
  const current = await readAll(projectId);
  await idbSet(versionsKey(projectId), current.filter((v) => v.id !== id));
}
