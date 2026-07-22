import { randomUUID } from 'node:crypto';

export interface ExternalToolSchema {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

interface EditorRegistration {
  editorId: string;
  lastSeen: number;
  tools: ExternalToolSchema[];
}

interface QueuedCall {
  id: string;
  projectId: string;
  name: string;
  arguments: Record<string, unknown>;
  dispatched: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExternalEditorCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const ONLINE_MS = 35_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const editors = new Map<string, EditorRegistration>();
const queues = new Map<string, QueuedCall[]>();
const pending = new Map<string, QueuedCall>();
const waiters = new Map<string, () => void>();
// ponytail: one local user's selected project. Use MCP-session scoped targets if this
// endpoint becomes a multi-user hosted service.
let targetProjectId: string | null = null;

export function registerEditor(
  projectId: string,
  editorId: string,
  tools: ExternalToolSchema[],
): void {
  editors.set(projectId, { editorId, lastSeen: Date.now(), tools });
  waiters.get(projectId)?.();
}

export function touchEditor(projectId: string, editorId: string): boolean {
  const editor = editors.get(projectId);
  if (!editor || editor.editorId !== editorId) return false;
  editor.lastSeen = Date.now();
  return true;
}

export function connectedProjectIds(): string[] {
  const now = Date.now();
  return [...editors.entries()]
    .filter(([projectId]) => isProjectConnected(projectId, now))
    .map(([projectId]) => projectId);
}

export function isProjectConnected(projectId: string, now = Date.now()): boolean {
  const editor = editors.get(projectId);
  if (!editor) return false;
  if (now - editor.lastSeen < ONLINE_MS) return true;
  return [...pending.values()].some((call) => call.projectId === projectId && call.dispatched);
}

export function editorStatuses(): Array<{
  projectId: string;
  editorId: string;
  connected: boolean;
  toolCount: number;
}> {
  const now = Date.now();
  return [...editors.entries()].map(([projectId, editor]) => ({
    projectId,
    editorId: editor.editorId,
    connected: isProjectConnected(projectId, now),
    toolCount: editor.tools.length,
  }));
}

export function registeredTools(): ExternalToolSchema[] {
  const first = editors.values().next().value as EditorRegistration | undefined;
  return first?.tools ?? [];
}

export function setTargetProject(projectId: string): void {
  targetProjectId = projectId;
}

export function resolveProjectId(requested?: unknown): string {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (targetProjectId) return targetProjectId;
  const connected = connectedProjectIds();
  if (connected.length === 1) return connected[0];
  if (connected.length === 0) {
    throw new Error('No OpenChatCut editor is connected. Open the target project in OpenChatCut first.');
  }
  throw new Error('Multiple OpenChatCut projects are open; pass editorProjectId or call target_project.');
}

export function invokeEditorTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  if (!connectedProjectIds().includes(projectId)) {
    throw new Error(`Project ${projectId} is not open in a connected OpenChatCut editor.`);
  }
  return new Promise((resolve, reject) => {
    const call: QueuedCall = {
      id: randomUUID(),
      projectId,
      name,
      arguments: args,
      dispatched: false,
      resolve,
      reject,
      timer: setTimeout(() => {
        pending.delete(call.id);
        reject(new Error(`OpenChatCut tool ${name} timed out`));
      }, Math.min(MAX_TIMEOUT_MS, Math.max(1_000, timeoutMs))),
    };
    const queue = queues.get(projectId) ?? [];
    queue.push(call);
    queues.set(projectId, queue);
    pending.set(call.id, call);
    waiters.get(projectId)?.();
  });
}

export async function nextEditorCall(
  projectId: string,
  editorId: string,
  signal: AbortSignal,
): Promise<ExternalEditorCall | null> {
  if (!touchEditor(projectId, editorId)) return null;
  const take = () => queues.get(projectId)?.shift();
  let call = take();
  if (!call) {
    await new Promise<void>((resolve) => {
      const done = () => {
        waiters.delete(projectId);
        resolve();
      };
      waiters.set(projectId, done);
      const timer = setTimeout(done, 25_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        done();
      }, { once: true });
    });
    call = take();
  }
  if (!call) return null;
  call.dispatched = true;
  return { id: call.id, name: call.name, arguments: call.arguments };
}

export function settleEditorCall(
  id: string,
  ok: boolean,
  value: unknown,
): boolean {
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearTimeout(call.timer);
  if (ok) call.resolve(value);
  else call.reject(new Error(typeof value === 'string' ? value : JSON.stringify(value)));
  return true;
}
