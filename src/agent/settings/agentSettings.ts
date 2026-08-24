import {
  isTranscriptionProviderId,
  type TranscriptionProviderId,
} from '../../transcript/types';
// Agent settings that actually change code paths (not soft prompt hints).
// Ask/YOLO controls proposal application and prompt behavior; built-in tools
// execute directly in both modes.

/** MG generates three levels of quality. */
export type MgTier = 'speed' | 'balance' | 'quality';
export const MG_TIERS: readonly MgTier[] = ['speed', 'balance', 'quality'];
export type AgentCacheMode = 'short' | 'long';
export const AGENT_CACHE_MODES: readonly AgentCacheMode[] = ['short', 'long'];
export const DEFAULT_ACCEPTANCE_ITERATIONS = 3;
export const MIN_ACCEPTANCE_ITERATIONS = 1;
export const MAX_ACCEPTANCE_ITERATIONS = 10;


export interface AgentSettings {
  /** MG quality file (default balance), injected through <agent_settings>. */
  mgTier: MgTier;
  /** Plan mode (Agent Settings planMode switch): come up with the numbering plan first, and then start after the user confirms it. */
  planMode: boolean;
  /** Provider prompt-cache duration: short sessions favor the default TTL; long sessions request 1h where supported. */
  cacheMode: AgentCacheMode;
  /** Opt-in: run the Agent loop on the local server so browser refreshes do not interrupt it. */
  serverRun: boolean;
  /** Opt-in settled-turn verification after the Agent changes project state. */
  autonomousAcceptance: boolean;
  /** Maximum verification passes before the run reports an unverified result. */
  maxAcceptanceIterations: number;
}

const KEY = 'cc.agentSettings.v1';

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  mgTier: 'balance',
  planMode: false,
  cacheMode: 'short',
  serverRun: true,
  autonomousAcceptance: false,
  maxAcceptanceIterations: DEFAULT_ACCEPTANCE_ITERATIONS,
};

export function normalizeAcceptanceIterations(value: unknown): number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= MIN_ACCEPTANCE_ITERATIONS
    && value <= MAX_ACCEPTANCE_ITERATIONS
    ? value
    : DEFAULT_ACCEPTANCE_ITERATIONS;
}

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_AGENT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    return {
      mgTier: MG_TIERS.includes(parsed.mgTier as MgTier) ? (parsed.mgTier as MgTier) : DEFAULT_AGENT_SETTINGS.mgTier,
      planMode: parsed.planMode === true,
      cacheMode: AGENT_CACHE_MODES.includes(parsed.cacheMode as AgentCacheMode)
        ? parsed.cacheMode as AgentCacheMode
        : DEFAULT_AGENT_SETTINGS.cacheMode,
      serverRun: true, // server-side execution is the only Agent path (issue-less refactor); stored/old false is ignored.
      autonomousAcceptance: parsed.autonomousAcceptance === true,
      maxAcceptanceIterations: normalizeAcceptanceIterations(parsed.maxAcceptanceIterations),
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
export function agentSettingsPrompt(s: Pick<AgentSettings, 'mgTier' | 'planMode'>): string {
  const lines = [
    `motion_graphic_tier=${s.mgTier}`,
    `When using the motion-graphic-gen skill for this request, pass --tier ${s.mgTier}.`,
    'This value was snapshotted when the user sent the message and applies only to this request.',
    'For motion graphics, honor the selected tier: speed = fastest delivery, balance = balanced quality and speed, quality = polish motion details.',
  ];
  if (s.planMode) {
    lines.push('plan_mode=on: output only a numbered plan first, wait for user confirmation, then call tools.');
  }
  return `\n\n<agent_settings>\n${lines.join('\n')}\n</agent_settings>`;
}

// ── Inline thinking tag extraction ───────────────────────────────────────────
// Some relays/models mix reasoning into the text flow with literal labels instead of native thinking blocks:
// DeepSeek/MiniMax/GLM/Qwen/MiMo systems commonly use <think>, and some transfer and prompt words use <thinking>.
// Both pairs are stripped from the visible reply and routed to the collapsed thinking block.
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

/** Resolve the transcription provider that will actually receive this invocation.
 * Tool arguments have precedence over the saved setting. */
export function effectiveTranscriptionProvider(
  args?: Readonly<Record<string, unknown>>,
): TranscriptionProviderId {
  if (args?.provider !== undefined) {
    return isTranscriptionProviderId(args.provider) ? args.provider : 'assemblyai';
  }
  try {
    const saved = globalThis.localStorage?.getItem('cc.transcriptionProvider');
    return isTranscriptionProviderId(saved) ? saved : 'assemblyai';
  } catch {
    return 'assemblyai';
  }
}
