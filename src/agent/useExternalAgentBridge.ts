import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentContext } from './context';
import {
  ExternalBridgeRuntime,
  type ExternalBridgeBinding,
  type ExternalProposalSnapshot,
} from './external-bridge-runtime';
import {
  ExternalEditSessionOutcomeError,
  type ExternalEditSessionTerminalStatus,
} from './external-edit-session';
import { ExternalCallCancellationRegistry } from './external-call-cancellation';
import { externalToolSchemas } from './external-tool-schemas';
import type { Proposal } from './proposal';
import { loadExternalProposal } from '../persist/externalProposalStore';

export interface ExternalCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  binding: ExternalBridgeBinding;
}
interface ExternalCallRuntime {
  execute: ExternalBridgeRuntime['execute'];
}

export type ExternalResultSender = (
  id: string,
  outcome: ExternalEditSessionTerminalStatus,
  value: unknown,
  signal: AbortSignal,
) => Promise<void>;

interface ExternalCancellation {
  id: string;
  outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>;
  message: string;
}
export interface ExternalBridgeReadinessToken {
  projectId: string;
  editorInstanceId: string;
  runtimeIdentity: object;
}

interface ExternalBridgeRuntimeSlot extends ExternalBridgeReadinessToken {
  runtime: ExternalBridgeRuntime;
}
interface ExternalBridgeHydrator {
  hydrate: ExternalBridgeRuntime['hydrate'];
}

export function externalBridgeReadinessMatches(
  readiness: ExternalBridgeReadinessToken,
  slot: ExternalBridgeReadinessToken,
  projectId: string,
): boolean {
  return readiness.projectId === projectId
    && slot.projectId === projectId
    && readiness.editorInstanceId === slot.editorInstanceId
    && readiness.runtimeIdentity === slot.runtimeIdentity;
}

export interface ExternalProposalController {
  proposal: Proposal | null;
  proposalStale: boolean;
  error: string | null;
  applyProposal: (selected: Set<number>) => void;
  forceApplyProposal: (selected: Set<number>) => void;
  rejectProposal: () => void;
}

const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function isFailureOutcome(
  value: unknown,
): value is Exclude<ExternalEditSessionTerminalStatus, 'applied'> {
  return value === 'rejected'
    || value === 'cancelled'
    || value === 'stale'
    || value === 'failed';
}

function parseExternalCall(value: unknown): ExternalCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid external editor call');
  }
  if (
    !('id' in value)
    || typeof value.id !== 'string'
    || !('name' in value)
    || typeof value.name !== 'string'
    || !('arguments' in value)
    || !value.arguments
    || typeof value.arguments !== 'object'
    || Array.isArray(value.arguments)
    || !('binding' in value)
    || !value.binding
    || typeof value.binding !== 'object'
    || Array.isArray(value.binding)
    || !('projectId' in value.binding)
    || typeof value.binding.projectId !== 'string'
    || !('editorInstanceId' in value.binding)
    || typeof value.binding.editorInstanceId !== 'string'
    || !('baseRevision' in value.binding)
    || typeof value.binding.baseRevision !== 'string'
  ) {
    throw new Error('invalid external editor call');
  }
  const args = value.arguments as Record<string, unknown>;
  return {
    id: value.id,
    name: value.name,
    arguments: args,
    binding: {
      projectId: value.binding.projectId,
      editorInstanceId: value.binding.editorInstanceId,
      baseRevision: value.binding.baseRevision,
    },
  };
}

function parseCancellation(value: unknown): ExternalCancellation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid external editor cancellation');
  }
  if (
    !('id' in value)
    || typeof value.id !== 'string'
    || !('outcome' in value)
    || !isFailureOutcome(value.outcome)
    || !('message' in value)
    || typeof value.message !== 'string'
  ) {
    throw new Error('invalid external editor cancellation');
  }
  return { id: value.id, outcome: value.outcome, message: value.message };
}

async function sendResult(
  id: string,
  outcome: ExternalEditSessionTerminalStatus,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/external-agent/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, outcome, value }),
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`result failed: HTTP ${response.status}`);
  }
}

function failedOutcome(
  error: unknown,
  signal: AbortSignal,
): {
  outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>;
  message: string;
} {
  if (error instanceof ExternalEditSessionOutcomeError) {
    return { outcome: error.outcome, message: error.message };
  }
  return {
    outcome: signal.aborted ? 'cancelled' : 'failed',
    message: errorMessage(error),
  };
}

export async function executeExternalCall(
  call: ExternalCall,
  runtime: ExternalCallRuntime,
  bridgeSignal: AbortSignal,
  cancellations: ExternalCallCancellationRegistry,
  deliverResult: ExternalResultSender = sendResult,
): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(bridgeSignal.reason);
  if (bridgeSignal.aborted) controller.abort(bridgeSignal.reason);
  else bridgeSignal.addEventListener('abort', cancel, { once: true });
  cancellations.register(call.id, controller);
  let outcome: ExternalEditSessionTerminalStatus = 'applied';
  let value: unknown;
  try {
    try {
      value = await runtime.execute(call.name, call.arguments, call.binding, controller.signal);
    } catch (error) {
      const failed = failedOutcome(error, controller.signal);
      outcome = failed.outcome;
      value = failed.message;
    }
    await deliverResult(call.id, outcome, value, bridgeSignal);
  } finally {
    cancellations.release(call.id);
    bridgeSignal.removeEventListener('abort', cancel);
  }
}

async function pollEditor(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  cancellations: ExternalCallCancellationRegistry,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const binding = runtime.binding();
    const query = new URLSearchParams({
      projectId,
      editorId: binding.editorInstanceId,
      baseRevision: binding.baseRevision,
    });
    const response = await fetch(`/api/external-agent/poll?${query}`, { signal });
    if (response.status === 204) continue;
    if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
    await executeExternalCall(parseExternalCall(await response.json()), runtime, signal, cancellations);
  }
}

