import type { AgentContext } from './context';
import { resolveAgentReferences } from './context';
import type { ProjectDoc } from '../editor/types';
import { TOOL_SCHEMAS } from './tools';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import { ToolActivation } from './tool-activation';
import type { AgentSettings } from './settings/agentSettings';
import { buildAgentSystemPrompt } from './systemPrompt';
import { getActiveAgentModelChoice } from './model-selection';
import { describeImagesForTextModel } from './vision';
import { resolveVisionModel } from './visionConfig';
import { effectiveOutputTokenBudget } from './context-compaction';
import type { AgentSendOptions } from './useAgentRun';
import { createAgentRetry, type DisplayMessage } from './agent-session';
import { resumeAgentRun, type AgentRunRecorder } from './runtime-ledger';
import { ServerRunToolExecutor } from './serverRunToolExecutor';
import {
  buildServerRunPayload,
  loadServerRunMetadata,
  requestServerRunCancellation,
  requestServerRunStart,
  type CreatedServerRunResponse,
  type ServerRunOptions,
  type ServerRunPayload,
  type ServerRunRecovery,
} from './serverRunProtocol';
import {
  isPermanentServerRunRecoveryError,
  recoveredToolMap,
  shouldRetryPendingServerRunAdmission,
} from './serverRunRecovery';
import {
  clearStoredServerRun,
  patchStoredServerRun,
  saveStoredServerRun,
  type StoredServerRun,
} from './serverRunSessionStorage';
import {
  acquireServerRunOwnership,
  releaseServerRunOwnership,
} from './serverRunOwnership';

interface MutableRef<T> {
  current: T;
}

export interface ServerRunSendEnvironment {
  readonly projectId: string;
  readonly refs: {
    readonly enabled: MutableRef<boolean>;
    readonly ready: MutableRef<boolean>;
    readonly running: MutableRef<boolean>;
    readonly context: MutableRef<AgentContext>;
    readonly settings: MutableRef<AgentSettings>;
    readonly options: MutableRef<ServerRunOptions>;
    readonly abort: MutableRef<AbortController | null>;
    readonly runId: MutableRef<string | null>;
    readonly capability: MutableRef<string | null>;
    readonly cursor: MutableRef<number>;
    readonly runProject: MutableRef<string | null>;
    readonly recorder: MutableRef<AgentRunRecorder | null>;
    readonly terminalRun: MutableRef<string | null>;
    readonly staleRecoveryRun: MutableRef<string | null>;
    readonly assistantText: MutableRef<string>;
  };
  readonly setRunning: (running: boolean) => void;
  readonly updateMessages: (
    update: (messages: DisplayMessage[]) => DisplayMessage[],
  ) => void;
  readonly appendMessage: (message: DisplayMessage) => void;
  readonly toolExecutor: ServerRunToolExecutor;
  readonly subscribe: (runId: string) => void;
  readonly finishRun: (
    runId: string,
    status: 'awaiting_user' | 'completed' | 'failed' | 'cancelled',
  ) => Promise<void>;
  readonly scheduleRecovery: (runId: string) => void;
  readonly scheduleAdmissionRecovery: (recover: () => void) => void;
  readonly abandonStaleRecovery: (runId: string, error: unknown) => void;
}

type ServerRunTransientRefs = Pick<
  ServerRunSendEnvironment['refs'],
  'abort' | 'assistantText' | 'cursor' | 'staleRecoveryRun' | 'terminalRun'
>;

export function prepareServerRunTransport(
  refs: ServerRunTransientRefs,
  abort: AbortController,
): void {
  refs.terminalRun.current = null;
  refs.staleRecoveryRun.current = null;
  refs.cursor.current = 0;
  refs.assistantText.current = '';
  refs.abort.current = abort;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('Server run request aborted.');
}

