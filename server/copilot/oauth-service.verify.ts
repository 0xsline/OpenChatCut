import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { CopilotAuthState } from '../../shared/copilot-auth.ts';
import { COPILOT_DEVICE_URI, COPILOT_OAUTH_CLIENT_ID, type CopilotOAuthApi, type GitHubDeviceResult } from './oauth-api.ts';
import { CopilotAuthError, type CopilotStoredAuth } from './oauth-types.ts';
import { CopilotOAuthService } from './oauth-service.ts';

const credentials = () => ({
  version: 1 as const, kind: 'oauth' as const, clientId: COPILOT_OAUTH_CLIENT_ID,
  accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 8 * 60 * 60_000,
  refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60_000,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  let stored: CopilotStoredAuth | null = null;
  let busy = false;
  let available = true;
  let changed = 0;
  let notify: () => Promise<void> = async () => { changed += 1; };
  const polls: number[] = [];
  let poll: CopilotOAuthApi['poll'] = async () => ({ kind: 'pending' });
  let refresh: CopilotOAuthApi['refresh'] = async (previous) => ({ ...credentials(), accessToken: 'rotated-access', login: previous.login });
  let write: (value: CopilotStoredAuth | null) => Promise<void> = async (value) => { stored = value; };
  const options = {
    store: {
      available: () => available, read: async () => stored,
      write: (value: CopilotStoredAuth | null) => write(value),
    },
    api: {
      start: async () => ({
        deviceCode: 'private-device', userCode: 'ABCD-1234', verificationUri: COPILOT_DEVICE_URI, expiresIn: 900, interval: 5,
      }),
      poll: (device: string, signal: AbortSignal) => { polls.push(Date.now()); return poll(device, signal); },
      identity: async () => 'test-user',
      refresh: (previous: Parameters<CopilotOAuthApi['refresh']>[0], signal: AbortSignal) => refresh(previous, signal),
    },
    isBusy: () => busy, credentialsChanged: () => notify(),
  };
  return {
    service: new CopilotOAuthService(options), options, polls,
    stored: () => stored, changed: () => changed,
    setStored: (value: CopilotStoredAuth | null) => { stored = value; },
    setBusy: (value: boolean) => { busy = value; },
    setAvailable: (value: boolean) => { available = value; },
    setPoll: (value: typeof poll) => { poll = value; },
    setRefresh: (value: typeof refresh) => { refresh = value; },
    setWrite: (value: typeof write) => { write = value; },
    setNotify: (value: typeof notify) => { notify = value; },
  };
}

function assertPublic(state: CopilotAuthState): void {
  const wire = JSON.stringify(state);
  assert.doesNotMatch(wire, /private-access|private-refresh|private-device|accessToken|refreshToken|deviceCode/);
}

mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
const fixtures: ReturnType<typeof fixture>[] = [];
const make = () => { const f = fixture(); fixtures.push(f); return f; };
try {
  const f = make();
  assert.equal(await f.service.accessToken(), undefined, 'only never-managed users retain legacy login');
  const start = await f.service.start();
  assert.equal(start.status, 'pending');
  assert.ok(start.device);
  assertPublic(start);
  await assert.rejects(f.service.start(), /already pending/);
  await assert.rejects(f.service.accessToken(), /Complete or cancel/);
  mock.timers.tick(4_999);
  await settle();
  assert.equal(f.polls.length, 0);
  mock.timers.tick(1);
  await settle();
  assert.equal(f.polls.length, 1);
  f.setPoll(async () => ({ kind: 'slow-down', interval: 12 }));
  mock.timers.tick(5000);
  await settle();
  assert.equal((await f.service.state()).device?.intervalMs, 12000);
  mock.timers.tick(11999);
  await settle();
  assert.equal(f.polls.length, 2);
  f.setPoll(async () => ({ kind: 'token', credentials: credentials() }));
  mock.timers.tick(1);
  await settle();
  const signedIn = await f.service.state();
  assert.equal(signedIn.status, 'signed-in');
  assert.equal(signedIn.account?.login, 'test-user');
  assertPublic(signedIn);
  assert.equal(await f.service.accessToken(), 'private-access');
  assert.equal(f.changed(), 1);
  const restarted = new CopilotOAuthService(f.options);
  assert.equal(await restarted.accessToken(), 'private-access');
  await restarted.logout();
  assert.equal((await restarted.state()).status, 'signed-out');
  await assert.rejects(f.service.accessToken(), /Sign in with GitHub/);
  restarted.dispose();

  const cancelled = make();
  const deferred = Promise.withResolvers<GitHubDeviceResult>();
  cancelled.setPoll(() => deferred.promise);
  const code = (await cancelled.service.start()).device!;
  mock.timers.tick(5000);
  await settle();
  await cancelled.service.cancel(code.id);
  deferred.resolve({ kind: 'token', credentials: credentials() });
  await settle();
  assert.equal(cancelled.stored(), null, 'a late token must not resurrect a cancelled login');
  assert.equal(cancelled.changed(), 0);
  await assert.rejects(cancelled.service.cancel(code.id), /no longer pending/);

  const logout = make();
  const late = Promise.withResolvers<GitHubDeviceResult>();
  logout.setPoll(() => late.promise);
  await logout.service.start();
  mock.timers.tick(5000);
  await settle();
  await logout.service.logout();
  late.resolve({ kind: 'token', credentials: credentials() });
  await settle();
  assert.deepEqual(logout.stored(), { version: 1, kind: 'signed-out' });
  await assert.rejects(logout.service.accessToken(), /Sign in with GitHub/);

  const expiry = make();
  await expiry.service.start();
  mock.timers.tick(900_000);
  await settle();
  assert.match((await expiry.service.state()).error ?? '', /expired/);
  assert.equal(expiry.polls.length, 0);
  const denied = make();
  denied.setPoll(async () => { throw new CopilotAuthError('GitHub sign-in was denied.'); });
  await denied.service.start();
  mock.timers.tick(5000);
  await settle();
  assert.match((await denied.service.state()).error ?? '', /denied/);

  const refresh = make();
  refresh.setStored({ ...credentials(), login: 'test-user', expiresAt: Date.now() + 30_000 });
  let refreshCount = 0;
  refresh.setRefresh(async (previous) => { refreshCount += 1; return { ...previous, accessToken: 'rotated-access', expiresAt: Date.now() + 28800000 }; });
  const tokens = await Promise.all([refresh.service.accessToken(), refresh.service.accessToken()]);
  assert.deepEqual(tokens, ['rotated-access', 'rotated-access']);
  assert.equal(refreshCount, 1, 'concurrent callers must not consume a refresh token twice');
  assert.equal(refresh.changed(), 1);

  const revoked = make();
  revoked.setStored({ ...credentials(), login: 'test-user', expiresAt: Date.now() - 1 });
  revoked.setRefresh(async () => { throw new CopilotAuthError('GitHub sign-in was revoked.', 401, true); });
  await assert.rejects(revoked.service.accessToken(), /revoked/);
  await assert.rejects(revoked.service.accessToken(), /Sign in with GitHub/);
  assert.deepEqual(revoked.stored(), { version: 1, kind: 'signed-out' });

  const busy = make();
  busy.setBusy(true);
  await assert.rejects(busy.service.start(), /active Copilot run/);
  await assert.rejects(busy.service.logout(), /active Copilot run/);
  busy.setAvailable(false);
  busy.setBusy(false);
  await assert.rejects(busy.service.start(), /secure desktop credential storage/);
  assert.equal((await busy.service.state()).available, false);

  const failing = make();
  failing.setPoll(async () => ({ kind: 'token', credentials: credentials() }));
  failing.setWrite(async () => { throw new CopilotAuthError('Could not securely save the Copilot sign-in.'); });
  await failing.service.start();
  mock.timers.tick(5000);
  await settle();
  assert.equal((await failing.service.state()).status, 'error');
  assert.equal(failing.changed(), 0);
  assert.equal(failing.stored(), null, 'a failed vault write cannot claim successful sign-in');

  const leased = make();
  leased.setStored({ ...credentials(), login: 'test-user', expiresAt: Date.now() + 30000 });
  const lease = await leased.service.acquireForTurn();
  assert.equal(lease.token, 'rotated-access', 'refresh happens before locking the run identity');
  await assert.rejects(leased.service.logout(), /active Copilot run/);
  await assert.rejects(leased.service.start(), /active Copilot run/);
  lease.release();
  lease.release();
  await leased.service.logout();
  await assert.rejects(leased.service.acquireForTurn(), /Sign in with GitHub/);

  const writeRace = make();
  const writeStarted = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  writeRace.setWrite(async (value) => {
    if (value?.kind === 'oauth') { writeStarted.resolve(); await finishWrite.promise; }
    writeRace.setStored(value);
  });
  writeRace.setPoll(async () => ({ kind: 'token', credentials: credentials() }));
  const racingCode = (await writeRace.service.start()).device!;
  mock.timers.tick(5000);
  await writeStarted.promise;
  const cancellation = writeRace.service.cancel(racingCode.id);
  finishWrite.resolve();
  await cancellation;
  assert.equal(writeRace.stored(), null, 'cancel during a vault write restores the previous credential');
  assert.equal(writeRace.changed(), 0);

  const refreshRace = make();
  refreshRace.setStored({ ...credentials(), login: 'test-user', expiresAt: Date.now() - 1 });
  const refreshStarted = Promise.withResolvers<void>();
  const finishRefresh = Promise.withResolvers<void>();
  refreshRace.setRefresh(async () => {
    refreshStarted.resolve();
    await finishRefresh.promise;
    return { ...credentials(), login: 'test-user' };
  });
  const refreshing = assert.rejects(refreshRace.service.accessToken(), /cancelled/);
  await refreshStarted.promise;
  const signingOut = refreshRace.service.logout();
  finishRefresh.resolve();
  await Promise.all([refreshing, signingOut]);
  assert.deepEqual(refreshRace.stored(), { version: 1, kind: 'signed-out' },
    'a late refresh cannot undo sign-out');

  const shutdownRace = make();
  const shutdownStarted = Promise.withResolvers<void>();
  const finishShutdown = Promise.withResolvers<void>();
  shutdownRace.setNotify(async () => { shutdownStarted.resolve(); await finishShutdown.promise; });
  shutdownRace.setPoll(async () => ({ kind: 'token', credentials: credentials() }));
  const shutdownCode = (await shutdownRace.service.start()).device!;
  mock.timers.tick(5000);
  await shutdownStarted.promise;
  const cancelDuringShutdown = shutdownRace.service.cancel(shutdownCode.id);
  finishShutdown.resolve();
  assert.equal((await cancelDuringShutdown).status, 'signed-out');
  assert.equal(shutdownRace.stored(), null, 'cancelling during SDK shutdown must roll back sign-in');

  const leaseRace = make();
  leaseRace.setStored({ ...credentials(), login: 'test-user', expiresAt: Date.now() - 1 });
  const resetStarted = Promise.withResolvers<void>();
  const finishReset = Promise.withResolvers<void>();
  leaseRace.setNotify(async () => { resetStarted.resolve(); await finishReset.promise; });
  const acquiring = assert.rejects(leaseRace.service.acquireForTurn(), /cancelled/);
  await resetStarted.promise;
  const logoutDuringReset = leaseRace.service.logout();
  finishReset.resolve();
  await acquiring;
  assert.equal((await logoutDuringReset).status, 'signed-out',
    'logout during SDK shutdown must not be defeated by a newly granted turn lease');
} finally {
  fixtures.forEach(({ service }) => service.dispose());
  mock.timers.reset();
}
console.log('copilot-oauth-service.verify: polling, isolation, cancellation, expiry, rotation, sign-out and busy guards passed');
