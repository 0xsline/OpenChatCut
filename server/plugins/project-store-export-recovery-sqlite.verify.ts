import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  executeImmediateExportRecoveryMutation,
  type ExportRecoveryLeaseInput,
} from './project-store-export-recovery.ts';
import { sqliteImmediateTransaction } from '../storage/sqlite-store.ts';

const CHILD_MODE = process.env.OPENCHATCUT_EXPORT_RECOVERY_RACE_CHILD === '1';
const renderId = '11111111-1111-4111-8111-111111111111';
const key = `export-recovery:${renderId}`;

function claim(ownerInstanceId: string): ExportRecoveryLeaseInput {
  return {
    operation: 'export-recovery-lease',
    key,
    renderId,
    action: 'claim',
    ownerInstanceId,
    leaseMs: 60_000,
  };
}

function runChild(): void {
  process.on('message', (message) => {
    if (message !== 'go') return;
    try {
      const result = sqliteImmediateTransaction((store) => (
        executeImmediateExportRecoveryMutation(store, claim(`process-${process.pid}`), 10_000)
      ));
      process.send?.({ accepted: result.accepted, leaseToken: result.lease?.leaseToken });
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  process.send?.('ready');
}

function waitForMessage(child: ChildProcess, expected: (value: unknown) => boolean): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const cleanup = () => {
    child.off('message', onMessage);
    child.off('exit', onExit);
  };
  const onMessage = (value: unknown) => {
    if (!expected(value)) return;
    cleanup();
    resolve(value);
  };
  const onExit = (code: number | null) => {
    cleanup();
    reject(new Error(`race child exited before response (${code ?? 'signal'})`));
  };
  child.on('message', onMessage);
  child.once('exit', onExit);
  return promise;
}

function spawnChild(home: string): ChildProcess {
  return fork(fileURLToPath(import.meta.url), [], {
    env: {
      ...process.env,
      HOME: home,
      OPENCHATCUT_EXPORT_RECOVERY_RACE_CHILD: '1',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}

async function seedRecovery(home: string): Promise<void> {
  const path = join(home, '.openchatcut', 'project-store-v1.sqlite3');
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(key, JSON.stringify({
    version: 1,
    renderId,
    projectId: 'sqlite-race-project',
    stage: 'output-ready',
    updatedAt: 1,
  }));
  db.close();
}

async function runParent(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'openchatcut-export-recovery-race-'));
  try {
    await seedRecovery(home);
    const children = [spawnChild(home), spawnChild(home)];
    await Promise.all(children.map((child) => waitForMessage(child, (value) => value === 'ready')));
    const results = children.map((child) => waitForMessage(
      child,
      (value) => !!value && typeof value === 'object' && ('accepted' in value || 'error' in value),
    ));
    for (const child of children) child.send('go');
    const settled = await Promise.all(results) as Array<{ accepted?: boolean; error?: string }>;
    assert.deepEqual(settled.map((result) => result.error), [undefined, undefined]);
    assert.equal(settled.filter((result) => result.accepted).length, 1,
      'two independent SQLite processes must accept exactly one recovery owner');
    for (const child of children) child.disconnect();
    console.log('✓ export recovery SQLite BEGIN IMMEDIATE race accepted exactly one owner');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

if (CHILD_MODE) runChild();
else void runParent().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
