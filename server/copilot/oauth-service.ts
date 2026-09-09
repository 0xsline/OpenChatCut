import { randomUUID } from 'node:crypto';
import type { CopilotAuthState, CopilotDeviceAuthorization } from '../../shared/copilot-auth.ts';
import type { CopilotOAuthApi } from './oauth-api.ts';
import { CopilotAuthError, type CopilotCredentialLease, type CopilotCredentialStore, type CopilotStoredAuth } from './oauth-types.ts';

interface PendingAuthorization {
  readonly id: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly abort: AbortController;
  intervalMs: number;
}

export interface CopilotOAuthOptions {
  readonly store: CopilotCredentialStore;
  readonly api: CopilotOAuthApi;
  readonly credentialsChanged: () => Promise<void>;
  readonly isBusy?: () => boolean;
  readonly now?: () => number;
}

function message(error: unknown): string {
  return error instanceof CopilotAuthError ? error.message : 'Copilot sign-in failed. Please try again.';
}

export class CopilotOAuthService {
  private pending: PendingAuthorization | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private error: string | undefined;
  private closed = false;
  private leases = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private credentialAbort = new AbortController();
  private readonly now: () => number;
  private readonly options: CopilotOAuthOptions;

  constructor(options: CopilotOAuthOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next;
    return next;
  }

  async state(): Promise<CopilotAuthState> {
    return this.serialize(async () => {
      try {
        return this.snapshot(await this.options.store.read());
      } catch (error) {
        return {
          available: this.options.store.available(), status: 'error',
          account: null, device: null, error: message(error),
        };
      }
    });
  }

  private snapshot(stored: CopilotStoredAuth | null): CopilotAuthState {
    const available = this.options.store.available();
    const account = stored?.kind === 'oauth' ? { login: stored.login } : null;
    let error = this.error;
    if (!available) error = 'Secure desktop credential storage is unavailable. Existing CLI sign-in can still be used.';
    if (stored?.kind === 'oauth' && stored.expiresAt !== undefined && stored.expiresAt <= this.now()
      && (!stored.refreshToken || (stored.refreshExpiresAt !== undefined && stored.refreshExpiresAt <= this.now()))) {
      error = 'GitHub sign-in expired. Sign in again.';
    }
    const pending = this.pending;
    const device: CopilotDeviceAuthorization | null = pending ? {
      id: pending.id, userCode: pending.userCode, verificationUri: pending.verificationUri,
      expiresAt: pending.expiresAt, intervalMs: pending.intervalMs,
    } : null;
    return {
      available, account, device,
      status: pending ? 'pending' : error ? 'error' : account ? 'signed-in' : 'signed-out',
      ...(error ? { error } : {}),
    };
  }

  async start(): Promise<CopilotAuthState> {
    return this.serialize(async () => {
      this.requireIdle();
      if (!this.options.store.available()) throw new CopilotAuthError('GitHub sign-in requires secure desktop credential storage.');
      if (this.pending) throw new CopilotAuthError('A GitHub sign-in is already pending. Complete or cancel it first.', 409);
      const stored = await this.options.store.read();
      const abort = this.credentialAbort;
      const code = await this.options.api.start(abort.signal);
      if (this.closed || abort.signal.aborted) throw new CopilotAuthError('GitHub sign-in was cancelled.', 409);
      this.error = undefined;
      this.pending = {
        id: randomUUID(), deviceCode: code.deviceCode, userCode: code.userCode,
        verificationUri: code.verificationUri, expiresAt: this.now() + code.expiresIn * 1000,
        intervalMs: code.interval * 1000, abort: new AbortController(),
      };
      this.schedule(this.pending);
      return this.snapshot(stored);
    });
  }