interface PreparedServerRun {
  readonly payload: ServerRunPayload;
  readonly trimmed: string;
  readonly content: string;
  readonly baseDoc: ProjectDoc;
  readonly modelHistoryLength: number;
  readonly options: ServerRunOptions;
  readonly sendOptions: AgentSendOptions;
}
interface ActiveServerRun extends PreparedServerRun {
  readonly abort: AbortController;
  readonly storedCreation: StoredServerRun;
  admission: 'not-attempted' | 'uncertain' | 'accepted' | 'rejected';
}

async function prepareServerRunPayload(
  environment: ServerRunSendEnvironment,
  text: string,
  sendOptions: AgentSendOptions,
): Promise<PreparedServerRun | null> {
  const refs = environment.refs;
  const trimmed = text.trim();
  if (!refs.enabled.current
    || !refs.ready.current
    || !trimmed
    || refs.running.current) return null;
  const choice = getActiveAgentModelChoice();
  if (!choice || (choice.backend !== 'api' && choice.backend !== 'codex')) {
    environment.appendMessage({ role: 'error', text: '服务端运行仅支持已配置的 API / Codex 模型。' });
    return null;
  }
  const settings = refs.settings.current;
  const ctx = refs.context.current;
  const options = refs.options.current;
  const entries = resolveAgentReferences(ctx, sendOptions.references ?? []);
  const content = entries.length
    ? `${trimmed}\n\n${JSON.stringify({ type: 'chat_context_entry', entries })}`
    : trimmed;
  let modelMessages = options.session?.modelMessages() ?? [];
  // Vision pass-through for server-run: when the active main model is text-only
  // and a custom vision model is configured, describe image attachments in the
  // history to text before submitting, so the server receives them as usable
  // context instead of dropping them. A vision-capable main model keeps the
  // raw image parts (projectedHistory carries them through) so it can see the
  // actual pixels instead of a lossy description.
  const supportsImages = choice.capabilities.supportsImages.value;
  const vision = resolveVisionModel(choice);
  if (!supportsImages && vision) {
    modelMessages = await describeImagesForTextModel(modelMessages, vision);
  }
  const payload = buildServerRunPayload(environment.projectId, content, sendOptions, {
    history: modelMessages,
    systemPrompt: buildAgentSystemPrompt(ctx, settings),
    provider: choice.provider,
    model: choice.model,
    backend: choice.backend,
    cacheMode: settings.cacheMode,
    maxOutputTokens: effectiveOutputTokenBudget(
      choice.capabilities.maxOutputTokens.value,
      choice.capabilities.contextWindowTokens.value,
    ),
    openAiApiMode: choice.openAiApiMode,
  });
  return {
    payload,
    trimmed,
    content,
    baseDoc: ctx.getDoc(),
    options,
    sendOptions,
    modelHistoryLength: modelMessages.length,
  };
}

function storedServerRunFor(
  environment: ServerRunSendEnvironment,
  prepared: PreparedServerRun,
): StoredServerRun {
  const { payload } = prepared;
  return {
    projectId: environment.projectId,
    runId: payload.runId,
    capability: payload.capability,
    createdAt: Date.now(),
    admissionPending: true,
    text: prepared.trimmed,
    content: prepared.content,
    askOnly: payload.askOnly,
    modelHistoryLength: prepared.modelHistoryLength,
    activeToolNames: payload.tools.map((schema) => schema.name),
    references: payload.references,
    cursor: 0,
    assistantText: '',
    attempts: [],
  };
}

function setupLocalServerRun(
  environment: ServerRunSendEnvironment,
  prepared: PreparedServerRun,
): ActiveServerRun {
  const { trimmed, sendOptions } = prepared;
  const abort = new AbortController();
  environment.refs.running.current = true;
  environment.setRunning(true);
  prepareServerRunTransport(environment.refs, abort);
  environment.updateMessages((current) => [
    ...current,
    { role: 'user', text: trimmed, retry: createAgentRetry(trimmed, sendOptions) },
    { role: 'assistant', text: '' },
  ]);
  return {
    ...prepared,
    abort,
    storedCreation: storedServerRunFor(environment, prepared),
    admission: 'not-attempted',
  };
}

