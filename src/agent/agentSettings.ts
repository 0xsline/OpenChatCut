// Agent settings (source Composer "Agent settings": Speed / Thinking / MG Quality).
// Persisted locally; skill_guard gates high-cost tools even when auto-apply is on.

export type AgentSpeed = 'balance' | 'fast';
export type MgQuality = 'draft' | 'standard' | 'high';

export interface AgentSettings {
  /** Balance = fuller reasoning; Fast = shorter replies. */
  speed: AgentSpeed;
  /** Ask the model to surface a thinking block before tools. */
  thinkingMode: boolean;
  /** Hint for motion-graphic generation quality. */
  mgQuality: MgQuality;
  /**
   * skill_guard (source): high-cost tools never auto-apply — user must confirm
   * via the existing proposal card even when "自动应用" is on.
   */
  skillGuard: boolean;
}

const KEY = 'cc.agentSettings.v1';

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  speed: 'balance',
  thinkingMode: false,
  mgQuality: 'standard',
  skillGuard: true,
};

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      speed: parsed.speed === 'fast' ? 'fast' : 'balance',
      thinkingMode: !!parsed.thinkingMode,
      mgQuality: parsed.mgQuality === 'draft' || parsed.mgQuality === 'high' ? parsed.mgQuality : 'standard',
      skillGuard: parsed.skillGuard !== false,
    };
  } catch {
    return { ...DEFAULT_AGENT_SETTINGS };
  }
}

export function saveAgentSettings(next: AgentSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

/** Tools that cost money / long GPU / irreversible export (source skill_guard). */
export const HIGH_COST_TOOLS = new Set([
  'submit_image_generation',
  'submit_video_generation',
  'submit_music_generation',
  'submit_sound_generation',
  'submit_voice_generation',
  'submit_export',
  'export_timeline',
  'export_motion_graphic_prores',
  'convert_motion_graphic_to_video',
  'isolate_voice',
  'generate_image',
  'generate_video',
  'generate_music',
  'generate_voice',
  'generate_sound',
]);

export function isHighCostTool(name: string): boolean {
  return HIGH_COST_TOOLS.has(name);
}

export function proposalHasHighCost(ops: { toolName?: string; name?: string }[]): boolean {
  return ops.some((op) => isHighCostTool(op.toolName ?? op.name ?? ''));
}

/** Extra system-prompt fragment from settings. */
export function agentSettingsPrompt(s: AgentSettings): string {
  const lines = [
    '',
    '## Agent settings (user preferences)',
    `- Speed: ${s.speed === 'fast' ? 'Fast — prefer concise replies and fewer exploratory tool calls.' : 'Balance — thorough planning is OK.'}`,
    `- Thinking mode: ${s.thinkingMode ? 'ON — briefly state your plan before tool calls.' : 'OFF'}`,
    `- Motion graphic quality: ${s.mgQuality} (draft=faster simpler, high=best polish).`,
    s.skillGuard
      ? '- Skill guard: ON — high-cost generation/export tools will require the user to confirm the proposal before applying.'
      : '- Skill guard: OFF',
  ];
  return lines.join('\n');
}
