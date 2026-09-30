import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { runtimeProfile } from '../runtime-profile.ts';

// Local record of every Upload-Post publish attempt, keyed by request id.
// An id is written here BEFORE its upload is sent; once present, the publish
// route never uploads it again (see upload-post.ts). Upload-Post's own
// Idempotency-Key dedup lasts 24 hours; this record has no time window.

const LEDGER_MAX_ENTRIES = 1000;

// ── Attempt ledger ──────────────────────────────────────────────────────────
export interface LedgerEntry {
  readonly state: 'sending' | 'accepted' | 'ambiguous';
  readonly at: number;
}
type Ledger = Record<string, LedgerEntry>;

export function defaultLedgerPath(): string {
  return join(runtimeProfile().rootDir, 'upload-post-publishes.json');
}

let ledgerQueue: Promise<unknown> = Promise.resolve();

async function readLedger(path: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Ledger : {};
  } catch {
    return {};
  }
}

/** Serialized read-modify-write with an atomic rename, so a crash never leaves a torn file. */
function updateLedger(path: string, update: (ledger: Ledger) => void): Promise<void> {
  const run = ledgerQueue.then(async () => {
    const ledger = await readLedger(path);
    update(ledger);
    const kept = Object.entries(ledger)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, LEDGER_MAX_ENTRIES);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(Object.fromEntries(kept)), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  });
  ledgerQueue = run.catch(() => undefined);
  return run;
}

export async function ledgerEntry(path: string, requestId: string): Promise<LedgerEntry | undefined> {
  await ledgerQueue;
  return (await readLedger(path))[requestId];
}

export const markLedger = (path: string, requestId: string, state: LedgerEntry['state']) =>
  updateLedger(path, (ledger) => { ledger[requestId] = { state, at: Date.now() }; });
export const clearLedger = (path: string, requestId: string) =>
  updateLedger(path, (ledger) => { delete ledger[requestId]; });
