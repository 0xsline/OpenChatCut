export const PROJECT_STORE_CHANNEL = 'openchatcut:project-store';

export type ProjectStoreRequest =
  | { operation: 'snapshot' }
  | { operation: 'entry'; key: string }
  | { operation: 'merge'; entries: Record<string, unknown> }
  | { operation: 'set'; key: string; value: unknown }
  | { operation: 'delete'; key: string };

export type ProjectStoreResponse =
  | { version: 1; entries: Record<string, unknown> }
  | { found: boolean; value?: unknown }
  | { ok: true };
