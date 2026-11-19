import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RUN_OWNER_TTL_MS,
  MAX_RUN_RECOVERY_TOOLS_PER_RUN,
  RUN_RECOVERY_SCHEMA_VERSION,
  RunRecoverySchemaError,
  RunRecoveryStore,
  defaultRunRecoveryStorePath,
  resetRunRecoveryStoreForTest,
} from './run-recovery-store.ts';
import { beginRunRecoveryRuntime, resetRunRecoveryRuntimeForTest } from './run-recovery-runtime';
import type { ServerRun } from './store-types';
import type { RunRecoveryKey } from './run-recovery-store.ts';
/**
 * P1 — the durable recovery record.
 *
 * The checks below are the ones a restart actually depends on: identity is
 * unique per (project, generation, run), a second writer cannot silently share
 * authority, a reopened database reads the same progress back, and a failed
 * write leaves no partial advance behind.
 */
const directory = mkdtempSync(join(tmpdir(), 'run-recovery-verify-'));
const dbPath = join(directory, 'run-recovery-v1.sqlite3');
const key: RunRecoveryKey = {
  projectId: 'run-recovery-verify',
  sessionGeneration: 'gen-1',
  runId: '11111111-1111-4111-8111-111111111111',
};
const keyOf = (runId: string, overrides: Partial<RunRecoveryKey> = {}): RunRecoveryKey => ({
  ...key,
  runId,
  ...overrides,
});
function store(): RunRecoveryStore {
  return new RunRecoveryStore(dbPath);
}
const admission = {
  ...key,
  backend: 'codex',
  model: 'gpt-5.4',
  askOnly: false,
  admissionExpiresAt: Date.now() + 60_000,
  now: 1_000,
};
try {
  // --- admission: one row per identity, for supported backends ---------------------
  const first = store();
  assert.equal(first.prepareAdmission(admission), 'admitted');
  assert.equal(
    first.prepareAdmission(admission),
    'duplicate',
    'an identical create retry completes the same admission instead of starting a second executor',
  );
  assert.equal(
    first.prepareAdmission({ ...admission, model: 'other/model' }),
    'identity-conflict',
    'the same run id with a different model is a different run and must not be merged',
  );
  for (const backend of ['copilot', 'pi']) {
    assert.equal(first.prepareAdmission({ ...admission, ...keyOf(`unsupported-${backend}`), backend }),
      'unsupported-backend', `${backend} keeps its existing recovery rules`);
  }
  const codexKey = { ...key, projectId: 'codex-recovery-store', runId: 'codex-store' };
  assert.equal(first.prepareAdmission({ ...admission, ...codexKey, backend: 'codex' }), 'admitted');
  assert.equal(first.load(codexKey)?.backend, 'codex', 'Codex shares the durable recovery store');
  first.finalize(codexKey);
  const admitted = first.load(key);
  assert.ok(admitted);
  assert.equal(admitted.phase, 'admitted');
  assert.equal(admitted.ownerInstance, null, 'admission grants no execution authority');
  assert.equal(
    admitted.admissionExpiresAt,
    admission.admissionExpiresAt,
    'a retry never extends the original admission deadline',
  );
  // --- ownership: exactly one live executor per run -------------------------
  const claimed = first.acquireOwnership(key, { instanceId: 'service-A', now: 2_000 });
  assert.equal(claimed.outcome, 'acquired');
  assert.equal(claimed.epoch, 1, 'the first owner starts at epoch 1, so 0 can mean "no authority"');
  assert.equal(
    first.acquireOwnership(key, { instanceId: 'service-B', now: 2_001 }).outcome,
    'held-elsewhere',
    'a live lease cannot be stolen',
  );
  assert.equal(
    first.acquireOwnership(key, { instanceId: 'service-A', now: 2_002 }).outcome,
    'renewed',
    'the owner renews without bumping its epoch',
  );
  assert.equal(
    first.acquireOwnership(key, {
      instanceId: 'service-B',
      now: 2_002 + DEFAULT_RUN_OWNER_TTL_MS - 1,
    }).outcome,
    'held-elsewhere',
    'renewal extended the recorded expiry, so the run is not takeover-able early',
  );
  const takeover = first.acquireOwnership(key, {
    instanceId: 'service-B',
    now: 2_002 + DEFAULT_RUN_OWNER_TTL_MS + 1,
  });
  assert.equal(takeover.outcome, 'acquired', 'an expired lease may be taken over');
  assert.equal(takeover.epoch, 2, 'takeover bumps the epoch so the old owner is fenced out');
  // The displaced owner cannot advance anything.
  assert.throws(
    () => first.beginRequest(key, {
      epoch: 1,
      requestIndex: 1,
      prompt: 'stale',
      messages: [{ role: 'user', content: 'stale' }],
      toolNames: [],
    }),
    /ownership is stale/,
  );
  // --- request input survives a reopen -------------------------------------
  first.beginRequest(key, {
    epoch: 2,
    requestIndex: 1,
    prompt: 'USER:\nRead the timeline, trim clip-7 by 2 seconds, then confirm.',
    messages: [{ role: 'user', content: 'Read the timeline, trim clip-7 by 2 seconds, then confirm.' }],
    toolNames: ['read_timeline', 'edit_item'],
  });
  const dispatchA = first.beginTool(key, {
    epoch: 2,
    intent: { toolCallId: 'call-A', name: 'read_timeline', argsDigest: 'digest-A' },
  });
  assert.deepEqual(dispatchA, { opSeq: 1, state: 'intent' });
  assert.equal(
    first.claimTool(key, { epoch: 2, toolCallId: 'call-A', argsDigest: 'digest-A', claimId: 'claim-1' }),
    'claimed',
  );
  assert.equal(
    first.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 1, toolCallId: 'call-A', name: 'read_timeline', argsDigest: 'digest-A', success: true, result: { items: 3 } },
    }),
    'recorded',
  );
  first.close();
  const reopened = store();
  const loaded = reopened.load(key);
  assert.ok(loaded, 'the reopened database reads the run back');
  assert.equal(loaded.phase, 'executing');
  assert.match(loaded.prompt ?? '', /clip-7/, 'the interrupted model input survived the process');
  assert.equal(loaded.requestIndex, 1);
  assert.deepEqual(loaded.toolNames, ['read_timeline', 'edit_item']);
  assert.equal(loaded.nextOpSeq, 2, 'the dispatch counter resumed where it stopped');
  assert.equal(loaded.tools.length, 1);
  assert.equal(loaded.tools[0]!.state, 'outcome');
  assert.deepEqual(loaded.tools[0]!.result, { items: 3 });

  // --- tool identity -------------------------------------------------------
  const dispatchB = reopened.beginTool(key, {
    epoch: 2,
    intent: { toolCallId: 'call-B', name: 'edit_item', argsDigest: 'digest-B' },
  });
  assert.deepEqual(dispatchB, { opSeq: 2, state: 'intent' });
  assert.deepEqual(
    reopened.beginTool(key, {
      epoch: 2,
      intent: { toolCallId: 'call-B', name: 'edit_item', argsDigest: 'digest-B' },
    }),
    { opSeq: 2, state: 'duplicate' },
    're-dispatching the same call keeps its sequence instead of consuming a new one',
  );
  assert.throws(
    () => reopened.beginTool(key, {
      epoch: 2,
      intent: { toolCallId: 'call-B', name: 'edit_item', argsDigest: 'different-digest' },
    }),
    /different arguments/,
    'the same call id with different arguments is a conflict, not a new operation',
  );

  // --- claims are the proof of execution authority -------------------------
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-A', argsDigest: 'digest-A', claimId: 'claim-1' }),
    'run-finalized',
    'a completed tool cannot be claimed again',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-B', argsDigest: 'digest-B', claimId: 'claim-2' }),
    'claimed',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-B', argsDigest: 'digest-B', claimId: 'claim-2' }),
    'duplicate',
    'the browser retrying its own claim gets the same answer',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-B', argsDigest: 'digest-B', claimId: 'claim-3' }),
    'already-claimed',
    'a different claimant cannot take a granted claim',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 1, toolCallId: 'call-B', argsDigest: 'digest-B', claimId: 'claim-4' }),
    'epoch-stale',
    'a displaced owner cannot hand out new execution authority',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-Z', argsDigest: 'digest-Z', claimId: 'claim-5' }),
    'unknown-tool',
    'an unknown call id never creates a row',
  );

  // --- outcomes are idempotent, and conflicts are surfaced -----------------
  assert.equal(
    reopened.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 2, toolCallId: 'call-B', name: 'edit_item', argsDigest: 'digest-B', success: true, result: { applied: true } },
    }),
    'recorded',
  );
  assert.equal(
    reopened.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 2, toolCallId: 'call-B', name: 'edit_item', argsDigest: 'digest-B', success: true, result: { applied: true } },
    }),
    'duplicate',
    'a resent identical result converges instead of double-counting',
  );
  assert.equal(
    reopened.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 2, toolCallId: 'call-B', name: 'edit_item', argsDigest: 'digest-B', success: true, result: { applied: false } },
    }),
    'conflict',
    'a different result for the same operation is never merged silently',
  );
  assert.equal(
    reopened.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 9, toolCallId: 'call-C', name: 'read_timeline', argsDigest: 'digest-C', success: true, result: {} },
    }),
    'unknown-tool',
  );

  // Unclaimed outcomes are refused: the server cannot accept a result for
  // authority it never granted.
  const dispatchD = reopened.beginTool(key, {
    epoch: 2,
    intent: { toolCallId: 'call-D', name: 'read_timeline', argsDigest: 'digest-D' },
  });
  assert.equal(dispatchD.opSeq, 3);
  assert.equal(
    reopened.finishTool(key, {
      epoch: 2,
      outcome: { opSeq: 3, toolCallId: 'call-D', name: 'read_timeline', argsDigest: 'digest-D', success: true, result: {} },
    }),
    'unclaimed',
  );

  // --- a failed write rolls back whole ------------------------------------
  const beforeFailure = reopened.load(key)!;
  const failingKey = keyOf('22222222-2222-4222-8222-222222222222');
  assert.equal(reopened.prepareAdmission({ ...admission, ...failingKey }), 'admitted');
  const ownerB = reopened.acquireOwnership(failingKey, { instanceId: 'service-A', now: 2_000 });
  assert.equal(ownerB.outcome, 'acquired');
  let inserted = 0;
  assert.throws(() => {
    for (let index = 0; index < MAX_RUN_RECOVERY_TOOLS_PER_RUN + 1; index += 1) {
      reopened.beginTool(failingKey, {
        epoch: ownerB.epoch!,
        intent: { toolCallId: `call-${index}`, name: 'read_timeline', argsDigest: `digest-${index}` },
      });
      inserted += 1;
    }
  }, /tool limit reached/);
  const afterFailure = reopened.load(failingKey)!;
  assert.equal(afterFailure.tools.length, MAX_RUN_RECOVERY_TOOLS_PER_RUN);
  assert.equal(
    afterFailure.nextOpSeq,
    MAX_RUN_RECOVERY_TOOLS_PER_RUN + 1,
    'the rejected insert did not consume a sequence number',
  );
  assert.equal(inserted, MAX_RUN_RECOVERY_TOOLS_PER_RUN);
  assert.equal(
    reopened.load(key)!.nextOpSeq,
    beforeFailure.nextOpSeq,
    'a failure in one run never advances another run',
  );

  // --- finalize drops the replay body, keeping identity -------------------
  assert.equal(reopened.finalize(key), true);
  assert.equal(reopened.finalize(key), false, 'finalize is idempotent');
  const finalized = reopened.load(key)!;
  assert.equal(finalized.phase, 'finalized');
  assert.equal(finalized.prompt, null, 'terminal runs do not keep model text');
  assert.equal(finalized.messages, null);
  assert.equal(
    finalized.tools.length,
    3,
    'tool rows stay for diagnostics: A and B outcomes plus the unclaimed D intent',
  );
  assert.equal(
    reopened.acquireOwnership(key, { instanceId: 'service-C', now: 9_000 }).outcome,
    'run-finalized',
    'a finalized run cannot be resumed by anyone',
  );
  assert.equal(
    reopened.claimTool(key, { epoch: 2, toolCallId: 'call-D', argsDigest: 'digest-D', claimId: 'claim-9' }),
    'run-finalized',
  );

  // --- generation scoping --------------------------------------------------
  const otherGeneration = keyOf(key.runId, { sessionGeneration: 'gen-2' });
  reopened.prepareAdmission({ ...admission, ...otherGeneration });
  assert.equal(reopened.load(otherGeneration)?.phase, 'admitted');
  assert.equal(reopened.load(key)?.phase, 'finalized', 'generations are separate rows');
  assert.equal(
    reopened.purgeOtherGenerations(key.projectId, 'gen-2'),
    2,
    'rotating the session generation drops every old-generation row of the project',
  );
  assert.equal(reopened.load(key), null);
  assert.equal(reopened.load(failingKey), null);
  assert.ok(reopened.load(otherGeneration), 'the current generation survives');

  // --- cleanup -------------------------------------------------------------
  assert.equal(reopened.purgeProject(otherGeneration.projectId), 1);
  assert.equal(reopened.load(otherGeneration), null);
  reopened.prepareAdmission({ ...admission, ...otherGeneration });
  assert.equal(
    reopened.purgeRun(otherGeneration),
    1,
    'an explicit end-of-run purge removes the row entirely',
  );
  assert.equal(reopened.load(otherGeneration), null);
  reopened.close();

  // HTTP outcomes commit before acknowledgement; model shaping is a separate,
  // fenced projection, while browser retries still compare their original body.
  const boundary = new RunRecoveryStore(':memory:');
  boundary.prepareAdmission(admission);
  const firstOwner = boundary.acquireOwnership(key, { instanceId: 'boundary-1' });
  boundary.beginRequest(key, { epoch: firstOwner.epoch!, requestIndex: 1,
    prompt: 'original', messages: [{ role: 'user', content: 'original' }], toolNames: ['ToolSearch'], instructions: 'system' });
  const operation = boundary.beginTool(key, { epoch: firstOwner.epoch!,
    intent: { toolCallId: 'shape', name: 'ToolSearch', argsDigest: 'shape-digest', args: { query: 'edit' } } });
  boundary.claimTool(key, { epoch: firstOwner.epoch!, toolCallId: 'shape', argsDigest: 'shape-digest', claimId: 'shape-claim' });
  const browserAnswer = { toolCallId: 'shape', argsDigest: 'shape-digest', claimId: 'shape-claim', result: { tools: ['edit_item'], detail: 'browser payload' } };
  assert.equal(boundary.recordBrowserOutcome(key, browserAnswer), 'recorded');
  const modelAnswer = { opSeq: operation.opSeq, toolCallId: 'shape', name: 'ToolSearch', argsDigest: 'shape-digest', success: true, result: { activated: ['edit_item'] } };
  assert.equal(boundary.finishTool(key, { epoch: firstOwner.epoch!, outcome: modelAnswer }), 'recorded');
  assert.equal(boundary.finishTool(key, { epoch: firstOwner.epoch!, outcome: modelAnswer }), 'duplicate');
  assert.equal(boundary.recordBrowserOutcome(key, browserAnswer), 'duplicate', 'HTTP retries compare the browser answer after shaping');
  assert.deepEqual(boundary.load(key)!.tools[0].result, modelAnswer.result);
  const newer = boundary.acquireOwnership(key, { instanceId: 'boundary-2', now: Date.now() + DEFAULT_RUN_OWNER_TTL_MS + 1 });
  assert.throws(() => boundary.finalize(key, Date.now(), firstOwner.epoch), /stale/, 'a stale executor cannot finalize a newer owner');
  assert.equal(boundary.finalize(key), false, 'unowned cleanup cannot finalize a live executor');
  assert.equal(boundary.finalize(key, Date.now(), newer.epoch), true);
  boundary.close();

  // API round checkpoints preserve native SDK message structure and advance
  // messages, request index and acceptance state in one fenced update.
  const apiStore = new RunRecoveryStore(':memory:');
  const apiKey = { ...key, projectId: 'api-round-checkpoint' };
  apiStore.prepareAdmission({ ...admission, ...apiKey, backend: 'api' });
  const apiOwner = apiStore.acquireOwnership(apiKey, { instanceId: 'api-round-1' });
  const initialMessages: import('ai').ModelMessage[] = [{ role: 'user', content: 'edit then inspect' }];
  const initialState = { activeToolNames: ['edit_item'], acceptance: { phase: 'working', iteration: 0 } };
  apiStore.completeRequest(apiKey, { epoch: apiOwner.epoch!, nextRequestIndex: 1, messages: initialMessages, executionState: initialState });
  assert.equal(apiStore.load(apiKey)?.requestState, 'pending');
  apiStore.beginRequest(apiKey, { epoch: apiOwner.epoch!, requestIndex: 1, prompt: '', messages: initialMessages,
    instructions: 'exact API system', toolNames: ['edit_item'], requestOptions: { maxOutputTokens: 256 } });
  assert.equal(apiStore.load(apiKey)?.requestState, 'inflight');
  assert.deepEqual(apiStore.load(apiKey)?.requestOptions, { maxOutputTokens: 256 });
  const apiIntent = apiStore.beginTool(apiKey, { epoch: apiOwner.epoch!,
    intent: { toolCallId: 'native-B', name: 'edit_item', argsDigest: 'api-digest' } });
  apiStore.finishTool(apiKey, { epoch: apiOwner.epoch!, outcome: { ...apiIntent,
    toolCallId: 'native-B', name: 'edit_item', argsDigest: 'api-digest', success: true, local: true, result: { applied: true } } });
  const nextMessages: import('ai').ModelMessage[] = [...initialMessages,
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'native-B', toolName: 'edit_item', input: { duration: 120 } }],
      providerOptions: { openai: { opaque: 'preserve-provider-data' } } },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'native-B', toolName: 'edit_item',
      output: { type: 'json', value: { applied: true, values: [1, { id: 'clip-7' }] } } }] },
  ];
  const nextState = { activeToolNames: ['read_timeline'], acceptance: { phase: 'checking', iteration: 1, mutated: true } };
  apiStore.completeRequest(apiKey, { epoch: apiOwner.epoch!, nextRequestIndex: 2, messages: nextMessages, executionState: nextState });
  const nextRound = apiStore.load(apiKey)!;
  assert.equal(nextRound.requestIndex, 2);
  assert.equal(nextRound.requestState, 'pending');
  assert.equal(nextRound.prompt, null, 'a completed round is never mistaken for a request to replay');
  assert.equal(nextRound.requestOpBoundary, apiIntent.opSeq);
  assert.deepEqual(nextRound.messages, nextMessages);
  assert.deepEqual(nextRound.executionState, nextState);
  apiStore.acquireOwnership(apiKey, { instanceId: 'api-round-2', now: Date.now() + DEFAULT_RUN_OWNER_TTL_MS + 1 });
  assert.throws(() => apiStore.completeRequest(apiKey, { epoch: apiOwner.epoch!, nextRequestIndex: 3,
    messages: [], executionState: initialState }), /stale/);
  assert.equal(apiStore.load(apiKey)?.requestIndex, 2);
  apiStore.close();

  // Renewal storage errors abort the executor instead of escaping a timer.
  const leaseStore = new RunRecoveryStore(':memory:');
  resetRunRecoveryStoreForTest(leaseStore);
  leaseStore.prepareAdmission(admission);
  let renew: (() => void) | undefined;
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = ((callback: () => void) => {
    renew = callback;
    return realInterval(() => undefined, 60_000);
  }) as typeof setInterval;
  try {
    const leaseRun = { id: key.runId, projectId: key.projectId, sessionGeneration: key.sessionGeneration,
      abort: new AbortController() } as ServerRun;
    assert.ok(beginRunRecoveryRuntime(leaseRun, { instanceId: 'renewal-test' }));
    leaseStore.acquireOwnership = () => { throw new Error('SQLITE_BUSY'); };
    assert.doesNotThrow(() => renew!());
    assert.equal(leaseRun.abort!.signal.aborted, true);
    assert.equal(leaseRun.abort!.signal.reason.code, 'recovery-write-failed');
  } finally {
    globalThis.setInterval = realInterval;
    resetRunRecoveryRuntimeForTest();
    resetRunRecoveryStoreForTest(null);
  }

  // --- a future schema is readable only for diagnostics -------------------
  const futurePath = join(directory, 'future.sqlite3');
  const future = new RunRecoveryStore(futurePath);
  future.close();
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(futurePath);
  raw.exec(`PRAGMA user_version = ${RUN_RECOVERY_SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(
    () => new RunRecoveryStore(futurePath),
    (error: unknown) => error instanceof RunRecoverySchemaError
      && /not supported/.test(error.message),
  );

  // Existing v1 records migrate without inventing recoverable model inputs.
  const migrationPath = join(directory, 'old-schema.sqlite3');
  const beforeMigration = new RunRecoveryStore(migrationPath);
  beforeMigration.prepareAdmission(admission);
  beforeMigration.close();
  const legacyDb = new DatabaseSync(migrationPath);
  for (const name of ['execution_input', 'instructions', 'execution_state', 'reconcile_reason', 'request_state', 'request_op_boundary', 'request_options', 'completion']) {
    legacyDb.exec(`ALTER TABLE run_recovery_runs DROP COLUMN ${name}`);
  }
  for (const name of ['request_index', 'args', 'model_result']) legacyDb.exec(`ALTER TABLE run_recovery_tools DROP COLUMN ${name}`);
  for (const name of ['attempt_number', 'last_error', 'last_continuation_id']) legacyDb.exec(`ALTER TABLE run_recovery_runs DROP COLUMN ${name}`);
  legacyDb.exec('DROP TABLE run_recovery_attempts');
  legacyDb.exec('PRAGMA user_version = 1');
  legacyDb.close();
  const migrated = new RunRecoveryStore(migrationPath);
  assert.equal(migrated.load(key)?.phase, 'admitted');
  assert.equal(migrated.load(key)?.executionInput, null, 'old records never get fabricated admission input');
  migrated.close();

  // A pre-API v2 subprocess request remains replayable after the additive migration.
  const v2Path = join(directory, 'v2-schema.sqlite3');
  const v2Before = new RunRecoveryStore(v2Path);
  v2Before.prepareAdmission(admission);
  const v2Owner = v2Before.acquireOwnership(key, { instanceId: 'v2-owner' });
  v2Before.beginRequest(key, { epoch: v2Owner.epoch!, requestIndex: 7, prompt: 'v2 prompt',
    messages: [{ role: 'user', content: 'v2 original messages' }], toolNames: ['read_timeline'] });
  v2Before.close();
  const v2Db = new DatabaseSync(v2Path);
  for (const name of ['request_state', 'request_op_boundary', 'request_options', 'completion']) v2Db.exec(`ALTER TABLE run_recovery_runs DROP COLUMN ${name}`);
  for (const name of ['attempt_number', 'last_error', 'last_continuation_id']) v2Db.exec(`ALTER TABLE run_recovery_runs DROP COLUMN ${name}`);
  v2Db.exec('DROP TABLE run_recovery_attempts');
  v2Db.exec('PRAGMA user_version = 2');
  v2Db.close();
  const concurrentOpen = () => new Promise<void>((resolve, reject) => {
    const moduleUrl = new URL('./run-recovery-store.ts', import.meta.url).href;
    const script = `import { RunRecoveryStore } from ${JSON.stringify(moduleUrl)}; new RunRecoveryStore(process.argv[1]).close();`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, v2Path],
      { cwd: new URL('../..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Concurrent migration failed: ${errors}`)));
  });
  await Promise.all([concurrentOpen(), concurrentOpen()]);
  const v2After = new RunRecoveryStore(v2Path);
  assert.equal(v2After.load(key)?.requestState, 'inflight');
  assert.equal(v2After.load(key)?.requestIndex, 7);
  assert.equal(v2After.load(key)?.prompt, 'v2 prompt');
  assert.deepEqual(v2After.load(key)?.messages, [{ role: 'user', content: 'v2 original messages' }]);
  v2After.close();

  // --- default location stays outside the project store scan --------------
  const defaultPath = defaultRunRecoveryStorePath();
  assert.ok(defaultPath.endsWith('run-recovery-v1.sqlite3'));
  assert.ok(
    !defaultPath.includes('project-store-v1/'),
    'the recovery database must not sit inside the directory the JSON project store scans',
  );

  assert.ok(existsSync(dbPath));
  console.log(
    'run-recovery-store.verify: identity, ownership epochs, claim proof, idempotent outcomes, rollback, finalize and cleanup passed',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
