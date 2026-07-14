// Agent settings that actually change code paths (not soft prompt hints).
// skill_guard: high-cost tools never auto-apply even when "自动应用" is on.

export interface AgentSettings {
  /**
   * skill_guard (source): high-cost tools never auto-apply — user must confirm
   * via the existing proposal card even when "自动应用" is on.
   */
  skillGuard: boolean;
}

const KEY = 'cc.agentSettings.v1';

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  skillGuard: true,
};

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
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
