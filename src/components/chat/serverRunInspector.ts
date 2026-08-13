import type { AgentRunEvent, AgentRunRecord } from '../../persist/agentRuntimeTypes';

export interface ServerRunInspectorEvent {
  readonly id: number;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isServerEvent(value: unknown): value is ServerRunInspectorEvent {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.type !== 'string'
    || !Number.isFinite(value.at)) return false;
  return isRecord(value.data);
}

export function serverEventFromAgentEvent(event: AgentRunEvent): ServerRunInspectorEvent | null {
  if (typeof event.summary !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(event.summary);
    if (!isRecord(parsed) || !isServerEvent(parsed.serverEvent)) return null;
    return parsed.serverEvent;
  } catch {
    return null;
  }
}

export function serverEventsForRun(run: AgentRunRecord): readonly ServerRunInspectorEvent[] {
  return run.events
    .map(serverEventFromAgentEvent)
    .filter((event): event is ServerRunInspectorEvent => event !== null)
    .sort((a, b) => a.id - b.id);
}

export function isServerRunRecord(run: AgentRunRecord): boolean {
  return run.userInputPreview.startsWith('server:') || serverEventsForRun(run).length > 0;
}

export function serverRunTerminalReason(
  run: AgentRunRecord,
  events: readonly ServerRunInspectorEvent[] = serverEventsForRun(run),
): string | undefined {
  // Completed and awaiting-user runs end with the model's reply text, which
  // already lives in the chat panel; only abnormal endings get a reason here.
  if (run.status === 'completed' || run.status === 'awaiting_user') return undefined;
  if (run.finalSummary) return run.finalSummary;
  const terminal = [...events].reverse().find((event) => event.type === 'done' || event.type === 'error');
  const reason = terminal?.data.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

export function serverEventDetail(event: ServerRunInspectorEvent): string | undefined {
  const data = event.data;
  if (typeof data.name === 'string') return data.name;
  if (typeof data.toolCallId === 'string' && typeof data.status === 'string') {
    return `${data.toolCallId}: ${data.status}`;
  }
  if (typeof data.error === 'string') return data.error;
  if (typeof data.reason === 'string') return data.reason;
  if (event.type === 'text-end' || event.type === 'finish') return '完成';
  return undefined;
}
