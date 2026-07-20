// 插件安装管线(浏览器侧):JSON → 纯校验 → 真编译探针(GLSL 经 GlRuntime,
// MG 经 template-host 沙箱编译)→ LUT .cube 上传成文件 → 注册 → 入库。
// 事务顺序:先 register 成功再 save;任一步失败回滚注册表(不留半装状态)。
// 运行期沙箱照常兜底,这里是第一道门。
import { validatePack } from './validate';
import { listPacks, savePack, registerPack, unregisterPack, type InstalledPack } from './store';
import type { PluginPack } from './types';
import { createGlRuntime } from '../gl/runtime';
import { compileTemplate } from '../template-host';

export type InstallResult =
  | { ok: true; pack: InstalledPack }
  | { ok: false; errors: string[] };

export type InstallFromUrlOpts = {
  /** 可选:期望 body 的 SHA-256(hex,小写或大写均可);不匹配则拒装 */
  sha256?: string;
  source?: InstalledPack['source'];
};

const err = (errors: string[]): InstallResult => ({ ok: false, errors });

/** GLSL 真编译探针:tiny canvas 上跑一遍,编译/链接失败即拒。 */
async function probeShaders(pack: PluginPack): Promise<string[]> {
  const shaderItems = pack.items.filter((i) => i.type === 'fx' || i.type === 'transition');
  if (!shaderItems.length) return [];
  const errors: string[] = [];
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  let runtime: ReturnType<typeof createGlRuntime>;
  try {
    runtime = createGlRuntime(canvas);
  } catch (e) {
    return [`WebGL 不可用,无法校验 shader:${e instanceof Error ? e.message : String(e)}`];
  }
  const src = document.createElement('canvas');
  src.width = 2;
  src.height = 2;
  src.getContext('2d')!.fillRect(0, 0, 2, 2);
  try {
    for (const item of shaderItems) {
      try {
        if (item.type === 'transition') runtime.render(item.frag, src, src, 0.5, {});
        else for (const frag of item.passes ?? [item.frag]) runtime.renderFxChain([{ frag, uniforms: {} }], src);
      } catch (e) {
        errors.push(`「${item.name}」shader 编译失败:${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    runtime.dispose();
  }
  return errors;
}

/** MG 模板真编译探针(template-host 沙箱静态面) */
async function probeTemplates(pack: PluginPack): Promise<string[]> {
  const errors: string[] = [];
  const mgItems = pack.items.filter((i) => i.type === 'mg-template');
  if (!mgItems.length) return [];
  for (const item of mgItems) {
    try {
      compileTemplate(item.code);
    } catch (e) {
      errors.push(`「${item.name}」模板编译失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors;
}

/** LUT .cube 上传成 /media/uploads 文件(导出 bundle symlink / R2 备份天然覆盖) */
async function uploadCubes(pack: PluginPack): Promise<{ cubeUrls: Record<string, string>; errors: string[] }> {
  const cubeUrls: Record<string, string> = {};
  const errors: string[] = [];
  for (const item of pack.items) {
    if (item.type !== 'lut') continue;
    const assetId = `plugin-${pack.id}-${item.id}-cube`.replace(/[^a-zA-Z0-9_-]/g, '-');
    try {
      const res = await fetch(`/upload?name=${assetId}.cube&assetId=${assetId}`, { method: 'POST', body: item.cube });
      const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
      if (!res.ok || !body?.path) {
        errors.push(`「${item.name}」.cube 上传失败:${body?.error ?? `HTTP ${res.status}`}`);
        continue;
      }
      cubeUrls[item.id] = body.path;
    } catch (e) {
      errors.push(`「${item.name}」.cube 上传失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { cubeUrls, errors };
}

/** 计算 UTF-8 文本的 SHA-256 hex(小写) */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 从 JSON 文本安装(文件/粘贴共用)。opts.sha256 可选完整性校验。 */
export async function installFromText(text: string, opts?: InstallFromUrlOpts): Promise<InstallResult> {
  if (opts?.sha256) {
    const got = await sha256Hex(text);
    if (got !== opts.sha256.trim().toLowerCase()) {
      return err([`SHA-256 不匹配(期望 ${opts.sha256.slice(0, 12)}…,实得 ${got.slice(0, 12)}…)`]);
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err(['不是合法 JSON']);
  }
  const res = validatePack(json);
  if (!res.ok) return err(res.errors);
  const pack = res.pack;

  const [shaderErrors, templateErrors] = await Promise.all([probeShaders(pack), probeTemplates(pack)]);
  if (shaderErrors.length || templateErrors.length) return err([...shaderErrors, ...templateErrors]);

  const { cubeUrls, errors: cubeErrors } = await uploadCubes(pack);
  if (cubeErrors.length) return err(cubeErrors);

  const installed: InstalledPack = {
    ...pack,
    installedAt: Date.now(),
    enabled: true,
    ...(Object.keys(cubeUrls).length ? { cubeUrls } : {}),
    ...(opts?.source ? { source: opts.source } : {}),
  };

  // 事务:摘掉同 id 旧包注册 → 注册新包 → 持久化;失败回滚注册表
  const previous = (await listPacks()).find((p) => p.id === installed.id) ?? null;
  if (previous) {
    try { await unregisterPack(previous); } catch { /* 旧包反注册失败仍继续覆盖 */ }
  }
  try {
    await registerPack(installed);
  } catch (e) {
    if (previous) {
      try { await registerPack(previous); } catch { /* 尽力恢复 */ }
    }
    return err([`注册失败:${e instanceof Error ? e.message : String(e)}`]);
  }
  try {
    await savePack(installed);
  } catch (e) {
    try { await unregisterPack(installed); } catch { /* ignore */ }
    if (previous) {
      try { await registerPack(previous); } catch { /* ignore */ }
    }
    return err([`写入本地失败:${e instanceof Error ? e.message : String(e)}`]);
  }
  return { ok: true, pack: installed };
}

/** 从 URL 安装(gist/raw/远程索引等;跨域被 CORS 拦时提示改用文件安装) */
export async function installFromUrl(url: string, opts?: InstallFromUrlOpts): Promise<InstallResult> {
  let text: string;
  try {
    const res = await fetch(url);
    if (!res.ok) return err([`下载失败:HTTP ${res.status}`]);
    text = await res.text();
  } catch (e) {
    return err([`下载失败(可能被 CORS 拦):${e instanceof Error ? e.message : String(e)}。可下载文件后用「选文件」安装`]);
  }
  return installFromText(text, {
    ...opts,
    source: opts?.source ?? {
      kind: 'url',
      url,
      ...(opts?.sha256 ? { sha256: opts.sha256 } : {}),
    },
  });
}
