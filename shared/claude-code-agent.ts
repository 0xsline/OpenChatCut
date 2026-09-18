export interface ClaudeCodeAccountSummary {
  readonly loggedIn: boolean;
  readonly email: string | null;
  readonly subscriptionType: string | null;
  readonly authMethod: string | null;
}

export interface ClaudeCodeAgentStatus {
  readonly installed: boolean;
  readonly version: string | null;
  readonly account: ClaudeCodeAccountSummary | null;
  readonly error?: string;
}

export interface ClaudeCodeAgentModel {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ClaudeCodeAgentModelsResponse {
  readonly models: readonly ClaudeCodeAgentModel[];
  readonly error?: string;
}

export interface ClaudeCodeTurnRequest {
  readonly requestId: string;
  readonly system: string;
  readonly prompt: string;
  readonly projectId: string;
  readonly model?: string;
  readonly sessionId?: string;
  /**
   * The composer's auto-apply (YOLO) state for this run. Declared to the
   * turn's own MCP server so begin_edit_session cannot fall back to "manual"
   * when the model omits the argument. Omitted means "leave it to the model",
   * which is the pre-existing behaviour.
   */
  readonly approvalMode?: 'manual' | 'auto';
}

/**
 * Unlike Codex's dynamicTools RPC bridge, Claude Code CLI's own MCP client
 * calls OpenChatCut's MCP server directly and executes tools itself — these
 * events are for chat-UI display only, never for OpenChatCut to act on.
 */
export type ClaudeCodeTurnStreamEvent =
  | { readonly type: 'session'; readonly sessionId: string }
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
      readonly cacheReadTokens?: number;
    }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'done' };
