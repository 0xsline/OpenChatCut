import type { ProjectDoc } from '../editor/types';
import { migrateProjectDoc } from '../persist/projectStore';
import { revisionOf } from './external-edit-session';
import type { Operation } from './proposal';

const MAX_CHANGE_SESSIONS = 20;

export interface AgentChangeOperation {
  action: string;
  target: string;
  impact: string;
}

export interface AgentChangeSession {
  id: string;
  createdAt: number;
  summary: string;
  operations: AgentChangeOperation[];
  beforeDoc: ProjectDoc;
  afterRevision: string;
  rollbackable: boolean;
}

export function createAgentChangeSession(
  summary: string,
  operations: readonly Pick<Operation, 'action' | 'target' | 'impact'>[],
  beforeDoc: ProjectDoc,
  afterDoc: ProjectDoc,
  rollbackable = true,
): AgentChangeSession {
  return {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    summary: summary.trim() || 'Agent 修改',
    operations: operations.map(({ action, target, impact }) => ({ action, target, impact })),
    beforeDoc,
    afterRevision: revisionOf(afterDoc),
    rollbackable,
  };
}

export function appendAgentChange(
  sessions: readonly AgentChangeSession[],
  session: AgentChangeSession,
): AgentChangeSession[] {
  return [...sessions, session].slice(-MAX_CHANGE_SESSIONS);
}

function parseOperation(value: unknown): AgentChangeOperation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AgentChangeOperation>;
  return typeof item.action === 'string' && typeof item.target === 'string' && typeof item.impact === 'string'
    ? { action: item.action, target: item.target, impact: item.impact }
    : null;
}

export function parseAgentChangeLog(value: unknown): AgentChangeSession[] {
  if (!Array.isArray(value)) return [];
  const sessions: AgentChangeSession[] = [];
  for (const raw of value.slice(-MAX_CHANGE_SESSIONS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<AgentChangeSession>;
    const beforeDoc = migrateProjectDoc(item.beforeDoc);
    if (!Array.isArray(item.operations)) continue;
    const operations = item.operations.map(parseOperation);
    if (!beforeDoc || operations.some((operation) => !operation)
      || typeof item.id !== 'string' || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)
      || typeof item.summary !== 'string' || typeof item.afterRevision !== 'string') continue;
    sessions.push({
      id: item.id,
      createdAt: item.createdAt,
      summary: item.summary,
      operations: operations as AgentChangeOperation[],
      beforeDoc,
      afterRevision: item.afterRevision,
      rollbackable: item.rollbackable !== false,
    });
  }
  return sessions;
}

export function canRollbackAgentChange(session: AgentChangeSession, currentDoc: ProjectDoc): boolean {
  return session.rollbackable && revisionOf(currentDoc) === session.afterRevision;
}

export function rollbackAgentChange(
  session: AgentChangeSession,
  currentDoc: ProjectDoc,
  force = false,
): ProjectDoc | null {
  if (!session.rollbackable || (!force && !canRollbackAgentChange(session, currentDoc))) return null;
  return migrateProjectDoc(session.beforeDoc);
}
