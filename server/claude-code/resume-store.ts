/**
 * Claude Code CLI session ids, remembered between Agent runs so a follow-up
 * message can `--resume` instead of cold-starting.
 *
 * Why this exists: unlike Codex, which keeps one long-lived `codex app-server`
 * process alive across turns, every Claude Code turn is a fresh `claude -p`
 * subprocess. Without a session id each one re-boots the CLI, re-runs the MCP
 * initialize/tools-list handshake, and re-sends the entire serialized
 * conversation as a new prompt. Resuming replaces all of that with the CLI's
 * own transcript plus the one new user message.
 *
 * The key is (project, agent session generation, model) rather than the run id,
 * because a run is a single user message: resumption has to span runs, but must
 * not span a cleared or rewound chat (the generation rotates) or a model switch
 * (a resumed transcript belongs to the model that produced it).
 *
 * Entries are in-memory only. A server restart loses them, which costs one cold
 * start and nothing else — the CLI's own transcript on disk is unaffected.
 */

/** Bounded so a long-lived dev server cannot accumulate an entry per project forever. */
const MAX_ENTRIES = 64;

const sessions = new Map<string, string>();

export interface ClaudeCodeSessionScope {
  readonly projectId: string;
  readonly sessionGeneration: string;
  readonly model: string;
}

export function claudeCodeSessionKey(scope: ClaudeCodeSessionScope): string {
  return `${scope.projectId}\0${scope.sessionGeneration}\0${scope.model}`;
}

export function recallClaudeCodeSession(key: string): string | null {
  const sessionId = sessions.get(key);
  if (sessionId === undefined) return null;
  // Refresh recency so the busy project is not the one evicted.
  sessions.delete(key);
  sessions.set(key, sessionId);
  return sessionId;
}

export function rememberClaudeCodeSession(key: string, sessionId: string): void {
  if (!sessionId) return;
  sessions.delete(key);
  sessions.set(key, sessionId);
  while (sessions.size > MAX_ENTRIES) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
}

/**
 * Drop a remembered session. Called whenever the CLI's transcript can no longer
 * be trusted to match what OpenChatCut thinks the conversation is: a failed or
 * timed-out turn (the CLI's state is unknown), or a compacted context (the
 * summary rewrote OpenChatCut's history but not the CLI's).
 */
export function forgetClaudeCodeSession(key: string): void {
  sessions.delete(key);
}

/** Test seam: the store is process-global, so verify runs must start clean. */
export function resetClaudeCodeSessionsForTest(): void {
  sessions.clear();
}

export function claudeCodeSessionCountForTest(): number {
  return sessions.size;
}
