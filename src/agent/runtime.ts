import {
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS, executeTool } from './tools';
import { SYSTEM_PROMPT, assembleSystemPrompt, creativeModePrompt, designStylePrompt, editorStatePrompt } from './systemPrompt';
import { capabilitiesPrompt } from './capabilities';
import { findSkill } from './skills/skills-catalog';
import { PLUGIN_SKILLS_INDEX } from './skills/plugin-skills';
import {
  getLanguageModel,
  getLanguageModelProviderOptions,
  protocolForProvider,
  PROVIDER,
} from './client';
import { makeMessagesPortable, normalizeLlmMessages } from './messages';
import { describeTimelineDelta, snapshotTimeline } from './timelineDelta';
import {
  agentSettingsPrompt,
  createInlineThinkingExtractor,
  generationSkillForTool,
  loadAgentSettings,
  type GenerationGuardSkill,
} from './settings/agentSettings';
import type { GuardDecision } from './skills/skillGuard';
import { completeAbortedTurn } from './abortedTurn';

const MAX_OUTPUT_TOKENS = 64000;
const MAX_TOOL_TURNS = 200;
type ToolResultOutput = ToolResultPart['output'];

export type LLMMessage = ModelMessage;

export type AgentEvent =
  | { type: 'text-start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-input-start'; name: string }
  | { type: 'tool-input-delta'; delta: string }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'max-turns'; turns: number }
  | { type: 'error'; message: string }
  | { type: 'context'; tokens: number; threshold: number };

export function initialMessages(): LLMMessage[] {
  return [];
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as Error & { statusCode?: number; status?: number }).statusCode
    ?? (error as Error & { status?: number }).status;
  return status != null && !error.message.startsWith(String(status))
    ? `${status} ${error.message}`
    : error.message;
}

function toolModelOutput(output: unknown): ToolResultOutput {
  const shaped = output as {
    denied?: boolean;
    note?: string;
    __images?: Array<{ frame: number; base64: string }>;
  } | null;
  if (shaped?.denied) {
    return { type: 'execution-denied', reason: shaped.note ?? 'User denied tool execution.' };
  }
  if (Array.isArray(shaped?.__images)) {
    return {
      type: 'content',
      value: [
        ...shaped.__images.map((image) => ({
          type: 'file' as const,
          data: { type: 'data' as const, data: image.base64 },
          mediaType: 'image/jpeg',
          filename: `timeline-frame-${image.frame}.jpg`,
        })),
        {
          type: 'text' as const,
          text: shaped.note ?? `${shaped.__images.length} frames rendered`,
        },
      ],
    };
  }
  const value = JSON.stringify(output ?? null);
  return { type: 'text', value };
}

function createAgentTools(
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  settings: ReturnType<typeof loadAgentSettings>,
  onSkillGuard?: (info: { skill: GenerationGuardSkill; tool: string }) => Promise<GuardDecision>,
  onFollowup?: () => void,
  onVerifyBudgetStatus?: (status: string) => void,
): ToolSet {
  return Object.fromEntries(TOOL_SCHEMAS.map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
      ),
      execute: async (input) => {
        const args = input ?? {};
        const guardSkill = settings.skillGuard ? generationSkillForTool(schema.name) : null;
        if (guardSkill && onSkillGuard) {
          const decision = await onSkillGuard({ skill: guardSkill, tool: schema.name });
          if (decision === 'deny') {
            const denied = {
              denied: true,
              note: 'User denied this generation via skill_guard. Do not retry automatically; ask what to adjust instead.',
            };
            onEvent({ type: 'tool', name: schema.name, args, result: denied });
            return denied;
          }
        }

        try {
          // 工具前后各拍一次时间线快照:改动型工具直接把「实际改了什么」带回给
          // 模型,省掉一次全量 read_project(只读工具的差分是 null,不加字段)。
          const before = snapshotTimeline(ctx.getState());
          const result = await executeTool(schema.name, args, ctx);
          // Level 3 enforce: capture verify_word_budget's status DIRECTLY from the tool's
          // return value (robust — does not depend on the SDK's responseMessages shape,
          // which wraps results as JSON text and would otherwise need parsing).
          if (schema.name === 'verify_word_budget') {
            const status = (result as { status?: unknown } | null)?.status;
            if (typeof status === 'string') onVerifyBudgetStatus?.(status);
          }
          const changed = describeTimelineDelta(before, ctx.getState());
          const enriched = changed && result && typeof result === 'object' && !Array.isArray(result)
            ? { ...(result as Record<string, unknown>), changed }
            : result;
          onEvent({ type: 'tool', name: schema.name, args, result: enriched });
          const followup = (result as { __followup?: unknown } | null)?.__followup;
          if (typeof followup === 'string') {
            onEvent({ type: 'text-start' });
            onEvent({ type: 'text-delta', delta: followup });
            onFollowup?.();
          }
          return enriched;
        } catch (error) {
          const failed = { error: errorMessage(error) };
          onEvent({ type: 'tool', name: schema.name, args, result: failed });
          return failed;
        }
      },
      toModelOutput: ({ output }) => toolModelOutput(output),
    }),
  ]));
}

