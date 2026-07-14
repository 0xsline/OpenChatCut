// skill_guard helpers — decide whether a proposal may auto-apply.

import { isHighCostTool, loadAgentSettings } from './agentSettings';
import type { Proposal } from './proposal';

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
