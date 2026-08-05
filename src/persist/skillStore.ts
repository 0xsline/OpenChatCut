// Custom skills are a global library shared across projects. Persisted data is
// untrusted and normalized into the same runtime model as bundled skills.
// Storage: the server mirror (/api/skills → ~/.openchatcut/skills/<slug>/SKILL.md
// + kv) when reachable; IndexedDB falls back when it isn't (static hosting).
import { parseSkillFrontmatter } from '../agent/skills/skill-frontmatter';
import type { SkillDefinition } from '../agent/skills/skill-types';
import { kvGet as idbGet, kvSet as idbSet } from './sharedKv';

export interface CustomSkill extends SkillDefinition {
  source: 'custom';
  createdAt: number;
}

const SKILLS_KEY = 'skills:custom';
const SKILLS_API = '/api/skills';
const SAFE_SLUG = /^[A-Za-z0-9_-]+$/;

const canReachServer = (): boolean =>
  typeof window !== 'undefined'
  && typeof location !== 'undefined'
  && typeof fetch === 'function'
  && (location.protocol === 'http:' || location.protocol === 'https:');

export function normalizeStoredCustomSkill(value: unknown): CustomSkill | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const stored = value as Record<string, unknown>;
  if (stored.source !== 'custom' && stored.builtin !== false) return undefined;
  if (typeof stored.id !== 'string' || !SAFE_SLUG.test(stored.id)) return undefined;
  if (typeof stored.name !== 'string' || typeof stored.body !== 'string') return undefined;
  if (typeof stored.summary !== 'string' || typeof stored.createdAt !== 'number') return undefined;
  if (!Array.isArray(stored.scenarios) || !stored.scenarios.every((item) => typeof item === 'string')) {
    return undefined;
  }
  const parsed = parseSkillFrontmatter(stored.body);
  const candidate = typeof stored.slug === 'string' ? stored.slug.trim() : parsed.name;
  const slug = SAFE_SLUG.test(candidate) ? candidate : stored.id;
  const description = typeof stored.description === 'string' && stored.description.trim()
    ? stored.description.trim()
    : (parsed.description || stored.summary);
  return {
    id: stored.id,
    slug,
    name: stored.name,
    nameZh: typeof stored.nameZh === 'string' ? stored.nameZh : stored.name,
    description,
    summary: stored.summary,
    scenarios: stored.scenarios,
    body: stored.body,
    files: [],
    source: 'custom',
    createdAt: stored.createdAt,
  };
}

async function readAll(): Promise<CustomSkill[]> {
  const raw = await idbGet<unknown>(SKILLS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeStoredCustomSkill)
    .filter((skill): skill is CustomSkill => Boolean(skill));
}

export async function loadCustomSkills(): Promise<CustomSkill[]> {
  // Server mirror wins when reachable: kv skills + user-dropped SKILL.md files.
  if (canReachServer()) {
    try {
      const response = await fetch(SKILLS_API, { headers: { Accept: 'application/json' } });
      if (response.ok) {
        const body = await response.json() as { skills?: unknown[] };
        if (Array.isArray(body.skills)) {
          return body.skills
            .map(normalizeStoredCustomSkill)
            .filter((skill): skill is CustomSkill => Boolean(skill));
        }
      }
    } catch {
      // fall through to IDB
    }
  }
  try {
    return await readAll();
  } catch {
    return [];
  }
}

export const listCustomSkills = loadCustomSkills;

export async function saveCustomSkill(skill: CustomSkill): Promise<CustomSkill> {
  const current = await readAll();
  const existing = current.some((saved) => saved.id === skill.id);
  const next = existing
    ? current.map((saved) => (saved.id === skill.id ? skill : saved))
    : [...current, skill];
  try {
    await idbSet(SKILLS_KEY, next);
  } catch {
    // Persistence failure keeps the in-session result usable.
  }
  // Best-effort mirror to ~/.openchatcut/skills/<slug>/SKILL.md.
  if (canReachServer()) {
    fetch(SKILLS_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill }),
    }).catch(() => undefined);
  }
  return skill;
}

export async function deleteCustomSkill(id: string): Promise<void> {
  try {
    const current = await readAll();
    await idbSet(SKILLS_KEY, current.filter((skill) => skill.id !== id));
  } catch {
    // Deletion is best-effort when local persistence is unavailable.
  }
  if (canReachServer()) {
    fetch(`${SKILLS_API}/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
  }
}
