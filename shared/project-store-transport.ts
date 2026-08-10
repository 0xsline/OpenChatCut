export const PROJECT_STORE_CHANNEL = 'openchatcut:project-store';

export type AgentRunLeaseAction = 'claim' | 'renew' | 'release' | 'check';

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
    operation: 'agent-runtime-cas';
    key: string;
    expectedRevision: number | null;
    value: unknown;
  }
  | {
    operation: 'agent-session-rotate';
    projectId: string;
  }
  | {
    operation: 'project-document-cas';
    key: string;
    expectedRevision: null;
    value: unknown;
  }
  | {
    operation: 'project-document-cas';
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
