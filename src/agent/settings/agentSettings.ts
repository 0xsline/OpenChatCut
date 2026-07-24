// Agent settings that actually change code paths (not soft prompt hints).
// skill_guard: high-cost tools never auto-apply even when "auto-apply" is on.

/** MG Generate quality level three. */
export type MgTier = 'speed' | 'balance' | 'quality';
export const MG_TIERS: readonly MgTier[] = ['speed', 'balance', 'quality'];

export interface AgentSettings {
  /**
   * skill_guard: high-cost tools never auto-apply — user must confirm
   * via the existing proposal card even when "Automatically apply" is on.
   */
  skillGuard: boolean;
  /** Thinking model(open → Request to bring thinking:'adaptive' + effort:'medium')。 */
  thinkingEnabled: boolean;
  /** MG quality file(Default balance),by <agent_settings> Inject. */
  mgTier: MgTier;
  /** planning mode(Agent Settings planMode switch):First-out numbering plan,The user must confirm before proceeding. */
  planMode: boolean;
}

const KEY = 'cc.agentSettings.v1';

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  skillGuard: true,
  thinkingEnabled: false,
  mgTier: 'balance',
  planMode: false,
};

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      skillGuard: parsed.skillGuard !== false,
      thinkingEnabled: parsed.thinkingEnabled === true,
      mgTier: MG_TIERS.includes(parsed.mgTier as MgTier) ? (parsed.mgTier as MgTier) : DEFAULT_AGENT_SETTINGS.mgTier,
      planMode: parsed.planMode === true,
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

/**
 * Injected per request <agent_settings> segment:
 * `<agent_settings>motion_graphic_tier=${tier} … pass --tier ${tier}</agent_settings>`,
 * append to system Assemble the tail (runtime.runAgent). English key remain unchanged.
 */
export function agentSettingsPrompt(s: Pick<AgentSettings, 'mgTier' | 'planMode' | 'skillGuard'>): string {
  const lines = [
    `motion_graphic_tier=${s.mgTier}`,
    `When using the motion-graphic-gen skill for this request, pass --tier ${s.mgTier}.`,
    'This value was snapshotted when the user sent the message and applies only to this request.',
    `generate MG Choose according to gear:speed=Quickest way to work / balance=equilibrium / quality=Polish the details of motion effects.`,
  ];
  if (s.planMode) {
    lines.push('plan_mode=on:First output only the numbering plan and wait for user confirmation,Start calling the tool again.');
  }
  if (s.skillGuard !== false) {
    lines.push('skill_guard=true');
    lines.push('High-cost submit_* / export tools need explicit user confirmation; if the user Denies, do not retry automatically.');
  }
  return `\n\n<agent_settings>\n${lines.join('\n')}\n</agent_settings>`;
}

// ── Inline <thinking> extraction (display path of thinking mode) ────────────────────────────────
// Part of the transfer/model mixes reasoning into the text flow as literal <thinking>…</thinking> instead of native thinking
// blocks; both are shown folded into thinking blocks. Cross-chunk state machine:
// The text after entering the label enters the thinking channel but does not enter the main text; it is restored after closing; it is not closed at the end of the stream → all the remainder is returned
// Thinking; Half-cut tags (such as "<thin") eventually become no tags → the text is counted as it is.

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export interface ThinkingSplit {
  text: string;
  thinking: string;
}

/** `s` At the end, "Maybe tag The longest true prefix length of "beginning" — left to next chunk Decide again. */
function danglingPrefixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export function createInlineThinkingExtractor(): {
  push(chunk: string): ThinkingSplit;
  flush(): ThinkingSplit;
} {
  let inside = false; // Whether the current scanning position is within the <thinking> tag
  let held = ''; // The last half label candidate is merged into the next chunk.

  const scan = (input: string): ThinkingSplit => {
    let text = '';
    let thinking = '';
    let s = input;
    for (;;) {
      const tag = inside ? CLOSE_TAG : OPEN_TAG;
      const i = s.indexOf(tag);
      if (i >= 0) {
        if (inside) thinking += s.slice(0, i);
        else text += s.slice(0, i);
        s = s.slice(i + tag.length);
        inside = !inside;
        continue;
      }
      const hold = danglingPrefixLen(s, tag);
      const emit = s.slice(0, s.length - hold);
      if (inside) thinking += emit;
      else text += emit;
      held = s.slice(s.length - hold);
      return { text, thinking };
    }
  };

  return {
    push(chunk: string): ThinkingSplit {
      const s = held + chunk;
      held = '';
      return scan(s);
    },
    flush(): ThinkingSplit {
      const rest = held;
      held = '';
      // Unclosed → The remainder (including half-closed tags) are all attributed to thinking; the half-open tags outside the tags are just ordinary text.
      return inside ? { text: '', thinking: rest } : { text: rest, thinking: '' };
    },
  };
}

/** Tools that cost money / long GPU / irreversible export (gated by skill_guard).
 *  Names match live TOOL_SCHEMAS (not legacy generate_* aliases). */
export const HIGH_COST_TOOLS = new Set([
  // live submit_* generation surface
  'submit_image',
  'submit_video',
  'submit_music',
  'submit_sound',
  'submit_voice',
  'submit_motion_graphic',
  'create_motion_graphic', // alias of submit_motion_graphic
  'submit_shader',
  // export / bake
  'submit_export',
  'submit_render_job',
  'export_timeline',
  'export_motion_graphic_prores',
  'convert_motion_graphic_to_video',
  // legacy aliases kept for older proposals
  'submit_image_generation',
  'submit_video_generation',
  'submit_music_generation',
  'submit_sound_generation',
  'submit_voice_generation',
  'generate_image',
  'generate_video',
  'generate_music',
  'generate_voice',
  'generate_sound',
]);

export function isHighCostTool(name: string): boolean {
  return HIGH_COST_TOOLS.has(name);
}

/** skill_guard keys for image, motion-graphic, and video generation. */
export type GenerationGuardSkill = 'image-gen' | 'motion-graphic-gen' | 'video-gen';

export function generationSkillForTool(tool: string): GenerationGuardSkill | null {
  if (tool === 'submit_image' || tool === 'generate_image' || tool === 'submit_image_generation') return 'image-gen';
  if (
    tool === 'submit_motion_graphic' || tool === 'create_motion_graphic'
    || tool === 'create_motion_graphic_from_code'
  ) return 'motion-graphic-gen';
  if (tool === 'submit_video' || tool === 'generate_video' || tool === 'submit_video_generation') return 'video-gen';
  return null;
}
