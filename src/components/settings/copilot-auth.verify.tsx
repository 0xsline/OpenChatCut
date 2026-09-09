import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import type { CopilotAgentModel, CopilotAgentStatus } from '../../../shared/copilot-agent';
import type { CopilotAuthState } from '../../../shared/copilot-auth';
import {
  cancelCopilotAuth, fetchCopilotAuth, logoutCopilotAuth, startCopilotAuth,
} from '../../agent/copilot/client';
import { getAgentModelSnapshot } from '../../agent/model-selection';
import { ensureLocaleDict, setLocale } from '../../i18n/locale';
import { createCopilotSettingsStore, type CopilotSettingsController } from './useCopilotSettings';

const signedOut: CopilotAuthState = { available: true, status: 'signed-out', account: null, device: null };
const signedIn: CopilotAuthState = { ...signedOut, status: 'signed-in', account: { login: 'octocat' } };
const runtimeOut: CopilotAgentStatus = {
  installed: true, supported: true, version: '1.0.11', path: '/bundled/copilot',
  authenticated: false, account: null,
};
const runtimeIn: CopilotAgentStatus = {
  ...runtimeOut, authenticated: true, account: { login: 'octocat', authType: 'oauth', host: 'github.com' },
};
const model: CopilotAgentModel = {
  id: 'gpt-5', label: 'GPT-5', isDefault: true, supportsTools: true, supportsVision: true,
  contextWindowTokens: 100_000, maxInputTokens: null, maxOutputTokens: null, supportedReasoningEfforts: [],
};
function pending(overrides: Partial<NonNullable<CopilotAuthState['device']>> = {}): CopilotAuthState {
  return {
    ...signedOut, status: 'pending',
    device: {
      id: 'safe-attempt-id', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device',
      expiresAt: Date.now() + 600_000, intervalMs: 5_000, ...overrides,
    },
  };
}