function persistLocalServerRun(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): void {
  if (!saveStoredServerRun(environment.projectId, active.storedCreation)) {
    throw new Error('Browser durable storage is unavailable.');
  }
  environment.refs.runId.current = active.payload.runId;
  environment.refs.capability.current = active.payload.capability;
  environment.refs.runProject.current = environment.projectId;
}

function isDefiniteAdmissionRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

async function submitServerRun(active: ActiveServerRun): Promise<void> {
  active.admission = 'uncertain';
  const response = await fetch('/api/agent-runs/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(active.payload),
    signal: active.abort.signal,
  });
  if (!response.ok) {
    if (isDefiniteAdmissionRejection(response.status)) active.admission = 'rejected';
    throw new Error(`agent run failed: HTTP ${response.status}`);
  }
  const value = await response.json() as CreatedServerRunResponse;
  if (value.id !== active.payload.runId
    || value.capability !== active.payload.capability) {
    throw new Error('Server run identity did not match the submitted request.');
  }
  active.admission = 'accepted';
}

async function admitServerRun(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): Promise<void> {
  const { payload, abort, options } = active;
  throwIfAborted(abort.signal);
  const recorder = await resumeAgentRun(environment.projectId, payload.runId);
  if (!recorder) throw new Error('Server run recorder ownership could not be claimed.');
  throwIfAborted(abort.signal);
  environment.refs.recorder.current = recorder;
  await options.onRunPrepare?.({
    runId: payload.runId,
    text: active.trimmed,
    content: active.content,
    askOnly: payload.askOnly,
    references: payload.references,
    baseDoc: active.baseDoc,
  });
  throwIfAborted(abort.signal);
  await requestServerRunStart(environment.projectId, payload.runId, payload.capability);
  throwIfAborted(abort.signal);
  if (!patchStoredServerRun(environment.projectId, {
    admissionPending: false,
    leaseToken: recorder.recoveryLeaseToken(),
  })) throw new Error('Browser durable storage is unavailable.');
  throwIfAborted(abort.signal);
  const recovery = await options.onRunStart?.({
    runId: payload.runId,
    text: active.trimmed,
    content: active.content,
    askOnly: payload.askOnly,
    references: payload.references,
    recorder,
    baseDoc: active.baseDoc,
    resumed: false,
  });
  throwIfAborted(abort.signal);
  activateServerRunTools(environment, active, recorder, recovery);
}

function activateServerRunTools(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
  recorder: AgentRunRecorder,
  recovery: ServerRunRecovery | void,
): void {
  const { payload, abort } = active;
  environment.toolExecutor.start({
    capability: payload.capability,
    baseDoc: recovery?.baseDoc ?? active.baseDoc,
    draftDoc: recovery?.draftDoc,
    activation: new ToolActivation(
      payload.askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS,
      payload.messages,
      payload.tools.map((schema) => schema.name),
    ),
    recorder,
    abort,
    recovered: recoveredToolMap(recovery?.tools ?? []),
  });
  environment.subscribe(payload.runId);
}

function ownsServerRun(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): boolean {
  return environment.refs.runId.current === active.payload.runId
    && environment.refs.runProject.current === environment.projectId;
}

async function settleAcceptedFailure(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
  ownsRun: boolean,
): Promise<void> {
  const { payload } = active;
  try {
    const status = await requestServerRunCancellation(
      environment.projectId,
      payload.runId,
      payload.capability,
    );
    if (!ownsRun) return;
    if (status === 'cancelled') await environment.finishRun(payload.runId, status);
    else environment.subscribe(payload.runId);
  } catch (cancelError) {
    if (!ownsRun) return;
    if (isPermanentServerRunRecoveryError(cancelError)) {
      environment.abandonStaleRecovery(payload.runId, cancelError);
    } else {
      environment.scheduleRecovery(payload.runId);
    }
  }
}

function surfaceAdmissionFailure(
  environment: ServerRunSendEnvironment,
  message: string,
): void {
  environment.updateMessages((current) => {
    const last = current.at(-1);
    const retained = last?.role === 'assistant' && !last.text
      ? current.slice(0, -1)
      : current;
    return [...retained, { role: 'error', text: message }];
  });
}

