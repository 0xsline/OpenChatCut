// skill_guard helpers — pre-execution guard (canUseTool: interrupt confirmation before execution of generated tool,
// localStorage remembers authorization, motion-graphic-gen remembers the whole project, image/video remembers the single project)
// + Proposal layer auto-apply interception (high-cost tools are not automatically applied). There is no concept of billing and no point estimation.

import { isHighCostTool, loadAgentSettings, type GenerationGuardSkill } from '../settings/agentSettings';
import type { Proposal } from '../proposal';

/** User decisions on guard cards.allow-scope = Remember to authorize(Scope is determined by skill,see rememberSkillAllowed)。 */
export type GuardDecision = 'allow-once' | 'allow-scope' | 'deny';

const ALLOW_KEY = 'cc.skillGuardAllow.v1';

interface AllowStore {
  [skill: string]: { all?: boolean; projects?: string[] };
}

function loadAllowStore(): AllowStore {
  try {
    return (JSON.parse(localStorage.getItem(ALLOW_KEY) ?? '{}') ?? {}) as AllowStore;
  } catch {
    return {};
  }
}

/** Whether the generation skill has been remembered and authorized in this project(The guard will let you go directly before execution.)。 */
export function isSkillAllowed(skill: GenerationGuardSkill, projectId: string): boolean {
  const entry = loadAllowStore()[skill];
  if (!entry) return false;
  return entry.all === true || (entry.projects ?? []).includes(projectId);
}

/** Remember to delegate. Scope:motion-graphic-gen=All projects,image-gen/video-gen=Single project. */
export function rememberSkillAllowed(skill: GenerationGuardSkill, projectId: string): void {
  const store = loadAllowStore();
  const entry = store[skill] ?? {};
  if (skill === 'motion-graphic-gen') entry.all = true;
  else entry.projects = [...new Set([...(entry.projects ?? []), projectId])];
  store[skill] = entry;
  try {
    localStorage.setItem(ALLOW_KEY, JSON.stringify(store));
  } catch { /* quota:This session still takes effect outside of the memory judgment.,ignore */ }
}

/** True when auto-apply should be blocked so the proposal card can confirm. */
export function shouldBlockAutoApply(proposal: Proposal, autoApply: boolean): boolean {
  if (!autoApply) return true; // not auto-applying at all
  const settings = loadAgentSettings();
  if (!settings.skillGuard) return false;
  return proposal.options[0].operations.some((op) => isHighCostTool(op.tool));
}

export function highCostOps(proposal: Proposal): string[] {
  return proposal.options[0].operations
    .filter((op) => isHighCostTool(op.tool))
    .map((op) => op.tool);
}
