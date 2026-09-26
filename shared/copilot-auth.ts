export interface CopilotDeviceAuthorization {
  readonly id: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
}

/** Safe for the renderer: OAuth device, access, and refresh tokens stay on the server. */
export interface CopilotAuthState {
  readonly available: boolean;
  readonly status: 'signed-out' | 'pending' | 'signed-in' | 'error';
  readonly account: { readonly login: string } | null;
  readonly device: CopilotDeviceAuthorization | null;
  readonly error?: string;
}
