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
import type { DisplayMessage, LiveTool, PendingGuard } from './agent-session';
import type { AgentContextUsage } from './context-compaction';
import type { GuardDecision } from './skills/costGuard';
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
  readonly liveTool: LiveTool | null;
  readonly contextUsage: AgentContextUsage | null;
  readonly pendingGuard: PendingGuard | null;
  readonly confirmGuard: (decision: GuardDecision) => void;
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
// Base64 budget for visual parts (user-pasted image attachments / rendered
// frames) carried through the server-run payload. Text stays within its own
// char budget; images share one byte budget so a few frames fit but the whole
// body cannot blow past MAX_SERVER_RUN_BODY_BYTES.
const MAX_SERVER_RUN_PROJECTED_IMAGE_BYTES = 512 * 1024;
const utf8Encoder = new TextEncoder();

interface ProjectedPart {
  readonly type: 'text' | 'file';
  readonly text?: string;
  readonly rawBase64?: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

function serializeImagePart(part: { image: string | { data: string; mediaType?: string }; mediaType?: string }): { base64: string; mediaType: string } {
  const source = typeof part.image === 'string'
    ? part.image
    : (part.image as { data?: string })?.data ?? '';
  const mediaType = typeof part.image === 'object'
      && 'mediaType' in part.image && typeof part.image.mediaType === 'string'
    ? part.image.mediaType
    : part.mediaType ?? 'image/jpeg';
  if (source.startsWith('data:')) {
    const comma = source.indexOf(',');
    if (comma >= 0) {
      const head = source.slice(5, comma);
      const slash = head.indexOf('/');
      const semi = head.indexOf(';');
      const inferred = semi > 0 ? head.slice(0, semi) : (slash > 0 ? `image/${head.slice(slash + 1)}` : mediaType);
      return { base64: source.slice(comma + 1), mediaType: inferred || mediaType };
    }
    return { base64: source, mediaType };
  }
  return { base64: source, mediaType };
}

function serializeFilePart(part: { data: string | { data?: string }; mediaType?: string; filename?: string }): { base64: string; mediaType: string; filename?: string } {
  const data = typeof part.data === 'string' ? part.data : part.data?.data ?? '';
  return {
    base64: data,
    mediaType: part.mediaType ?? 'application/octet-stream',
    ...(typeof part.filename === 'string' ? { filename: part.filename } : {}),
  };
}

function toProjectedParts(message: ModelMessage): ProjectedPart[] {
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  if (!Array.isArray(message.content)) return [];
  const parts: ProjectedPart[] = [];
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      const { base64, mediaType } = serializeImagePart(part as never);
      parts.push({ type: 'file', rawBase64: base64, mediaType, filename: 'attachment.jpg' });
    } else if (part.type === 'file' && part.mediaType?.toLowerCase().startsWith('image/')) {
      const { base64, mediaType, filename } = serializeFilePart(part as never);
      parts.push({ type: 'file', rawBase64: base64, mediaType, filename: filename ?? 'attachment' });
    }
  }
  return parts;
}

/**
 * Project run history into a serializable ModelMessage[] for the server-side
 * executor. Keeps each user/assistant message's text (bounded) plus its image /
 * image-file attachments (base64, bounded by one shared byte budget) so visual
 * input is passed through instead of dropped. Non-visual non-text parts are
 * dropped; the array is capped at MAX_SERVER_RUN_HISTORY_MESSAGES.
 */
export function projectedHistory(history: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let imageBudget = MAX_SERVER_RUN_PROJECTED_IMAGE_BYTES;
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let textLen = 0;
    let text = '';
    const fileParts: Array<{ data: string; mediaType: string; filename?: string }> = [];
    for (const part of toProjectedParts(message)) {
      if (part.type === 'text' && part.text) {
        text += part.text;
        textLen += part.text.length;
      } else if (part.type === 'file' && part.rawBase64 && imageBudget > 0) {
        const base64 = part.rawBase64.slice(0, imageBudget);
        imageBudget = Math.max(0, imageBudget - part.rawBase64.length);
        if (base64) fileParts.push({
          data: base64,
          mediaType: part.mediaType ?? 'image/jpeg',
          ...(part.filename ? { filename: part.filename } : {}),
        });
      }
    }
    let content: ModelMessage['content'];
    if (!fileParts.length) {
      const trimmed = text.slice(0, MAX_SERVER_RUN_HISTORY_MESSAGE_CHARS).trim();
      if (!trimmed) continue;
      content = trimmed;
    } else {
      const parts: unknown[] = [];
      const trimmed = text.slice(0, MAX_SERVER_RUN_HISTORY_MESSAGE_CHARS).trim();
      if (trimmed) parts.push({ type: 'text', text: trimmed });
      for (const file of fileParts) {
        parts.push({ type: 'file', data: { type: 'data', data: file.data }, mediaType: file.mediaType, ...(file.filename ? { filename: file.filename } : {}) });
      }
      content = parts as ModelMessage['content'];
    }
    out.push({ role: message.role, content } as ModelMessage);
  }
  return out.slice(-MAX_SERVER_RUN_HISTORY_MESSAGES);
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
