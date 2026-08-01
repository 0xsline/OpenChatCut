export interface CodexAccountSummary {
  readonly type: 'chatgpt' | 'apiKey';
  readonly email: string | null;
  readonly planType: string | null;
}

export interface CodexAgentStatus {
  readonly installed: boolean;
  readonly version: string | null;
  readonly account: CodexAccountSummary | null;
  readonly loginPending: boolean;
  readonly error?: string;
}

export interface CodexAgentModel {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface CodexAgentModelsResponse {
  readonly models: readonly CodexAgentModel[];
  readonly error?: string;
}

export type CodexLoginMode = 'chatgpt' | 'chatgptDeviceCode';

export type CodexLoginStartResponse =
  | { readonly type: 'chatgpt'; readonly loginId: string; readonly authUrl: string }
  | {
      readonly type: 'chatgptDeviceCode';
      readonly loginId: string;
      readonly verificationUrl: string;
      readonly userCode: string;
    };

export interface CodexAgentToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CodexTurnRequest {
  readonly requestId: string;
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly askOnly?: boolean;
  readonly tools: readonly CodexAgentToolSpec[];
}

export interface CodexToolResultRequest {
  readonly requestId: string;
  readonly callId: string;
  readonly success: boolean;
  readonly result: unknown;
}

export type CodexTurnStreamEvent =
  | { readonly type: 'text-delta'; readonly delta: string }
  | { readonly type: 'thinking-delta'; readonly delta: string }
  | {
      readonly type: 'tool-start';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly type: 'tool-end';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
      readonly result: unknown;
      readonly success: boolean;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'done' };
