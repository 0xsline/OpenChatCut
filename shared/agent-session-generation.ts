export const LEGACY_AGENT_SESSION_GENERATION = 'legacy';

export interface AgentSessionGenerationRecord {
  readonly version: 1;
  readonly generation: string;
  readonly clearedAt: number;
}

const PROJECT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const GENERATION = /^[A-Za-z0-9_-]{1,80}$/;

export function requireAgentSessionProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) throw new Error('Invalid Agent session project id.');
}

export function parseAgentSessionGenerationRecord(
  value: unknown,
): AgentSessionGenerationRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<AgentSessionGenerationRecord>;
  return record.version === 1
    && typeof record.generation === 'string'
    && GENERATION.test(record.generation)
    && typeof record.clearedAt === 'number'
    && Number.isFinite(record.clearedAt)
    && record.clearedAt >= 0
    ? record as AgentSessionGenerationRecord
    : null;
}

export const agentSessionGenerationKey = (projectId: string): string =>
  `agent-session-generation:${projectId}`;

export const agentSessionRuntimeKey = (projectId: string, generation: string): string =>
  generation === LEGACY_AGENT_SESSION_GENERATION
    ? `agent-runtime:${projectId}`
    : `agent-session-runtime:${projectId}:${generation}`;
export const agentSessionChatKey = (projectId: string, generation: string): string =>
  generation === LEGACY_AGENT_SESSION_GENERATION
    ? `chat:${projectId}`
    : `agent-session-chat:${projectId}:${generation}`;


export const agentSessionProposalKey = (projectId: string, generation: string): string =>
  generation === LEGACY_AGENT_SESSION_GENERATION
    ? `proposal:${projectId}`
    : `agent-session-proposal:${projectId}:${generation}`;
export const agentSessionArtifactPrefix = (projectId: string, generation: string): string =>
  generation === LEGACY_AGENT_SESSION_GENERATION
    ? `agent-artifact:${projectId}:`
    : `agent-session-artifact:${projectId}:${generation}:`;

export const agentSessionArtifactKey = (
  projectId: string,
  artifactId: string,
  generation: string,
): string => `${agentSessionArtifactPrefix(projectId, generation)}${artifactId}`;
