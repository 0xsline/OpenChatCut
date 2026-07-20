// Agent settings that actually change code paths (not soft prompt hints).
// skill_guard: high-cost tools never auto-apply even when "自动应用" is on.

/** MG 生成质量三档。 */
export type MgTier = 'speed' | 'balance' | 'quality';
export const MG_TIERS: readonly MgTier[] = ['speed', 'balance', 'quality'];

export interface AgentSettings {
  /**
   * skill_guard: high-cost tools never auto-apply — user must confirm
   * via the existing proposal card even when "自动应用" is on.
   */
  skillGuard: boolean;
  /** 思考模式(开 → 请求带 thinking:'adaptive' + effort:'medium')。 */
  thinkingEnabled: boolean;
  /** MG 质量档(默认 balance),经 <agent_settings> 注入。 */
  mgTier: MgTier;
  /** 计划模式(Agent Settings planMode 开关):先出编号计划,用户确认后再动手。 */
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
 * 每请求注入的 <agent_settings> 段:
 * `<agent_settings>motion_graphic_tier=${tier} … pass --tier ${tier}</agent_settings>`,
 * 追加到 system 组装尾部 (runtime.runAgent)。英文 key 保持不变。
 */
export function agentSettingsPrompt(s: Pick<AgentSettings, 'mgTier' | 'planMode' | 'skillGuard'>): string {
  const lines = [
    `motion_graphic_tier=${s.mgTier}`,
    `When using the motion-graphic-gen skill for this request, pass --tier ${s.mgTier}.`,
    'This value was snapshotted when the user sent the message and applies only to this request.',
    `生成 MG 时按档位取舍:speed=最快出活 / balance=均衡 / quality=打磨动效细节。`,
  ];
  if (s.planMode) {
    lines.push('plan_mode=on:先只输出编号计划并等用户确认,再开始调用工具。');
  }
  if (s.skillGuard !== false) {
    lines.push('skill_guard=true');
    lines.push('High-cost submit_* / export tools need explicit user confirmation; if the user Denies, do not retry automatically.');
  }
  return `\n\n<agent_settings>\n${lines.join('\n')}\n</agent_settings>`;
}

// ── 内联 <thinking> 抽取(思考模式的展示路径) ─────────────────────────────────
// 部分中转/模型把推理以字面 <thinking>…</thinking> 混在文本流里,而非原生 thinking
// 块;两者都折成 thinking 块展示。跨 chunk 状态机:
// 进入标签后的文本进 thinking 通道不进正文;闭合后恢复;流结束时未闭合 → 余量全归
// thinking;半截开标签(如 "<thin")最终没成标签 → 原样算正文。

const OPEN_TAG = '<thinking>';
const CLOSE_TAG = '</thinking>';

export interface ThinkingSplit {
  text: string;
  thinking: string;
}

/** `s` 结尾处「可能是 tag 开头」的最长真前缀长度 — 留到下一 chunk 再定夺。 */
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
  let inside = false; // 当前扫描位置是否在 <thinking> 标签内
  let held = ''; // 结尾半截标签候选,并入下一 chunk

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
      // 未闭合 → 余量(含半截闭标签)全归 thinking;标签外的半截开标签只是普通文本。
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
