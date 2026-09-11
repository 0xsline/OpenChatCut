import type { ModelMessage } from 'ai';
import type { AgentContext } from './context';
import type { AgentRunRecorder } from './runtime-ledger';
import type { HarnessToolExecutionContext } from './harness-context';
import type { AgentSettings } from './settings/agentSettings';
import { executeOpenChatCutTool, type CodexToolExecution } from './codex/runtime';
import {
  estimateTextTokens,
  verifyCanonicalContextCheckpoint,
  type AgentContextUsage,
} from './context-compaction';
import type { ToolFailureTracker } from './toolFailure';
import { ToolActivation } from './tool-activation';
import {
  loadAgentArtifact,
  loadAgentRuntimeSidecar,
  sha256Text,
} from '../persist/agentRuntimeStore';

export {
  apiToolExecutionOutput,
  isCompatibleMediaFallbackError,
  shouldRetryCompatibleMediaRequest,
  shouldRetryTransientAgentRequest,
  streamPartStartsCompatibleMediaOutput,
} from './api-runtime';
export type LLMMessage = ModelMessage;
export interface RuntimeContextUpdate {
  readonly messages: ModelMessage[];
  readonly compacted: boolean;
}
export type RuntimeContextPreparer = (
  messages: readonly ModelMessage[],
  tools: readonly unknown[],
) => Promise<RuntimeContextUpdate>;
export type ProviderContextUsageRecorder = (
  usage: AgentContextUsage,
  schemas: readonly unknown[],
) => Promise<void>;
export interface RunAgentOptions {
  readonly askOnly?: boolean;
  readonly signal?: AbortSignal;
  readonly previousContextUsage?: AgentContextUsage;
  readonly toolFailures?: ToolFailureTracker;
  /** Internal per-request registry state; callers normally leave this unset. */
  readonly toolActivation?: ToolActivation;
  readonly prepareContextForTools?: RuntimeContextPreparer;
  readonly recordProviderContextUsage?: ProviderContextUsageRecorder;
  readonly runRecorder?: AgentRunRecorder;
}

export type AgentEvent =
  | { type: 'text-start' }
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-input-start'; name: string }
  | { type: 'tool-input-delta'; delta: string }
  | { type: 'tool'; name: string; args: unknown; result: unknown }
  | { type: 'max-turns'; turns: number }
  | { type: 'context-usage'; usage: AgentContextUsage }
  | { type: 'error'; message: string };

export function initialMessages(): LLMMessage[] {
  return [];
}
export async function validateCheckpointHistory(
  messages: readonly ModelMessage[],
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) {
    await verifyCanonicalContextCheckpoint(messages, [], async () => null);
    return undefined;
  }
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  const marker = await verifyCanonicalContextCheckpoint(
    messages,
    sidecar.checkpoints,
    (sourceArtifactId) => loadAgentArtifact(projectId, sourceArtifactId),
  );
  return marker?.checkpointId;
}
export interface AgentRequestShapeInput {
  readonly system: string;
  readonly backend: string;
  readonly modelId: string;
  readonly schemas: readonly unknown[];
  readonly checkpointId?: string;
}
export async function computeAgentRequestShapeFingerprint(
  input: AgentRequestShapeInput,
): Promise<{
  requestShapeHash: string;
  systemTokens: number;
  toolSchemaChars: number;
  systemDigest: string;
  toolSchemaDigest: string;
}> {
  const schemaText = JSON.stringify(input.schemas);
  const systemTokens = estimateTextTokens(input.system);
  const shape = {
    backend: input.backend,
    modelId: input.modelId,
    systemTokens,
    systemDigest: await sha256Text(input.system),
    toolNames: input.schemas.map((schema) => (
      schema && typeof schema === 'object' && 'name' in schema ? String(schema.name) : ''
    )),
    toolSchemaChars: schemaText.length,
    toolSchemaDigest: await sha256Text(schemaText),
    checkpointId: input.checkpointId,
  };
  return {
    requestShapeHash: await sha256Text(JSON.stringify(shape)),
    systemTokens,
    toolSchemaChars: schemaText.length,
    systemDigest: shape.systemDigest,
    toolSchemaDigest: shape.toolSchemaDigest,
  };
}
export interface CodexToolRequest {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly activation: ToolActivation;
  readonly ctx: AgentContext;
  readonly onEvent: (event: AgentEvent) => void;
  readonly settings: AgentSettings;
  readonly runRecorder?: AgentRunRecorder;
  readonly toolCallId?: string;
  readonly signal?: AbortSignal;
  readonly harness?: HarnessToolExecutionContext;
  readonly onFollowup?: (text: string) => void;
}

export async function executeCodexTool(request: CodexToolRequest): Promise<{
  readonly activation: ToolActivation;
  readonly execution: CodexToolExecution;
}> {
  const {
    name, args, activation, ctx, onEvent, settings, runRecorder,
    toolCallId, signal, harness, onFollowup,
  } = request;
  const schema = activation.allSchemas().find((candidate) => candidate.name === name);
  if (!schema) {
    return {
      activation,
      execution: { success: false, result: { error: `Unknown Codex tool: ${name}` } },
    };
  }
  // A model may remember a tool it used earlier in the conversation even though
  // the current request did not activate it. Activation is a token optimization,
  // not a security boundary — canonical membership above already gates the call.
  const admitted = activation.admit(name);
  const execution = await executeOpenChatCutTool(schema, args, {
    ctx,
    onEvent,
    settings,
    toolCatalog: admitted.allSchemas(),
    activeToolCatalog: admitted.schemas(),
    harness,
    runRecorder,
    toolCallId,
    signal,
    onFollowup,
  });
  if ((name !== 'ToolSearch' && name !== 'load_skill') || !execution.success) {
    return { activation: admitted, execution };
  }
  const activated = admitted.withToolResult(name, execution.result);
  return {
    activation: activated.activation,
    execution: {
      ...execution,
      result: activated.result,
      refreshTools: activated.activation.names().length > admitted.names().length,
    },
  };
}