  private schedule(pending: PendingAuthorization): void {
    if (this.closed || this.pending !== pending || pending.abort.signal.aborted) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.poll(pending); }, Math.max(0,
      Math.min(pending.intervalMs, pending.expiresAt - this.now())));
    this.timer.unref?.();
  }

  private async poll(pending: PendingAuthorization): Promise<void> {
    try {
      if (this.closed || this.pending !== pending || pending.abort.signal.aborted) return;
      if (this.now() >= pending.expiresAt) throw new CopilotAuthError('The GitHub sign-in code expired. Start sign-in again.');
      const result = await this.options.api.poll(pending.deviceCode, pending.abort.signal);
      if (this.pending !== pending || pending.abort.signal.aborted) return;
      if (result.kind === 'slow-down') {
        pending.intervalMs = Math.max(pending.intervalMs + 5000, (result.interval ?? 0) * 1000);
      }
      if (result.kind !== 'token') {
        this.schedule(pending);
        return;
      }
      const login = await this.options.api.identity(result.credentials.accessToken, pending.abort.signal);
      await this.serialize(async () => {
        if (this.closed || this.pending !== pending || pending.abort.signal.aborted) return;
        if (this.now() >= pending.expiresAt) throw new CopilotAuthError('The GitHub sign-in code expired. Start sign-in again.');
        const previous = await this.options.store.read();
        await this.options.store.write({ ...result.credentials, login });
        // Cancel/sign-out may arrive while the atomic encrypted write is in progress.
        if (this.closed || this.pending !== pending || pending.abort.signal.aborted) {
          await this.options.store.write(previous);
          return;
        }
        await this.options.credentialsChanged();
        this.pending = null;
        this.error = undefined;
      });
    } catch (error) {
      if (this.pending !== pending || pending.abort.signal.aborted) return;
      this.pending = null;
      this.error = message(error);
    }
  }

  async cancel(id: string): Promise<CopilotAuthState> {
    if (!this.pending || this.pending.id !== id) throw new CopilotAuthError('This GitHub sign-in is no longer pending.', 409);
    this.pending.abort.abort(new CopilotAuthError('GitHub sign-in was cancelled.', 409));
    this.pending = null;
    clearTimeout(this.timer);
    return this.state();
  }

  async logout(): Promise<CopilotAuthState> {
    this.requireIdle();
    this.pending?.abort.abort(new CopilotAuthError('GitHub sign-in was cancelled.', 409));
    this.pending = null;
    clearTimeout(this.timer);
    this.credentialAbort.abort(new CopilotAuthError('GitHub sign-in was cancelled.', 409));
    this.credentialAbort = new AbortController();
    return this.serialize(async () => {
      this.requireIdle();
      // Persist an explicit sign-out so a restart cannot silently switch to gh's account.
      await this.options.store.write({ version: 1, kind: 'signed-out' });
      this.error = undefined;
      await this.options.credentialsChanged();
      return this.snapshot({ version: 1, kind: 'signed-out' });
    });
  }

  /** undefined preserves legacy CLI auth only when this app has never managed a login. */
  async accessToken(): Promise<string | undefined> {
    return this.serialize(() => this.readAccessToken());
  }

  /** Reserve the authenticated identity before SDK startup, not just after session creation. */
  async acquireForTurn(): Promise<CopilotCredentialLease> {
    return this.serialize(async () => {
      const token = await this.readAccessToken();
      this.leases += 1;
      let released = false;
      return {
        token,
        release: () => {
          if (released) return;
          released = true;
          this.leases -= 1;
        },
      };
    });
  }

  private busy(): boolean { return this.leases > 0 || this.options.isBusy?.() === true; }

  private async readAccessToken(): Promise<string | undefined> {
    if (this.closed) throw new CopilotAuthError('Copilot sign-in service is closed.');
    if (this.pending) throw new CopilotAuthError('Complete or cancel the pending GitHub sign-in first.', 409);
    const stored = await this.options.store.read();
    if (!stored) return undefined;
    if (stored.kind === 'signed-out') throw new CopilotAuthError('Sign in with GitHub in Settings > Copilot.', 401);
    if (stored.expiresAt === undefined || stored.expiresAt > this.now() + 60_000) return stored.accessToken;
    if (this.busy() && stored.expiresAt > this.now()) return stored.accessToken;
    if (this.busy()) throw new CopilotAuthError('GitHub sign-in expired. Finish the active Copilot run, then sign in again.', 401);
    if (!stored.refreshToken || (stored.refreshExpiresAt !== undefined && stored.refreshExpiresAt <= this.now())) {
      throw new CopilotAuthError('GitHub sign-in expired. Sign in again.', 401);
    }
    const abort = this.credentialAbort;
    try {
      const next = await this.options.api.refresh(stored, abort.signal);
      if (abort.signal.aborted || this.closed) throw new CopilotAuthError('GitHub sign-in was cancelled.', 409);
      if (next.login !== stored.login) throw new CopilotAuthError('GitHub returned a different account. Sign in again.', 401, true);
      await this.options.store.write(next);
      if (abort.signal.aborted || this.closed) {
        await this.options.store.write(stored);
        throw new CopilotAuthError('GitHub sign-in was cancelled.', 409);
      }
      await this.options.credentialsChanged();
      this.error = undefined;
      return next.accessToken;
    } catch (error) {
      if (error instanceof CopilotAuthError && error.reauthorize) {
        await this.options.store.write({ version: 1, kind: 'signed-out' });
        await this.options.credentialsChanged();
      }
      this.error = message(error);
      throw error;
    }
  }

  private requireIdle(): void {
    if (this.closed) throw new CopilotAuthError('Copilot sign-in service is closed.');
    if (this.busy()) throw new CopilotAuthError('Finish or cancel the active Copilot run before changing sign-in.', 409);
  }

  dispose(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending?.abort.abort(new CopilotAuthError('Copilot sign-in service is closed.'));
    this.credentialAbort.abort(new CopilotAuthError('Copilot sign-in service is closed.'));
  }
}

let service: CopilotOAuthService | null = null;

export function configureCopilotOAuth(next: CopilotOAuthService): void {
  if (service) throw new Error('Copilot OAuth is already configured');
  service = next;
}

export function copilotOAuth(): CopilotOAuthService | null { return service; }

export const unavailableCopilotAuthState = (): CopilotAuthState => ({
  available: false, status: 'signed-out', account: null, device: null,
  error: 'Browser-based GitHub sign-in is available in the desktop app. Web development can still use an existing CLI login.',
});
