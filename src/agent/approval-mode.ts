/**
 * YOLO (auto-apply) mode is a per-project composer preference. The system
 * prompt reads it through this module-level registry without threading React
 * props through the agent run loop. The registry starts false until the
 * composer syncs the persisted value on mount and on every toggle.
 */
let autoApply = false;

export function setAgentAutoApply(value: boolean): void {
  autoApply = value;
}

export function agentAutoApply(): boolean {
  return autoApply;
}
