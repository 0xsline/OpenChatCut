import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentContext } from './context';
import { TOOL_SCHEMAS } from './tools';
import { executeCodexTool } from './runtime';
import { ToolActivation } from './tool-activation';
import { loadAgentSettings } from './settings/agentSettings';
import { getAgentModelSnapshot } from './model-selection';
import { draftContext } from './useAgentRun';
import { makeDraft } from '../editor/store';
import type { DisplayMessage, PendingGuard } from './agent-session';
import type { GuardDecision } from './skills/costGuard';
import type { AgentEvent } from './runtime';

export interface ServerRunController {
  send: (text: string) => void;
  messages: readonly DisplayMessage[];
  running: boolean;
  pendingGuard: PendingGuard | null;
  confirmGuard: (allow: boolean) => void;
  stop: () => void;
}

const RUN_ID_KEY = (projectId: string): string => `cc.serverRun.${projectId}`;

function runIdStorage(projectId: string): string | null {
  try {
    return sessionStorage.getItem(RUN_ID_KEY(projectId));
  } catch {
    return null;
  }
}

/**
 * Browser side of the server-side durable agent run (Phase B).
 *
 * The LLM loop executes on the dev server; this hook starts a run, streams
 * events over SSE, and acts as the tool-execution proxy: every tool-request
 * event is executed through the existing executeCodexTool chain (guards,
 * draft context, run recording), and the result is delivered back so the
 * server loop can continue. Refreshing the page only drops the EventSource —
 * the run keeps running and the browser reconnects (Last-Event-ID) to resume
 * streaming and pending tool requests.
 */
export function useServerRun(ctx: AgentContext, projectId: string): ServerRunController {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [pendingGuard, setPendingGuard] = useState<PendingGuard | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const runIdRef = useRef<string | null>(null);
  const activationRef = useRef<ToolActivation | null>(null);
  const draftRef = useRef<ReturnType<typeof makeDraft> | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const guardResolveRef = useRef<((decision: GuardDecision) => void) | null>(null);
  const runningRef = useRef(false);
  const settingsRef = useRef(loadAgentSettings());

  const appendMessage = useCallback((message: DisplayMessage) => {
    setMessages((current) => [...current, message]);
  }, []);

  const updateStreamingText = useCallback((text: string) => {
    setMessages((current) => {
      const next = [...current];
      const last = next[next.length - 1];
      if (last?.role === 'assistant' && last.text !== text) {
        next[next.length - 1] = { ...last, text };
      }
      return next;
    });
  }, []);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const handleToolRequest = useCallback(async (runId: string, toolCallId: string, name: string, args: Record<string, unknown>) => {
    if (!draftRef.current) {
      draftRef.current = makeDraft(ctxRef.current.getDoc());
    }
    const draft = draftRef.current;
    const activation = activationRef.current ?? new ToolActivation(TOOL_SCHEMAS, []);
    activationRef.current = activation;
    const onEvent = (_event: AgentEvent): void => {
      // Tool events are visible to the LLM through the delivered result;
      // nothing extra to render in Phase B.
    };
    try {
      const { execution } = await executeCodexTool({
        name,
        args,
        activation,
        ctx: draftContext(ctxRef.current, draft),
        onEvent,
        settings: settingsRef.current,
        onSkillGuard: async (guard) => new Promise<GuardDecision>((resolve) => {
          guardResolveRef.current = resolve;
          setPendingGuard({ ...guard, resolve: (requested) => {
            guardResolveRef.current = null;
            setPendingGuard(null);
            resolve(requested === 'deny' ? 'deny' : 'allow-once');
          } });
        }),
        toolCallId,
      });
      await fetch(`/api/agent-runs/${runId}/tool-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId, result: execution.result }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await fetch(`/api/agent-runs/${runId}/tool-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolCallId, error: message }),
      });
    }
  }, []);

  const subscribe = useCallback((runId: string) => {
    closeStream();
    const es = new EventSource(`/api/agent-runs/${runId}/events`);
    esRef.current = es;
    es.addEventListener('text-delta', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { text: string };
        updateStreamingText(data.text);
      } catch {
        // Malformed event; keep streaming.
      }
    });
    es.addEventListener('tool-request', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          toolCallId: string;
          name: string;
          args: Record<string, unknown>;
        };
        void handleToolRequest(runId, data.toolCallId, data.name, data.args ?? {});
      } catch {
        // Malformed tool request; the server loop waits until it is cancelled.
      }
    });
    es.addEventListener('error', () => {
      // EventSource auto-reconnects with Last-Event-ID; nothing to do here.
    });
    es.addEventListener('done', () => {
      closeStream();
      setRunning(false);
      runningRef.current = false;
    });
  }, [closeStream, handleToolRequest, updateStreamingText]);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || runningRef.current) return;
    const snapshot = getAgentModelSnapshot();
    const active = snapshot.choices.find((choice) => choice.id === snapshot.activeId)
      ?? snapshot.choices[0];
    if (!active) return;
    const payload = {
      projectId,
      provider: active.provider,
      model: active.model,
      messages: [{ role: 'user' as const, content: trimmed }],
      tools: TOOL_SCHEMAS,
    };
    runningRef.current = true;
    setRunning(true);
    setMessages((current) => [...current, { role: 'user', text: trimmed }]);
    appendMessage({ role: 'assistant', text: '' });
    void (async () => {
      try {
        const response = await fetch('/api/agent-runs/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          throw new Error(`agent run failed: HTTP ${response.status}`);
        }
        const value = (await response.json()) as { id: string };
        runIdRef.current = value.id;
        try {
          sessionStorage.setItem(RUN_ID_KEY(projectId), value.id);
        } catch {
          // Session storage unavailable; this page still streams.
        }
        subscribe(value.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendMessage({ role: 'error', text: message });
        setRunning(false);
        runningRef.current = false;
      }
    })();
  }, [appendMessage, projectId, subscribe]);

  const confirmGuard = useCallback((allow: boolean) => {
    guardResolveRef.current?.(allow ? 'allow-once' : 'deny');
  }, []);

  const stop = useCallback(() => {
    const runId = runIdRef.current;
    if (runId) void fetch(`/api/agent-runs/${runId}/cancel`, { method: 'POST' });
    closeStream();
    setRunning(false);
    runningRef.current = false;
  }, [closeStream]);

  // Resume after refresh: reconnect to a run this project started earlier.
  useEffect(() => {
    const stored = runIdStorage(projectId);
    if (!stored) return undefined;
    runIdRef.current = stored;
    runningRef.current = true;
    setRunning(true);
    appendMessage({ role: 'assistant', text: '' });
    subscribe(stored);
    return closeStream;
  }, [appendMessage, closeStream, projectId, subscribe]);

  return { send, messages, running, pendingGuard, confirmGuard, stop };
}
