import { access, readdir } from 'node:fs/promises';
import type { AgentToolSchema } from '../../src/agent/tool-schema';

async function bundledSkillIds(): Promise<string[]> {
  const root = new URL('../../src/agent/skills/', import.meta.url);
  const entries = await readdir(root, { withFileTypes: true });
  const ids = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        await access(new URL(`${entry.name}/SKILL.md`, root));
        return entry.name;
      } catch {
        return null;
      }
    }));
  return ids.filter((id): id is string => id !== null).sort();
}

export async function serverToolCatalogForGeneration(
  schemas: readonly AgentToolSchema[],
): Promise<AgentToolSchema[]> {
  const cloned = structuredClone(schemas);
  const loadSkill = cloned.find((schema) => schema.name === 'load_skill');
  if (!loadSkill) return [...cloned];
  if (!loadSkill.description?.endsWith('Bundled skills: .')) {
    throw new Error('load_skill schema description format changed.');
  }
  loadSkill.description = loadSkill.description.replace(
    'Bundled skills: .',
    `Bundled skills: ${(await bundledSkillIds()).join(', ')}.`,
  );
  return [...cloned];
}
