export class CopilotAuthError extends Error {
  readonly statusCode: number;
  readonly reauthorize: boolean;

  constructor(message: string, statusCode = 503, reauthorize = false) {
    super(message);
    this.name = 'CopilotAuthError';
    this.statusCode = statusCode;
    this.reauthorize = reauthorize;
  }
}

export interface CopilotOAuthCredentials {
  readonly version: 1;
  readonly kind: 'oauth';
  readonly clientId: string;
  readonly login: string;
  readonly accessToken: string;
  readonly expiresAt?: number;
  readonly refreshToken?: string;
  readonly refreshExpiresAt?: number;
}

export type CopilotStoredAuth = CopilotOAuthCredentials | { readonly version: 1; readonly kind: 'signed-out' };

export interface CopilotCredentialStore {
  available(): boolean;
  read(): Promise<CopilotStoredAuth | null>;
  write(value: CopilotStoredAuth | null): Promise<void>;
}

export interface CopilotCredentialLease {
  readonly token: string | undefined;
  release(): void;
}

export function parseStoredCopilotAuth(value: unknown): CopilotStoredAuth {
  if (!value || typeof value !== 'object') throw new CopilotAuthError('Stored Copilot sign-in is invalid. Sign out and sign in again.');
  const record = value as Record<string, unknown>;
  const validSecret = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 16_384 && !/\s/.test(v);
  const validTime = (v: unknown): v is number | undefined => v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
  if (record.version === 1 && record.kind === 'signed-out') return { version: 1, kind: 'signed-out' };
  if (record.version !== 1 || record.kind !== 'oauth'
    || typeof record.clientId !== 'string' || !/^[A-Za-z0-9]{10,128}$/.test(record.clientId)
    || typeof record.login !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.login)
    || !validSecret(record.accessToken)
    || (record.refreshToken !== undefined && !validSecret(record.refreshToken))
    || !validTime(record.expiresAt) || !validTime(record.refreshExpiresAt)) {
    throw new CopilotAuthError('Stored Copilot sign-in is invalid. Sign out and sign in again.');
  }
  return {
    version: 1, kind: 'oauth', clientId: record.clientId, login: record.login, accessToken: record.accessToken,
    ...(record.refreshToken === undefined ? {} : { refreshToken: record.refreshToken }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: record.refreshExpiresAt }),
  };
}
