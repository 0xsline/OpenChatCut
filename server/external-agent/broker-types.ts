export interface ExternalToolSchema {
  name: string;
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export interface EditorBinding {
  projectId: string;
  editorInstanceId: string;
  baseRevision: string;
  ownershipEpoch?: number;
}

export type ExternalCallTerminalOutcome =
  | 'applied'
  | 'rejected'
  | 'cancelled'
  | 'stale'
  | 'failed';

export class ExternalEditorCallError extends Error {
  readonly outcome: Exclude<ExternalCallTerminalOutcome, 'applied'>;

  constructor(outcome: Exclude<ExternalCallTerminalOutcome, 'applied'>, message: string) {
    super(message);
    this.name = 'ExternalEditorCallError';
    this.outcome = outcome;
  }
}
