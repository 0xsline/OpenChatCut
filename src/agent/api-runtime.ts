import {
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { errorMessage } from './api-retry';
export {
  isCompatibleMediaFallbackError,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-retry';
import type { AgentContext } from './context';
import type { AgentModelChoice } from './model-selection';
import { TOOL_SCHEMAS } from './tools';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import type { AgentToolSchema } from './tool-schema';
import type { AgentRunRecorder } from './runtime-ledger';
import { ToolActivation } from './tool-activation';
import {
  harnessContextForModelRound,
  type HarnessToolExecutionContext,
} from './harness-context';
import { toolResultModelOutput } from './tool-result-output';
import {
  cacheTtlMsForProvider,
  getLanguageModel,
  getLanguageModelProviderOptions,
} from './client';
import { normalizeLlmMessages } from './messages';
import { loadAgentSettings, type AgentSettings } from './settings/agentSettings';
import { completeAbortedTurn } from './abortedTurn';
import { executeOpenChatCutTool, type CodexToolExecution } from './codex/runtime';
import { toolFailureReason, ToolFailureTracker } from './toolFailure';
import type {
  AgentEvent,
  LLMMessage,
  RunAgentOptions,
} from './runtime';
import { runApiRequestAttempt, type ApiAttemptOutcome } from './api-attempt';
import {
  ApiRoundOutput,
  prepareApiMessages,
  type PreparedApiMessages,
} from './api-round';

const MAX_TOOL_TURNS = 30;
export function apiToolExecutionOutput(execution: CodexToolExecution): unknown {
  if (!execution.success) throw new Error(toolFailureReason(execution.result));
  return execution.result;
}


function createAgentTools(
  schemas: readonly AgentToolSchema[],
  getActivation: () => ToolActivation,
  setActivation: (activation: ToolActivation) => void,
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  settings: AgentSettings,
  harness: HarnessToolExecutionContext,
  onFollowup?: (text: string) => void,
  runRecorder?: AgentRunRecorder,
): ToolSet {
  return Object.fromEntries(schemas.map((schema) => [
    schema.name,
    tool({
      description: schema.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
      ),
      execute: async (input, options) => {
        const execution = await executeOpenChatCutTool(schema, input ?? {}, {
          ctx,
          onEvent,
          settings,
          onFollowup,
          toolCatalog: getActivation().allSchemas(),
          activeToolCatalog: getActivation().schemas(),
          harness,
          runRecorder,
          toolCallId: options.toolCallId,
          signal: options.abortSignal,
        });
        const result = apiToolExecutionOutput(execution);
        if (schema.name !== 'ToolSearch' && schema.name !== 'load_skill') return result;
        const activated = getActivation().withToolResult(schema.name, result);
        setActivation(activated.activation);
        return activated.result;
      },
      toModelOutput: ({ output }) => toolResultModelOutput(output, schema.name === 'load_skill'),
    }),
  ]));
}

function responseUsedTools(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call'));
}

export interface ApiRuntimeDependencies {
  readonly model?: LanguageModel;
}

interface ApiRunnerInput {
  readonly messages: LLMMessage[];
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly choice: AgentModelChoice;
  readonly system: string;
  readonly contextWasCompacted: boolean;
  readonly maxOutputTokens: number;
  readonly opts?: RunAgentOptions;
  readonly dependencies: ApiRuntimeDependencies;
}


interface PreparedApiRound extends PreparedApiMessages {
  readonly model: LanguageModel;
  readonly tools: ToolSet;
  readonly toolSchemas: readonly AgentToolSchema[];
  readonly providerOptions?: ProviderOptions;
  readonly cacheTtlMs?: number;
}

class ApiAgentRunner {
  private conv: ModelMessage[];
  private activation: ToolActivation;
  private toolTurns = 0;
  private requestCount = 0;
  private compatibleMediaFallbackRequired = false;
  private requestContextWasCompacted: boolean;
  private readonly input: ApiRunnerInput;
  private readonly settings: AgentSettings;
  private readonly toolFailures: ToolFailureTracker;

  constructor(input: ApiRunnerInput) {
    this.input = input;
    this.conv = normalizeLlmMessages(input.messages);
    this.settings = loadAgentSettings();
    this.toolFailures = input.opts?.toolFailures ?? new ToolFailureTracker();
    this.requestContextWasCompacted = input.contextWasCompacted;
    const catalog = !input.choice.capabilities.supportsTools.value
      ? []
      : input.opts?.askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS;
    this.activation = input.opts?.toolActivation ?? new ToolActivation(catalog, this.conv);
  }

  private async prepareRound(output: ApiRoundOutput): Promise<PreparedApiRound> {
    const { ctx, onEvent, choice, opts, dependencies } = this.input;
    if (this.toolTurns > 0 && opts?.prepareContextForTools) {
      const prepared = await opts.prepareContextForTools(this.conv, this.activation.schemas());
      this.conv = normalizeLlmMessages(prepared.messages);
      this.requestContextWasCompacted ||= prepared.compacted;
    }
    const toolSchemas = this.activation.schemas();
    const messages = await prepareApiMessages(
      this.conv, choice, this.compatibleMediaFallbackRequired, opts?.signal,
    );
    const maxInput = choice.capabilities.maxInputTokens;
    const maxInputTokens = maxInput.estimated
      ? Math.max(1, choice.capabilities.contextWindowTokens.value - this.input.maxOutputTokens)
      : maxInput.value;
    const harness = harnessContextForModelRound({
      messages: messages.requestMessages,
      system: this.input.system,
      toolSchemas,
      contextWindowTokens: choice.capabilities.contextWindowTokens.value,
      maxInputTokens,
      maxOutputTokens: this.input.maxOutputTokens,
    });
    const tools = createAgentTools(
      toolSchemas,
      () => this.activation,
      (next) => { this.activation = next; },
      ctx,
      onEvent,
      this.settings,
      harness,

      output.markFollowup,
      opts?.runRecorder,
    );
    return {
      ...messages,
      tools,
      toolSchemas,
      providerOptions: getLanguageModelProviderOptions(
        choice.provider,
        choice.openAiApiMode,
        this.settings.cacheMode,
      ),
      cacheTtlMs: cacheTtlMsForProvider(choice.provider, this.settings.cacheMode),
      model: dependencies.model
        ?? await getLanguageModel(choice.provider, choice.model, choice.openAiApiMode),
    };
  }

  private completeAborted(outcome: ApiAttemptOutcome, output: ApiRoundOutput): LLMMessage[] {
    const responseMessages = outcome.responseMessages;
    output.flush();
    this.toolFailures.clear();
    const persisted = responseMessages.length || !output.visibleText
      ? responseMessages
      : [{ role: 'assistant', content: [{ type: 'text', text: output.visibleText }] } as ModelMessage];
    return completeAbortedTurn(this.conv, persisted);
  }

  private completeRound(outcome: ApiAttemptOutcome, output: ApiRoundOutput): LLMMessage[] | null {
    const unresolved = this.toolFailures.hasUnresolved;
    const responseMessages = outcome.responseMessages;
    output.flush();
    const usedTools = responseUsedTools(responseMessages);
    if (output.askedFollowup) {
      output.flushFollowup();
      return [...this.conv, ...responseMessages];
    }
    if (!usedTools) {
      // The model saw the failed tool result in its own context and replies
      // freely; no failure-report template is injected.
      if (unresolved) this.toolFailures.clear();
      return [...this.conv, ...responseMessages];
    }
    this.conv = [...this.conv, ...responseMessages];
    this.toolTurns += 1;
    if (this.toolTurns < MAX_TOOL_TURNS) return null;
    this.input.onEvent({ type: 'max-turns', turns: this.toolTurns });
    this.toolFailures.clear();
    return this.conv;
  }

  private failRound(error: unknown, output: ApiRoundOutput): LLMMessage[] {
    if (this.input.opts?.signal?.aborted) {
      this.toolFailures.clear();
      return this.conv;
    }
    this.toolFailures.clear();
    output.flush();
    this.input.onEvent({ type: 'error', message: errorMessage(error).trim() });
    return this.conv;
  }

  private async runRound(): Promise<LLMMessage[] | null> {
    const output = new ApiRoundOutput(this.input.onEvent);
    try {
      const prepared = await this.prepareRound(output);
      const requestIndex = this.requestCount + 1;
      this.requestCount = requestIndex;
      const outcome = await runApiRequestAttempt({
        ...prepared,
        messages: prepared.requestMessages,
        requestIndex,
        system: this.input.system,
        maxOutputTokens: this.input.maxOutputTokens,
        onContextUsage: async (usage) => {
          await this.input.opts?.recordProviderContextUsage?.(usage, prepared.toolSchemas);
        },
        signal: this.input.opts?.signal,
        choice: this.input.choice,
        contextWasCompacted: this.requestContextWasCompacted,
        onEvent: this.input.onEvent,
        onText: output.emitText,
        toolFailures: this.toolFailures,
      });
      this.compatibleMediaFallbackRequired ||= outcome.compatibleMediaFallbackRequired;
      return outcome.aborted || this.input.opts?.signal?.aborted
        ? this.completeAborted(outcome, output)
        : this.completeRound(outcome, output);
    } catch (error) {
      return this.failRound(error, output);
    }
  }

  async run(): Promise<LLMMessage[]> {
    for (;;) {
      const result = await this.runRound();
      if (result) return result;
    }
  }
}

/**
 * Browser-side API Agent loop. Server-side execution (serverRun) is the only
 * Agent run path since the server-only refactor; this loop has no runtime
 * consumer and is kept solely as a regression-test asset
 * (token-efficiency.verify exercises it against a live provider).
 */
export function runApiAgent(
  messages: LLMMessage[],
  ctx: AgentContext,
  onEvent: (event: AgentEvent) => void,
  choice: AgentModelChoice,
  system: string,
  contextWasCompacted: boolean,
  maxOutputTokens: number,
  opts?: RunAgentOptions,
  dependencies: ApiRuntimeDependencies = {},
): Promise<LLMMessage[]> {
  return new ApiAgentRunner({
    messages,
    ctx,
    onEvent,
    choice,
    system,
    contextWasCompacted,
    maxOutputTokens,
    opts,
    dependencies,
  }).run();
}
