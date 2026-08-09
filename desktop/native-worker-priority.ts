import { constants, setPriority } from 'node:os';
import type { UtilityProcess } from 'electron';

export function lowerNativeWorkerPriority(worker: UtilityProcess): void {
  if (worker.pid === undefined) return;
  try {
    setPriority(worker.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Priority adjustment is best-effort; inference remains isolated in the utility process.
  }
}
