// 已安装扩展包的本机共享持久化 + 启动水合(注册进运行时注册表)。
// 主存储为 ~/.openchatcut/plugins；旧 IndexedDB 数据只用于一次迁移和无浏览器服务的检查回落。
// 读取一律重跑 validatePack(持久化数据不可信),坏包静默丢弃。
// 时间线渲染不依赖这里 —— 应用过的内容已快照进 state(fxDefs/customFrag/code),
// 水合只服务资源库列表与 agent 工具可见性。
import { validatePack } from './validate';
import { pluginAssetId, type PluginFxItem, type PluginLutItem, type PluginPack, type PluginTransitionItem } from './types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import type { CustomTransitionDef } from '../gl/customTransitions';
import { registerCustomZoom, unregisterCustomZoom } from '../editor/customZooms';

const DB_NAME = 'openchatcut';
const STORE = 'kv';
const PACKS_KEY = 'plugins:packs';
const API_PATH = '/api/plugins';
let memoryPacks: unknown[] = [];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  if (typeof indexedDB === 'undefined') return (key === PACKS_KEY ? memoryPacks : undefined) as T | undefined;
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    if (key === PACKS_KEY) memoryPacks = Array.isArray(val) ? val : [];
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key: string): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    if (key === PACKS_KEY) memoryPacks = [];
    return;
  }
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const canUseServer = () => typeof window !== 'undefined' && typeof fetch === 'function';

/** 安装产物:包 + 安装期生成的资产(LUT cube 上传后的 URL,按条目 id 记) */
export interface InstalledPack extends PluginPack {
  installedAt: number;
  enabled: boolean;
  /** lut 条目 id → 已上传 .cube 的 /media/uploads URL */
  cubeUrls?: Record<string, string>;
  source?: {
    kind: 'registry' | 'url' | 'file';
    url?: string;
    sha256?: string;
  };
}

function toValidInstalled(v: unknown): InstalledPack | null {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Partial<InstalledPack>;
  const res = validatePack(v);
  if (!res.ok || typeof raw.installedAt !== 'number') return null;
  const cubeUrls = raw.cubeUrls && typeof raw.cubeUrls === 'object' && !Array.isArray(raw.cubeUrls)
    ? Object.fromEntries(Object.entries(raw.cubeUrls).filter(([, u]) => typeof u === 'string'))
    : undefined;
  const source = raw.source && typeof raw.source === 'object' && !Array.isArray(raw.source)
    && ['registry', 'url', 'file'].includes(String(raw.source.kind))
    ? {
        kind: raw.source.kind as 'registry' | 'url' | 'file',
        ...(typeof raw.source.url === 'string' ? { url: raw.source.url } : {}),
        ...(typeof raw.source.sha256 === 'string' ? { sha256: raw.source.sha256 } : {}),
      }
    : undefined;
  return {
    ...res.pack,
    installedAt: raw.installedAt,
    enabled: raw.enabled !== false,
    ...(cubeUrls ? { cubeUrls } : {}),
    ...(source ? { source } : {}),
  };
}

// 安装/卸载后的 UI 刷新订阅(扩展中心/资源库分类用)
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };
export function subscribePlugins(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

async function listLegacyPacks(): Promise<InstalledPack[]> {
  try {
    const raw = await idbGet<unknown>(PACKS_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.map(toValidInstalled).filter((p): p is InstalledPack => p !== null);
  } catch {
    return [];
  }
}

async function saveLegacyPack(pack: InstalledPack): Promise<void> {
  const packs = await listLegacyPacks();
  const at = packs.findIndex((p) => p.id === pack.id);
  const next = at === -1 ? [...packs, pack] : packs.map((p, i) => (i === at ? pack : p));
  await idbSet(PACKS_KEY, next);
}

async function requestServer(path = '', init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_PATH}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `扩展存储请求失败 (${response.status})`);
  }
  return response;
}

async function listServerPacks(): Promise<InstalledPack[]> {
  const response = await requestServer();
  const body = await response.json() as { packs?: unknown };
  if (!Array.isArray(body.packs)) return [];
  return body.packs.map(toValidInstalled).filter((pack): pack is InstalledPack => pack !== null);
}

