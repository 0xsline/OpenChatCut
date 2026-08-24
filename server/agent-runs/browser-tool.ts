import { jsonSchema, tool } from 'ai';
import { policyForTool } from '../../src/agent/execution-policy';
import { ToolActivation } from '../../src/agent/tool-activation';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import { toolResultModelOutput } from '../../src/agent/tool-result-output';
import {
  isFailedToolResult,
  toolFailureReason,
  ToolFailureTracker,
} from '../../src/agent/toolFailure';
import { toolExecutionMode } from '../../src/agent/tools/execution-modes';
import { recordAcceptedTool, type AcceptanceLoopState } from './acceptance-loop';
import { assertCanonicalToolInvocation } from './tool-policy';
import {
  digestToolArgs,
  pushRunEvent,
  waitForToolResult,
  type ServerRun,
} from './store';

export interface ActivationState {
  current: ToolActivation;
  tail: Promise<void>;
  followupText: string | null;
  toolFailures: ToolFailureTracker;
  acceptance: AcceptanceLoopState;
  repeatGuardNote?: string;
  lastSuccessfulPureTool?: { name: string; argsDigest: string; result: unknown };
}

function cacheablePureTool(name: string): boolean {
  return name === 'analyze_music';
}

function recordTool(activation: ActivationState, schema: AgentToolSchema, args: Record<string, unknown>): void {
  activation.acceptance = recordAcceptedTool(
    activation.acceptance,
    policyForTool(schema.name, args).effect,
  );
}

export async function executeBrowserTool(
  run: ServerRun,
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  toolCallId: string,
  activation: ActivationState,
): Promise<unknown> {
  const parallel = toolExecutionMode(schema.name) === 'parallel';
  let release: (() => void) | undefined;
  if (!parallel) {
    const previous = activation.tail;
    const { promise: next, resolve } = Promise.withResolvers<void>();
    activation.tail = next;
    release = resolve;
    await previous;
  }
  try {
    activation.current = activation.current.admit(schema.name);
    assertCanonicalToolInvocation(schema, args, activation.current.schemas());
    const argsDigest = digestToolArgs(args);
    const cached = activation.lastSuccessfulPureTool;
    if (cacheablePureTool(schema.name)
      && cached?.name === schema.name
      && cached.argsDigest === argsDigest) {
      activation.repeatGuardNote = `Reused the adjacent successful ${schema.name} result; skipped duplicate browser execution.`;
      const shaped = activation.current.withToolResult(schema.name, cached.result);
      activation.current = shaped.activation;
      recordTool(activation, schema, args);
      return shaped.result;
    }
    activation.repeatGuardNote = undefined;
    activation.lastSuccessfulPureTool = undefined;
    pushRunEvent(run, 'tool-request', { toolCallId, name: schema.name, args, argsDigest });
    const delivered = await waitForToolResult(run, toolCallId, schema.name, argsDigest);
    const followup = delivered && typeof delivered === 'object'
      && '__followup' in delivered && typeof delivered.__followup === 'string'
      ? delivered.__followup
      : null;
    if (followup) activation.followupText = followup;
    const shaped = activation.current.withToolResult(schema.name, delivered);
    activation.current = shaped.activation;
    if (isFailedToolResult(shaped.result)) throw new Error(toolFailureReason(shaped.result));
    activation.toolFailures.record(schema.name, { success: true, result: shaped.result });
    if (!followup) recordTool(activation, schema, args);
    if (cacheablePureTool(schema.name)) {
      activation.lastSuccessfulPureTool = { name: schema.name, argsDigest, result: shaped.result };
    }
    return shaped.result;
  } catch (error) {
    activation.toolFailures.record(schema.name, { success: false, result: error });
    throw error;
  } finally {
    release?.();
  }
}

export function createServerTools(
  run: ServerRun,
  schemas: readonly AgentToolSchema[],
  activation: ActivationState,
) {
  return Object.fromEntries(schemas.map((schema) => [schema.name, tool({
    description: schema.description,
    inputSchema: jsonSchema<Record<string, unknown>>(
      schema.input_schema as Parameters<typeof jsonSchema<Record<string, unknown>>>[0],
    ),
    execute: (args: Record<string, unknown>, options: { toolCallId: string }) => (
      executeBrowserTool(run, schema, args, options.toolCallId, activation)
    ),
    toModelOutput: ({ output }) => toolResultModelOutput(output, schema.name === 'load_skill'),
  })]));
}
