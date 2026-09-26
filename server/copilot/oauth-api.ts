import { proxyDispatcher } from '../outbound-proxy.ts';
import { CopilotAuthError, type CopilotOAuthCredentials } from './oauth-types.ts';

export const COPILOT_OAUTH_CLIENT_ID = 'Ov23liPv9ggKNWtTTvRP';
export const COPILOT_DEVICE_URI = 'https://github.com/login/device';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const REQUEST_TIMEOUT_MS = 15_000;

export interface GitHubDeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export type GitHubDeviceResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'slow-down'; readonly interval?: number }
  | { readonly kind: 'token'; readonly credentials: Omit<CopilotOAuthCredentials, 'login'> };

export interface CopilotOAuthApi {
  start(signal: AbortSignal): Promise<GitHubDeviceCode>;
  poll(deviceCode: string, signal: AbortSignal): Promise<GitHubDeviceResult>;
  refresh(credentials: CopilotOAuthCredentials, signal: AbortSignal): Promise<CopilotOAuthCredentials>;
  identity(accessToken: string, signal: AbortSignal): Promise<string>;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  access_denied: 'GitHub sign-in was denied. Start sign-in again when ready.',
  expired_token: 'The GitHub sign-in code expired. Start sign-in again.',
  token_expired: 'The GitHub sign-in code expired. Start sign-in again.',
  device_flow_disabled: 'Enable Device Flow in the GitHub OAuth application settings.',
  incorrect_client_credentials: 'The GitHub OAuth Client ID is invalid.',
  incorrect_device_code: 'The GitHub sign-in code is invalid. Start sign-in again.',
  bad_refresh_token: 'GitHub sign-in expired or was revoked. Sign in again.',
};

function positiveSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 366 * 24 * 60 * 60;
}

function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/\s/.test(value);
}

function oauthError(body: Record<string, unknown>): void {
  if (typeof body.error !== 'string') return;
  throw new CopilotAuthError(
    ERROR_MESSAGES[body.error] ?? 'GitHub rejected the sign-in request. Please try again.',
    400, body.error === 'bad_refresh_token',
  );
}

const proxyFetch: typeof fetch = (url, init) => {
  const options = { ...init, dispatcher: proxyDispatcher() };
  return fetch(url, options);
};

export class GitHubCopilotOAuth implements CopilotOAuthApi {
  private readonly clientId: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;

  constructor(
    clientId = COPILOT_OAUTH_CLIENT_ID,
    request: typeof fetch = proxyFetch,
    now: () => number = Date.now,
  ) {
    this.clientId = clientId;
    this.request = request;
    this.now = now;
  }

  private async json(url: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init, redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        headers: { Accept: 'application/json', 'User-Agent': 'OpenChatCut', ...init.headers },
      });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new CopilotAuthError('Could not reach GitHub. Check your connection or proxy and try again.');
    }
    if (!response.ok) {
      throw new CopilotAuthError(
        response.status === 401
          ? 'GitHub sign-in expired or was revoked. Sign in again.'
          : `GitHub sign-in request failed (HTTP ${response.status}).`,
        503, response.status === 401,
      );
    }
    let body: unknown;
    try {
      const text = await response.text();
      if (text.length > 65_536) throw new Error('oversized response');
      body = JSON.parse(text);
    } catch {
      throw new CopilotAuthError('GitHub returned an invalid sign-in response.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new CopilotAuthError('GitHub returned an invalid sign-in response.');
    }
    return body as Record<string, unknown>;
  }

  private form(url: string, values: Record<string, string>, signal: AbortSignal) {
    if (!/^[A-Za-z0-9]{10,128}$/.test(this.clientId)) throw new CopilotAuthError('The GitHub OAuth Client ID is invalid.');
    return this.json(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
    }, signal);
  }

  async start(signal: AbortSignal): Promise<GitHubDeviceCode> {
    const body = await this.form('https://github.com/login/device/code', {
      client_id: this.clientId, scope: 'read:user',
    }, signal);
    oauthError(body);
    if (!secret(body.device_code) || typeof body.user_code !== 'string'
      || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.user_code)
      || body.verification_uri !== COPILOT_DEVICE_URI
      || !positiveSeconds(body.expires_in) || body.expires_in > 1800
      || !positiveSeconds(body.interval) || body.interval > 60) {
      throw new CopilotAuthError('GitHub returned an invalid device authorization.');
    }
    return {
      deviceCode: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri,
      expiresIn: body.expires_in, interval: body.interval,
    };
  }

  private token(body: Record<string, unknown>): Omit<CopilotOAuthCredentials, 'login'> {
    oauthError(body);
    if (!secret(body.access_token) || body.token_type !== 'bearer'
      || (body.expires_in !== undefined && !positiveSeconds(body.expires_in))
      || (body.refresh_token !== undefined && !secret(body.refresh_token))
      || (body.refresh_token_expires_in !== undefined && !positiveSeconds(body.refresh_token_expires_in))) {
      throw new CopilotAuthError('GitHub returned invalid sign-in credentials.');
    }
    return {
      version: 1, kind: 'oauth', clientId: this.clientId, accessToken: body.access_token,
      ...(positiveSeconds(body.expires_in) ? { expiresAt: this.now() + body.expires_in * 1000 } : {}),
      ...(secret(body.refresh_token) ? { refreshToken: body.refresh_token } : {}),
      ...(positiveSeconds(body.refresh_token_expires_in)
        ? { refreshExpiresAt: this.now() + body.refresh_token_expires_in * 1000 } : {}),
    };
  }

  async poll(deviceCode: string, signal: AbortSignal): Promise<GitHubDeviceResult> {
    const body = await this.form(TOKEN_URL, {
      client_id: this.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal);
    if (body.error === 'authorization_pending') return { kind: 'pending' };
    if (body.error === 'slow_down') {
      return { kind: 'slow-down', ...(positiveSeconds(body.interval) ? { interval: body.interval } : {}) };
    }
    return { kind: 'token', credentials: this.token(body) };
  }

  async identity(accessToken: string, signal: AbortSignal): Promise<string> {
    const body = await this.json('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, signal);
    if (typeof body.login !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.login)) {
      throw new CopilotAuthError('GitHub returned an invalid account identity.');
    }
    return body.login;
  }

  async refresh(credentials: CopilotOAuthCredentials, signal: AbortSignal): Promise<CopilotOAuthCredentials> {
    if (!credentials.refreshToken || credentials.clientId !== this.clientId) {
      throw new CopilotAuthError('GitHub sign-in expired. Sign in again.', 401, true);
    }
    const body = await this.form(TOKEN_URL, {
      client_id: this.clientId, grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
    }, signal);
    const next = this.token(body);
    // Rotation invalidates the old grant. Return the new pair for persistence
    // immediately; a separate profile lookup must not strand it on a network failure.
    return { ...next, login: credentials.login };
  }
}
