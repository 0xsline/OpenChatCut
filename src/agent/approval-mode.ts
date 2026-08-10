/**
 * YOLO (auto-apply) mode is a per-project composer preference. The runtime
 * guard gate reads it through this module-level registry so tool
 * confirmations can be released without threading React props through the
 * whole agent run loop. Defaults to false (ask mode); the composer syncs the
 * live value on mount and on every toggle.
 */
let autoApply = false;

export function setAgentAutoApply(value: boolean): void {
  autoApply = value;
}

export function agentAutoApply(): boolean {
  return autoApply;
}