interface Request {
  path: string;
  init?: RequestInit;
  respond: (value: unknown, status?: number) => void;
}
const requests: Request[] = [];
const history: Request[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => new Promise<Response>((resolve) => {
  const request: Request = {
    path: String(input), init,
    respond: (value, status = 200) => resolve(Response.json(value, { status })),
  };
  requests.push(request);
  history.push(request);
});
function take(path: string): Request {
  const index = requests.findIndex((request) => request.path === `/api/copilot/${path}`);
  assert.notEqual(index, -1, `expected request: ${path}`);
  return requests.splice(index, 1)[0];
}
function respond(path: string, value: unknown, status = 200): void {
  take(path).respond(value, status);
}
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
function copilotChoices() {
  return getAgentModelSnapshot().choices.filter((choice) => choice.backend === 'copilot');
}

let deactivate: (() => void) | undefined;
try {
  await ensureLocaleDict('en');
  setLocale('en');
  const clientCalls = Promise.all([fetchCopilotAuth(), startCopilotAuth(), cancelCopilotAuth('attempt-1'), logoutCopilotAuth()]);
  const authGet = take('auth');
  assert.equal(authGet.init?.cache, 'no-store');
  assert.ok(authGet.init?.signal);
  authGet.respond(signedOut);
  for (const [path, body] of [['auth/start', {}], ['auth/cancel', { id: 'attempt-1' }], ['auth/logout', {}]] as const) {
    const request = take(path);
    assert.equal(request.init?.method, 'POST');
    assert.equal(new Headers(request.init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(request.init?.body)), body);
    assert.doesNotMatch(String(request.init?.body), /device_code|access_token|refresh_token/);
    request.respond(signedOut);
  }
  await clientCalls;
  const rejected = startCopilotAuth();
  respond('auth/start', { error: 'A Copilot run is active.' }, 409);
  await assert.rejects(rejected, /A Copilot run is active/);

  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const store = createCopilotSettingsStore();
  const current = store.getSnapshot;
  await current().refresh();
  await current().startLogin();
  assert.equal(requests.length, 0, 'disabled settings do not fetch or start login');
  deactivate = store.activate();
  respond('status', runtimeOut);
  respond('auth', signedOut);
  await settle();
  assert.equal(current().auth?.status, 'signed-out');
  assert.equal(requests.length, 0, 'activation only reads auth/status, not models or login');

  async function startDevice(state = pending()): Promise<void> {
    const starting = current().startLogin();
    assert.equal(current().authBusy, 'start');
    await current().startLogin();
    assert.equal(requests.filter((request) => request.path.endsWith('/start')).length, 1);
    respond('auth/start', state);
    await settle();
    respond('status', runtimeOut);
    await starting;
  }
  await startDevice();
  mock.timers.tick(4_999);
  assert.equal(requests.length, 0);
  mock.timers.tick(1);
  const firstPoll = take('auth');
  mock.timers.tick(15_000);
  assert.equal(requests.length, 0, 'polls never overlap');
  firstPoll.respond(pending({ intervalMs: 1 }));
  await settle();
  mock.timers.tick(999);
  assert.equal(requests.length, 0);
  mock.timers.tick(1);
  respond('auth', { error: 'Connection interrupted.' }, 503);
  await settle();
  assert.equal(current().auth?.status, 'pending');
  assert.equal(current().authError, 'Connection interrupted.');
  mock.timers.tick(1_000);
  respond('auth', pending({ intervalMs: 90_000 }));
  await settle();
  assert.equal(current().authError, null, 'a successful retry clears the polling error');
  mock.timers.tick(29_999);
  assert.equal(requests.length, 0);
  mock.timers.tick(1);
  const canceledPoll = take('auth');
  const canceling = current().cancelLogin();
  assert.equal(canceledPoll.init?.signal?.aborted, true);
  const cancelRequest = take('auth/cancel');
  assert.deepEqual(JSON.parse(String(cancelRequest.init?.body)), { id: 'safe-attempt-id' });
  cancelRequest.respond(signedOut);
  await settle();
  respond('status', runtimeOut);
  await canceling;
  canceledPoll.respond(signedIn);
  await settle();
  assert.equal(current().auth?.status, 'signed-out', 'late poll cannot undo cancellation');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 0, 'cancellation stops all polling');

  await startDevice(pending({ intervalMs: 1_000 }));
  mock.timers.tick(1_000);
  respond('auth', signedIn);
  await settle();
  respond('status', runtimeIn);
  respond('models', { models: [model] });
  await settle();
  assert.equal(current().status?.authenticated, true);
  assert.deepEqual(current().models, [model]);
  assert.equal(copilotChoices()[0]?.model, model.id, 'sign-in immediately publishes composer models');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 0, 'completed sign-in stops polling');
  const refreshing = current().refresh();
  respond('status', runtimeIn);
  respond('auth', signedIn);
  await refreshing;
  assert.equal(requests.length, 0, 'ordinary refresh does not repeat model discovery');

  const busyLogout = current().logout();
  respond('auth/logout', { error: 'A Copilot run is active.' }, 409);
  await busyLogout;
  assert.equal(current().authError, 'A Copilot run is active.');
  assert.equal(current().auth?.status, 'signed-in');
  assert.equal(copilotChoices().length, 1, 'a rejected logout preserves the current account and models');

  const discovering = current().discoverModels();
  const staleStatus = take('status');
  const staleModels = take('models');
  const signingOut = current().logout();
  assert.equal(staleModels.init?.signal?.aborted, true);
  respond('auth/logout', signedOut);
  await settle();
  assert.deepEqual(current().models, []);
  assert.deepEqual(copilotChoices(), [], 'logout clears composer choices before the runtime refresh finishes');
  respond('status', runtimeOut);
  await signingOut;
  staleStatus.respond(runtimeIn);
  staleModels.respond({ models: [model] });
  await discovering;
  assert.equal(current().status?.authenticated, false);
  assert.deepEqual(current().models, [], 'late discovery cannot restore signed-out models');
  assert.deepEqual(copilotChoices(), []);

  const oldRefresh = current().refresh();
  const oldAuth = take('auth');
  const oldStatus = take('status');
  const newRefresh = current().refresh();
  respond('auth', pending({ id: 'new-attempt', intervalMs: 1_000 }));
  respond('status', runtimeOut);
  await newRefresh;
  oldAuth.respond(signedIn);
  oldStatus.respond(runtimeIn);
  await oldRefresh;
  assert.equal(current().auth?.device?.id, 'new-attempt', 'latest refresh wins even when earlier fetch ignores abort');
  assert.equal(current().status?.authenticated, false);
  assert.equal(requests.length, 0);

  mock.timers.tick(1_000);
  const disabledPoll = take('auth');
  deactivate();
  assert.equal(disabledPoll.init?.signal?.aborted, true);
  disabledPoll.respond(signedIn);
  await settle();
  mock.timers.tick(60_000);
  assert.equal(requests.length, 0, 'disable/unmount clears timers and ignores late responses');
  assert.equal(current().auth?.device?.id, 'new-attempt');

  deactivate = store.activate();
  respond('status', runtimeOut);
  respond('auth', pending({ expiresAt: Date.now() + 500 }));
  await settle();
  mock.timers.tick(1_000);
  respond('auth', { ...signedOut, status: 'error', error: 'Device code expired.' });
  await settle();
  assert.equal(current().auth?.status, 'error');
  mock.timers.tick(60_000);
  assert.equal(requests.length, 0, 'expiry is read from the server, then polling stops');
  deactivate();
  deactivate = undefined;
  const modelRequests = history.filter((request) => request.path.endsWith('/models'));
  assert.equal(modelRequests.length, 2, 'only completed sign-in and explicit discovery request models');
} finally {
  deactivate?.();
  mock.timers.reset();
  globalThis.fetch = originalFetch;
}