function settleUnacceptedFailure(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
  ownsRun: boolean,
): void {
  releaseServerRunOwnership(environment.projectId, active.payload.runId);
  clearStoredServerRun(environment.projectId, active.payload.runId);
  if (!ownsRun) return;
  environment.refs.recorder.current = null;
  environment.refs.runId.current = null;
  environment.refs.capability.current = null;
  environment.refs.runProject.current = null;
  environment.refs.abort.current = null;
  environment.refs.running.current = false;
  environment.setRunning(false);
}
function retryUncertainAdmission(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): void {
  environment.scheduleAdmissionRecovery(() => { void recoverUncertainAdmission(environment, active); });
}

async function confirmUncertainAdmission(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): Promise<boolean> {
  try {
    await loadServerRunMetadata(
      environment.projectId,
      active.payload.runId,
      active.payload.capability,
    );
    return true;
  } catch (error) {
    if (!ownsServerRun(environment, active)) return false;
    if (shouldRetryPendingServerRunAdmission(active.storedCreation, error)
      || !isPermanentServerRunRecoveryError(error)) {
      retryUncertainAdmission(environment, active);
    } else {
      if (!active.abort.signal.aborted) {
        surfaceAdmissionFailure(
          environment,
          `服务端任务未能启动：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      settleUnacceptedFailure(environment, active, true);
    }
    return false;
  }
}

async function recoverUncertainAdmission(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
): Promise<void> {
  if (!ownsServerRun(environment, active)) return;
  if (active.abort.signal.aborted) {
    if (!await confirmUncertainAdmission(environment, active)) return;
    active.admission = 'accepted';
    await settleAcceptedFailure(environment, active, true);
    return;
  }
  try {
    await submitServerRun(active);
  } catch (error) {
    if (active.admission === 'rejected') {
      await settleServerRunFailure(environment, active, error, 'rejected');
      return;
    }
    if (!await confirmUncertainAdmission(environment, active)) return;
  }
  active.admission = 'accepted';
  try {
    await admitServerRun(environment, active);
  } catch (error) {
    await settleServerRunFailure(environment, active, error, 'accepted');
  }
}

function settleUncertainAdmission(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
  ownsRun: boolean,
): void {
  if (!ownsRun) return;
  environment.refs.recorder.current = null;
  environment.scheduleAdmissionRecovery(() => { void recoverUncertainAdmission(environment, active); });
}


async function settleServerRunFailure(
  environment: ServerRunSendEnvironment,
  active: ActiveServerRun,
  error: unknown,
  admission: ActiveServerRun['admission'],
): Promise<void> {
  const ownsRun = ownsServerRun(environment, active);
  if (!active.abort.signal.aborted && admission !== 'uncertain') {
    const message = error instanceof Error ? error.message : String(error);
    if (admission === 'accepted') environment.appendMessage({ role: 'error', text: message });
    else surfaceAdmissionFailure(environment, message);
  }
  if (admission === 'accepted') {
    await settleAcceptedFailure(environment, active, ownsRun);
    return;
  }
  if (admission === 'uncertain') {
    settleUncertainAdmission(environment, active, ownsRun);
    return;
  }
  settleUnacceptedFailure(environment, active, ownsRun);
}

export async function sendServerRun(
  environment: ServerRunSendEnvironment,
  text: string,
  sendOptions: AgentSendOptions = {},
): Promise<void> {
  const prepared = await prepareServerRunPayload(environment, text, sendOptions);
  if (!prepared) return;
  if (!await acquireServerRunOwnership(environment.projectId, prepared.payload.runId)) {
    environment.appendMessage({
      role: 'error',
      text: '服务端任务已由另一个页面接管，本页不会重复执行。',
    });
    return;
  }
  const active = setupLocalServerRun(environment, prepared);
  try {
    persistLocalServerRun(environment, active);
    await submitServerRun(active);
    await admitServerRun(environment, active);
  } catch (error) {
    await settleServerRunFailure(environment, active, error, active.admission);
  }
}
