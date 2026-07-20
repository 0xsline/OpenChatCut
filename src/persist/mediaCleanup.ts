// 素材引用清点与清理。解决两件事:
//   ① 删工程时级联删素材——但只删「再无别的工程引用」的文件(复制出的工程共享
//      同名素材,引用计数保它们不被误杀);
//   ② 无主素材清扫——测试/已删工程留在 /media/uploads/ 的文件,按「全部工程文档
//      (含软删,可恢复即算引用)引用集」做差找出来,确认后批删。
// 磁盘删除走 DELETE /upload(server 侧单段安全名);IDB 媒体缓存同步清。
// R2 云端对象刻意不动:本地删是可逆的(回源仍可找回)。
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

/** 盘面清单(server 扫上传目录;dev 与桌面同一 API)。 */
export async function listUploadFiles(): Promise<UploadFileInfo[]> {
  const res = await fetch('/upload/list');
  if (!res.ok) throw new Error(`/upload/list → HTTP ${res.status}`);
  const body = (await res.json()) as { files?: UploadFileInfo[] };
  return Array.isArray(body.files) ? body.files : [];
}

/** 全部引用并集 = 工程文档(可排除一个 id——级联删除时排除被删工程自己)
 * ∪ 已安装扩展包的 LUT cube 上传(引用记在共享扩展存储,不在工程文档里,漏了会误杀)。 */
export async function collectAllUploadRefs(excludeId?: string): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const id of await listProjectDocIds()) {
    if (id === excludeId) continue;
    const doc = await loadProject(id);
    if (!doc) continue; // 坏文档读不出引用;其素材自然落进无主清单,文档本身由孤儿清扫处理
    for (const src of collectUploadSrcs(doc)) refs.add(src);
  }
  for (const pack of await listPacks().catch(() => [])) {
    for (const url of Object.values(pack.cubeUrls ?? {})) {
      if (url.startsWith(MEDIA_PREFIX)) refs.add(url);
    }
  }
  return refs;
}

/** 纯函数:盘面清单 − 引用集 = 无主文件。 */
export function unreferencedOf(files: UploadFileInfo[], refs: Set<string>): UploadFileInfo[] {
  return files.filter((f) => !refs.has(MEDIA_PREFIX + f.name));
}

/** 删一个上传文件(磁盘 + IDB 缓存)。返回 server 是否确认。 */
export async function deleteUploadFile(name: string): Promise<boolean> {
  const res = await fetch(`/upload?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  await deleteMediaBlob(MEDIA_PREFIX + name).catch(() => {});
  return res.ok;
}

export interface CleanupScan {
  orphanDocsPurged: number;
  files: UploadFileInfo[];
}

/** 清理面板入口:先清孤儿工程文档(索引之外的 project:* ——冒烟/旧测试残留),
 * 再返回当前无主文件清单。 */
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

/** 删工程 + 级联删其独占素材(别的工程还引用的保留)。 */
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
