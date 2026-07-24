// Custom creative skill library, managed by manage_skill.
// Custom skills = creative mode skills built by user/agent, and 8 built-in read-only skills (skills-catalog.ts)
// They appear side by side in the "Creative Mode" drop-down list and can be selected to inject system prompts. Cross-project sharing (like templates/my design styles
// It is also a global library, not divided by project), and shares the local server KV with projectStore.
// Always verify when reading (persistent data cannot be trusted).
//
// CustomSkill meets the CreativeSkill interface (id/name/nameZh/summary/scenarios/body), so
// systemPrompt.creativeModePrompt can inject custom skills without modification; additionally with builtin:false/
// createdAt tag to distinguish built-ins.
import type { CreativeSkill } from '../agent/skills/skills-catalog';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';

export interface CustomSkill extends CreativeSkill {
  builtin: false;
  createdAt: number;
}

// Global single key: Custom skills are shared across projects (without projectId), the same idea as owned design styles / templates.
const SKILLS_KEY = 'skills:custom';
// Boundary verification: Persistent data is not trustworthy (old version/damaged/written by other tabs), verify it first and then use it.
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

/** All saved custom skills(insertion order). On failure, an empty array is always returned.(Don’t trust persistent data)。 */
export async function loadCustomSkills(): Promise<CustomSkill[]> {
  try {
    return await readAll();
  } catch {
    return [];
  }
}

// ponytail: listCustomSkills and loadCustomSkills are read at the same time (the former is used for tool hydration and UI mounting).
// The latter), implement the same guide to avoid duplication of logic.
export const listCustomSkills = loadCustomSkills;

/** upsert:press id Replace in place if exists,Otherwise append(immutable:map/Expand new array,Do not change in place)。 */
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