const localeModule = '\0copilot-auth-test-locale';
const vite = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, hmr: false, watch: null },
  plugins: [{
    name: 'copilot-auth-test-locale',
    enforce: 'pre',
    resolveId(id) { return id.endsWith('/i18n/locale') ? localeModule : null; },
    load(id) {
      return id === localeModule ? `
        import dictionary from '/src/i18n/dict/en/settings.ts';
        export const t = (key, params = {}) => (dictionary[key] ?? key)
          .replace(/\\{(\\w+)\\}/g, (match, key) => params[key] ?? match);
        export const useT = () => t;
      ` : null;
    },
  }],
});
try {
  const { CopilotAccountCard } = await vite.ssrLoadModule('/src/components/settings/CopilotAccountCard.tsx');
  const calls: string[] = [];
  const base: CopilotSettingsController = {
    status: runtimeOut, loading: false, error: null, auth: signedOut,
    authLoading: false, authBusy: null, authError: null, models: [], modelBusy: false, modelError: null,
    refresh: async () => { calls.push('refresh'); return runtimeOut; },
    discoverModels: async () => { calls.push('models'); return []; },
    startLogin: async () => { calls.push('start'); },
    cancelLogin: async () => { calls.push('cancel'); },
    logout: async () => { calls.push('logout'); },
  };
  function markup(patch: Partial<CopilotSettingsController> = {}): string {
    return renderToStaticMarkup(createElement(CopilotAccountCard, { controller: { ...base, ...patch } }));
  }
  function click(node: ReactNode, label: string): boolean {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
      if (child.type === 'button' && child.props.children === label) {
        child.props.onClick?.();
        return true;
      }
      if (click(child.props.children, label)) return true;
    }
    return false;
  }
  assert.match(markup(), /Sign in with GitHub/);
  assert.match(markup(), /No gh or separate CLI installation is needed/);
  assert.doesNotMatch(markup(), /copilot login/);
  const device = pending();
  const pendingMarkup = markup({ auth: device, status: runtimeIn, authError: 'Try refreshing.' });
  assert.match(pendingMarkup, /Waiting for GitHub authorization/);
  assert.doesNotMatch(pendingMarkup, /Signed in to GitHub Copilot/);
  assert.match(pendingMarkup, /ABCD-1234/);
  assert.match(pendingMarkup, /user-select:all/);
  assert.match(pendingMarkup, /Expires at/);
  assert.match(pendingMarkup, /href="https:\/\/github.com\/login\/device" target="_blank" rel="noopener noreferrer"/);
  assert.match(pendingMarkup, /Open GitHub/);
  assert.match(pendingMarkup, /role="alert"[^>]*>Try refreshing\./);
  assert.doesNotMatch(pendingMarkup, /safe-attempt-id|device_code|access_token|refresh_token/);
  assert.match(markup({ auth: pending({ verificationUri: 'javascript:alert(1)' }) }), /invalid verification URL/);
  assert.doesNotMatch(markup({ auth: pending({ verificationUri: 'https://github.com.evil.example/login/device' }) }), /<a /);
  const expired = markup({ auth: pending({ expiresAt: Date.now() - 1 }) });
  assert.match(expired, /device code has expired/);
  assert.match(expired, /Sign in with GitHub/);
  assert.doesNotMatch(expired, /ABCD-1234|<a |Waiting for GitHub/);
  const unavailable = markup({ auth: { ...signedOut, available: false, error: 'Secure desktop sign-in unavailable.' } });
  assert.match(unavailable, /copilot login/);
  assert.match(unavailable, /Secure desktop sign-in unavailable/);
  assert.doesNotMatch(unavailable, /Sign in with GitHub/);
  assert.match(markup({ auth: null, authError: 'Not found' }), /copilot login/);
  assert.match(markup({ status: { ...runtimeOut, installed: false }, auth: { ...signedOut, available: false } }), /npm i -g @github\/copilot/);
  assert.match(markup({ status: { ...runtimeOut, supported: false }, auth: { ...signedOut, available: false } }), /copilot update/);
  assert.match(markup({ status: { ...runtimeOut, supported: false } }), /Update or reinstall the desktop app/);
  const authenticated = { ...base, status: runtimeIn, auth: signedIn };
  assert.match(markup(authenticated), /octocat/);
  assert.match(markup(authenticated), /Sign out of this app/);
  assert.match(markup(authenticated), /does not revoke GitHub authorization or sign out other apps/);
  assert.doesNotMatch(markup({ ...authenticated, authError: 'Logout busy' }), /Signed in to GitHub Copilot/);
  assert.match(markup({ authBusy: 'start' }), /<button[^>]*disabled=""[^>]*>Starting/);
  assert.ok(click(CopilotAccountCard({ controller: base }), 'Sign in with GitHub'));
  assert.ok(click(CopilotAccountCard({ controller: { ...base, auth: device } }), 'Cancel sign-in'));
  assert.ok(click(CopilotAccountCard({ controller: authenticated }), 'Sign out of this app'));
  assert.ok(click(CopilotAccountCard({ controller: authenticated }), 'Refresh status'));
  assert.ok(click(CopilotAccountCard({ controller: authenticated }), 'Load models'));
  assert.deepEqual(calls, ['start', 'cancel', 'logout', 'refresh', 'models']);
} finally {
  await vite.close();
}
console.log('copilot-auth.verify: safe HTTP contract, polling/races, composer synchronization and account UI passed');
