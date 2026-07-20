import { useEffect, useRef } from 'react';
import type { AgentContext } from './context';
import { executeTool, TOOL_SCHEMAS } from './tools';
import { saveProject } from '../persist/projectStore';

interface ExternalCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));

async function sendResult(id: string, ok: boolean, value: unknown): Promise<void> {
  await fetch('/api/external-agent/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ok, value }),
  });
}

async function executeExternalCall(
  call: ExternalCall,
  ctx: AgentContext,
  projectId: string,
): Promise<void> {
  if (!TOOL_SCHEMAS.some((tool) => tool.name === call.name)) {
    await sendResult(call.id, false, `unknown OpenChatCut tool ${call.name}`);
    return;
  }
  try {
    const result = await executeTool(call.name, call.arguments, ctx);
    await nextPaint();
    await saveProject(projectId, ctx.getDoc());
    await sendResult(call.id, true, result);
  } catch (error) {
    await sendResult(call.id, false, error instanceof Error ? error.message : String(error));
  }
}

export function useExternalAgentBridge(ctx: AgentContext, projectId: string): void {
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  useEffect(() => {
    const controller = new AbortController();
    const editorId = crypto.randomUUID();
    const run = async () => {
      while (!controller.signal.aborted) {
        try {
          const registered = await fetch('/api/external-agent/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, editorId, tools: TOOL_SCHEMAS }),
            signal: controller.signal,
          });
          if (!registered.ok) throw new Error(`registration failed: HTTP ${registered.status}`);
          while (!controller.signal.aborted) {
            const response = await fetch(
              `/api/external-agent/poll?projectId=${encodeURIComponent(projectId)}&editorId=${encodeURIComponent(editorId)}`,
              { signal: controller.signal },
            );
            if (response.status === 204) continue;
            if (!response.ok) throw new Error(`poll failed: HTTP ${response.status}`);
            await executeExternalCall(await response.json() as ExternalCall, ctxRef.current, projectId);
          }
        } catch {
          if (!controller.signal.aborted) await retryDelay();
        }
      }
    };
    void run();
    return () => controller.abort();
  }, [projectId]);
}
