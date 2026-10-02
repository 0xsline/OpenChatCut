import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runtimeProfile } from '../runtime-profile.ts';

// Local record of every Upload-Post publish attempt, keyed by request id.
// An id is written here BEFORE its upload starts; once present (in any state
// but `rejected`), the publish route never uploads it again (see upload-post.ts).
// Upload-Post's own Idempotency-Key dedup lasts 24 hours; this record has no
// time window, so it is never evicted: an entry is ~100 bytes, and dropping one
// would silently reopen the duplicate-post risk it exists to close.
//
// Fail closed: if the record cannot be read or written, callers refuse to
// publish instead of proceeding without duplicate protection.
//
// The file lives in the storage root and travels with a storage relocation
// (RELOCATED_ENTRIES in server/data-dir.ts); the relocation runs only while no
// upload is in flight (pausePublishing in upload-post.ts).

export type LedgerState =
  | 'sending' // written before the upload starts; also what an interrupted upload leaves behind
  | 'accepted' // Upload-Post accepted the upload
  | 'ambiguous' // no definitive answer (5xx, transport error, timeout…) and /status did not show it
  | 'rejected'; // definitive pre-acceptance rejection (400/401/403/422): nothing was posted

export interface LedgerEntry {
  readonly state: LedgerState;
  readonly at: number;
  readonly error?: string;
}
type Ledger = Record<string, LedgerEntry>;

export class LedgerUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`the local publish record ${path} cannot be used (${cause instanceof Error ? cause.message : String(cause)}); `
      + 'refusing to publish without duplicate protection');
    this.name = 'LedgerUnavailableError';
  }
}

export function defaultLedgerPath(): string {
  return join(runtimeProfile().rootDir, 'upload-post-publishes.json');
}

let ledgerQueue: Promise<unknown> = Promise.resolve();

async function readLedger(path: string): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LedgerUnavailableError(path, error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LedgerUnavailableError(path, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LedgerUnavailableError(path, new Error('not a JSON object'));
  }
  return parsed as Ledger;
}

/** Serialized read-modify-write with an atomic rename, so a crash never leaves a torn file. */
function updateLedger(path: string, update: (ledger: Ledger) => void): Promise<void> {
  const run = ledgerQueue.then(async () => {
    const ledger = await readLedger(path);
    update(ledger);
    try {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(ledger), { encoding: 'utf8', mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      throw new LedgerUnavailableError(path, error);
    }
  });
  ledgerQueue = run.catch(() => undefined);
  return run;
}

/** Resolves once every queued ledger write has landed on disk. */
export async function ledgerIdle(): Promise<void> {
  await ledgerQueue;
}

export async function ledgerEntry(path: string, requestId: string): Promise<LedgerEntry | undefined> {
  await ledgerQueue;
  return (await readLedger(path))[requestId];
}

export const markLedger = (path: string, requestId: string, state: LedgerState, error?: string) =>
  updateLedger(path, (ledger) => { ledger[requestId] = { state, at: Date.now(), ...(error ? { error } : {}) }; });
