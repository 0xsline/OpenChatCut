// skill_guard helpers — 前置执行守卫(canUseTool:生成类工具执行前中断确认,
// localStorage 记住授权,motion-graphic-gen 记全工程、image/video 记单工程)
// + 提案层 auto-apply 拦截(高成本工具不自动应用)。无计费概念,不做积分估算。

import { isHighCostTool, loadAgentSettings, type GenerationGuardSkill } from '../settings/agentSettings';
import type { Proposal } from '../proposal';

/** 守卫卡上的用户决定。allow-scope = 记住授权(作用域按技能定,见 rememberSkillAllowed)。 */
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

/** 该生成技能在此工程是否已被记住授权(执行前守卫直接放行)。 */
export function isSkillAllowed(skill: GenerationGuardSkill, projectId: string): boolean {
  const entry = loadAllowStore()[skill];
  if (!entry) return false;
  return entry.all === true || (entry.projects ?? []).includes(projectId);
}

/** 记住授权。作用域:motion-graphic-gen=所有工程,image-gen/video-gen=单工程。 */
export function rememberSkillAllowed(skill: GenerationGuardSkill, projectId: string): void {
  const store = loadAllowStore();
  const entry = store[skill] ?? {};
  if (skill === 'motion-graphic-gen') entry.all = true;
  else entry.projects = [...new Set([...(entry.projects ?? []), projectId])];
  store[skill] = entry;
  try {
    localStorage.setItem(ALLOW_KEY, JSON.stringify(store));
  } catch { /* quota:本次会话内仍生效于内存判定之外,忽略 */ }
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
