import type { ModelMessage } from 'ai';
import type { AgentReference } from './context';
import { TOOL_SCHEMAS } from './tools';
import { ASK_MODE_TOOL_SCHEMAS } from './ask-mode-tools';
import { ToolActivation } from './tool-activation';
import type { AgentToolSchema } from './tool-schema';
import type { AgentCacheMode } from './settings/agentSettings';


import type { AgentSend, AgentSendOptions } from './useAgentRun';
import type { AnyAction } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import type { DisplayMessage, PendingGuard } from './agent-session';
import type { AgentRunRecorder } from './runtime-ledger';

export interface ServerRunStart {
  readonly runId: string;
  readonly text: string;
  readonly content: string;
  readonly askOnly: boolean;
  readonly references: readonly AgentReference[];
  readonly recorder: AgentRunRecorder;
  readonly baseDoc: ProjectDoc;
  readonly resumed: boolean;
}
export type ServerRunPreparation = Omit<ServerRunStart, 'recorder' | 'resumed'>;


export interface ServerRunToolAction {
  readonly runId: string;
  readonly toolCallId: string;
  readonly argsDigest: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: string;
  readonly actions: AnyAction[];
  readonly baseDoc: ProjectDoc;
}

export interface ServerRunRecovery {
  readonly tools: readonly Pick<
    ServerRunToolAction,
    'toolCallId' | 'argsDigest' | 'name' | 'result' | 'error'
  >[];
  readonly baseDoc?: ProjectDoc;
  readonly draftDoc?: ProjectDoc;
}

export interface ServerRunTerminal {
  readonly runId: string;
  readonly status: 'awaiting_user' | 'completed' | 'failed' | 'cancelled';
  readonly assistantText: string;
  readonly recorder: AgentRunRecorder | null;
}
export type ServerRunTerminalDisposition = 'finalized' | 'waiting_approval';
export interface ServerRunTerminalHandoff {
  readonly disposition: ServerRunTerminalDisposition;
  readonly afterModelCommit: () => void | Promise<void>;
  readonly onAbandon?: () => void | Promise<void>;
}
export type ServerRunTerminalResolution =
  | ServerRunTerminalDisposition
  | ServerRunTerminalHandoff;



export interface ServerRunSession {
  readonly hydrated: boolean;
  readonly messages: DisplayMessage[];
  readonly updateMessages: (update: (messages: DisplayMessage[]) => DisplayMessage[]) => void;
  readonly modelMessages: () => readonly ModelMessage[];
  readonly commitModelTurn: (
    runId: string,
    modelHistoryLength: number,
    userContent: string,
    assistantText: string,
  ) => Promise<void>;
}

export interface ServerRunOptions {
  readonly enabled: boolean;
  readonly session?: ServerRunSession;
  readonly onRunPrepare?: (input: ServerRunPreparation) => void | Promise<void>;
  readonly onRunAbandon?: (runId: string) => void | Promise<void>;
  readonly onRunStart?: (
    start: ServerRunStart,
  ) => ServerRunRecovery | void | Promise<ServerRunRecovery | void>;
  readonly onToolAction?: (action: ServerRunToolAction) => void | Promise<void>;
  readonly onTerminal?: (
    terminal: ServerRunTerminal,
  ) => ServerRunTerminalResolution | false | Promise<ServerRunTerminalResolution | false>;
}

export interface ServerRunController {
  readonly send: AgentSend;
  readonly messages: DisplayMessage[];
  readonly running: boolean;
  readonly pendingGuard: PendingGuard | null;
  readonly confirmGuard: (allow: boolean) => void;
  readonly stop: () => void;
}

export interface ServerRunPayload {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly AgentToolSchema[];
  readonly askOnly: boolean;
  readonly references: readonly AgentReference[];
  readonly systemPrompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly cacheMode: AgentCacheMode;
  readonly maxOutputTokens: number;
  readonly externalSessionId?: string;
  readonly openAiApiMode?: string;
}

interface ServerRunTransportContext {
  readonly history?: readonly ModelMessage[];
  readonly systemPrompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly cacheMode: AgentCacheMode;
  readonly maxOutputTokens: number;
  readonly openAiApiMode?: string;
  readonly externalSessionId?: string;
}
function createServerRunIdentity(): Pick<ServerRunPayload, 'runId' | 'capability'> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const capability = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return { runId: crypto.randomUUID(), capability };
}
const MAX_SERVER_RUN_BODY_BYTES = 960 * 1024;
const MAX_SERVER_RUN_HISTORY_MESSAGES = 63;
const MAX_SERVER_RUN_HISTORY_MESSAGE_CHARS = 32_000;
const utf8Encoder = new TextEncoder();

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content.trim();
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap((part) => (
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
        ? [part.text]
        : []
    ))
    .join('\n')
    .trim();
}

function projectedHistory(history: readonly ModelMessage[]): ModelMessage[] {
  return history.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content = messageText(message).slice(0, MAX_SERVER_RUN_HISTORY_MESSAGE_CHARS);
    return content ? [{ role: message.role, content } as ModelMessage] : [];
  }).slice(-MAX_SERVER_RUN_HISTORY_MESSAGES);
}

function payloadByteLength(value: unknown): number {
  return utf8Encoder.encode(JSON.stringify(value)).byteLength;
}