async function saveServerPack(pack: InstalledPack): Promise<void> {
  await requestServer(`/${encodeURIComponent(pack.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pack),
  });
}

let migration: Promise<boolean> | null = null;
async function migrateLegacyPacks(remote: InstalledPack[]): Promise<boolean> {
  migration ??= (async () => {
    const legacy = await listLegacyPacks();
    let changed = false;
    for (const pack of legacy) {
      if (!remote.some((item) => item.id === pack.id)) {
        await saveServerPack(pack);
        changed = true;
      }
    }
    if (legacy.length) await idbDelete(PACKS_KEY);
    return changed;
  })();
  try {
    return await migration;
  } catch (error) {
    migration = null;
    throw error;
  }
}

export async function listPacks(): Promise<InstalledPack[]> {
  if (!canUseServer()) return listLegacyPacks();
  try {
    const remote = await listServerPacks();
    const changed = await migrateLegacyPacks(remote);
    return changed ? listServerPacks() : remote;
  } catch {
    return listLegacyPacks();
  }
}

/** 按 id upsert(重装=切换到新版本,旧版本文件保留供后续回滚)。 */
export async function savePack(pack: InstalledPack): Promise<void> {
  if (canUseServer()) await saveServerPack(pack);
  else await saveLegacyPack(pack);
  notify();
}

/** 从运行时注册表摘掉一包(fx/lut/转场/缩放);不碰持久层。已应用内容靠 state 快照仍可渲。 */
export async function unregisterPack(pack: InstalledPack): Promise<void> {
  const [fx, tr] = await Promise.all([
    import('../gl/fx/effects'),
    import('../gl/customTransitions'),
  ]);
  for (const item of pack.items) {
    const id = pluginAssetId(pack.id, item.id);
    if (item.type === 'fx' || item.type === 'lut') fx.unregisterCustomFx(id);
    else if (item.type === 'transition') tr.unregisterCustomTransition(id);
    else if (item.type === 'zoom') unregisterCustomZoom(id);
  }
}

export async function removePack(id: string): Promise<void> {
  const packs = await listPacks();
  const pack = packs.find((p) => p.id === id);
  if (pack) {
    try { await unregisterPack(pack); } catch { /* 反注册失败仍删持久层，避免卡死卸载 */ }
  }
  if (canUseServer()) {
    await requestServer(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } else {
    await idbSet(PACKS_KEY, packs.filter((p) => p.id !== id));
  }
  notify();
}

export async function setPackEnabled(id: string, enabled: boolean): Promise<void> {
  const packs = await listPacks();
  const pack = packs.find((item) => item.id === id);
  if (!pack || pack.enabled === enabled) return;
  if (enabled) await registerPack({ ...pack, enabled: true });
  else await unregisterPack(pack);
  try {
    if (canUseServer()) {
      await requestServer(`/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } else {
      await idbSet(PACKS_KEY, packs.map((item) => (item.id === id ? { ...item, enabled } : item)));
    }
  } catch (error) {
    if (enabled) await unregisterPack(pack);
    else await registerPack(pack);
    throw error;
  }
  notify();
}

// ── def 映射(纯函数,check 可测) ────────────────────────────────────────────

export function fxDefOf(pack: PluginPack, item: PluginFxItem): SerializableFxDef {
  return {
    id: pluginAssetId(pack.id, item.id),
    name: item.name,
    desc: item.desc ?? `${pack.name} 插件特效`,
    frag: item.frag,
    props: item.props ?? [],
    ...(item.passes ? { passes: item.passes } : {}),
  };
}

/** LUT def:frag 用通用 lut.frag(调用方注入,effects.ts 才有 ?raw 导入) */
export function lutDefOf(pack: PluginPack, item: PluginLutItem, cubeUrl: string, lutFrag: string): SerializableFxDef {
  return {
    id: pluginAssetId(pack.id, item.id),
    name: item.name,
    desc: item.desc ?? `${pack.name} 插件 LUT`,
    frag: lutFrag,
    props: [{ key: 'intensity', label: '强度', default: 1, min: 0, max: 1, step: 0.01 }],
    cube: cubeUrl,
  };
}

export function transitionDefOf(pack: PluginPack, item: PluginTransitionItem): CustomTransitionDef {
  return {
    id: pluginAssetId(pack.id, item.id),
    label: item.name,
    frag: item.frag,
    props: item.props ?? [],
  };
}

/** 单包注册进运行时注册表(fx/lut → ALL_FX,转场 → custom 注册表)。
 * effects.ts 含 .frag?raw 导入,只能动态 import(浏览器侧)。 */
export async function registerPack(pack: InstalledPack): Promise<void> {
  if (!pack.enabled) return;
  const [fx, tr] = await Promise.all([
    import('../gl/fx/effects'),
    import('../gl/customTransitions'),
  ]);
  for (const item of pack.items) {
    if (item.type === 'fx') fx.registerCustomFx(fxDefOf(pack, item));
    else if (item.type === 'lut') {
      const cubeUrl = pack.cubeUrls?.[item.id];
      if (cubeUrl) fx.registerCustomFx(lutDefOf(pack, item, cubeUrl, fx.LUT_FRAG));
    } else if (item.type === 'transition') {
      tr.registerCustomTransition(transitionDefOf(pack, item));
    } else if (item.type === 'zoom') {
      registerCustomZoom({
        id: pluginAssetId(pack.id, item.id),
        label: item.name,
        envelope: item.envelope,
        ...(item.magnification !== undefined ? { magnification: item.magnification } : {}),
      });
    }
    // mg-template 无注册表:资源库列表直接读 listPacks()
  }
}

/** App 启动水合:注册全部已装包;失败静默——渲染不依赖(state 快照自包含)。 */
export async function hydratePlugins(): Promise<void> {
  const packs = (await listPacks()).filter((pack) => pack.enabled);
  if (!packs.length) return;
  try {
    for (const pack of packs) await registerPack(pack);
  } catch {
    // 注册表水合失败不致命:已应用内容靠 state 快照照常渲染
  }
}
