import type { ExternalEditSession } from '../../src/agent/external-edit-session.ts';
import { validateAgentToolInvocation } from '../../src/agent/execution-policy.ts';
import type { AgentToolSchema } from '../../src/agent/tool-schema.ts';
import { ExternalEditorCallError } from './broker.ts';
import type { executeOfflineTool } from './offline-executor.ts';
import {
  commitOfflineStoredProject,
  deleteOfflineEditCheckpoint,
  loadOfflineEditCheckpoint,
  saveOfflineEditCheckpoint,
  type OfflineProjectCommitInput,
  type OfflineProjectCommitResult,
} from './offline-project-store.ts';
import {
  claimOfflineProjectOwnership,
  releaseProjectEditOwnership,
  renewProjectEditOwnership,
} from './project-edit-ownership.ts';
import { offlineExternalToolSchemas } from './offline-tools.ts';

export const ACTIVE_SESSION_STATUSES: Record<string, true> = {
  drafting: true,
  awaiting_review: true,
};

export interface OfflineEditorBinding {
  mode: 'offline';
  projectId: string;
  baseRevision: string;
}

export interface OfflineEditPersistence {
  claimProject: typeof claimOfflineProjectOwnership;
  renewOwnership: typeof renewProjectEditOwnership;
  releaseOwnership: typeof releaseProjectEditOwnership;
  commitProject: (input: OfflineProjectCommitInput) => Promise<OfflineProjectCommitResult>;
  loadCheckpoint?: typeof loadOfflineEditCheckpoint;
  saveCheckpoint?: typeof saveOfflineEditCheckpoint;
  deleteCheckpoint?: typeof deleteOfflineEditCheckpoint;
}

export interface OfflineRuntimeDependencies {
  persistence?: OfflineEditPersistence;
  isBrowserConnected?: (projectId: string) => boolean;
  executeTool?: typeof executeOfflineTool;
}

export interface VersionedOfflineSession {
  readonly session: ExternalEditSession;
  readonly generation: number;
}

export const DEFAULT_PERSISTENCE: OfflineEditPersistence = {
  claimProject: claimOfflineProjectOwnership,
  renewOwnership: renewProjectEditOwnership,
  releaseOwnership: releaseProjectEditOwnership,
  commitProject: commitOfflineStoredProject,
  loadCheckpoint: loadOfflineEditCheckpoint,
  saveCheckpoint: saveOfflineEditCheckpoint,
  deleteCheckpoint: deleteOfflineEditCheckpoint,
};

function withoutEditSessionId(schema: AgentToolSchema): AgentToolSchema {
  const properties = { ...(schema.input_schema.properties ?? {}) };
  delete properties.editSessionId;
  return {
    ...schema,
    input_schema: {
      ...schema.input_schema,
      properties,
      required: schema.input_schema.required?.filter((name) => name !== 'editSessionId'),
    },
  };
}

const OFFLINE_ACTIVE_CATALOG = offlineExternalToolSchemas().map(withoutEditSessionId);

export function validateOfflineInvocation(name: string, args: Record<string, unknown>): void {
  const schema = OFFLINE_ACTIVE_CATALOG.find((candidate) => candidate.name === name)
    ?? { name, input_schema: { type: 'object' } as const };
  const invocationArgs = { ...args };
  delete invocationArgs.editSessionId;
  const validation = validateAgentToolInvocation(schema, invocationArgs, OFFLINE_ACTIVE_CATALOG);
  if (!validation.ok) throw new ExternalEditorCallError('rejected', validation.error);
}

export function requiredSessionId(args: Record<string, unknown>): string {
  const value = args.editSessionId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExternalEditorCallError('rejected', 'editSessionId is required');
  }
  return value.trim();
}
