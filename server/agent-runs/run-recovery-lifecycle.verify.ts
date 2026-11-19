import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUN_RECOVERY_DB_FILENAME,
  RUN_RECOVERY_DB_ENV,
  RunRecoveryStore,
  defaultRunRecoveryStorePath,
  resetRunRecoveryStoreForTest,
  type RunRecoveryKey,
} from './run-recovery-store.ts';
import {
  beginRunRecoveryRuntime,
  finalizeRunRecovery,
  runRecoveryKeyOf,
  purgeRunRecoveryForProject,
  purgeRunRecoveryOtherGenerations,
  readRunRecoveryProjection,
  resetRunRecoveryRuntimeForTest,
  sweepRunRecovery,
} from './run-recovery-runtime.ts';
import { createRunWithCapability, prepareRunAdmission, resetServerRunStoreForTest } from './store.ts';

/**
 * P5 — recovery lifecycle: where the data lives, when it is purged, and the
 * proof that it never leaves the machine inside a project export.
 */

const directory = mkdtempSync(join(tmpdir(), 'run-recovery-p5-'));
const dbPath = join(directory, RUN_RECOVERY_DB_FILENAME);
process.env[RUN_RECOVERY_DB_ENV] = dbPath;
const store = new RunRecoveryStore(dbPath);
resetRunRecoveryStoreForTest(store);
resetRunRecoveryRuntimeForTest();
resetServerRunStoreForTest();

const generation = await prepareRunAdmission('run-recovery-p5');
const run = createRunWithCapability({
  projectId: 'run-recovery-p5',
  sessionGeneration: generation,
  backend: 'codex',
  provider: 'openai',
  model: 'gpt-5.4',
}).run;
const key: RunRecoveryKey = runRecoveryKeyOf(run);
store.prepareAdmission({
  ...key,
  backend: 'codex',
  model: run.model,
  askOnly: false,
  admissionExpiresAt: Date.now() + 60_000,
});

try {
  // --- the file lives outside the project store's own directory ------------
  const defaultPath = defaultRunRecoveryStorePath();
  assert.ok(defaultPath.endsWith(RUN_RECOVERY_DB_FILENAME));
  assert.ok(
    !defaultPath.includes('project-store-v1'),
    'the recovery database sits beside the project store, never inside the directory it scans',
  );

  // --- terminal runs keep identity but lose their replay body -------------
  const owner = beginRunRecoveryRuntime(run, { instanceId: 'p5-owner' });
  assert.ok(owner);
  store.beginRequest(key, {
    epoch: owner.epoch!,
    requestIndex: 1,
    prompt: 'USER:\nprivate instruction text',
    messages: [{ role: 'user', content: 'private instruction text' }],
    toolNames: ['read_timeline'],
  });
  assert.match(store.load(key)?.prompt ?? '', /private instruction text/);

  finalizeRunRecovery(run);
  const finalized = store.load(key)!;
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.prompt, null, 'the terminal path drops the prompt body');
  assert.equal(finalized.messages, null, 'and the message history with it');
  assert.ok(finalized.finalizedAt, 'the row still records when it ended');

  // --- a live run is never swept away by retention ------------------------
  const liveRun = createRunWithCapability({
    projectId: 'run-recovery-p5-live',
    sessionGeneration: await prepareRunAdmission('run-recovery-p5-live'),
    backend: 'codex',
    provider: 'openai',
    model: 'gpt-5.4',
  }).run;
  const liveKey = runRecoveryKeyOf(liveRun);
  store.prepareAdmission({
    ...liveKey,
    backend: 'codex',
    model: liveRun.model,
    askOnly: false,
    admissionExpiresAt: Date.now() + 60_000,
  });
  const liveOwner = store.acquireOwnership(liveKey, { instanceId: 'p5-owner' });
  store.beginRequest(liveKey, {
    epoch: liveOwner.epoch!,
    requestIndex: 1,
    prompt: 'USER:\nstill working',
    messages: [{ role: 'user', content: 'still working' }],
    toolNames: [],
  });
  // Even with a cutoff far in the future, a run that has not finalized stays.
  assert.equal(sweepRunRecovery(0, Date.now() + 24 * 60 * 60_000), 1, 'only the finalized row expired');
  assert.ok(store.load(liveKey), 'a live run is never collected by retention');
  assert.equal(store.load(key), null, 'the expired terminal row is gone');

  // --- project deletion and generation rotation ---------------------------
  assert.equal(
    purgeRunRecoveryForProject(liveKey.projectId),
    1,
    'deleting a project drops its recovery rows so no run can be resumed against it',
  );
  assert.equal(store.load(liveKey), null);

  const generationRun = createRunWithCapability({
    projectId: 'run-recovery-p5-generations',
    sessionGeneration: await prepareRunAdmission('run-recovery-p5-generations'),
    backend: 'codex',
    provider: 'openai',
    model: 'gpt-5.4',
  }).run;
  const generationKey = runRecoveryKeyOf(generationRun);
  store.prepareAdmission({
    ...generationKey,
    backend: 'codex',
    model: generationRun.model,
    askOnly: false,
    admissionExpiresAt: Date.now() + 60_000,
  });
  store.prepareAdmission({
    ...generationKey,
    sessionGeneration: 'next-generation',
    backend: 'codex',
    model: generationRun.model,
    askOnly: false,
    admissionExpiresAt: Date.now() + 60_000,
  });
  assert.equal(
    purgeRunRecoveryOtherGenerations(generationKey.projectId, 'next-generation'),
    1,
    'rotating the session generation drops the rows of the generation it replaced',
  );
  assert.ok(
    store.load({ ...generationKey, sessionGeneration: 'next-generation' }),
    'the current generation survives',
  );
  assert.equal(store.load(generationKey), null);

  // --- the projection the UI reads is a view, not an action --------------
  const viewKey = runRecoveryKeyOf(run);
  store.prepareAdmission({
    ...viewKey,
    backend: 'codex',
    model: run.model,
    askOnly: false,
    admissionExpiresAt: Date.now() + 60_000,
  });
  const view = readRunRecoveryProjection(viewKey, 42);
  assert.ok(view);
  assert.equal(view.state, 'admitted');
  assert.equal(view.lastEventId, 42);
  assert.equal(
    store.load(viewKey)?.ownerInstance,
    null,
    'reading the projection grants no execution authority',
  );

  // --- files on disk: only the recovery database, nothing inside the store
  const files = readdirSync(directory).sort();
  assert.deepEqual(
    files.filter((name) => name === RUN_RECOVERY_DB_FILENAME),
    [RUN_RECOVERY_DB_FILENAME],
  );
  const dbBytes = readFileSync(dbPath);
  assert.ok(statSync(dbPath).size > 0);
  // The database is a binary file; assert no plain-text instruction survives
  // after the terminal purge.
  assert.equal(
    dbBytes.includes(Buffer.from('private instruction text', 'utf8')),
    false,
    'a finalized run does not leave its prompt in the database file',
  );
  // No sidecar-like JSON is written next to it: exported project data comes from
  // the project store, which never sees this file.
  assert.deepEqual(
    files.filter((name) => name.endsWith('.json')),
    [],
    'the recovery store writes no JSON next to itself',
  );

  console.log(
    'run-recovery-lifecycle.verify: location, terminal purge, retention, project/generation cleanup and read-only projection passed',
  );
} finally {
  resetRunRecoveryRuntimeForTest();
  resetRunRecoveryStoreForTest(null);
  resetServerRunStoreForTest();
  rmSync(directory, { recursive: true, force: true });
  delete process.env[RUN_RECOVERY_DB_ENV];
}
