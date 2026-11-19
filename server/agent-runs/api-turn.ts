import { streamText, type LanguageModelUsage, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai';
import { estimateContextTokens, estimateTextTokens, type ContextPreparation } from '../../src/agent/context-compaction';
import { createServerTools, type ActivationState } from './browser-tool';
import { prepareServerContext, SERVER_RUN_AI_TIMEOUT, type ServerContextInput } from './context';
import { serverProviderOptions } from './model';
import { collectServerText } from './executor-events';
import { pushRunEvent, recordServerContextUsage } from './store';
import { classifyLlmFailure } from './llm-retry';
import type { ServerRunTurnRecoverySink, ServerSubprocessResume } from './run-recovery-contract';
import { RunRecoveryFault, asRecoveryFault, isRunRecoveryFault } from './run-recovery-fault';
import { createSubprocessToolDispatcher } from './subprocess-tool-dispatch';
import { answerUnexecutedToolCalls } from './unexecuted-tool-calls';

export type ServerApiTurnInput = Omit<ServerContextInput, 'schemas'> & {
  readonly activation: ActivationState;
  readonly requestIndex: number;
  readonly recovery?: ServerRunTurnRecoverySink;
  readonly resumeFrom?: ServerSubprocessResume;
  /** Silent overflow-recovery stage: shrinks the request after a provider rejection. */
  readonly overflowStage?: 'reduced-output';
};

function measuredContextUsage(
  prepared: ContextPreparation,
  total: LanguageModelUsage,
  text: string,
  requestIndex: number,
): ContextPreparation['usage'] {
  return {
    ...prepared.usage,
    inputTokens: total.inputTokens ?? prepared.usage.inputTokens,
    outputTokens: total.outputTokens ?? estimateTextTokens(text),
    reasoningTokens: total.outputTokenDetails.reasoningTokens,
    noCacheInputTokens: total.inputTokenDetails.noCacheTokens,
    cacheReadTokens: total.inputTokenDetails.cacheReadTokens,
    cacheWriteTokens: total.inputTokenDetails.cacheWriteTokens,
    requestIndex,
    attemptIndex: 0,
  };
}

export async function executeServerApiTurn(
  input: ServerApiTurnInput,
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  let toolBoundarySeen = false;
  const recordBoundary = () => { toolBoundarySeen = true; };
  const guardOverflowAfterTools = (error: unknown) => {
    if (input.recovery && toolBoundarySeen && classifyLlmFailure(error).code === 'CONTEXT_WINDOW_EXCEEDED') {
      throw Object.assign(new RunRecoveryFault('outcome-unknown', 'API context overflow after tool execution requires reconciliation.'), { cause: error });
    }
  };
  try {
    return await runServerTurnOnce(input, recordBoundary);
  } catch (error) {
    guardOverflowAfterTools(error);
    // A context overflow means the estimate undershot the real tokenizer.
    // Recover silently in escalating stages before surfacing anything:
    // 1) compress history (forceCompact), 2) shrink the output reservation,
    // 3) shrink both output and the active tool surface. Each stage only
    // changes the request; the user never sees an intermediate failure.
    // Deterministic retries for other failures live in llm-retry.ts.
    if (toolBoundarySeen
      || input.signal.aborted
      || input.forceCompact
      || input.resumeFrom
      || isRunRecoveryFault(error)
      || classifyLlmFailure(error).code !== 'CONTEXT_WINDOW_EXCEEDED') {
      throw error;
    }
    pushRunEvent(input.run, 'context-overflow-retry', { requestIndex: input.requestIndex });
    try {
      return await runServerTurnOnce({ ...input, forceCompact: true }, recordBoundary);
    } catch (retryError) {
      guardOverflowAfterTools(retryError);
      if (toolBoundarySeen || input.signal.aborted || classifyLlmFailure(retryError).code !== 'CONTEXT_WINDOW_EXCEEDED') {
        throw retryError;
      }
      pushRunEvent(input.run, 'context-overflow-retry', { requestIndex: input.requestIndex, stage: 'reduced-output' });
      return runServerTurnOnce({ ...input, forceCompact: true, overflowStage: 'reduced-output' }, recordBoundary);
    }
  }
}

async function runServerTurnOnce(
  input: ServerApiTurnInput,
  onToolBoundary: () => void,
): Promise<{
  messages: ModelMessage[];
  text: string;
  continued: boolean;
  followupText: string | null;
  hitMaxTokens: boolean;
}> {
  const resume = input.recovery ? input.resumeFrom : undefined;
  if (input.signal.aborted) throw input.signal.reason ?? new Error('API request cancelled.');
  if (resume && resume.messages === undefined) {
    throw new RunRecoveryFault('outcome-unknown', 'API recovery requires the original structured messages.');
  }
  const catalog = input.activation.current.allSchemas();
  const schemas = resume?.toolNames
    ? resume.toolNames.map((name) => {
      const schema = catalog.find((candidate) => candidate.name === name);
      if (!schema) throw new RunRecoveryFault('outcome-unknown', 'API tool catalog changed since the interrupted request.');
      return schema;
    })
    : input.activation.current.schemas();
  const instructions = resume?.instructions ?? input.instructions;
  // SDK messages may contain provider reasoning signatures and multimodal
  // parts. A partial response cannot supply a valid assistant/tool round, so
  // replay the original valid request and reuse confirmed tool dispatches.
  const prepared = resume ? {
    messages: [...resume.messages!],
    usage: {
      inputTokens: estimateContextTokens(resume.messages!, instructions, estimateTextTokens(JSON.stringify(schemas))),
      contextWindowTokens: input.contextWindowTokens,
      contextWindowEstimated: input.contextWindowEstimated,
      isEstimated: true, modelId: input.run.model, compacted: false,
      messageCount: resume.messages!.length,
      systemTokens: estimateTextTokens(instructions),
      historyTokens: estimateContextTokens(resume.messages!),
      toolSchemaTokens: estimateTextTokens(JSON.stringify(schemas)),
      toolCount: schemas.length, requestIndex: input.requestIndex, attemptIndex: 0,
    },
  } : await prepareServerContext({ ...input, schemas });
  const maxOutputTokens = resume?.requestOptions?.maxOutputTokens ?? (input.overflowStage === 'reduced-output'
    ? Math.max(4_096, Math.floor(input.maxOutputTokens / 4))
    : input.maxOutputTokens);
  if (input.recovery) {
    try {
      await input.recovery.beginRequest({
        requestIndex: resume?.requestIndex ?? input.requestIndex,
        instructions, messages: prepared.messages,
        // Structured messages are the sole API replay authority.
        prompt: '',
        toolNames: schemas.map((schema) => schema.name),
        requestOptions: { maxOutputTokens },
      });
    } catch (error) { throw asRecoveryFault(error); }
  }
  const controller = new AbortController();
  const stopped = Promise.withResolvers<never>();
  let open = true;
  const dispatch = createSubprocessToolDispatcher({ ...input, signal: controller.signal }, schemas, undefined, { structuredReplay: true, onToolBoundary });
  const stop = (error: unknown) => {
    if (!open) return;
    open = false;
    dispatch.close();
    controller.abort(error);
    stopped.reject(error);
  };
  const relayAbort = () => stop(input.signal.reason ?? new Error('API request cancelled.'));
  input.signal.addEventListener('abort', relayAbort, { once: true });
  const tools = createServerTools(schemas, async (name, args, callId) => {
    try {
      // Some providers restart their call ID sequence each round. The SDK
      // keeps the provider ID in the transcript; browser authority is run-wide.
      const transportId = input.recovery ? `api-${input.requestIndex}:${callId}` : callId;
      return await dispatch.executeTool({ callId: transportId, name, args });
    } catch (error) {
      // SDK tool-error parts are ordinary model evidence. A durable boundary
      // failure must abort the provider instead of being returned that way.
      if (isRunRecoveryFault(error)) stop(error);
      throw error;
    }
  });
  const options = serverProviderOptions(input.provider, input.apiMode, input.cacheMode);
  let outcome: Awaited<ReturnType<typeof runProvider>> | undefined;
  let failure: unknown = null;
  async function runProvider() {
    if (!open) throw controller.signal.reason;
    pushRunEvent(input.run, 'text-start', {});
    const result = streamText({
      model: input.model, instructions, messages: prepared.messages, tools,
      ...(options ? { providerOptions: options } : {}),
      maxOutputTokens, maxRetries: 0,
      abortSignal: controller.signal, timeout: SERVER_RUN_AI_TIMEOUT,
    });
    const completed = Promise.all([result.toolCalls, result.responseMessages, result.usage, result.finishReason]);
    // A stream error can win before these deferred SDK promises settle.
    void completed.catch(() => undefined);
    const text = await collectServerText(input.run, guardedStream(result.fullStream, controller.signal, () => {
      if (input.recovery && dispatch.hasUnconfirmedTools) {
        const error = new RunRecoveryFault('outcome-unknown', 'API stream ended with an unconfirmed browser operation.');
        stop(error);
        throw error;
      }
    }));
    const [toolCalls, responseMessages, totalUsage, finishReason] = await completed;
    if (dispatch.hasUnmatchedWrites) {
      throw new RunRecoveryFault('outcome-unknown', 'The replay omitted a confirmed edit; the operation needs reconciliation.');
    }
    recordServerContextUsage(input.run, measuredContextUsage(prepared, totalUsage, text, input.requestIndex), schemas.length, JSON.stringify(schemas).length);
    const continued = !input.activation.repeatGuardNote && (
      toolCalls.length > 0 || responseMessages.some((message) => message.role === 'tool')
    );
    return {
      // Preserve the SDK's own complete messages, including providerOptions.
      messages: [...prepared.messages, ...answerUnexecutedToolCalls(responseMessages, finishReason)],
      text, followupText: input.activation.followupText,
      continued, hitMaxTokens: finishReason === 'length',
    };
  }
  try {
    if (input.signal.aborted) relayAbort();
    outcome = await Promise.race([stopped.promise, runProvider()]);
  } catch (error) {
    failure = error;
  } finally {
    open = false;
    input.signal.removeEventListener('abort', relayAbort);
    dispatch.close();
    if (!controller.signal.aborted) controller.abort(new Error('API request closed.'));
  }
  if (dispatch.fault) failure = dispatch.fault;
  if (input.recovery && dispatch.hasUnconfirmedTools && !isRunRecoveryFault(failure)) {
    failure = Object.assign(new RunRecoveryFault('outcome-unknown', 'API request closed with an unconfirmed browser operation.'), { cause: failure });
  }
  if (failure) throw failure;
  return outcome!;
}

/** Stop consuming even if an old provider ignores its AbortSignal. */
async function* guardedStream<TOOLS extends ToolSet>(
  source: AsyncIterable<TextStreamPart<TOOLS>>,
  signal: AbortSignal,
  beforeEnd: () => void,
): AsyncIterable<TextStreamPart<TOOLS>> {
  const iterator = source[Symbol.asyncIterator]();
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(signal.reason ?? new Error('API stream cancelled.'));
  signal.addEventListener('abort', abort, { once: true });
  void stopped.promise.catch(() => undefined);
  try {
    if (signal.aborted) abort();
    while (true) {
      const next = await Promise.race([stopped.promise, iterator.next()]);
      if (signal.aborted) throw signal.reason;
      if (next.done) { beforeEnd(); return; }
      if (next.value.type === 'error') beforeEnd();
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined);
  }
}