function responseUsedTools(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call'));
}

// ── Auto-compact: summarize old conversation when context approaches the model limit ──
// Triggered before each streamText call. Threshold configurable via CC_CONTEXT_THRESHOLD.
const KEEP_RECENT_MESSAGES = 16;

function estimateTokens(messages: readonly ModelMessage[]): number {
  // rough: ~4 chars/token. Cukup untuk threshold check (bukan exact count).
  // Strip image/file parts first — base64 frame data (view_timeline_frames) would
  // otherwise inflate the char count ~33% and trip auto-compact far too early, since
  // image tokens are computed from pixel dims, not 1:4 chars.
  const stripped = messages.map((m) => {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) return m;
    const filtered = content.filter((part: { type?: string }) => part?.type !== 'file' && part?.type !== 'image');
    return { ...(m as object), content: filtered };
  });
  return Math.ceil(JSON.stringify(stripped).length / 4);
}

async function compactConversation(conv: ModelMessage[], signal?: AbortSignal): Promise<ModelMessage[]> {
  if (conv.length <= KEEP_RECENT_MESSAGES) return conv;
  const oldMessages = conv.slice(0, conv.length - KEEP_RECENT_MESSAGES);
  const recent = conv.slice(conv.length - KEEP_RECENT_MESSAGES);
  try {
    const summaryResult = await streamText({
      model: getLanguageModel(),
      system: 'Summarize the following agent conversation concisely. Preserve: the user request, key decisions, the narration script/plan, scene breakdown + word budget, timeline state, what was done so far, and any pending tasks. Output only the summary.',
      messages: oldMessages,
      maxOutputTokens: 6000,
      maxRetries: 0,
      abortSignal: signal,
    });
    const summary = await summaryResult.text;
    return [
      { role: 'user', content: `[Auto-compact summary of earlier conversation]\n${summary}\n[End summary — recent messages follow]` } as ModelMessage,
      ...recent,
    ];
  } catch {
    // fallback: truncate (keep recent only) — better than crashing on context overflow
    return recent;
  }
}

