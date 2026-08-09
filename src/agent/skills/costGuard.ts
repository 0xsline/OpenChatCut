// Cost-guard helpers — pre-execution guard (canUseTool: interrupt confirmation
// before execution of a paid tool, localStorage remembers authorization,
// motion-graphic-gen remembers the whole project, image/video remembers the
// single project) + Proposal-layer auto-apply interception (high-cost tools are
// never auto-applied — there is no billing integration and no way to undo a
// paid API call once made).
//
// High-cost tools ALWAYS confirm before execution. The guard is not
// configurable: generation, export, transcription, web scraping, and sandbox
// calls are paid surfaces, so even in auto/YOLO mode they require a
// confirmation card (which may be remembered per scope).

import { isHighCostTool, transcriptionIsPaid } from '../settings/agentSettings';
import type { Proposal } from '../proposal';

/** User-determined guard card. allow-scope = remember authorization (scope is determined by category, see rememberCostAllowed). */
export type GuardDecision = 'allow-once' | 'allow-scope' | 'deny';

const ALLOW_KEY = 'cc.skillGuardAllow.v1';

interface AllowStore {
  [category: string]: { all?: boolean; projects?: string[] };
}

function loadAllowStore(): AllowStore {
  try {
    return (JSON.parse(localStorage.getItem(ALLOW_KEY) ?? '{}') ?? {}) as AllowStore;
  } catch {
    return {};
  }
}

/** Whether the cost category has been remembered and authorized in this project (the guard will release it directly before execution). */
export function isCostAllowed(category: string, projectId: string): boolean {
  const entry = loadAllowStore()[category];
  if (!entry) return false;
  return entry.all === true || (entry.projects ?? []).includes(projectId);
}

/** Remember authorization. Scope: motion-graphic-gen=all projects, image-gen/video-gen=single project. */
export function rememberCostAllowed(category: string, projectId: string): void {
  const store = loadAllowStore();
  const entry = store[category] ?? {};
  if (category === 'motion-graphic-gen') entry.all = true;
  else entry.projects = [...new Set([...(entry.projects ?? []), projectId])];
  store[category] = entry;
  try {
    localStorage.setItem(ALLOW_KEY, JSON.stringify(store));
  } catch { /* quota: This session is still effective outside the memory judgment and is ignored */ }
}

/** Proposal auto-apply gate. This controls only whether reversible editor
 * actions wait on a Proposal card. Paid/external side effects are independently
 * confirmed before execution unless the user previously remembered permission
 * for that cost category; auto-apply never releases that runtime guard. */
export function shouldBlockAutoApply(_proposal: Proposal, autoApply: boolean): boolean {
  return !autoApply;
}

export function highCostOps(proposal: Proposal): string[] {
  return proposal.options[0].operations
    .filter((op) => isHighCostTool(op.tool)
      && !(op.tool === 'transcribe_track' && !transcriptionIsPaid()))
    .map((op) => op.tool);
}
