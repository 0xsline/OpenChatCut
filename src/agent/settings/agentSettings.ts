// Agent settings that actually change code paths (not soft prompt hints).
// skill_guard: high-cost tools never auto-apply even when "auto-apply" is on.

/** MG generates three levels of quality. */
export type MgTier = 'speed' | 'balance' | 'quality';
export const MG_TIERS: readonly MgTier[] = ['speed', 'balance', 'quality'];

export interface AgentSettings {
  /**
   * skill_guard: high-cost tools never auto-apply — user must confirm
   * via the existing proposal card even when "Auto-Apply" is on.
   */
  skillGuard: boolean;
  /** Thinking mode (on → request with thinking:'adaptive' + effort:'medium'). */
  thinkingEnabled: boolean;
  /** MG quality file (default balance), injected through <agent_settings>. */
  mgTier: MgTier;
  /** Plan mode (Agent Settings planMode switch): come up with the numbering plan first, and then start after the user confirms it. */
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
 * <agent_settings> section injected per request:
 * `<agent_settings>motion_graphic_tier=${tier} … pass --tier ${tier}</agent_settings>`,
 * Appended to the end of the system assembly (runtime.runAgent). The English key remains unchanged.
 */
export function agentSettingsPrompt(s: Pick<AgentSettings, 'mgTier' | 'planMode' | 'skillGuard'>): string {
  const lines = [
    `motion_graphic_tier=${s.mgTier}`,
    `When using the motion-graphic-gen skill for this request, pass --tier ${s.mgTier}.`,
    'This value was snapshotted when the user sent the message and applies only to this request.',
    'For motion graphics, honor the selected tier: speed = fastest delivery, balance = balanced quality and speed, quality = polish motion details.',
  ];
  if (s.planMode) {
    lines.push('plan_mode=on: output only a numbered plan first, wait for user confirmation, then call tools.');
  }
  if (s.skillGuard !== false) {
    lines.push('skill_guard=true');
    lines.push('High-cost submit_* / export tools need explicit user confirmation; if the user Denies, do not retry automatically.');
  }
  return `\n\n<agent_settings>\n${lines.join('\n')}\n</agent_settings>`;
}

// ──Inline thinking tag extraction (display path of thinking mode) ─────────────────────────────────
// Some relays/models mix reasoning into the text flow with literal labels instead of native thinking blocks:
// DeepSeek/MiniMax/GLM/Qwen/MiMo systems commonly use <think>, and some transfer and prompt words use <thinking>.
// Both pairs of tags are recognized and are uniformly effective for all providers; the native reasoning channel does not pass through here.
// Cross-chunk state machine: The text after entering the open tag enters the thinking channel but not the main text; when it encounters the text that is paired with the open tag
// The text is restored only when the tag is closed; the stream is not closed at the end → all the remainder goes to thinking; the tag is opened half way (such as "<thin")
// In the end, it did not become a label → the text is counted as it is.

const TAG_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['<think>', '</think>'],
  ['<thinking>', '</thinking>'],
];
const OPEN_TAGS = TAG_PAIRS.map(([open]) => open);

export interface ThinkingSplit {
  text: string;
  thinking: string;
}

/** The longest true prefix length at the end of `s` that "may be the beginning of a tag" - left to the next chunk to be determined.*/
function danglingPrefixLen(s: string, tags: readonly string[]): number {
  let hold = 0;
  for (const tag of tags) {
    const max = Math.min(s.length, tag.length - 1);
    for (let n = max; n > hold; n--) {
      if (s.endsWith(tag.slice(0, n))) { hold = n; break; }
    }
  }
  return hold;
}

export function createInlineThinkingExtractor(): {
  push(chunk: string): ThinkingSplit;
  flush(): ThinkingSplit;
} {
  let closeTag: string | null = null; // Non-empty = within the thinking block, wait for the closing tag of this pair
  let held = ''; // The last half label candidate is merged into the next chunk.

  const scan = (input: string): ThinkingSplit => {
    let text = '';
    let thinking = '';
    let s = input;
    for (;;) {
      if (closeTag) {
        const i = s.indexOf(closeTag);
        if (i >= 0) {
          thinking += s.slice(0, i);
          s = s.slice(i + closeTag.length);
          closeTag = null;
          continue;
        }
        const hold = danglingPrefixLen(s, [closeTag]);
        thinking += s.slice(0, s.length - hold);
        held = s.slice(s.length - hold);
        return { text, thinking };
      }
      let openAt = -1;
      let openPair: readonly [open: string, close: string] | undefined;
      for (const pair of TAG_PAIRS) {
        const i = s.indexOf(pair[0]);
        if (i >= 0 && (openAt < 0 || i < openAt)) { openAt = i; openPair = pair; }
      }
      if (openPair) {
        text += s.slice(0, openAt);
        s = s.slice(openAt + openPair[0].length);
        closeTag = openPair[1];
        continue;
      }
      const hold = danglingPrefixLen(s, OPEN_TAGS);
      text += s.slice(0, s.length - hold);
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
      return closeTag ? { text: '', thinking: rest } : { text: rest, thinking: '' };
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
