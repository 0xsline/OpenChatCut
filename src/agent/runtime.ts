import {
  UnsupportedFunctionalityError,
  jsonSchema,
  streamText,
  tool,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { AgentContext } from './context';
import type { CodexAgentToolSpec } from '../../shared/codex-agent';
import { TOOL_SCHEMAS } from './tools';
import { SYSTEM_PROMPT, agentLanguagePrompt, assembleSystemPrompt, creativeModePrompt, designStylePrompt, editorStatePrompt } from './systemPrompt';
import { capabilitiesPrompt } from './capabilities';
import { findSkill } from './skills/skills-catalog';
import { PLUGIN_SKILLS_INDEX } from './skills/plugin-skills';
import { getLocale } from '../i18n/locale';
import {
  getLanguageModel,
  getLanguageModelProviderOptions,
  protocolForProvider,
  PROVIDER,
  OPENAI_API_MODE,
} from './client';
import {
  makeMessagesPortable,
  normalizeLlmMessages,
  prepareChatCompletionsMediaMessages,
} from './messages';
import {
  agentSettingsPrompt,
  createInlineThinkingExtractor,
  generationSkillForTool,
  loadAgentSettings,
  type AgentSettings,
  type GenerationGuardSkill,
} from './settings/agentSettings';
import type { GuardDecision } from './skills/skillGuard';
import { completeAbortedTurn } from './abortedTurn';
import { resolveTrackedJobForProject } from '../persist/jobRegistryStore';
import { getActiveAgentModelChoice } from './model-selection';
import { executeOpenChatCutTool, runCodexAgent } from './codex/runtime';
const MAX_OUTPUT_TOKENS = 64000;
const MAX_TOOL_TURNS = 30;
type ToolResultOutput = ToolResultPart['output'];
export type LLMMessage = ModelMessage;
export interface AgentRuntimeModule {
  runAgent: typeof runAgent;
}
export interface RunAgentOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>;
}

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

export interface RuntimeGuardRequest {
  skill: GenerationGuardSkill;
  /** Actual provider/export tool whose execution is being confirmed. */
  tool: string;
  requestedTool?: string;
  operationId?: string;
  summary?: string;
}

function summarizeGuardArgs(toolName: string, args: Record<string, unknown>): string {
  const keys = ['provider', 'model', 'mode', 'durationSeconds', 'resolution', 'ratio', 'name'] as const;
  const details = keys.flatMap((key) => args[key] === undefined ? [] : [`${key}=${String(args[key])}`]);
  if (typeof args.prompt === 'string' && args.prompt.trim()) {
    const prompt = args.prompt.trim();
    details.push(`prompt=${JSON.stringify(prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt)}`);
  }
  return [toolName, ...details].join(' · ');
}

/** Resolve reruns before confirmation so the card names the original operation and args. */
export async function runtimeGuardForTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<RuntimeGuardRequest | null> {
  const defaultSkill = generationSkillForTool(toolName);
  if (!defaultSkill) return null;
  if (toolName !== 'rerun_generation') {
    return { skill: defaultSkill, tool: toolName, summary: summarizeGuardArgs(toolName, args) };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) throw new Error('rerun_generation requires a persisted project id');
  const resolution = await resolveTrackedJobForProject(projectId, String(args.jobId ?? ''));
  if (!resolution.ok) throw new Error(resolution.message);
  const original = resolution.job;
  if (original.submitArgsVersion !== 1 || !original.submitArgs || !original.toolName) {
    throw new Error(`generation operation ${original.operationId} is a legacy summary-only snapshot and cannot be rerun safely`);
  }
  return {
    skill: generationSkillForTool(original.toolName) ?? 'high-cost-operation',
    tool: original.toolName,
    requestedTool: toolName,
    operationId: original.operationId,
    summary: summarizeGuardArgs(original.toolName, original.submitArgs),
  };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as Error & { statusCode?: number; status?: number }).statusCode
    ?? (error as Error & { status?: number }).status;
  return status != null && !error.message.startsWith(String(status))
    ? `${status} ${error.message}`
    : error.message;
}

export interface CompatibleMediaRetryContext {
  protocol: string;
  movedMedia: boolean;
  retryAttempted: boolean;
  outputStarted: boolean;
  aborted: boolean;
  error: unknown;
}

