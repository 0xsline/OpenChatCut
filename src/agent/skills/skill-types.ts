export type SkillSource = 'builtin' | 'custom';

/** Runtime model shared by selectable built-in and user-created skills. */
export interface SkillDefinition {
  id: string;
  slug: string;
  name: string;
  nameZh: string;
  description: string;
  summary: string;
  scenarios: string[];
  body: string;
  files: string[];
  source: SkillSource;
}
