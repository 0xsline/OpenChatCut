import type { ModelMessage } from 'ai';

/**
 * Durable recovery boundary used by Codex subprocess runs.
 *
 * The contract is expressed here, apart from the SQLite implementation, so the
 * subprocess turn, the executor and the fixtures can agree on *what* has to survive a
 * process restart before anyone decides *where* it is stored. Every field below
 * exists because a restarted subprocess cannot be handed the model-side state:
 * Codex creates temporary threads, so the next prompt has to be
 * rebuilt from these records alone.
 *
 * Ordering rules the implementation must honour:
 *  1. `beginRequest` lands before the subprocess is asked to prompt, because it
 *     is the only copy of the exact model input this request used.
 *  2. `beginTool` lands before the tool request is published to the browser:
 *     without a durable intent the server cannot later prove whether the
 *     browser ever received execution authority.
 *  3. `finishTool` lands before the result is handed back to the model, so a crash
 *     between "browser answered" and "model saw it" replays from the record.
 */
export interface ServerRunRequestRecord {
  /** 1-based model request index within the run (turn counter). */
  readonly requestIndex: number;
  readonly instructions?: string;
  readonly requestOptions?: { readonly maxOutputTokens: number };
  /** Compacted base prompt; confirmed outcomes are appended only for resumed RPCs. */
  readonly prompt: string;
  /** Original prepared messages; resume preserves them without re-compaction. */
  readonly messages: readonly ModelMessage[];
  /** Active tool names for this request, to detect a catalog drift on resume. */
  readonly toolNames: readonly string[];
}

export interface ServerRunToolIntent {
  /** Monotonic dispatch sequence within the run, assigned by the server. */
  readonly opSeq: number;
  /** Model's call id; binds only this model call, never a cross-restart identity. */
  readonly toolCallId: string;
  readonly name: string;
  readonly argsDigest: string;
  readonly args?: Record<string, unknown>;
}

export interface ServerRunToolOutcome {
  readonly opSeq: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly argsDigest: string;
  readonly success: boolean;
  /** Local results never granted browser execution authority. */
  readonly local?: boolean;
  /** Compacted projection handed back to the model. */
  readonly result: unknown;
}

/**
 * Sink the subprocess turn writes through. A run without a sink keeps today's
 * in-memory-only behaviour, used by backends and older runs without recovery admission.
 */
export interface ServerRunTurnRecoverySink {
  beginRequest: (record: ServerRunRequestRecord) => Promise<void>;
  lookupTool?: (input: { readonly name: string; readonly argsDigest: string; readonly requestIndex?: number; readonly throughOpSeq?: number }) => Promise<
    (ServerRunToolIntent & {
      readonly state: 'intent' | 'claimed' | 'outcome';
      readonly ambiguous?: boolean;
      readonly success?: boolean;
      readonly result?: unknown;
    }) | null
  >;
  /**
   * Reserves the dispatch sequence and records the intent. The returned `opSeq`
   * is what the matching outcome must carry back, so the resumed prompt can
   * order outcomes by dispatch rather than by completion.
   */
  beginTool: (
    intent: Omit<ServerRunToolIntent, 'opSeq'>,
  ) => Promise<{ readonly opSeq: number; readonly duplicate?: boolean }>;
  finishTool: (outcome: ServerRunToolOutcome) => Promise<void>;
}

/** Persisted, replayable form of one completed tool call. */
export interface ServerRunToolRecord extends ServerRunToolIntent {
  readonly success: boolean;
  readonly result: unknown;
}

/** Context of one interrupted subprocess request, used by Codex. */
export interface ServerSubprocessResume {
  readonly requestIndex: number;
  readonly prompt: string;
  readonly instructions?: string;
  readonly requestOptions?: { readonly maxOutputTokens: number };
  readonly toolNames?: readonly string[];
  readonly messages?: readonly ModelMessage[];
  readonly throughOpSeq?: number;
  readonly completedTools: readonly ServerRunToolRecord[];
}
