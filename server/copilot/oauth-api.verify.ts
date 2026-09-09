import assert from 'node:assert/strict';
import { COPILOT_DEVICE_URI, COPILOT_OAUTH_CLIENT_ID, GitHubCopilotOAuth } from './oauth-api.ts';
import { CopilotAuthError, type CopilotOAuthCredentials } from './oauth-types.ts';
import { copilotRuntimeOptions } from './client.ts';

const signal = new AbortController().signal;
const requests: Array<{ url: string; init: RequestInit }> = [];
let response: unknown;
let responseStatus = 200;
const api = new GitHubCopilotOAuth(COPILOT_OAUTH_CLIENT_ID, async (url, init) => {
  requests.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify(response), { status: responseStatus });
}, () => 1_000_000);

response = {
  device_code: 'private-device-code', user_code: 'ABCD-1234',
  verification_uri: COPILOT_DEVICE_URI, expires_in: 900, interval: 5,
};
assert.deepEqual(await api.start(signal), {
  deviceCode: 'private-device-code', userCode: 'ABCD-1234',
  verificationUri: COPILOT_DEVICE_URI, expiresIn: 900, interval: 5,
});
assert.equal(requests[0]!.url, 'https://github.com/login/device/code');
assert.equal(new URLSearchParams(String(requests[0]!.init.body)).get('scope'), 'read:user');
assert.equal(new URLSearchParams(String(requests[0]!.init.body)).get('client_id'), COPILOT_OAUTH_CLIENT_ID);
assert.equal(requests[0]!.init.redirect, 'error', 'OAuth tokens must never follow redirects');

response = { error: 'authorization_pending' };
assert.deepEqual(await api.poll('private-device-code', signal), { kind: 'pending' });
response = { error: 'slow_down', interval: 10 };
assert.deepEqual(await api.poll('private-device-code', signal), { kind: 'slow-down', interval: 10 });

response = { access_token: 'private-access-token', token_type: 'bearer', expires_in: 28800,
  refresh_token: 'private-refresh-token', refresh_token_expires_in: 15897600 };
const token = await api.poll('private-device-code', signal);
assert.equal(token.kind, 'token');
if (token.kind !== 'token') throw new Error('expected token');
assert.equal(token.credentials.expiresAt, 29_800_000);
assert.equal(token.credentials.refreshToken, 'private-refresh-token');
assert.equal(new URLSearchParams(String(requests.at(-1)!.init.body)).get('grant_type'),
  'urn:ietf:params:oauth:grant-type:device_code');

const stored: CopilotOAuthCredentials = { ...token.credentials, login: 'test-user' };
const refreshRequests: Array<{ url: string; init: RequestInit }> = [];
const refreshApi = new GitHubCopilotOAuth(COPILOT_OAUTH_CLIENT_ID, async (url, init) => {
  refreshRequests.push({ url: String(url), init: init ?? {} });
  if (String(url).endsWith('/user')) return new Response('profile temporarily unavailable', { status: 502 });
  return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 28800 });
});
const refreshed = await refreshApi.refresh(stored, signal);
assert.equal(refreshed.refreshToken, 'rotated-refresh');
assert.equal(refreshed.login, stored.login);
const form = new URLSearchParams(String(refreshRequests[0]!.init.body));
assert.equal(form.get('grant_type'), 'refresh_token');
assert.equal(form.get('refresh_token'), 'private-refresh-token');
assert.equal(form.has('client_secret'), false, 'device-flow refresh must not require a bundled secret');
assert.equal(refreshRequests.length, 1,
  'no fallible profile request may discard a rotated token pair before it is persisted');
assert.ok(refreshRequests.every(({ init }) => init.redirect === 'error'));
response = { login: 'test-user' };
assert.equal(await api.identity('private-access-token', signal), 'test-user');
assert.equal(requests.at(-1)!.url, 'https://api.github.com/user');
assert.equal(new Headers(requests.at(-1)!.init.headers).get('Authorization'), 'Bearer private-access-token');

for (const error of ['access_denied', 'expired_token', 'device_flow_disabled', 'incorrect_client_credentials', 'unknown']) {
  response = { error, error_description: 'private-access-token' };
  await assert.rejects(api.poll('private-device-code', signal), (failure: unknown) =>
    failure instanceof CopilotAuthError && !failure.message.includes('private-access-token'));
}
response = { error: 'bad_refresh_token' };
await assert.rejects(api.refresh(stored, signal), (failure: unknown) =>
  failure instanceof CopilotAuthError && failure.reauthorize);

for (const patch of [
  { verification_uri: 'https://evil.example/login/device' }, { expires_in: 0 }, { interval: -1 },
  { user_code: '<script>' }, { device_code: '' },
]) {
  response = { device_code: 'private-device-code', user_code: 'ABCD-1234', verification_uri: COPILOT_DEVICE_URI,
    expires_in: 900, interval: 5, ...patch };
  await assert.rejects(api.start(signal), /invalid device authorization/);
}
for (const patch of [{ expires_in: -10 }, { access_token: '' }, { token_type: 'other' }]) {
  response = { access_token: 'private-access-token', token_type: 'bearer', ...patch };
  await assert.rejects(api.poll('device', signal), /invalid sign-in credentials/);
}
responseStatus = 401;
response = { secret: 'private-token' };
await assert.rejects(api.identity('private-access-token', signal), (failure: unknown) =>
  failure instanceof CopilotAuthError && failure.reauthorize && !failure.message.includes('private-token'));
responseStatus = 502;
await assert.rejects(api.start(signal), /HTTP 502/);
const offline = new GitHubCopilotOAuth(COPILOT_OAUTH_CLIENT_ID, async () => { throw new Error('private network detail'); });
await assert.rejects(offline.start(signal), /Could not reach GitHub/);
await assert.rejects(new GitHubCopilotOAuth('invalid').start(signal), /Client ID is invalid/,
  'an invalid optional configuration must fail sign-in, not desktop startup');
const abort = new AbortController();
abort.abort(new CopilotAuthError('cancelled'));
await assert.rejects(offline.start(abort.signal), /cancelled/);

const options = copilotRuntimeOptions('/bundled/copilot', 'private-access-token');
assert.equal(options.gitHubToken, 'private-access-token');
assert.equal(options.useLoggedInUser, false, 'explicit OAuth cannot fall back to gh or a different account');
assert.equal(options.mode, 'empty', 'OAuth must preserve the restricted runtime');
assert.ok(options.baseDirectory?.endsWith('/.openchatcut/copilot'));
assert.equal(copilotRuntimeOptions('/bundled/copilot').gitHubToken, undefined,
  'web/legacy CLI users retain their existing authentication path');
console.log('copilot-oauth-api.verify: secretless device/refresh grants, safe errors and explicit isolated SDK auth passed');