async function pollCancellations(
  projectId: string,
  editorInstanceId: string,
  cancellations: ExternalCallCancellationRegistry,
  signal: AbortSignal,
): Promise<void> {
  const query = new URLSearchParams({ projectId, editorId: editorInstanceId });
  while (!signal.aborted) {
    const response = await fetch(`/api/external-agent/cancellation?${query}`, { signal });
    if (response.status === 204) continue;
    if (!response.ok) throw new Error(`cancellation poll failed: HTTP ${response.status}`);
    const cancellation = parseCancellation(await response.json());
    cancellations.cancel(cancellation.id, cancellation.message);
  }
}

async function unregisterBridge(projectId: string, editorInstanceId: string): Promise<void> {
  await fetch('/api/external-agent/unregister', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, editorId: editorInstanceId }),
    keepalive: true,
  }).catch(() => undefined);
}

async function runBridge(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  signal: AbortSignal,
  onError: (message: string | null) => void,
): Promise<void> {
  const { editorInstanceId } = runtime.binding();
  while (!signal.aborted) {
    const cancellations = new ExternalCallCancellationRegistry();
    const controller = new AbortController();
    const cancel = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', cancel, { once: true });
    try {
      const binding = runtime.binding();
      const response = await fetch('/api/external-agent/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          editorId: editorInstanceId,
          baseRevision: binding.baseRevision,
          tools: externalToolSchemas(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`registration failed: HTTP ${response.status}`);
      onError(null);
      await Promise.all([
        pollEditor(projectId, runtime, cancellations, controller.signal),
        pollCancellations(projectId, editorInstanceId, cancellations, controller.signal),
      ]);
    } catch (error) {
      if (!signal.aborted) onError(errorMessage(error));
    } finally {
      controller.abort();
      signal.removeEventListener('abort', cancel);
      cancellations.abortAll(controller.signal.reason);
      await unregisterBridge(projectId, editorInstanceId);
    }
    if (!signal.aborted) await retryDelay();
  }
}

export async function hydrateExternalBridge(
  projectId: string,
  runtime: ExternalBridgeHydrator,
  isAlive: () => boolean,
  onError: (message: string) => void,
  onHydrated: () => void,
  loadProposal: typeof loadExternalProposal = loadExternalProposal,
): Promise<void> {
  try {
    const pending = await loadProposal(projectId);
    if (!isAlive()) return;
    try {
      await runtime.hydrate(pending);
    } catch (hydrateError) {
      if (isAlive()) onError(errorMessage(hydrateError));
    }
  } catch (loadError) {
    if (!isAlive()) return;
    await runtime.hydrate(null);
    onError(errorMessage(loadError));
  }
  if (isAlive()) onHydrated();
}

export function useExternalAgentBridge(ctx: AgentContext, projectId: string): ExternalProposalController {
  const [snapshot, setSnapshot] = useState<ExternalProposalSnapshot>({ proposal: null, stale: false });
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<ExternalBridgeReadinessToken | null>(null);
  const ctxRef = useRef(ctx);
  const runtimeRef = useRef<ExternalBridgeRuntimeSlot | null>(null);
  ctxRef.current = ctx;

  useEffect(() => {
    let alive = true;
    const editorInstanceId = crypto.randomUUID();
    const runtimeIdentity = {};
    const isCurrent = () => (
      alive
      && runtimeRef.current?.runtimeIdentity === runtimeIdentity
    );
    const runtime = new ExternalBridgeRuntime(
      projectId,
      editorInstanceId,
      () => ctxRef.current,
      (next) => { if (isCurrent()) setSnapshot(next); },
    );
    const slot: ExternalBridgeRuntimeSlot = {
      projectId,
      editorInstanceId,
      runtimeIdentity,
      runtime,
    };
    runtimeRef.current = slot;
    setReadiness(null);
    void hydrateExternalBridge(
      projectId,
      runtime,
      isCurrent,
      (message) => { if (isCurrent()) setError(message); },
      () => {
        if (isCurrent()) setReadiness({ projectId, editorInstanceId, runtimeIdentity });
      },
    );
    return () => {
      alive = false;
      if (runtimeRef.current?.runtimeIdentity === runtimeIdentity) runtimeRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    const slot = runtimeRef.current;
    if (
      !readiness
      || !slot
      || !externalBridgeReadinessMatches(readiness, slot, projectId)
    ) return undefined;
    const controller = new AbortController();
    const close = () => { void unregisterBridge(projectId, readiness.editorInstanceId); };
    window.addEventListener('pagehide', close);
    void runBridge(projectId, slot.runtime, controller.signal, setError);
    return () => {
      window.removeEventListener('pagehide', close);
      controller.abort();
      close();
    };
  }, [readiness, projectId]);

  const runAction = useCallback((action: Promise<void> | undefined) => {
    if (!action) return;
    setError(null);
    void action.catch((actionError) => setError(errorMessage(actionError)));
  }, []);
  const applyProposal = useCallback(
    (selected: Set<number>) => runAction(runtimeRef.current?.runtime.apply(selected)),
    [runAction],
  );
  const forceApplyProposal = useCallback(
    (selected: Set<number>) => runAction(runtimeRef.current?.runtime.apply(selected, true)),
    [runAction],
  );
  const rejectProposal = useCallback(() => runAction(runtimeRef.current?.runtime.reject()), [runAction]);
  return {
    proposal: snapshot.proposal,
    proposalStale: snapshot.stale,
    error,
    applyProposal,
    forceApplyProposal,
    rejectProposal,
  };
}
