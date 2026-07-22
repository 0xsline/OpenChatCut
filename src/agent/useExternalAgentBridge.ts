import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentContext } from './context';
import { ExternalBridgeRuntime, type ExternalProposalSnapshot } from './external-bridge-runtime';
import { externalToolSchemas } from './external-tool-schemas';
import type { Proposal } from './proposal';
import { loadExternalProposal } from '../persist/externalProposalStore';

interface ExternalCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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

async function sendResult(id: string, ok: boolean, value: unknown): Promise<void> {
  await fetch('/api/external-agent/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ok, value }),
  });
}

async function executeCall(call: ExternalCall, runtime: ExternalBridgeRuntime): Promise<void> {
  try {
    await sendResult(call.id, true, await runtime.execute(call.name, call.arguments));
  } catch (error) {
    await sendResult(call.id, false, error instanceof Error ? error.message : String(error));
  }
}

async function pollEditor(
  projectId: string,
  editorId: string,
  runtime: ExternalBridgeRuntime,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const response = await fetch(
      `/api/external-agent/poll?projectId=${encodeURIComponent(projectId)}&editorId=${encodeURIComponent(editorId)}`,
      { signal },
    );
    if (response.status === 204) continue;
    if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
    await executeCall(await response.json() as ExternalCall, runtime);
  }
}

async function runBridge(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  signal: AbortSignal,
  onError: (message: string | null) => void,
): Promise<void> {
  const editorId = crypto.randomUUID();
  while (!signal.aborted) {
    try {
      const response = await fetch('/api/external-agent/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, editorId, tools: externalToolSchemas() }),
        signal,
      });
      if (!response.ok) throw new Error(`registration failed: HTTP ${response.status}`);
      onError(null);
      await pollEditor(projectId, editorId, runtime, signal);
    } catch (error) {
      if (!signal.aborted) {
        onError(errorMessage(error));
        await retryDelay();
      }
    }
  }
}

async function hydrateBridge(
  projectId: string,
  runtime: ExternalBridgeRuntime,
  isAlive: () => boolean,
  onError: (message: string) => void,
  onHydrated: () => void,
): Promise<void> {
  try {
    const pending = await loadExternalProposal(projectId);
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
  const [hydrated, setHydrated] = useState(false);
  const ctxRef = useRef(ctx);
  const runtimeRef = useRef<ExternalBridgeRuntime | null>(null);
  ctxRef.current = ctx;

  useEffect(() => {
    let alive = true;
    setHydrated(false);
    const runtime = new ExternalBridgeRuntime(
      projectId,
      () => ctxRef.current,
      (next) => { if (alive) setSnapshot(next); },
    );
    runtimeRef.current = runtime;
    void hydrateBridge(projectId, runtime, () => alive, setError, () => setHydrated(true));
    return () => { alive = false; runtimeRef.current = null; };
  }, [projectId]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!hydrated || !runtime) return undefined;
    const controller = new AbortController();
    void runBridge(projectId, runtime, controller.signal, setError);
    return () => controller.abort();
  }, [hydrated, projectId]);

  const runAction = useCallback((action: Promise<void> | undefined) => {
    if (!action) return;
    setError(null);
    void action.catch((actionError) => setError(errorMessage(actionError)));
  }, []);
  const applyProposal = useCallback((selected: Set<number>) => runAction(runtimeRef.current?.apply(selected)), [runAction]);
  const forceApplyProposal = useCallback((selected: Set<number>) => runAction(runtimeRef.current?.apply(selected, true)), [runAction]);
  const rejectProposal = useCallback(() => runAction(runtimeRef.current?.reject()), [runAction]);
  return { proposal: snapshot.proposal, proposalStale: snapshot.stale, error, applyProposal, forceApplyProposal, rejectProposal };
}
