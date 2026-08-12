export const PROJECT_STORE_CHANNEL = 'openchatcut:project-store';

export type AgentRunLeaseAction = 'claim' | 'renew' | 'release' | 'check';
export type ExportRecoveryLeaseAction =
  | 'claim' | 'renew' | 'release' | 'check' | 'retire'
  | 'ready' | 'ambiguous' | 'commit' | 'rebind' | 'reconcile';

export interface AgentRunLeaseState {
  ownerInstanceId: string;
  leaseToken: string;
  leaseExpiresAt: number;
}

export interface ProjectStoreMutationResponse {
  accepted: boolean;
  found: boolean;
  value?: unknown;
  lease?: AgentRunLeaseState;
  error?: {
    code: string;
    run?: {
      runId: string;
      status: 'running' | 'waiting_approval' | 'awaiting_user';
      updatedAt: number;
      ownerInstanceId?: string;
      leaseExpiresAt?: number;
    };
  };
}

export interface ProjectDocumentMutationResponse extends ProjectStoreMutationResponse {
  currentRevision?: string;
  ownershipEpoch?: number;
}

export type ProjectStoreRequest =
  | { operation: 'snapshot' }
  | { operation: 'entry'; key: string }
  | { operation: 'merge'; entries: Record<string, unknown> }
  | { operation: 'set'; key: string; value: unknown }
  | { operation: 'delete'; key: string }
  | { operation: 'purge-project'; projectId: string }
  | {
    operation: 'agent-runtime-write';
    key: string;
    expectedRevision: number | null;
    value: unknown;
  }
  | {
    operation: 'agent-session-rotate';
    projectId: string;
  }
  | {
    operation: 'project-document-write';
    key: string;
    expectedRevision: null;
    value: unknown;
  }
  | {
    operation: 'project-document-write';
    key: string;
    expectedRevision: string;
    ownerId: string;
    ownershipEpoch: number;
    value: unknown;
  }
  | {
    operation: 'agent-run-lease';
    key: string;
    runId: string;
    action: AgentRunLeaseAction;
    ownerInstanceId: string;
    leaseToken?: string;
    leaseMs?: number;
  }
  | {
    operation: 'export-recovery-lease';
    key: string;
    renderId: string;
    action: ExportRecoveryLeaseAction;
    ownerInstanceId: string;
    leaseToken?: string;
    leaseMs?: number;
    value?: unknown;
    authorityEstablished?: boolean;
  }
  // Semantic vectors (phase C): server-side sqlite-vec index.
  | {
    operation: 'semantic-vectors-upsert';
    scopeId: string;
    assetId: string;
    samples: Array<{
      assetId: string;
      sampleTime: number;
      sourceRevision?: string;
      sceneId?: string;
      sceneStart?: number;
      sceneEnd?: number;
      vector: number[];
    }>;
  }
  | {
    operation: 'semantic-vectors-search';
    scopeId: string;
    queryVector: number[];
    limit: number;
  }
  | {
    operation: 'semantic-vectors-prune';
    scopeId: string;
    validAssetIds: string[];
    validSourceRevisions?: Record<string, string>;
  }
  | {
    operation: 'semantic-vectors-clear';
    scopeId: string;
  };

export type ProjectStoreResponse =
  | { version: 1; entries: Record<string, unknown> }
  | { found: boolean; value?: unknown }
  | { ok: true }
  | ProjectStoreMutationResponse
  | { semanticVectors: unknown };
