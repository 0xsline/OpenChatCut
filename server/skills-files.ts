// User-visible skill files under ~/.openchatcut/skills/<slug>/SKILL.md —
// the same layout as ~/.codex/skills and ~/.claude/skills. This layer is a
// mirror of the kv-backed custom skills (project-store skills:custom) plus a
// discovery channel: files the user drops here by hand become custom skills.
// Pure fs helpers, no route logic — unit-checked under tsx.
import { homedir } from 'node:os';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

import { getKey } from './keystore.ts';
import { parseSkillFrontmatter } from '../src/agent/skills/skill-frontmatter.ts';

/** Slug whitelist — mirrors src/persist/skillStore.ts SAFE_SLUG. */
const SAFE_SLUG = /^[A-Za-z0-9_-]{1,120}$/;

/** Override for tests and unusual installs; defaults to ~/.openchatcut/skills. */
export function skillFilesRoot(): string {
  return getKey('OPENCHATCUT_SKILLS_DIR') || join(homedir(), '.openchatcut', 'skills');
}

export function skillDirFor(root: string, slug: string): string | null {
  if (!SAFE_SLUG.test(slug)) return null;
  const dir = resolve(root, slug);
  // Defense in depth: the resolved path must stay inside the root.
  if (!dir.startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`)) return null;
  return dir;
}

export interface DiscoveredSkillFile {
  slug: string;
  body: string;
  description: string;
}

/** Scan ~/.openchatcut/skills/ for SKILL.md files (user-dropped or mirrored). */
export async function discoverSkillFiles(root: string): Promise<DiscoveredSkillFile[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: DiscoveredSkillFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SLUG.test(entry.name)) continue;
    const dir = skillDirFor(root, entry.name);
    if (!dir) continue;
    try {
      const raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed.body.trim()) continue;
      found.push({ slug: entry.name, body: raw, description: parsed.description || parsed.name || entry.name });
    } catch {
      // Missing/unreadable SKILL.md is not a skill.
    }
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Mirror one skill to ~/.openchatcut/skills/<slug>/SKILL.md (idempotent). */
export async function mirrorSkillFile(root: string, slug: string, body: string): Promise<string | null> {
  const dir = skillDirFor(root, slug);
  if (!dir) return null;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), body, 'utf8');
  return join(dir, 'SKILL.md');
}

/** Remove the mirrored directory for a slug. Returns false when nothing existed. */
export async function removeSkillFile(root: string, slug: string): Promise<boolean> {
  const dir = skillDirFor(root, slug);
  if (!dir) return false;
  try {
    await access(dir);
  } catch {
    return false;
  }
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Human-readable install location for tool responses: ~/.openchatcut/skills/<slug>. */
export function displaySkillPath(slug: string): string {
  return join('~', '.openchatcut', 'skills', slug);
}