function budgetedHistory(
  payloadWithoutHistory: ServerRunPayload,
  history: readonly ModelMessage[],
): ModelMessage[] {
  const selected: ModelMessage[] = [];
  let payloadBytes = payloadByteLength(payloadWithoutHistory);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    const addedBytes = payloadByteLength(message) + 1;
    if (payloadBytes + addedBytes > MAX_SERVER_RUN_BODY_BYTES) break;
    selected.unshift(message);
    payloadBytes += addedBytes;
  }
  const firstUser = selected.findIndex((message) => message.role === 'user');
  return firstUser < 0 ? [] : selected.slice(firstUser);
}

export function buildServerRunPayload(
  projectId: string,
  text: string,
  options: AgentSendOptions,
  transport: ServerRunTransportContext,
): ServerRunPayload {
  const askOnly = options.askOnly === true;
  const history = projectedHistory(transport.history ?? []);
  const currentMessage = { role: 'user', content: text.trim() } as ModelMessage;
  const activationMessages = [...history, currentMessage];
  const catalog = askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS;
  const payloadWithoutHistory: ServerRunPayload = {
    ...createServerRunIdentity(),
    projectId,
    messages: [currentMessage],
    tools: new ToolActivation(catalog, activationMessages).schemas(),
    askOnly,
    references: [...(options.references ?? [])],
    ...(transport.systemPrompt ? { systemPrompt: transport.systemPrompt } : {}),
    ...(transport.provider ? { provider: transport.provider } : {}),
    ...(transport.model ? { model: transport.model } : {}),
    cacheMode: transport.cacheMode,
    maxOutputTokens: transport.maxOutputTokens,
    ...(transport.openAiApiMode ? { openAiApiMode: transport.openAiApiMode } : {}),
    ...(transport.externalSessionId
      ? { externalSessionId: transport.externalSessionId }
      : {}),
  };
  const retainedHistory = budgetedHistory(payloadWithoutHistory, history);
  return {
    ...payloadWithoutHistory,
    messages: [...retainedHistory, currentMessage],
  };
}

export function restoreServerRunToolActivation(
  askOnly: boolean,
  activeToolNames: unknown,
): ToolActivation | null {
  if (!Array.isArray(activeToolNames)
    || !activeToolNames.every((name) => typeof name === 'string')) return null;
  const catalog = askOnly ? ASK_MODE_TOOL_SCHEMAS : TOOL_SCHEMAS;
  const selected = new Set(activeToolNames);
  const canonicalNames = catalog
    .filter((schema) => selected.has(schema.name))
    .map((schema) => schema.name);
  if (canonicalNames.length !== activeToolNames.length
    || canonicalNames.some((name, index) => name !== activeToolNames[index])) return null;
  const activation = new ToolActivation(
    catalog,
    [],
    canonicalNames,
    canonicalNames.includes('ToolSearch'),
  );
  const restoredNames = activation.names();
  return restoredNames.length === canonicalNames.length
    && restoredNames.every((name, index) => name === canonicalNames[index])
    ? activation
    : null;
}

export function serverRunShouldResume(
  enabled: boolean,
  storedProjectId: string | undefined,
  currentProjectId: string,
): boolean {
  return enabled && storedProjectId === currentProjectId;
}

export const SERVER_RUN_CAPABILITY_HEADER = 'X-OpenChatCut-Run-Capability';

export interface CreatedServerRunResponse {
  readonly id: string;
  readonly capability: string;
}

export interface ServerRunMetadata {
  readonly status?: 'created' | 'running' | 'awaiting-confirmation'
    | 'awaiting-user' | 'completed' | 'failed' | 'cancelled';
  readonly firstEventId?: number;
  readonly lastEventId?: number;
}
export function recoveredServerRunTerminal(
  metadata: ServerRunMetadata,
  cursor: number,
): ServerRunTerminal['status'] | null {
  if (typeof metadata.lastEventId !== 'number' || cursor < metadata.lastEventId) return null;
  if (metadata.status === 'awaiting-user') return 'awaiting_user';
  return metadata.status === 'completed'
    || metadata.status === 'failed'
    || metadata.status === 'cancelled'
    ? metadata.status
    : null;
}


export async function loadServerRunMetadata(
  projectId: string,
  runId: string,
  capability: string,
): Promise<ServerRunMetadata> {
  const response = await fetch(
    `/api/agent-runs/${runId}?projectId=${encodeURIComponent(projectId)}`,
    {
      cache: 'no-store',
      headers: { [SERVER_RUN_CAPABILITY_HEADER]: capability },
    },
  );
  if (!response.ok) {
    throw new Error(`server run metadata failed: HTTP ${response.status}`);
  }
  return response.json() as Promise<ServerRunMetadata>;
}

export async function requestServerRunStart(
  projectId: string,
  runId: string,
  capability: string,
): Promise<void> {
  const response = await fetch(`/api/agent-runs/${runId}/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SERVER_RUN_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw new Error(`server run start failed: HTTP ${response.status}`);
}

export async function requestServerRunCancellation(
  projectId: string,
  runId: string,
  capability: string,
): Promise<ServerRunTerminal['status']> {
  const response = await fetch(`/api/agent-runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [SERVER_RUN_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const value = await response.json() as { status?: unknown };
  if (value.status === 'awaiting-user') return 'awaiting_user';
  if (value.status !== 'completed'
    && value.status !== 'failed'
    && value.status !== 'cancelled') {
    throw new Error('server run cancellation returned an invalid status');
  }
  return value.status;
}
