// 素材目录的绝对磁盘路径(FCPXML 导出重链用)。物理位置由服务端的 MEDIA_DIR
// 决定,浏览器侧只能问服务端;一个会话内不会变,取一次缓存住。
// 拿不到就返回 undefined —— 导出仍然出得来,只是 NLE 里素材是离线的,
// 比整个导出失败好。

let cached: string | undefined;
let inflight: Promise<string | undefined> | undefined;

async function fetchMediaDir(): Promise<string | undefined> {
  try {
    const res = await fetch('/api/keys');
    if (!res.ok) return undefined;
    const body = (await res.json()) as { mediaDir?: unknown };
    return typeof body.mediaDir === 'string' && body.mediaDir ? body.mediaDir : undefined;
  } catch {
    return undefined; // 预览构建等没有该端点的场景
  }
}

/** 当前素材目录的绝对路径;不可用时 undefined。 */
export async function exportMediaDir(): Promise<string | undefined> {
  if (cached !== undefined) return cached;
  inflight ??= fetchMediaDir().then((dir) => {
    if (dir) cached = dir;
    inflight = undefined;
    return dir;
  });
  return inflight;
}

/** 测试用:清掉进程内缓存。 */
export function resetExportMediaDirCache(): void {
  cached = undefined;
  inflight = undefined;
}
