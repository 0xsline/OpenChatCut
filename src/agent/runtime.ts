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
import { SYSTEM_PROMPT, designStylePrompt, creativeModePrompt, editorStatePrompt } from './systemPrompt';
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
import {
  agentSettingsPrompt,
  createInlineThinkingExtractor,
  generationSkillForTool,
  loadAgentSettings,
  type GenerationGuardSkill,
} from './settings/agentSettings';
import type { GuardDecision } from './skills/skillGuard';

const MAX_OUTPUT_TOKENS = 64000;
const MAX_TOOL_TURNS = 30;
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
  | { type: 'error'; message: string };

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
          const result = await executeTool(schema.name, args, ctx);
          onEvent({ type: 'tool', name: schema.name, args, result });
          const followup = (result as { __followup?: unknown } | null)?.__followup;
          if (typeof followup === 'string') {
            onEvent({ type: 'text-start' });
            onEvent({ type: 'text-delta', delta: followup });
            onFollowup?.();
          }
          return result;
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
  const conv = normalizeLlmMessages(messages);
  const settings = loadAgentSettings();
  const system = SYSTEM_PROMPT
    + editorStatePrompt(ctx)
    + capabilitiesPrompt()
    + designStylePrompt(ctx.getDoc().designStyle)
    + creativeModePrompt(findSkill(ctx.getCreativeMode()))
    + PLUGIN_SKILLS_INDEX
    + agentSettingsPrompt(settings);

  let reasoningFellBack = false;
  let toolTurns = 0;

  for (;;) {
    const withReasoning = settings.thinkingEnabled && !reasoningFellBack;
    const extract = createInlineThinkingExtractor();
    let sawContentEvent = false;
    let textStarted = false;
    let askedFollowup = false;
    const emitText = (delta: string) => {
      if (!textStarted) {
        onEvent({ type: 'text-start' });
        textStarted = true;
      }
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
        );

    try {
      // Responses relays do not consistently persist `rs_*` item IDs. Keep
      // OpenAI turns stateless by replaying portable local history and asking
      // the provider not to store the response.
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
          return conv;
        }
      }

      const tail = extract.flush();
      if (tail.thinking) onEvent({ type: 'thinking-delta', delta: tail.thinking });
      if (tail.text) emitText(tail.text);

      const responseMessages = await result.responseMessages;
      conv.push(...responseMessages);
      if (askedFollowup) return conv;
      if (!responseUsedTools(responseMessages)) return conv;

      if (++toolTurns >= MAX_TOOL_TURNS) {
        onEvent({ type: 'max-turns', turns: toolTurns });
        return conv;
      }
    } catch (error) {
      if (opts?.signal?.aborted) return conv;
      const message = errorMessage(error).trim();
      if (withReasoning
        && !sawContentEvent
        && /thinking|reasoning|param|invalid|unsupported|Not supported/i.test(message)) {
        reasoningFellBack = true;
        onEvent({ type: 'error', message: 'The current model interface does not support thinking mode and has automatically closed this round.' });
        continue;
      }
      onEvent({ type: 'error', message });
      return conv;
    }
  }
}
