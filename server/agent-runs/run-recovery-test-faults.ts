import type { RunRecoveryStore } from './run-recovery-store.ts';

/**
 * Test-only fault injection for the recovery store.
 *
 * The P2 acceptance needs to prove what happens when a durable write fails
 * *while* a run is active, which cannot be produced by a healthy database. The
 * override is installed on one store instance, never on the production path.
 */
export function denyRunRecoveryWrites(store: RunRecoveryStore): () => void {
  const target = store as unknown as Record<string, unknown>;
  const names = ['beginRequest', 'beginTool', 'finishTool', 'claimTool'] as const;
  const originals = new Map<string, unknown>();
  for (const name of names) {
    originals.set(name, target[name]);
    target[name] = () => {
      throw new Error('recovery store is unavailable');
    };
  }
  return () => {
    for (const [name, value] of originals) target[name] = value;
  };
}
