/**
 * Copilot agent contract (SPIKE).
 *
 * Mirrors `shared/codex-agent.ts` so the Copilot backend can reuse the exact
 * turn/stream plumbing the Codex backend already drives. `CopilotTurnStreamEvent`
 * is structurally identical to `CodexTurnStreamEvent`: a promoted implementation
 * can collapse both into one shared union without touching consumers.
 */

export interface CopilotAccountSummary {
  readonly login: string | null;
  /** How the runtime authenticated: user session, gh CLI, env token, etc. */
  readonly authType: string | null;
  readonly host: string | null;
}

export interface CopilotAgentStatus {
  readonly installed: boolean;
  readonly version: string | null;
  readonly path: string | null;
  readonly supported: boolean;
  readonly authenticated: boolean;
  readonly account: CopilotAccountSummary | null;
  readonly error?: string;
}

export interface CopilotAgentModel {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
  readonly contextWindowTokens: number | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly supportedReasoningEfforts: readonly string[];
}

export interface CopilotAgentModelsResponse {
  readonly models: readonly CopilotAgentModel[];
  readonly error?: string;
}

export interface CopilotAgentToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CopilotTurnRequest {
  readonly requestId: string;
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly reasoningEffort?: string | null;
  readonly askOnly?: boolean;
  readonly tools: readonly CopilotAgentToolSpec[];
}

export interface CopilotToolResultRequest {
  readonly requestId: string;
  readonly callId: string;
  readonly success: boolean;
  readonly result: unknown;
}

export type CopilotTurnStreamEvent =
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
  | {
      readonly type: 'context-usage';
      readonly inputTokens: number;
      readonly contextWindowTokens?: number;
      readonly outputTokens?: number;
      readonly reasoningTokens?: number;
      readonly cacheReadTokens?: number;
      readonly noCacheInputTokens?: number;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'done' };
