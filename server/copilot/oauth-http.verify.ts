import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { copilotAgentPlugin } from '../plugins/copilot-agent.ts';
import { configureCopilotOAuth, CopilotOAuthService } from './oauth-service.ts';
import { COPILOT_DEVICE_URI } from './oauth-api.ts';
import type { CopilotStoredAuth } from './oauth-types.ts';
import type { CopilotAuthState } from '../../shared/copilot-auth.ts';

let handle: (req: IncomingMessage, res: ServerResponse) => void = () => { throw new Error('route not mounted'); };
const server = createServer((req, res) => handle(req, res));
const plugin = copilotAgentPlugin();
const configure = plugin.configureServer;
if (typeof configure !== 'function') throw new Error('configureServer must be a function');
await configure.call(plugin as never, {
  middlewares: { use: (_path: string, callback: typeof handle) => { handle = callback; } },
  httpServer: server,
} as unknown as ViteDevServer);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server must have a port');
const origin = `http://127.0.0.1:${address.port}`;
const previousOrigin = process.env.OPENCHATCUT_EDITOR_URL;
process.env.OPENCHATCUT_EDITOR_URL = origin;
let stored: CopilotStoredAuth | null = null;
let starts = 0;
let busy = false;
const auth = new CopilotOAuthService({
  store: { available: () => true, read: async () => stored, write: async (value) => { stored = value; } },
  api: {
    start: async () => {
      starts += 1;
      return { deviceCode: 'private-device-secret', userCode: 'ABCD-1234',
        verificationUri: COPILOT_DEVICE_URI, expiresIn: 900, interval: 60 };
    },
    poll: async () => ({ kind: 'pending' }),
    identity: async () => 'test-user',
    refresh: async (previous) => previous,
  },
  credentialsChanged: async () => undefined,
  isBusy: () => busy,
});
const call = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(`${origin}/api/copilot/auth${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
});
try {
  const unconfigured = await fetch(`${origin}/api/copilot/auth`);
  assert.equal(unconfigured.status, 200);
  assert.equal(((await unconfigured.json()) as CopilotAuthState).available, false,
    'plain web development has no plaintext credential fallback');
  configureCopilotOAuth(auth);
  assert.equal((await call('/start', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/start', {}, { origin: 'null' })).status, 403);
  assert.equal((await call('/start', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await call('/start', {}, { 'content-type': 'text/plain' })).status, 415);
  const missingOrigin = await fetch(`${origin}/api/copilot/auth/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal((await call('/start', { clientId: 'attacker-app' })).status, 400,
    'the renderer cannot override OAuth app identity or endpoints');
  assert.equal((await call('/start', { token: 'private-token' })).status, 400);
  assert.equal((await call('/start', { text: 'x'.repeat(2000) })).status, 413);
  assert.equal(starts, 0);
  assert.equal((await fetch(`${origin}/api/copilot/auth/start`, { headers: { origin } })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  busy = true;
  assert.equal((await call('/start')).status, 409);
  busy = false;
  const started = await call('/start');
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const state = await started.json() as CopilotAuthState;
  assert.equal(state.status, 'pending');
  assert.equal(state.device?.userCode, 'ABCD-1234');
  assert.doesNotMatch(JSON.stringify(state), /private-device-secret|deviceCode|accessToken|refreshToken/);
  assert.equal(starts, 1);
  assert.equal((await call('/start')).status, 409);
  assert.equal((await call('/cancel', { id: 'invalid' })).status, 400);
  assert.equal((await call('/cancel', { id: '00000000-0000-4000-8000-000000000000' })).status, 409);
  assert.equal((await call('/cancel', { id: state.device!.id })).status, 200);
  assert.equal((await call('/logout')).status, 200);
  await assert.rejects(auth.accessToken(), /Sign in with GitHub/);
  const status = await fetch(`${origin}/api/copilot/auth`);
  assert.equal((await status.json() as CopilotAuthState).status, 'signed-out');
} finally {
  auth.dispose();
  if (previousOrigin === undefined) delete process.env.OPENCHATCUT_EDITOR_URL;
  else process.env.OPENCHATCUT_EDITOR_URL = previousOrigin;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log('copilot-oauth-http.verify: same-origin guards, bounded JSON, safe state, pending ownership and sign-out passed');
