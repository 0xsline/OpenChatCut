import type { ExternalBridgeBinding } from './external-bridge-runtime';
import type { ExternalEditSessionTerminalStatus } from './external-edit-session';

export interface ExternalCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  binding: ExternalBridgeBinding;
}

export interface ExternalCancellation {
  id: string;
  outcome: Exclude<ExternalEditSessionTerminalStatus, 'applied'>;
  message: string;
}

function isFailureOutcome(
  value: unknown,
): value is Exclude<ExternalEditSessionTerminalStatus, 'applied'> {
  return value === 'rejected'
    || value === 'cancelled'
    || value === 'stale'
    || value === 'failed';
}

export function parseExternalCall(value: unknown): ExternalCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid external editor call');
  }
  if (
    !('id' in value)
    || typeof value.id !== 'string'
    || !('name' in value)
    || typeof value.name !== 'string'
    || !('arguments' in value)
    || !value.arguments
    || typeof value.arguments !== 'object'
    || Array.isArray(value.arguments)
    || !('binding' in value)
    || !value.binding
    || typeof value.binding !== 'object'
    || Array.isArray(value.binding)
    || !('projectId' in value.binding)
    || typeof value.binding.projectId !== 'string'
    || !('editorInstanceId' in value.binding)
    || typeof value.binding.editorInstanceId !== 'string'
    || !('baseRevision' in value.binding)
    || typeof value.binding.baseRevision !== 'string'
  ) {
    throw new Error('invalid external editor call');
  }
  const args = value.arguments as Record<string, unknown>;
  return {
    id: value.id,
    name: value.name,
    arguments: args,
    binding: {
      projectId: value.binding.projectId,
      editorInstanceId: value.binding.editorInstanceId,
      baseRevision: value.binding.baseRevision,
    },
  };
}

export function parseExternalCancellation(value: unknown): ExternalCancellation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid external editor cancellation');
  }
  if (
    !('id' in value)
    || typeof value.id !== 'string'
    || !('outcome' in value)
    || !isFailureOutcome(value.outcome)
    || !('message' in value)
    || typeof value.message !== 'string'
  ) {
    throw new Error('invalid external editor cancellation');
  }
  return { id: value.id, outcome: value.outcome, message: value.message };
}