export function isCompatibleMediaFallbackError(error: unknown): boolean {
  if (error == null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const shaped = error as { name?: unknown; statusCode?: unknown; status?: unknown };
  if (shaped.name === 'AbortError') return false;
  if (UnsupportedFunctionalityError.isInstance(error)) return true;
  return shaped.statusCode === 400 || shaped.status === 400;
}

export function shouldRetryCompatibleMediaRequest({
  protocol,
  movedMedia,
  retryAttempted,
  outputStarted,
  aborted,
  error,
}: CompatibleMediaRetryContext): boolean {
  return protocol === 'openai-compatible'
    && movedMedia
    && !retryAttempted
    && !outputStarted
    && !aborted
    && isCompatibleMediaFallbackError(error);
}

export interface TransientAgentRetryContext {
  retryAttempted: boolean;
  outputStarted: boolean;
  aborted: boolean;
  error: unknown;
}

function isTransientAgentRequestError(error: unknown): boolean {
  if (error == null || (typeof error !== 'object' && typeof error !== 'function')) return false;
  const shaped = error as {
    name?: unknown;
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    cause?: unknown;
    message?: unknown;
    isRetryable?: unknown;
  };
  const cause = shaped.cause && typeof shaped.cause === 'object'
    ? shaped.cause as {
      name?: unknown;
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
      isRetryable?: unknown;
    }
    : null;
  if (shaped.name === 'AbortError' || cause?.name === 'AbortError') return false;
  const status = shaped.statusCode ?? shaped.status ?? cause?.statusCode ?? cause?.status;
  if (status === 502 || status === 503 || status === 504) return true;
  if (status != null) return false;
  if (shaped.isRetryable === true || cause?.isRetryable === true) return true;

  const signal = [shaped.code, shaped.message, cause?.code, cause?.message].map(String).join(' ');
  if (/\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)\b|upstream request failed/i.test(signal)) {
    return true;
  }
  const browserNetworkFailure = /^(?:failed to fetch|fetch failed|load failed|networkerror(?: when attempting to fetch resource\.?)?)$/i;
  return [shaped, cause].some((candidate) => (
    candidate?.name === 'TypeError'
    && browserNetworkFailure.test(String(candidate.message ?? '').trim())
  ));
}

export function shouldRetryTransientAgentRequest({
  retryAttempted,
  outputStarted,
  aborted,
  error,
}: TransientAgentRetryContext): boolean {
  return !retryAttempted
    && !outputStarted
    && !aborted
    && isTransientAgentRequestError(error);
}

export function streamPartStartsCompatibleMediaOutput(type: string): boolean {
  return type === 'text-start'
    || type === 'text-delta'
    || type === 'text-end'
    || type === 'reasoning-start'
    || type === 'reasoning-delta'
    || type === 'reasoning-end'
    || type === 'reasoning-file'
    || type === 'file'
    || type === 'source'
    || type === 'custom'
    || type === 'tool-input-start'
    || type === 'tool-input-delta'
    || type === 'tool-input-end'
    || type === 'tool-call'
    || type === 'tool-result'
    || type === 'tool-error'
    || type === 'tool-output-denied'
    || type === 'tool-approval-request'
    || type === 'tool-approval-response';
}

type SynchronousStart<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

function captureSynchronousStart<T>(start: () => T): SynchronousStart<T> {
  try {
    return { ok: true, value: start() };
  } catch (error) {
    return { ok: false, error };
  }
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
  settings: AgentSettings,
  onSkillGuard?: (info: RuntimeGuardRequest) => Promise<GuardDecision>,
  onFollowup?: () => void,
): ToolSet {
  return Object.fromEntries(TOOL_SCHEMAS.map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
      ),
      execute: async (input) => (
        await executeOpenChatCutTool(schema, input ?? {}, {
          ctx,
          onEvent,
          settings,
          resolveGuard: runtimeGuardForTool,
          onSkillGuard,
          onFollowup,
        })
      ).result,
      toModelOutput: ({ output }) => toolModelOutput(output),
    }),
  ]));
}

function responseUsedTools(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call'));
}
const CODEX_TOOL_SPECS: readonly CodexAgentToolSpec[] = TOOL_SCHEMAS.map((schema) => ({
  name: schema.name,
  description: schema.description,
  inputSchema: schema.input_schema,
}));

async function runCodexBackend(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  model: string,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const settings = loadAgentSettings();
  const tools = opts?.askOnly ? [] : CODEX_TOOL_SPECS;
  return runCodexAgent(messages, ctx, onEvent, {
    askOnly: opts?.askOnly,
    signal: opts?.signal,
    model,
    tools,
    executeTool: async (name, args) => {
      const schema = TOOL_SCHEMAS.find((candidate) => candidate.name === name);
      if (!schema) return { success: false, result: { error: `Unknown Codex tool: ${name}` } };
      return executeOpenChatCutTool(schema, args, {
        ctx,
        onEvent,
        settings,
        resolveGuard: runtimeGuardForTool,
        onSkillGuard: opts?.onSkillGuard,
      });
    },
  });
}

export async function runAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  const active = getActiveAgentModelChoice();
  if (active?.backend === 'codex') {
    return runCodexBackend(messages, ctx, onEvent, active.model, opts);
  }
  return runApiAgent(messages, ctx, onEvent, opts);
}