export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts?: {
    askOnly?: boolean;
    signal?: AbortSignal;
    onSkillGuard?: (info: { skill: GenerationGuardSkill; tool: string }) => Promise<GuardDecision>;
  },
): Promise<LLMMessage[]> {
  let conv = normalizeLlmMessages(messages);
  let settings = loadAgentSettings();
  // 顺序按「越不变的排越前」——提示词缓存匹配的是逐字节前缀,中间插一段每轮都变的
  // 内容,它后面的一切(其余段落、上百个工具 schema、整段历史)就全部作废。
  // editorStatePrompt 是实时时间线快照,必须排在最后一段;新增段落也一律加在它前面。
  const system = assembleSystemPrompt([
    SYSTEM_PROMPT,
    capabilitiesPrompt(),
    PLUGIN_SKILLS_INDEX,
    agentSettingsPrompt(settings),
    designStylePrompt(ctx.getDoc().designStyle),
    creativeModePrompt(findSkill(ctx.getCreativeMode())),
  ], editorStatePrompt(ctx));

  let reasoningFellBack = false;
  let toolTurns = 0;
  // Level 3 enforce: track the last verify_word_budget status so the runtime can BLOCK the agent
  // from finishing while the narration is under the requested word count.
  let lastVerifyBudgetStatus: string | null = null;

  for (;;) {
    // Re-read agent settings per turn so UI toggles (auto-compact, planMode, skillGuard, thinking)
    // take effect immediately mid-run — not just on the next message.
    settings = loadAgentSettings();
    const withReasoning = settings.thinkingEnabled && !reasoningFellBack;
    const extract = createInlineThinkingExtractor();
    let sawContentEvent = false;
    let textStarted = false;
    let visibleText = '';
    let askedFollowup = false;
    const emitText = (delta: string) => {
      if (!textStarted) {
        onEvent({ type: 'text-start' });
        textStarted = true;
      }
      visibleText += delta;
      onEvent({ type: 'text-delta', delta });
    };
    const tools = opts?.askOnly
      ? {}
      : createAgentTools(
          ctx,
          onEvent,
          settings,
          opts?.onSkillGuard,
          () => { askedFollowup = true; },
          (status) => { lastVerifyBudgetStatus = status; },
        );

    try {
      // Responses relays do not consistently persist `rs_*` item IDs. Keep
      // OpenAI turns stateless by replaying portable local history and asking
      // the provider not to store the response.
      // Auto-compact: if enabled (agentSettings) and context approaches the model limit, summarize old conversation.
      if (settings.autoCompact && estimateTokens(conv) > settings.contextThreshold) {
        onEvent({ type: 'error', message: `[context] auto-compact: context exceeded ~${settings.contextThreshold} tokens — summarizing older conversation, keeping ${KEEP_RECENT_MESSAGES} recent messages` });
        const compacted = await compactConversation(conv, opts?.signal);
        conv.length = 0;
        conv.push(...compacted);
        // Re-fire guard: if even the kept-recent window alone exceeds the threshold (one
        // huge tool dump), trim oldest from the RECENT window so the gate doesn't fire
        // again next turn and re-summarize its own summary. Keep index 0 (the summary)
        // intact — splice(1,1), NOT shift(), so the original-request summary is preserved.
        while (estimateTokens(conv) > settings.contextThreshold && conv.length > 4) {
          conv.splice(1, 1);
        }
      }
      const requestMessages = protocolForProvider(PROVIDER) === 'openai'
        ? makeMessagesPortable(conv)
        : conv;
      const providerOptions = getLanguageModelProviderOptions();
      const result = streamText({
        model: getLanguageModel(),
        system,
        messages: requestMessages,
        tools,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        abortSignal: opts?.signal,
        ...(providerOptions ? { providerOptions } : {}),
        ...(withReasoning ? { reasoning: 'medium' as const } : {}),
      });

      let aborted = false;
      try {
        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            sawContentEvent = true;
            const extracted = extract.push(part.text);
            if (extracted.thinking) onEvent({ type: 'thinking-delta', delta: extracted.thinking });
            if (extracted.text) emitText(extracted.text);
          } else if (part.type === 'reasoning-delta') {
            sawContentEvent = true;
            if (part.text) onEvent({ type: 'thinking-delta', delta: part.text });
          } else if (part.type === 'tool-input-start') {
            sawContentEvent = true;
            onEvent({ type: 'tool-input-start', name: part.toolName });
          } else if (part.type === 'tool-input-delta') {
            sawContentEvent = true;
            if (part.delta) onEvent({ type: 'tool-input-delta', delta: part.delta });
          } else if (part.type === 'error') {
            throw part.error;
          } else if (part.type === 'abort') {
            aborted = true;
            break;
          }
        }
      } catch (error) {
        if (!opts?.signal?.aborted) throw error;
        aborted = true;
      }

      const tail = extract.flush();
      if (tail.thinking) onEvent({ type: 'thinking-delta', delta: tail.thinking });
      if (tail.text) emitText(tail.text);

      let responseMessages: ModelMessage[];
      try {
        responseMessages = await result.responseMessages;
      } catch (error) {
        if (!aborted && !opts?.signal?.aborted) throw error;
        responseMessages = [];
      }
      if (aborted || opts?.signal?.aborted) {
        const persisted = responseMessages.length || !visibleText
          ? responseMessages
          : [{ role: 'assistant', content: [{ type: 'text', text: visibleText }] } as ModelMessage];
        return completeAbortedTurn(conv, persisted);
      }
      conv = [...conv, ...responseMessages];
      // verify_word_budget status is captured directly in createAgentTools' execute()
      // (via onVerifyBudgetStatus) — see comment there. No responseMessages parsing here.
      // Emit context token count: prefer EXACT from model usage, fall back to chars/4 estimate.
      // 9router (OpenAI-compat proxy) may NOT include usage in streaming responses by default
      // (OpenAI requires stream_options:{include_usage:true}). The fallback ensures the meter
      // always updates instead of staying stuck at 0K.
      try {
        const usage = await result.usage;
        const promptTokens = (usage as { promptTokens?: number } | null)?.promptTokens;
        const tokens = (typeof promptTokens === 'number' && promptTokens > 0)
          ? promptTokens
          : estimateTokens(conv);
        onEvent({ type: 'context', tokens, threshold: settings.contextThreshold });
      } catch {
        onEvent({ type: 'context', tokens: estimateTokens(conv), threshold: settings.contextThreshold });
      }
      if (askedFollowup) return conv;
      if (!responseUsedTools(responseMessages)) {
        // Level 3 enforce: the agent CANNOT finish while verify_word_budget reports UNDER_BUDGET.
        // Inject a user turn forcing expansion + re-verify and continue the loop (agent must tool-call).
        if (lastVerifyBudgetStatus === 'UNDER_BUDGET') {
          conv.push({ role: 'user', content: 'verify_word_budget reported status UNDER_BUDGET. The requested word count is a HARD FLOOR, not a suggestion — stopping short is a failure. You MUST expand the narration (add scenes / lengthen thin ones) and call verify_word_budget again, looping until it returns status ok. Do NOT finish, do NOT ask the user whether to continue — keep writing and verifying.' });
          if (++toolTurns >= MAX_TOOL_TURNS) { onEvent({ type: 'max-turns', turns: toolTurns }); return conv; }
          continue;
        }
        return conv;
      }

      if (++toolTurns >= MAX_TOOL_TURNS) {
        onEvent({ type: 'max-turns', turns: toolTurns });
        return conv;
      }
    } catch (error) {
      if (opts?.signal?.aborted) return conv;
      const message = errorMessage(error).trim();
      if (withReasoning
        && !sawContentEvent
        && /thinking|reasoning|param|invalid|unsupported|不支持/i.test(message)) {
        reasoningFellBack = true;
        onEvent({ type: 'error', message: '当前模型接口不支持思考模式，已自动关闭本轮' });
        continue;
      }
      onEvent({ type: 'error', message });
      return conv;
    }
  }
}
