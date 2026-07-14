// 自定义创作技能库(source manage_skill 的网页版 in-app agent 独有工具)。
// 自定义技能 = 用户/agent 自建的创作模式技能,与内置 8 个只读技能(skills-catalog.ts)
// 并列出现在「创作模式」下拉里、可被选中注入系统提示。跨工程共享(像模板/我的设计风格
// 一样是全局库,不按工程分),存在 projectStore 的同一个 kv 库,但这里自己开同一个库
// (idb helper 是模块私有的),不改 projectStore.ts。读取时一律校验(持久化数据不可信)。
//
// CustomSkill 满足 CreativeSkill 接口(id/name/nameZh/summary/scenarios/body),这样
// systemPrompt.creativeModePrompt 无需改动就能注入自定义技能;额外带 builtin:false/
// createdAt 标记以区分内置。
import type { CreativeSkill } from '../agent/skills-catalog';

export interface CustomSkill extends CreativeSkill {
  builtin: false;
  createdAt: number;
}

const DB_NAME = 'chatcut-clone';
const STORE = 'kv';
// 全局单键:自定义技能跨工程共享(不带 projectId),与 owned design styles / templates 同思路。
const SKILLS_KEY = 'skills:custom';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, val: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 边界校验:持久化数据不可信(旧版/损坏/别的 tab 写的),先校验再用。
function isCustomSkill(v: unknown): v is CustomSkill {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<CustomSkill>;
  return typeof s.id === 'string'
    && typeof s.name === 'string'
    && typeof s.nameZh === 'string'
    && typeof s.summary === 'string'
    && typeof s.body === 'string'
    && s.builtin === false
    && typeof s.createdAt === 'number'
    && Array.isArray(s.scenarios) && s.scenarios.every((x) => typeof x === 'string');
}

async function readAll(): Promise<CustomSkill[]> {
  const raw = await idbGet<unknown>(SKILLS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCustomSkill);
}

/** 全部已存自定义技能(插入顺序)。失败一律返回空数组(不信任持久化数据)。 */
export async function loadCustomSkills(): Promise<CustomSkill[]> {
  try {
    return await readAll();
  } catch {
    return [];
  }
}

// ponytail: listCustomSkills 与 loadCustomSkills 是同一次读取(工具水合用前者、UI 挂载用
// 后者),同实现导两名,避免重复逻辑。
export const listCustomSkills = loadCustomSkills;

/** upsert:按 id 存在则原位替换,否则追加(不可变:map/展开出新数组,不原地改)。 */
export async function saveCustomSkill(skill: CustomSkill): Promise<CustomSkill> {
  const current = await readAll();
  const existing = current.some((s) => s.id === skill.id);
  const next = existing ? current.map((s) => (s.id === skill.id ? skill : s)) : [...current, skill];
  try {
    await idbSet(SKILLS_KEY, next);
  } catch {
    /* ignore persist failures; caller still gets the entry back for in-session use */
  }
  return skill;
}

export async function deleteCustomSkill(id: string): Promise<void> {
  try {
    const current = await readAll();
    await idbSet(SKILLS_KEY, current.filter((s) => s.id !== id));
  } catch {
    /* ignore */
  }
}