async function runApiAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  opts?: RunAgentOptions,
): Promise<LLMMessage[]> {
  let conv = normalizeLlmMessages(messages);
  const settings = loadAgentSettings();
  const system = assembleSystemPrompt([
    SYSTEM_PROMPT,
    agentLanguagePrompt(getLocale()),
    capabilitiesPrompt(),
    PLUGIN_SKILLS_INDEX,
    agentSettingsPrompt(settings),
    designStylePrompt(ctx.getDoc().designStyle),
    creativeModePrompt(findSkill(ctx.getCreativeMode())),
  ], editorStatePrompt(ctx));

  let toolTurns = 0;
  let compatibleMediaFallbackRequired = false;

  for (;;) {
    const extract = createInlineThinkingExtractor();
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
        );

    try {
      // Responses relays do not consistently persist `rs_*` item IDs. Keep
      // OpenAI turns stateless by replaying portable local history and asking
      // the provider not to store the response.
      // Compatible Chat providers keep vendor history intact and move only
      // tool-result media into a supported user attachment message. A provider
      // that rejects the attachment before producing output gets one text-only
      // retry; the original conversation and tool instances stay unchanged.
      const protocol = protocolForProvider(PROVIDER);
      const mediaPreparation = protocol === 'openai-compatible'
        ? prepareChatCompletionsMediaMessages(conv)
        : null;
      let requestCarriesMedia =
        (mediaPreparation?.movedMedia ?? false) && !compatibleMediaFallbackRequired;
      let requestMessages = protocol === 'openai'
        ? makeMessagesPortable(conv, OPENAI_API_MODE)
        : mediaPreparation
          ? compatibleMediaFallbackRequired
            ? mediaPreparation.messagesWithoutMedia
            : mediaPreparation.messages
          : conv;
      const providerOptions = getLanguageModelProviderOptions();
      const model = await getLanguageModel();
      let retriedWithoutMedia = false;
      let retriedTransientRequest = false;
      let aborted = false;
      let responseMessages: ModelMessage[] = [];

      requestAttempt:
      for (;;) {
        let outputStarted = false;
        const started = captureSynchronousStart(() => streamText({
          model,
          system,
          messages: requestMessages,
          tools,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: opts?.signal,
          ...(providerOptions ? { providerOptions } : {}),
        }));
        if (!started.ok) {
          if (opts?.signal?.aborted) {
            aborted = true;
            break requestAttempt;
          }
          if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error: started.error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          }
          if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error: started.error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          }
          throw started.error;
        }
        const result = started.value;

        try {
          for await (const part of result.stream) {
            if (streamPartStartsCompatibleMediaOutput(part.type)) outputStarted = true;
            if (part.type === 'text-delta') {
              const extracted = extract.push(part.text);
              if (extracted.thinking) onEvent({ type: 'thinking-delta', delta: extracted.thinking });
              if (extracted.text) emitText(extracted.text);
            } else if (part.type === 'reasoning-delta') {
              if (part.text) onEvent({ type: 'thinking-delta', delta: part.text });
            } else if (part.type === 'tool-input-start') {
              onEvent({ type: 'tool-input-start', name: part.toolName });
            } else if (part.type === 'tool-input-delta') {
              if (part.delta) onEvent({ type: 'tool-input-delta', delta: part.delta });
            } else if (part.type === 'error') {
              throw part.error;
            } else if (part.type === 'abort') {
              aborted = true;
              break;
            }
          }
        } catch (error) {
          if (opts?.signal?.aborted) {
            aborted = true;
          } else if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          } else if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          } else {
            throw error;
          }
        }

        const tail = extract.flush();
        if (tail.thinking) onEvent({ type: 'thinking-delta', delta: tail.thinking });
        if (tail.text) emitText(tail.text);

        try {
          responseMessages = await result.responseMessages;
        } catch (error) {
          if (aborted || opts?.signal?.aborted) {
            responseMessages = [];
          } else if (shouldRetryCompatibleMediaRequest({
            protocol,
            movedMedia: requestCarriesMedia,
            retryAttempted: retriedWithoutMedia,
            outputStarted,
            aborted,
            error,
          })) {
            requestMessages = mediaPreparation!.messagesWithoutMedia;
            requestCarriesMedia = false;
            retriedWithoutMedia = true;
            compatibleMediaFallbackRequired = true;
            continue requestAttempt;
          } else if (shouldRetryTransientAgentRequest({
            retryAttempted: retriedTransientRequest,
            outputStarted,
            aborted,
            error,
          })) {
            retriedTransientRequest = true;
            continue requestAttempt;
          } else {
            throw error;
          }
        }
        break requestAttempt;
      }

      if (aborted || opts?.signal?.aborted) {
        const persisted = responseMessages.length || !visibleText
          ? responseMessages
          : [{ role: 'assistant', content: [{ type: 'text', text: visibleText }] } as ModelMessage];
        return completeAbortedTurn(conv, persisted);
      }
      conv = [...conv, ...responseMessages];
      if (askedFollowup) return conv;
      if (!responseUsedTools(responseMessages)) return conv;

      if (++toolTurns >= MAX_TOOL_TURNS) {
        onEvent({ type: 'max-turns', turns: toolTurns });
        return conv;
      }
    } catch (error) {
      if (opts?.signal?.aborted) return conv;
      const message = errorMessage(error).trim();
      onEvent({ type: 'error', message });
      return conv;
    }
  }
}
